// Idempotent Tdarr config sync. Runs from a CronJob; safe to run repeatedly.
//
// Applies, from the files mounted next to this script:
//   flows/*.json        flows (secret placeholders filled from the environment)
//   libraries.json      libraries (merged over the live doc so Tdarr's counters survive)
//   workers.json        per-node worker limits
//   retire.json         pilot/legacy flows and libraries to remove
// and refreshes, on the shared cache volume read by every node:
//   foreign-originals.txt  titles whose original language is not English (keep their audio)
//   skip-folders.txt       favourite titles (never transcoded)
// then (only when feed.json says enabled) feeds the Tdarr queue in priority order.
//
// NOTE: no template literals here. Flux substitutes dollar-brace text in ConfigMaps.

const fs = require("fs")
const path = require("path")

const CONFIG = process.env.CONFIG_DIR || "/config"
const STATE = process.env.STATE_DIR || "/temp/hc"
const TDARR = process.env.TDARR_URL
const ARR = {
  sonarr: { url: process.env.SONARR_URL, key: process.env.SONARR_APIKEY },
  radarr: { url: process.env.RADARR_URL, key: process.env.RADARR_APIKEY },
}
const QUEUE_BUDGET = Number(process.env.QUEUE_BUDGET || 400)
const MAX_SCANS_PER_RUN = Number(process.env.MAX_SCANS_PER_RUN || 60)
// Stop feeding a library once this many files sit in error: a few corrupt files are normal, a pile
// means something systematic (dead cache mount, bad flow) and feeding more only burns the backlog.
const ERROR_BREAKER = Number(process.env.ERROR_BREAKER || 25)
// DRY_RUN=1: read everything, log every write instead of performing it
const DRY = process.env.DRY_RUN === "1"
const CACHE_DIR = process.env.CACHE_DIR || "/temp"
const WORKDIR_STALE_HOURS = Number(process.env.WORKDIR_STALE_HOURS || 6)
const WRITE_ENDPOINTS = new Set(["alter-worker-limit", "scan-files"])
const WRITE_MODES = new Set(["insert", "update", "removeOne"])

const readJson = (f) =>
  JSON.parse(fs.readFileSync(path.join(CONFIG, f), "utf8"))
const log = (m) => console.log(new Date().toISOString() + " " + m)

async function tdarr(endpoint, data) {
  const writes =
    WRITE_ENDPOINTS.has(endpoint) ||
    (endpoint === "cruddb" && data && WRITE_MODES.has(data.mode))
  if (DRY && writes) {
    log("DRY_RUN would " + endpoint + " " + JSON.stringify(data).slice(0, 150))
    return "DRY"
  }
  const res = await fetch(TDARR + "/api/v2/" + endpoint, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify({ data }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(endpoint + " HTTP " + res.status)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    return text
  }
}
const db = (collection, mode, extra) =>
  tdarr("cruddb", Object.assign({ collection, mode }, extra || {}))

async function arr(kind, endpoint) {
  const a = ARR[kind]
  const res = await fetch(a.url + "/api/v3/" + endpoint, {
    headers: { "X-Api-Key": a.key },
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(kind + " " + endpoint + " HTTP " + res.status)
  return res.json()
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === "object"
    )
      merge(target[k], v)
    else target[k] = v
  }
  return target
}

async function waitForTdarr() {
  for (let i = 0; i < 30; i += 1) {
    try {
      await tdarr("get-nodes")
      return
    } catch (e) {
      await new Promise((r) => setTimeout(r, 10000))
    }
  }
  throw new Error("Tdarr API not reachable at " + TDARR)
}

// Global Tdarr settings (single document). runMkvpropedit=false matters: with it on, Tdarr
// edits original .mkv files in place (statistics tags), which changes size/mtime and would
// trip the flow's "source unchanged" check on most of the library.
async function syncSettings() {
  const want = readJson("settings.json")
  const docs = await db("SettingsGlobalJSONDB", "getAll")
  const have = docs[0]
  const diff = Object.entries(want).filter(([k, v]) => !same(have[k], v))
  if (diff.length === 0) {
    log("global settings: unchanged")
    return
  }
  await db("SettingsGlobalJSONDB", "update", {
    docID: have._id,
    obj: Object.fromEntries(diff),
  })
  log("global settings: updated " + diff.map(([k]) => k).join(", "))
}

async function syncFlows() {
  const existing = new Map(
    (await db("FlowsJSONDB", "getAll")).map((f) => [f._id, f])
  )
  const subs = {
    hcTv: { "@@ARR_HOST@@": ARR.sonarr.url, "@@ARR_API_KEY@@": ARR.sonarr.key },
    hcMovies: {
      "@@ARR_HOST@@": ARR.radarr.url,
      "@@ARR_API_KEY@@": ARR.radarr.key,
    },
  }
  const flowFiles = fs
    .readdirSync(CONFIG)
    .filter((f) => f.startsWith("flow-") && f.endsWith(".json"))
  for (const file of flowFiles.sort()) {
    let text = fs.readFileSync(path.join(CONFIG, file), "utf8")
    const flow = JSON.parse(text)
    for (const [from, to] of Object.entries(subs[flow._id] || {}))
      text = text.split(from).join(to)
    const desired = JSON.parse(text)
    const have = existing.get(desired._id)
    if (!have) {
      await db("FlowsJSONDB", "insert", { docID: desired._id, obj: desired })
      log("flow " + desired._id + ": created")
    } else if (
      !same(have.flowPlugins, desired.flowPlugins) ||
      !same(have.flowEdges, desired.flowEdges) ||
      have.name !== desired.name
    ) {
      await db("FlowsJSONDB", "update", { docID: desired._id, obj: desired })
      log("flow " + desired._id + ": updated")
    } else {
      log("flow " + desired._id + ": unchanged")
    }
  }
}

async function syncLibraries() {
  const libs = await db("LibrarySettingsJSONDB", "getAll")
  const template = libs.find((l) => l.name === "Other") || libs[0]
  const out = []
  for (const def of readJson("libraries.json")) {
    const set = {
      name: def.name,
      folder: def.folder,
      flowId: def.flow,
      pluginIDs: [],
      decisionMaker: { settingsFlows: true, settingsPlugin: false },
      processLibrary: true,
      processTranscodes: true,
      processHealthChecks: false,
      folderWatching: false,
      scanOnStart: false,
      scheduledScanFindNew: false,
      holdNewFiles: false,
      priority: def.priority,
      cache: "/temp",
      output: ".",
    }
    const have = libs.find((l) => l.name === def.name || l._id === def.id)
    if (have) {
      const merged = merge(JSON.parse(JSON.stringify(have)), set)
      if (!same(have, merged)) {
        await db("LibrarySettingsJSONDB", "update", {
          docID: have._id,
          obj: merged,
        })
        log("library " + def.name + ": updated")
      } else {
        log("library " + def.name + ": unchanged")
      }
      out.push(Object.assign({}, def, { id: have._id }))
    } else {
      const doc = merge(JSON.parse(JSON.stringify(template)), set)
      doc._id = def.id
      doc.createdAt = Date.now()
      for (const k of [
        "totalHealthCheckCount",
        "totalTranscodeCount",
        "sizeDiff",
      ])
        delete doc[k]
      await db("LibrarySettingsJSONDB", "insert", { docID: def.id, obj: doc })
      log("library " + def.name + ": created")
      out.push(def)
    }
  }
  return out
}

async function syncWorkers() {
  const want = readJson("workers.json")
  const nodes = await tdarr("get-nodes")
  for (const [nodeID, node] of Object.entries(nodes)) {
    for (const [type, target] of Object.entries(want)) {
      for (let i = 0; i < 12; i += 1) {
        const cur = (await tdarr("get-nodes"))[nodeID].workerLimits[type]
        if (cur === target) break
        if (DRY) {
          log(
            "DRY_RUN node " +
              node.nodeName +
              " " +
              type +
              ": " +
              cur +
              " -> " +
              target
          )
          break
        }
        await tdarr("alter-worker-limit", {
          nodeID,
          workerType: type,
          process: cur < target ? "increase" : "decrease",
        })
      }
      const now = (await tdarr("get-nodes"))[nodeID].workerLimits[type]
      if (now !== target)
        log(
          "node " +
            node.nodeName +
            " " +
            type +
            ": wanted " +
            target +
            " have " +
            now
        )
    }
  }
  log("worker limits checked on " + Object.keys(nodes).length + " node(s)")
}

function writeAtomic(file, text) {
  if (DRY) {
    log("DRY_RUN would write " + file + " (" + text.length + " bytes)")
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

async function syncLists() {
  const cfg = readJson("lists.json")
  const foreign = []
  const favourites = []
  for (const kind of ["radarr", "sonarr"]) {
    const profiles = new Map(
      (await arr(kind, "qualityprofile")).map((p) => [p.id, p.name])
    )
    const items = await arr(kind, kind === "radarr" ? "movie" : "series")
    for (const it of items) {
      if (!it.path) continue
      const prefix = it.path.replace(/\/+$/, "") + "/"
      const lang = it.originalLanguage && it.originalLanguage.name
      if (lang && lang !== "English") foreign.push(prefix)
      if (cfg.favouriteProfiles.includes(profiles.get(it.qualityProfileId)))
        favourites.push(prefix)
    }
  }
  writeAtomic(
    path.join(STATE, "foreign-originals.txt"),
    foreign.sort().join("\n") + "\n"
  )
  writeAtomic(
    path.join(STATE, "skip-folders.txt"),
    favourites.sort().join("\n") + "\n"
  )
  log(
    "lists: " +
      foreign.length +
      " foreign-original titles, " +
      favourites.length +
      " favourite titles"
  )
  return new Set(favourites)
}

async function retire() {
  const r = readJson("retire.json")
  const libs = new Set(
    (await db("LibrarySettingsJSONDB", "getAll")).map((l) => l._id)
  )
  const flows = new Set((await db("FlowsJSONDB", "getAll")).map((f) => f._id))
  for (const id of r.libraries) {
    if (libs.has(id)) {
      await db("LibrarySettingsJSONDB", "removeOne", { docID: id })
      log("library " + id + ": removed")
    }
  }
  for (const id of r.flows) {
    if (flows.has(id)) {
      await db("FlowsJSONDB", "removeOne", { docID: id })
      log("flow " + id + ": removed")
    }
  }
}

async function feed(libraries, favourites) {
  const cfg = readJson("feed.json")
  if (!cfg.enabled) {
    log("feeder: disabled (feed.json enabled=false)")
    return
  }
  for (const lib of libraries) {
    if (!lib.priorityFile) continue
    const pies = await tdarr("stats/get-pies", { libraryId: lib.id })
    const queued = (
      (pies.pieStats &&
        pies.pieStats.status &&
        pies.pieStats.status.transcode) ||
      []
    )
      .filter((s) => s.name === "Queued")
      .reduce((n, s) => n + s.value, 0)
    const errored = (
      (pies.pieStats &&
        pies.pieStats.status &&
        pies.pieStats.status.transcode) ||
      []
    )
      .filter((s) => /error/i.test(s.name))
      .reduce((n, s) => n + s.value, 0)
    if (errored > ERROR_BREAKER) {
      log(
        "feeder " +
          lib.name +
          ": PAUSED, " +
          errored +
          " files in error (limit " +
          ERROR_BREAKER +
          "); review with scripts/tdarr-requeue.py"
      )
      continue
    }
    let budget = QUEUE_BUDGET - queued
    const stateFile = path.join(STATE, "fed-" + lib.id + ".json")
    const fed = new Set(
      fs.existsSync(stateFile)
        ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
        : []
    )
    log(
      "feeder " +
        lib.name +
        ": queued=" +
        queued +
        " budget=" +
        budget +
        " fed=" +
        fed.size
    )
    let added = 0
    for (const item of readJson(lib.priorityFile)) {
      if (fed.has(item.path)) continue
      if (favourites.has(item.path + "/")) continue
      if (budget <= 0 || (added > 0 && item.files > budget)) break
      // Per-run cap: the library's queue count can lag a scan, so never trust it for a big batch
      if (added >= MAX_SCANS_PER_RUN) break
      await tdarr("scan-files", {
        scanConfig: {
          dbID: lib.id,
          arrayOrPath: item.path,
          mode: "scanFindNew",
        },
      })
      fed.add(item.path)
      budget -= item.files
      added += 1
      log(
        "feeder " +
          lib.name +
          ": scanning " +
          item.path +
          " (" +
          item.files +
          " eligible files, " +
          item.gb +
          " GB, " +
          item.cls +
          ")"
      )
      // a one-folder scan finishes in about a second; scans fired this close together all land
      await new Promise((r) => setTimeout(r, 1500))
    }
    writeAtomic(stateFile, JSON.stringify([...fed]))
  }
}

// Tdarr deletes its own work folders when a job ends, but a killed pod leaves one behind
// (partial output, up to a few GB) and a failed job may too. A folder that nothing has written
// to for several hours cannot belong to a running encode, so it is safe to remove.
function newestMtime(dir, depth) {
  let newest = fs.statSync(dir).mtimeMs
  if (depth === 0) return newest
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    try {
      const m = e.isDirectory()
        ? newestMtime(p, depth - 1)
        : fs.statSync(p).mtimeMs
      if (m > newest) newest = m
    } catch (err) {
      // file vanished while scanning: ignore
    }
  }
  return newest
}

function sweepWorkdirs() {
  const cutoff = Date.now() - WORKDIR_STALE_HOURS * 3600 * 1000
  let removed = 0
  for (const e of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith("tdarr-workDir")) continue
    const dir = path.join(CACHE_DIR, e.name)
    if (newestMtime(dir, 3) >= cutoff) continue
    if (DRY) {
      log("DRY_RUN would remove stale work folder " + dir)
    } else {
      fs.rmSync(dir, { recursive: true, force: true })
      log("removed stale work folder " + dir)
    }
    removed += 1
  }
  log("work folder sweep: " + removed + " stale folder(s)")
}

;(async () => {
  await waitForTdarr()
  await syncSettings()
  await syncFlows()
  const libraries = await syncLibraries()
  await syncWorkers()
  const favourites = await syncLists()
  await retire()
  try {
    sweepWorkdirs()
  } catch (e) {
    log("work folder sweep failed (continuing): " + e.message)
  }
  await feed(libraries, favourites)
  log("done")
})().catch((e) => {
  console.error("FAILED: " + e.message)
  process.exit(1)
})
