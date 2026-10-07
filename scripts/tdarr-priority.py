#!/usr/bin/env python3
"""Regenerate the Tdarr queue priority lists (priority-tv.json, priority-movies.json).

Order: titles with the most convertible bytes first; titles watched in the last 90 days
go last (so a file is never swapped under an active viewer). Favourites are excluded.
"Convertible" mirrors the flow's guard: not HDR, <=1080p, and not already HEVC at <=720p.

Run on demand (needs kubectl access to the cluster; reads Sonarr/Radarr APIs and the
Tautulli history database, which covers Plex plays only):

  scripts/tdarr-priority.py

Commit the regenerated files; the tdarr-config CronJob feeds Tdarr from them in order.
"""
import json
import pathlib
import re
import sqlite3
import subprocess
import tempfile
import time

OUT = pathlib.Path(__file__).resolve().parent.parent / "cluster/apps/media/tdarr-config/app/config"
# "HD - 720p/1080p" and "HC Any" are the take-anything fallback profiles, not favourites
FAVOURITE_PROFILES = {"HD-1080p", "HC 1080p HEVC"}
RECENT_DAYS = 90
NS = "media"


def sh(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def arr_get(app, port, endpoint):
    key = app.upper() + "__AUTH__APIKEY"
    script = 'curl -s -H "X-Api-Key: $%s" "http://localhost:%d/api/v3/%s"' % (key, port, endpoint)
    return json.loads(sh(["kubectl", "-n", NS, "exec", "deploy/" + app, "-c", "main", "--", "sh", "-c", script]))


def sonarr_episode_files(series_ids):
    loop = "for i in %s; do curl -s -H \"X-Api-Key: $SONARR__AUTH__APIKEY\" \"http://localhost:8989/api/v3/episodefile?seriesId=$i\" | jq -c '.[]|{p:.path,s:.size,m:.mediaInfo}'; done" % " ".join(map(str, series_ids))
    out = sh(["kubectl", "-n", NS, "exec", "deploy/sonarr", "-c", "main", "--", "sh", "-c", loop])
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def convertible(m):
    m = m or {}
    if m.get("videoDynamicRange"):
        return False
    res = (m.get("resolution") or "0x0").split("x")
    w = int(res[0]) if res[0].isdigit() else 0
    h = int(res[1]) if len(res) == 2 and res[1].isdigit() else 0
    if h > 1100 or w > 1930:
        return False
    codec = (m.get("videoCodec") or "").lower()
    if ("265" in codec or "hevc" in codec) and h <= 740 and w <= 1300:
        return False
    return True


def norm(title):
    t = re.sub(r"\(\d{4}\)|\[.*?\]", "", title.lower()).replace("&", "and")
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def last_played():
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        with open(tmp.name, "wb") as fh:
            fh.write(subprocess.run(["kubectl", "-n", NS, "exec", "deploy/tautulli", "-c", "app", "--", "cat", "/config/tautulli.db"],
                                    check=True, capture_output=True).stdout)
        db = sqlite3.connect(tmp.name)
        tv = {norm(t): ts for t, ts in db.execute(
            "select m.grandparent_title, max(h.started) from session_history h join session_history_metadata m on m.id = h.id where m.media_type = 'episode' group by 1")}
        mv = {norm(t): ts for t, ts in db.execute(
            "select m.title, max(h.started) from session_history h join session_history_metadata m on m.id = h.id where m.media_type = 'movie' group by 1")}
    return tv, mv


def classify(ts, now):
    if ts is None:
        return "never"
    age = (now - ts) / 86400
    return "recent" if age <= RECENT_DAYS else ("12m+" if age > 365 else "3-12m")


def write(name, items):
    items.sort(key=lambda i: (i["cls"] == "recent", -i["gb"]))
    path = OUT / name
    path.write_text(json.dumps(items, indent=2) + "\n")
    total = sum(i["gb"] for i in items)
    recent = [i for i in items if i["cls"] == "recent"]
    print("%s: %d titles, %.1f TB convertible; %d recently watched placed last (%.1f TB)" %
          (name, len(items), total / 1000, len(recent), sum(i["gb"] for i in recent) / 1000))


def main():
    now = time.time()
    tv_seen, mv_seen = last_played()

    profiles = {p["id"]: p["name"] for p in arr_get("sonarr", 8989, "qualityprofile")}
    series = arr_get("sonarr", 8989, "series")
    favourite_series = {s["path"] for s in series if profiles.get(s["qualityProfileId"]) in FAVOURITE_PROFILES}
    by_path = {s["path"].rstrip("/"): s for s in series}
    files = sonarr_episode_files([s["id"] for s in series if s.get("statistics", {}).get("sizeOnDisk", 0) > 0])
    agg = {}
    for f in files:
        show_dir = "/".join(f["p"].split("/")[:3])
        s = by_path.get(show_dir)
        if s is None or s["path"] in favourite_series or not convertible(f["m"]):
            continue
        a = agg.setdefault(show_dir, {"bytes": 0, "files": 0, "title": s["title"]})
        a["bytes"] += f["s"]
        a["files"] += 1
    items = [{"path": p, "files": a["files"], "gb": round(a["bytes"] / 1e9, 1), "cls": classify(tv_seen.get(norm(a["title"])), now)}
             for p, a in agg.items()]
    write("priority-tv.json", items)

    profiles = {p["id"]: p["name"] for p in arr_get("radarr", 7878, "qualityprofile")}
    items = []
    for m in arr_get("radarr", 7878, "movie"):
        mf = m.get("movieFile")
        if not mf or profiles.get(m["qualityProfileId"]) in FAVOURITE_PROFILES or not convertible(mf.get("mediaInfo")):
            continue
        items.append({"path": m["path"].rstrip("/"), "files": 1, "gb": round(mf["size"] / 1e9, 2),
                      "cls": classify(mv_seen.get(norm(m["title"])), now)})
    write("priority-movies.json", items)


if __name__ == "__main__":
    main()
