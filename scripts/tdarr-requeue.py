#!/usr/bin/env python3
"""List or requeue Tdarr files that ended in an error state (corrupt file, failed safety check,
interrupted job that did not restart, ...).

  scripts/tdarr-requeue.py                       list errored files in all libraries
  scripts/tdarr-requeue.py --library TV          only the library named TV
  scripts/tdarr-requeue.py --requeue             put them back in the queue (originals are untouched
                                                 by failed jobs, so this is safe to repeat)

A file that fails again for the same reason (for example a genuinely corrupt file) will just error
again: look at its job report in the Tdarr UI before requeueing it in a loop.
Needs kubectl access. Errors are read a page at a time from the queue UI's error table, so this is cheap on a large library.
"""
import argparse
import base64
import json
import subprocess

NS = "media"


def kube(script):
    return subprocess.run(["kubectl", "-n", NS, "exec", "deploy/tdarr-server", "-c", "main", "--", "sh", "-c", script],
                          check=True, capture_output=True, text=True).stdout


def api(endpoint, data):
    body = base64.b64encode(json.dumps({"data": data}).encode()).decode()
    return kube("echo %s | base64 -d | curl -s -m 300 -X POST -H 'Content-Type: application/json' --data @- http://localhost:8265/api/v2/%s" % (body, endpoint))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", help="library name (default: all)")
    ap.add_argument("--requeue", action="store_true", help="requeue instead of just listing")
    args = ap.parse_args()

    libs = {l["_id"]: l["name"] for l in json.loads(api("cruddb", {"collection": "LibrarySettingsJSONDB", "mode": "getAll"}))}
    if args.library:
        libs = {k: v for k, v in libs.items() if v == args.library}
        if not libs:
            raise SystemExit("no library named %s" % args.library)
    # The error list is table3 of the queue UI. Read it a page at a time: a full-table read
    # (cruddb getAll of FileJSONDB, ~45k rows) OOM-kills the 2Gi tdarr-server container.
    found = []
    while True:
        page = json.loads(api("client/status-tables", {"start": len(found), "pageSize": 100, "filters": [],
                                                       "sorts": [], "opts": {"table": "table3"}}))
        rows = page["array"]
        found += [{"id": r["_id"], "db": r["DB"]} for r in rows]
        if not rows or len(found) >= page["totalCount"]:
            break
    found = [f for f in found if f["db"] in libs]
    print("%d errored file(s)" % len(found))
    for f in found[:50]:
        print("  [%s] %s" % (libs[f["db"]], f["id"]))
    if len(found) > 50:
        print("  ... %d more" % (len(found) - 50))
    if args.requeue:
        for f in found:
            api("cruddb", {"collection": "FileJSONDB", "mode": "update", "docID": f["id"], "obj": {"TranscodeDecisionMaker": "Queued"}})
        print("requeued %d file(s)" % len(found))


if __name__ == "__main__":
    main()
