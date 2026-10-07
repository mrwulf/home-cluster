#!/usr/bin/env python3
"""Generate the HC Tdarr flows (flow JSON is committed; re-run this to change policy).

Policy: re-encode to HEVC (Intel QSV, 10-bit); downscale >720p to 720p (aspect preserving);
skip HDR/DV, >1080p, remux, hardlinked, favourites, and anything already HEVC at <=720p.
Strip non-English audio/subs only when an English track exists (never audio for titles
whose original language is not English). Verify duration + size before replacing, then
tell Radarr/Sonarr to rescan. Secrets are placeholders (@@ARR_HOST@@, @@ARR_API_KEY@@)
filled in by the config-sync job; never put real keys in these files.

  scripts/tdarr-flow.py            regenerate both flows into cluster/apps/media/tdarr-config
"""
import json
import pathlib
import sys

QUALITY = "21"
PRESET = "slow"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "cluster/apps/media/tdarr-config/app/config/flows"

GUARD = r"""
module.exports = async (args) => {
  const fs = require('fs');
  const file = args.inputFileObj._id;
  const streams = (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const skip = (why) => { args.jobLog('HC skip: ' + why); return { outputFileObj: args.inputFileObj, outputNumber: 3, variables: args.variables }; };
  if (!v) return skip('no video stream');
  let st = null;
  try { st = fs.statSync(file); } catch (e) { return skip('cannot stat file'); }
  if (st.nlink > 1) return skip('hardlinked (' + st.nlink + ')');
  // replaceOriginalFile will not check for an existing file at the new .mkv name: do it here
  if (!/\.mkv$/i.test(file)) {
    const target = file.replace(/\.[^./]+$/, '.mkv');
    if (fs.existsSync(target)) return skip('would overwrite existing ' + target);
  }
  // remember the source so we can refuse to replace it if Sonarr/Radarr changed it meanwhile
  args.variables.user = args.variables.user || {};
  args.variables.user.hcSize = String(st.size);
  args.variables.user.hcMtime = String(Math.floor(st.mtimeMs));
  // Favourites (kept at original quality); list written by the config-sync job
  try {
    const fav = fs.readFileSync('/temp/hc/skip-folders.txt', 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    if (fav.some((p) => file.startsWith(p))) return skip('favourite title');
  } catch (e) {}
  if (/remux/i.test(file)) return skip('remux');
  const hdr = ['smpte2084', 'arib-std-b67'].includes(v.color_transfer) ||
    (v.side_data_list || []).some((d) => /dovi|dolby|mastering|content light/i.test(d.side_data_type || ''));
  if (hdr) return skip('HDR/DV');
  const h = Number(v.height) || 0;
  const w = Number(v.width) || 0;
  if (h > 1100 || w > 1930) return skip('above 1080p (' + w + 'x' + h + ')');
  const codec = v.codec_name;
  const scale = h > 740 || w > 1300;
  if (codec === 'hevc' && !scale) return skip('already HEVC <=720p');
  // GPU can only decode these; anything else (xvid, wmv, ...) decodes in software
  const hwOk = ['h264', 'hevc', 'mpeg2video', 'vc1', 'vp9'].includes(codec);
  // Aspect-correct 720p target: width 1280 for >=16:9, height 720 for narrower
  let tw = w, th = h;
  if (scale) {
    if (w / h >= 1280 / 720) { tw = 1280; th = Math.round((1280 * h / w) / 2) * 2; }
    else { th = 720; tw = Math.round((720 * w / h) / 2) * 2; }
  }
  args.variables.user = args.variables.user || {};
  args.variables.user.hcScale = scale ? '1' : '0';
  args.variables.user.hcW = String(tw);
  args.variables.user.hcH = String(th);
  args.variables.user.hcHw = hwOk ? '1' : '0';
  args.jobLog('HC plan: ' + codec + ' ' + w + 'x' + h + ' -> ' + (scale ? tw + 'x' + th : 'same res') + ' hwdec=' + hwOk);
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
"""

LANG = r"""
module.exports = async (args) => {
  const cmd = args.variables.ffmpegCommand;
  const file = args.inputFileObj._id;
  const isEng = (s) => /^en/i.test(((s.tags && s.tags.language) || '').trim());
  const isUnd = (s) => { const l = ((s.tags && s.tags.language) || '').trim().toLowerCase(); return l === '' || l === 'und' || l === 'unk'; };
  // Titles whose original language is not English, one path prefix per line.
  // Written by the config sync job onto the shared cache volume every node mounts.
  let prefixes = [];
  try { prefixes = require('fs').readFileSync('/temp/hc/foreign-originals.txt', 'utf8').split('\n').map((x) => x.trim()).filter(Boolean); } catch (e) {}
  const foreignOriginal = prefixes.some((p) => file.startsWith(p));
  const strip = (type, label) => {
    const set = cmd.streams.filter((s) => s.codec_type === type && !s.removed);
    if (!set.some(isEng)) return;                       // no English: keep everything
    let n = 0;
    for (const s of set) {
      if (isEng(s) || isUnd(s)) continue;
      if (type === 'subtitle' && s.disposition && s.disposition.forced) continue;
      s.removed = true; n += 1;
    }
    if (n) { cmd.shouldProcess = true; args.jobLog('HC ' + label + ': removed ' + n + ' non-English stream(s)'); }
  };
  if (foreignOriginal) args.jobLog('HC audio: foreign-original title, keeping all audio');
  else strip('audio', 'audio');
  strip('subtitle', 'subs');
  // drop attachments/data (fonts, cover art): tiny, but they bloat track lists
  for (const s of cmd.streams) {
    if (s.codec_type === 'attachment' || s.codec_type === 'data') { s.removed = true; cmd.shouldProcess = true; }
  }
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
"""

ROUTE = r"""
module.exports = async (args) => ({
  outputFileObj: args.inputFileObj,
  outputNumber: ((args.variables.user || {}).hcHw === '1') ? 1 : 2,
  variables: args.variables,
});
"""

SCALE = r"""
module.exports = async (args) => {
  const cmd = args.variables.ffmpegCommand;
  const u = args.variables.user || {};
  if (u.hcScale !== '1') return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
  const w = u.hcW, h = u.hcH;
  const hw = u.hcHw === '1';
  for (const s of cmd.streams) {
    if (s.codec_type !== 'video' || s.removed) continue;
    if (s.disposition && s.disposition.attached_pic) continue;
    // ffmpeg honours only ONE -vf, and the 10-bit step already added its own: merge, don't stack
    const i = s.outputArgs.indexOf('-vf');
    const prev = i >= 0 ? String(s.outputArgs[i + 1]) : '';
    if (hw) {
      const m = /format=([a-z0-9]+)/.exec(prev);
      if (i >= 0) s.outputArgs.splice(i, 2);
      s.outputArgs.push('-vf', 'vpp_qsv=w=' + w + ':h=' + h + (m ? ':format=' + m[1] : ''));
    } else if (i >= 0) {
      s.outputArgs[i + 1] = 'scale=' + w + ':' + h + ':flags=lanczos,' + prev;
    } else {
      s.outputArgs.push('-vf', 'scale=' + w + ':' + h + ':flags=lanczos');
    }
  }
  cmd.shouldProcess = true;
  args.jobLog('HC scale ' + (hw ? 'vpp_qsv' : 'sw') + ' ' + w + 'x' + h);
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
"""


UNCHANGED = r"""
module.exports = async (args) => {
  const fs = require('fs');
  const u = args.variables.user || {};
  let ok = false;
  try {
    const st = fs.statSync(args.originalLibraryFile._id);
    ok = String(st.size) === u.hcSize && String(Math.floor(st.mtimeMs)) === u.hcMtime;
  } catch (e) {}
  args.jobLog(ok ? 'HC source unchanged, safe to replace' : 'HC source changed or missing since the encode started: not replacing');
  return { outputFileObj: args.inputFileObj, outputNumber: ok ? 1 : 2, variables: args.variables };
};
"""


def build(flow_id, name, arr):
    nodes, edges = [], []

    def node(nid, plugin, label, inputs=None, x=0, y=0):
        nodes.append({"name": label, "sourceRepo": "Community", "pluginName": plugin, "version": "1.0.0",
                      "id": nid, "position": {"x": x, "y": y}, "inputsDB": inputs or {}})

    def edge(src, dst, out="1"):
        edges.append({"source": src, "sourceHandle": out, "target": dst, "targetHandle": None, "id": "e%d" % (len(edges) + 1)})

    def enc(hw):
        return {"outputCodec": "hevc", "ffmpegPresetEnabled": "true", "ffmpegPreset": PRESET,
                "ffmpegQualityEnabled": "true", "ffmpegQuality": QUALITY, "hardwareEncoding": "true",
                "hardwareType": "qsv", "hardwareDecoding": hw, "forceEncoding": "true"}

    node("in", "inputFile", "Input", x=400, y=0)
    node("guard", "customFunction", "Guard: skip rules + plan", {"code": GUARD}, 400, 100)
    node("skipnote", "comment", "Skipped (no change)", {}, 800, 100)
    node("start", "ffmpegCommandStart", "Begin ffmpeg command", x=400, y=200)
    node("lang", "customFunction", "Language strip", {"code": LANG}, 400, 300)
    node("route", "customFunction", "Route hw/sw decode", {"code": ROUTE}, 400, 400)
    node("enc_hw", "ffmpegCommandSetVideoEncoder", "HEVC QSV (hw decode)", enc("true"), 200, 500)
    node("enc_sw", "ffmpegCommandSetVideoEncoder", "HEVC QSV (sw decode)", enc("false"), 600, 500)
    node("ten", "ffmpegCommand10BitVideo", "10-bit", x=400, y=600)
    node("scale", "customFunction", "Aspect-correct 720p scale", {"code": SCALE}, 400, 700)
    node("cont", "ffmpegCommandSetContainer", "MKV", {"container": "mkv", "forceConform": "false"}, 400, 800)
    node("exec", "ffmpegCommandExecute", "Run ffmpeg", x=400, y=900)
    node("dur", "compareFileDurationRatio", "Duration within 1%", {"greaterThan": "99", "lessThan": "101"}, 400, 1000)
    node("size", "compareFileSizeRatio", "Size 10-100% of original", {"greaterThan": "10", "lessThan": "100"}, 400, 1100)
    node("review", "requireReview", "Needs review (original untouched)", {}, 800, 1050)
    node("unchanged", "customFunction", "Source unchanged since start?", {"code": UNCHANGED}, 400, 1150)
    node("replace", "replaceOriginalFile", "Replace original", x=400, y=1200)
    node("notify", "notifyRadarrOrSonarr", "Notify " + arr,
         {"arr": arr, "arr_api_key": "@@ARR_API_KEY@@", "arr_host": "@@ARR_HOST@@"}, 400, 1300)

    edge("in", "guard")
    edge("guard", "start", "1")
    edge("guard", "skipnote", "3")
    edge("start", "lang")
    edge("lang", "route")
    edge("route", "enc_hw", "1")
    edge("route", "enc_sw", "2")
    edge("enc_hw", "ten")
    edge("enc_sw", "ten")
    edge("ten", "scale")
    edge("scale", "cont")
    edge("cont", "exec")
    edge("exec", "dur")
    edge("dur", "size", "1")
    edge("dur", "review", "2")
    edge("dur", "review", "3")
    edge("size", "unchanged", "1")
    edge("size", "review", "2")
    edge("unchanged", "replace", "1")
    edge("unchanged", "review", "2")
    edge("replace", "notify")
    return {"_id": flow_id, "name": name, "description": "HEVC QSV, 720p cap, language strip, safety checks; notifies " + arr,
            "tags": "", "flowPlugins": nodes, "flowEdges": edges}


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for flow_id, name, arr, fname in (("hcTv", "HC compact HEVC 720p (TV)", "sonarr", "hc-tv.json"),
                                      ("hcMovies", "HC compact HEVC 720p (Movies)", "radarr", "hc-movies.json")):
        path = OUT_DIR / fname
        json.dump(build(flow_id, name, arr), open(path, "w"), indent=2)
        print("wrote", path.relative_to(OUT_DIR.parent.parent.parent.parent.parent.parent))
