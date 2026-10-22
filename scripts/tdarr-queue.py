#!/usr/bin/env python3
"""Add a show or movie to the Tdarr queue and change its priority.

  scripts/tdarr-queue.py status [TITLE]        queue counts, or one title's files by state
  scripts/tdarr-queue.py add TITLE [--bump]    queue every convertible file of a new show/movie
  scripts/tdarr-queue.py bump TITLE            move the title's queued files to the front
  scripts/tdarr-queue.py deprioritize TITLE    move them behind everything else
  scripts/tdarr-queue.py reset TITLE           back to normal queue order

TITLE is a case-insensitive substring of the Sonarr/Radarr title; if it matches more than one title the
script lists them and stops (use a longer string, or --all). --library TV|Movies narrows the search.

`add` is for titles Tdarr does not know yet (a fresh download: the libraries do not watch folders and the
backlog feeder only follows priority-*.json). It applies the same rules as the feeder: convertible files
only, no favourites, nothing in no-savings.txt, nothing Tdarr already has. `bump`, `deprioritize` and
`reset` only touch files that are still Queued, never finished or errored ones.

Priority is Tdarr's per-file `bumped` field (the UI's Bump / Deprioritize / Reset buttons); it needs
"Enable bumped files" on in the queue options, which is the live setting. Bumped files run ahead of the
rest of the queue. The order among several bumped titles is Tdarr's own and has not been verified here.

Needs kubectl access. Tdarr calls run inside the tdarr-server pod, a page at a time: never read the whole
file table in one call (about 45k rows, enough to OOM-kill the 2Gi server container).
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time

NS = "media"
CONFIG = pathlib.Path(__file__).resolve().parent.parent / "cluster/apps/media/tdarr-config/app/config"
STATE = "/temp/hc"  # shared cache volume, written by the tdarr-config job
BATCH = 100  # files per scan-files call, same as the feeder

# Runs in the tdarr-server pod: reads [{e: endpoint, d: data, pick: [keys]}] on stdin, prints the results.
NODE = r"""
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", async () => {
  const out = []
  for (const r of JSON.parse(s)) {
    const res = await fetch("http://localhost:8265/api/v2/" + r.e, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: r.d }),
    })
    const text = await res.text()
    let v = text
    try { v = JSON.parse(text) } catch (e) {}
    if (r.pick && v && typeof v === "object")
      v = Object.fromEntries(r.pick.map((k) => [k, v[k]]))
    out.push(v)
  }
  console.log(JSON.stringify(out))
})
"""


def kube(deploy, container, argv, stdin=None):
    return subprocess.run(["kubectl", "-n", NS, "exec", "-i", "deploy/" + deploy, "-c", container, "--"] + argv,
                          input=stdin, check=True, capture_output=True, text=True).stdout


def tdarr(calls):
    """calls: [(endpoint, data) or (endpoint, data, pick)]; returns the parsed responses in order."""
    reqs = [{"e": c[0], "d": c[1], "pick": c[2] if len(c) > 2 else None} for c in calls]
    return json.loads(kube("tdarr-server", "main", ["node", "-e", NODE], json.dumps(reqs)))


def arr_get(app, port, endpoint):
    key = app.upper() + "__AUTH__APIKEY"
    script = 'curl -s -H "X-Api-Key: $%s" "http://localhost:%d/api/v3/%s"' % (key, port, endpoint)
    return json.loads(kube(app, "main", ["sh", "-c", script]))


def pod_lines(name):
    try:
        return set(kube("tdarr-server", "main", ["cat", STATE + "/" + name]).split("\n")) - {""}
    except subprocess.CalledProcessError:
        return set()


def convertible(m):
    """Mirrors the flow's guard (and the feeder's `convertible` in sync.js): not HDR, <=1080p, not HEVC at <=720p."""
    m = m or {}
    if m.get("videoDynamicRange"):
        return False
    res = (m.get("resolution") or "0x0").split("x")
    w = int(res[0]) if res[0].isdigit() else 0
    h = int(res[1]) if len(res) == 2 and res[1].isdigit() else 0
    if h > 1100 or w > 1930:
        return False
    codec = (m.get("videoCodec") or "").lower()
    return not (("265" in codec or "hevc" in codec) and h <= 740 and w <= 1300)


def label(item):
    """Title with its year, unless Sonarr/Radarr already put the year in the title."""
    t = item["title"]
    return t if t.endswith(")") else "%s (%s)" % (t, item.get("year"))


def find_titles(query, libraries, take_all):
    """Matching titles as {library, title, path, files: [(path, mediaInfo)]}."""
    q = query.lower()
    found = []
    for lib in libraries:
        items = arr_get("sonarr", 8989, "series") if lib["arr"] == "sonarr" else arr_get("radarr", 7878, "movie")
        hits = [i for i in items if q in label(i).lower()]
        for h in hits:
            found.append({"library": lib, "title": label(h), "raw": h})
    exact = [f for f in found if q in (f["raw"]["title"].lower(), f["title"].lower())]
    if len(found) > 1 and not take_all:
        if len(exact) == 1:
            return exact
        print("%d titles match %r, be more specific (or pass --all):" % (len(found), query))
        for f in found[:20]:
            print("  [%s] %s" % (f["library"]["name"], f["title"]))
        if len(found) > 20:
            print("  ... %d more" % (len(found) - 20))
        sys.exit(2)
    if not found:
        sys.exit("no Sonarr/Radarr title matches %r" % query)
    return found


def title_files(t):
    """All files Sonarr/Radarr has for the title, as (path, mediaInfo)."""
    raw = t["raw"]
    if t["library"]["arr"] == "sonarr":
        files = arr_get("sonarr", 8989, "episodefile?seriesId=%d" % raw["id"])
        return [(f["path"], f.get("mediaInfo")) for f in files]
    mf = raw.get("movieFile")
    return [(mf["path"], mf.get("mediaInfo"))] if mf else []


def file_states(paths):
    """Tdarr's view of each path: None if it does not know the file, else its decision and bump value."""
    rows = tdarr([("cruddb", {"collection": "FileJSONDB", "mode": "getById", "docID": p},
                   ["TranscodeDecisionMaker", "bumped"]) for p in paths]) if paths else []
    return {p: (r if r and r.get("TranscodeDecisionMaker") is not None else None) for p, r in zip(paths, rows)}


def wait_scanner(lib_id, timeout=600):
    """The API answers OK to a scan it then drops while another runs, so wait for an idle scanner."""
    last, t0 = "", time.time()
    while time.time() - t0 < timeout:
        st = str(tdarr([("get-filescanner-status", {"dbID": lib_id})])[0]).split("Scanner mem:")[0].strip()
        done = True
        if "Extracting info:" in st:
            i, n = st.split("Extracting info:")[1].split("/")[:2]
            done = i.strip() == n.split()[0]
        if done and st == last:
            return
        last = st
        time.sleep(1)
    sys.exit("scanner for %s still busy after %d s" % (lib_id, timeout))


def set_bumped(paths, value):
    tdarr([("cruddb", {"collection": "FileJSONDB", "mode": "update", "docID": p, "obj": {"bumped": value}})
           for p in paths])


def cmd_status(args):
    libs = [l for l in json.load(open(CONFIG / "libraries.json")) if not args.library or l["name"] == args.library]
    if not args.title:
        pies = tdarr([("stats/get-pies", {"libraryId": l["id"]}) for l in libs])
        for lib, p in zip(libs, pies):
            counts = {s["name"]: s["value"] for s in p["pieStats"]["status"]["transcode"]}
            print("%-7s %s" % (lib["name"], ", ".join("%s %d" % kv for kv in sorted(counts.items())) or "no stats yet (Tdarr rebuilds them after a restart)"))
        return
    for t in find_titles(args.title, libs, args.all):
        states = file_states([p for p, _ in title_files(t)])
        tally = {}
        for st in states.values():
            key = "not in Tdarr" if st is None else st["TranscodeDecisionMaker"]
            if st is not None and st["bumped"] not in (False, None):
                key += " (bumped)" if st["bumped"] != -1 else " (deprioritized)"
            tally[key] = tally.get(key, 0) + 1
        print("[%s] %s: %s" % (t["library"]["name"], t["title"], ", ".join("%s %d" % kv for kv in sorted(tally.items()))))


def cmd_add(args):
    libs = [l for l in json.load(open(CONFIG / "libraries.json")) if not args.library or l["name"] == args.library]
    skip = pod_lines("skip-folders.txt")
    no_savings = pod_lines("no-savings.txt")
    for t in find_titles(args.title, libs, args.all):
        lib = t["library"]
        folder = t["raw"]["path"].rstrip("/") + "/"
        if folder in skip:
            print("[%s] %s: favourite profile, never transcoded" % (lib["name"], t["title"]))
            continue
        files = [p for p, m in title_files(t) if convertible(m) and p not in no_savings]
        known = {p for p, st in file_states(files).items() if st is not None}
        todo = [p for p in files if p not in known]
        print("[%s] %s: %d convertible, %d already in Tdarr, %d to add" % (lib["name"], t["title"], len(files), len(known), len(todo)))
        for i in range(0, len(todo), BATCH):
            wait_scanner(lib["id"])
            tdarr([("scan-files", {"scanConfig": {"dbID": lib["id"], "arrayOrPath": todo[i:i + BATCH], "mode": "scanFolderWatcher"}})])
            time.sleep(1.5)  # let the server start the scan before the next status check
        if todo:
            wait_scanner(lib["id"])
            added = [p for p, st in file_states(todo).items() if st is not None]
            print("  added %d of %d (the rest were skipped by the scanner or are still extracting)" % (len(added), len(todo)))
        if args.bump:
            bump(lib, files, int(time.time() * 1000), t["title"])


def bump(lib, files, value, title):
    queued = [p for p, st in file_states(files).items() if st is not None and st["TranscodeDecisionMaker"] == "Queued"]
    set_bumped(queued, value)
    print("  [%s] %s: set %d queued file(s) to %s" % (lib["name"], title, len(queued), {False: "normal order", -1: "last"}.get(value, "front")))


def cmd_set(args):
    libs = [l for l in json.load(open(CONFIG / "libraries.json")) if not args.library or l["name"] == args.library]
    value = {"bump": int(time.time() * 1000), "deprioritize": -1, "reset": False}[args.cmd]
    for t in find_titles(args.title, libs, args.all):
        bump(t["library"], [p for p, _ in title_files(t)], value, t["title"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("status", "add", "bump", "deprioritize", "reset"):
        p = sub.add_parser(name)
        p.add_argument("title", nargs="?" if name == "status" else None)
        p.add_argument("--library", choices=["TV", "Movies"])
        p.add_argument("--all", action="store_true", help="act on every title that matches")
        if name == "add":
            p.add_argument("--bump", action="store_true", help="also move the new files to the front of the queue")
    args = ap.parse_args()
    {"status": cmd_status, "add": cmd_add}.get(args.cmd, cmd_set)(args)


if __name__ == "__main__":
    main()
