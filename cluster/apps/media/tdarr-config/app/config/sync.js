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
//   priority-<library>.json  the feed order, rebuilt from Sonarr/Radarr and Tautulli at most once
//                          per PRIORITY_TTL_HOURS. Title lists and watch history are personal, so
//                          they live only on the cache volume and never in the repo.
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
// Seconds of scanning per run, split across libraries; the next run (CronJob) carries on
const FEED_SECONDS = Number(process.env.FEED_SECONDS || 240)
// DRY_RUN=1: read everything, log every write instead of performing it
const DRY = process.env.DRY_RUN === "1"
const TAUTULLI = {
  url: process.env.TAUTULLI_URL,
  key: process.env.TAUTULLI_APIKEY,
}
// Rebuild a library's priority list when it is older than this
const PRIORITY_TTL_HOURS = Number(process.env.PRIORITY_TTL_HOURS || 24)
// Titles played in the last N days go last, so a file is never swapped under an active viewer
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 90)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Paths the flow's size check found it cannot shrink; never feed them again
function noSavings() {
  try {
    return new Set(
      fs
        .readFileSync(path.join(STATE, "no-savings.txt"), "utf8")
        .split("\n")
        .filter(Boolean)
    )
  } catch (e) {
    return new Set()
  }
}

// Mirrors the flow's guard: skip HDR/DV, above 1080p, and anything already HEVC at 720p or below
function convertible(m) {
  m = m || {}
  if (m.videoDynamicRange) return false
  const [w, h] = (m.resolution || "0x0").split("x").map((n) => Number(n) || 0)
  if (h > 1100 || w > 1930) return false
  const codec = (m.videoCodec || "").toLowerCase()
  if (
    (codec.includes("265") || codec.includes("hevc")) &&
    h <= 740 &&
    w <= 1300
  )
    return false
  return true
}

// Files to feed for one priority-list folder, from Sonarr/Radarr (same paths Tdarr sees).
// Folder scans (scan-files with scanFindNew) cannot be used to feed: each one REPLACES the
// library's queued set, so feeding folder after folder keeps only the last one. Adding files
// by path (scanFolderWatcher, what Tdarr's own Sonarr/Radarr hooks use) accumulates.
async function folderFiles(kind, folder, cache) {
  if (kind === "radarr") {
    if (!cache.radarr) {
      cache.radarr = new Map()
      for (const mv of await arr("radarr", "movie")) {
        const f = mv.movieFile
        if (!f || !convertible(f.mediaInfo)) continue
        const dir = mv.path.replace(/\/$/, "")
        if (!cache.radarr.has(dir)) cache.radarr.set(dir, [])
        cache.radarr.get(dir).push(f.path)
      }
    }
    return cache.radarr.get(folder) || []
  }
  if (!cache.series) {
    cache.series = new Map(
      (await arr("sonarr", "series")).map((x) => [
        x.path.replace(/\/$/, ""),
        x.id,
      ])
    )
  }
  const id = cache.series.get(folder)
  if (id === undefined) return []
  return (await arr("sonarr", "episodefile?seriesId=" + id))
    .filter((f) => convertible(f.mediaInfo))
    .map((f) => f.path)
}

// scan-files answers "OK" even when the server drops the request ("Scan is already running on
// library" in its log), so a folder fed while another scan runs is silently lost. Wait for the
// scanner first. Its status reads "Files found:N", then "Extracting info:i/N", and keeps the
// last value when done: finished means i == N and nothing changing.
async function scanSettled(libId, timeoutMs) {
  const t0 = Date.now()
  let last = ""
  while (Date.now() - t0 < timeoutMs) {
    const st = String(await tdarr("get-filescanner-status", { dbID: libId }))
      .replace(/Scanner mem:.*$/, "")
      .trim()
    const m = st.match(/Extracting info:(\d+)\/(\d+)/)
    const finished = m ? m[1] === m[2] : true
    if (finished && st === last) return true
    last = st
    await sleep(1000)
  }
  return false
}

const normTitle = (t) =>
  t
    .toLowerCase()
    .replace(/\(\d{4}\)|\[.*?\]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

// Normalised titles played in the last RECENT_DAYS, from Tautulli's history (Plex plays only)
async function recentlyPlayed() {
  const after = new Date(Date.now() - RECENT_DAYS * 86400000)
    .toISOString()
    .slice(0, 10)
  const tv = new Set()
  const movies = new Set()
  let start = 0
  for (;;) {
    const params = new URLSearchParams({
      apikey: TAUTULLI.key,
      cmd: "get_history",
      after,
      grouping: "0",
      start: String(start),
      length: "1000",
    })
    const res = await fetch(TAUTULLI.url + "/api/v2?" + params, {
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) throw new Error("tautulli get_history HTTP " + res.status)
    const body = (await res.json()).response
    if (body.result !== "success") throw new Error("tautulli: " + body.message)
    const rows = body.data.data
    for (const r of rows) {
      if (r.media_type === "episode") tv.add(normTitle(r.grandparent_title || ""))
      else if (r.media_type === "movie") movies.add(normTitle(r.title || ""))
    }
    start += rows.length
    if (rows.length === 0 || start >= body.data.recordsFiltered) break
  }
  return { tv, movies }
}

// Feed order for one library: most convertible gigabytes first, recently watched titles last.
// Favourites are left out. Same "convertible" test as the flow's guard.
async function buildPriority(lib, favourites) {
  const recent = await recentlyPlayed()
  const items = []
  if (lib.arr === "radarr") {
    for (const mv of await arr("radarr", "movie")) {
      const f = mv.movieFile
      const dir = mv.path.replace(/\/+$/, "")
      if (!f || !convertible(f.mediaInfo) || favourites.has(dir + "/")) continue
      items.push({
        path: dir,
        files: 1,
        gb: Math.round(f.size / 1e7) / 100,
        cls: recent.movies.has(normTitle(mv.title)) ? "recent" : "older",
      })
    }
  } else {
    for (const sr of await arr("sonarr", "series")) {
      const dir = sr.path.replace(/\/+$/, "")
      const onDisk = sr.statistics && sr.statistics.sizeOnDisk
      if (!onDisk || favourites.has(dir + "/")) continue
      let bytes = 0
      let files = 0
      for (const f of await arr("sonarr", "episodefile?seriesId=" + sr.id)) {
        if (!convertible(f.mediaInfo)) continue
        bytes += f.size
        files += 1
      }
      if (files > 0)
        items.push({
          path: dir,
          files,
          gb: Math.round(bytes / 1e8) / 10,
          cls: recent.tv.has(normTitle(sr.title)) ? "recent" : "older",
        })
    }
  }
  items.sort(
    (a, b) => (a.cls === "recent") - (b.cls === "recent") || b.gb - a.gb
  )
  return items
}

// The cached list when it is fresh, else a rebuilt one. If the rebuild fails (Tautulli or an arr
// down), an old list is better than none, but a missing one means this library is not fed this run.
async function priorityList(lib, favourites) {
  const file = path.join(STATE, "priority-" + lib.id + ".json")
  const ageHours = fs.existsSync(file)
    ? (Date.now() - fs.statSync(file).mtimeMs) / 3600000
    : Infinity
  if (ageHours < PRIORITY_TTL_HOURS) return JSON.parse(fs.readFileSync(file, "utf8"))
  try {
    const items = await buildPriority(lib, favourites)
    writeAtomic(file, JSON.stringify(items))
    log(
      "feeder " + lib.name + ": built priority list, " + items.length + " titles, " +
        items.filter((i) => i.cls === "recent").length + " recently watched placed last"
    )
    return items
  } catch (e) {
    if (ageHours === Infinity) throw e
    log("feeder " + lib.name + ": priority rebuild failed (" + e.message + "), using the old list")
    return JSON.parse(fs.readFileSync(file, "utf8"))
  }
}

async function feed(libraries, favourites) {
  const cfg = readJson("feed.json")
  if (!cfg.enabled) {
    log("feeder: disabled (feed.json enabled=false)")
    return
  }
  const cache = {}
  const skipSet = noSavings()
  for (const lib of libraries) {
    if (!lib.arr) continue
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
    const deadline = Date.now() + (FEED_SECONDS * 1000) / libraries.length
    let batch = []
    let pending = 0
    // One scan call per ~100 files (movie folders hold a single file each). A title only
    // counts as fed once its files were handed to a scan the scanner was free to take.
    const flush = async () => {
      const all = batch.flatMap((b) => b.files)
      for (let i = 0; i < all.length; i += 100) {
        if (!(await scanSettled(lib.id, 600000))) {
          log(
            "feeder " + lib.name + ": scanner still busy after 10 min, stopping"
          )
          return false
        }
        await tdarr("scan-files", {
          scanConfig: {
            dbID: lib.id,
            arrayOrPath: all.slice(i, i + 100),
            mode: "scanFolderWatcher",
          },
        })
        await sleep(1500) // let the server start the scan before the next status check
      }
      for (const b of batch) {
        fed.add(b.item.path)
        log(
          "feeder " +
            lib.name +
            ": fed " +
            b.item.path +
            " (" +
            b.files.length +
            " files, " +
            b.item.gb +
            " GB, " +
            b.item.cls +
            ")"
        )
      }
      batch = []
      pending = 0
      return true
    }
    let ok = true
    let priority
    try {
      priority = await priorityList(lib, favourites)
    } catch (e) {
      log("feeder " + lib.name + ": no priority list (" + e.message + "), skipping")
      continue
    }
    for (const item of priority) {
      if (fed.has(item.path)) continue
      if (favourites.has(item.path + "/")) continue
      if (budget <= 0 || (added > 0 && item.files > budget)) break
      if (added >= MAX_SCANS_PER_RUN || Date.now() > deadline) break
      const files = (await folderFiles(lib.arr, item.path, cache)).filter(
        (f) => !skipSet.has(f)
      )
      if (files.length === 0) {
        fed.add(item.path) // nothing left to convert in this title
        continue
      }
      batch.push({ item, files })
      pending += files.length
      budget -= files.length
      added += 1
      if (pending >= 100 && !(ok = await flush())) break
    }
    if (ok && batch.length > 0) await flush()
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
