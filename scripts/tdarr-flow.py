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
  // Files an earlier attempt could not make smaller (written by the size check)
  try {
    if (fs.readFileSync('/temp/hc/no-savings.txt', 'utf8').split('\n').includes(file)) return skip('no savings on an earlier attempt');
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
  // Keyframe every ~5 s (hevc_qsv defaults to 250 frames: 10 s at 24 fps, which slows seeking and resume)
  const fr = String(v.avg_frame_rate || v.r_frame_rate || '').split('/');
  const fps = Number(fr[0]) / (Number(fr[1]) || 1);
  args.variables.user.hcGop = String(Math.round((fps > 0 && fps < 121 ? fps : 24) * 5));
  // Some MP4s report a bogus container rate (240 fps) next to a sane average (23.97). hevc_qsv refuses
  // to open at 240 fps, so pin the output to the average rate (the usual NTSC fractions kept exact).
  const rr = String(v.r_frame_rate || '').split('/');
  const rfps = Number(rr[0]) / (Number(rr[1]) || 1);
  if (rfps > 120 && fps > 0 && fps < 121) {
    const ntsc = [24000, 30000, 60000].find((n) => Math.abs(fps - n / 1001) < 0.02);
    args.variables.user.hcRate = ntsc ? ntsc + '/1001' : String(Math.round(fps * 1000) / 1000);
    args.jobLog('HC rate: container reports ' + rfps + ' fps, encoding at ' + args.variables.user.hcRate);
  }
  args.jobLog('HC plan: ' + codec + ' ' + w + 'x' + h + ' -> ' + (scale ? tw + 'x' + th : 'same res') + ' hwdec=' + hwOk + ' gop=' + args.variables.user.hcGop);
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
"""

LANG = r"""
module.exports = async (args) => {
  const cmd = args.variables.ffmpegCommand;
  // No -xerror: it aborts on harmless source glitches (a Bluray rip failed with a mux error under it
  // but encodes cleanly without). The duration and size checks still catch truncated output.
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
  // mov_text (MP4 text subtitles) cannot be stream-copied into Matroska: ffmpeg fails writing the header
  // ("Function not implemented", reported against the video filter). Convert them to SRT instead.
  for (const s of cmd.streams) {
    if (s.codec_type === 'subtitle' && !s.removed && String(s.codec_name).toLowerCase() === 'mov_text') {
      if (!s.outputArgs.includes('-c:{outputIndex}')) s.outputArgs.push('-c:{outputIndex}', 'srt');
      cmd.shouldProcess = true;
      args.jobLog('HC subs: converting mov_text to srt');
    }
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
  const gop = String(Number(u.hcGop) || 120);
  for (const s of cmd.streams) {
    if (s.codec_type !== 'video' || s.removed) continue;
    if (s.disposition && s.disposition.attached_pic) continue;
    if (!s.outputArgs.includes('-g')) s.outputArgs.push('-g', gop);
    if (u.hcRate && !s.outputArgs.includes('-r')) s.outputArgs.push('-r', u.hcRate);
  }
  cmd.shouldProcess = true;
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


# Sample probe, after the encoder args are built and before the real encode. Encodes two short
# slices with exactly the video args the flow will use, measures the same slices stream-copied, and
# projects the whole-file result. Compact sources (the encoder would not make them 10% smaller) are
# skipped here in about 15 seconds instead of after a full encode. Output 1: encode for real. Output 3: skip.
# Any trouble running the probe falls through to the real encode, so it can only save work.
PROBE = r"""
module.exports = async (args) => {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const go = (why) => { args.jobLog('HC probe: ' + why); return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables }; };
  const u = args.variables.user || {};
  const cmd = args.variables.ffmpegCommand;
  const file = args.inputFileObj._id;
  const fmt = (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) || {};
  const dur = Number(fmt.duration) || Number(args.inputFileObj.meta && args.inputFileObj.meta.Duration) || 0;
  const size = Number(u.hcSize) || 0;
  const SAMPLE = 30;
  if (u.hcHw !== '1') return go('software decode path, encoding without a sample');
  if (dur < 300 || !size) return go('too short to sample, encoding');
  const vs = cmd && cmd.streams.find((s) => s.codec_type === 'video' && !s.removed && !(s.disposition && s.disposition.attached_pic));
  if (!vs || !Array.isArray(vs.outputArgs)) return go('no video args to sample, encoding');
  const vargs = vs.outputArgs.map((a) => String(a).replace(/\{outputIndex\}/g, '0').replace(/\{outputTypeIndex\}/g, '0'));
  const ffmpeg = args.ffmpegPath || 'tdarr-ffmpeg';
  const tmp = path.join(args.workDir || '/temp', 'hcprobe-' + Date.now());
  // run one slice; returns { bytes, secs } or null on any failure
  const run = (start, pre, post, name) => {
    const out = path.join(tmp, name + '.mkv');
    const r = spawnSync(ffmpeg, ['-y', '-nostdin', '-hide_banner', ...pre, '-ss', String(Math.round(start)), '-t', String(SAMPLE),
      '-i', file, '-map', '0:' + vs.index, ...post, '-f', 'matroska', out], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) return null;
    const t = [...String(r.stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
    if (!t) return null;
    const secs = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    let bytes = 0;
    try { bytes = fs.statSync(out).size; } catch (e) { return null; }
    return secs >= 10 && bytes > 0 ? { bytes, secs } : null;
  };
  let src = 0, srcS = 0, enc = 0, encS = 0;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const p of [0.35, 0.7]) {
      const start = Math.max(0, dur * p - SAMPLE / 2);
      const c = run(start, [], ['-c', 'copy'], 'copy');
      const e = c && run(start, ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'], vargs, 'enc');
      if (!c || !e) return go('sample failed, encoding');
      src += c.bytes; srcS += c.secs; enc += e.bytes; encS += e.secs;
    }
  } catch (e) {
    return go('sample error (' + e.message + '), encoding');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  const srcBps = src * 8 / srcS, encBps = enc * 8 / encS;
  // whole-file projection: audio and subtitles are copied, only the video stream changes
  const projected = (size - (srcBps - encBps) * dur / 8) / size;
  args.jobLog('HC probe: video ' + Math.round(srcBps / 1000) + ' -> ' + Math.round(encBps / 1000) + ' kbps, projected file ' + (projected * 100).toFixed(0) + '% of original');
  // Skip unless at least 10% is expected: the final check only needs 5%, but a sample is good to about
  // +-3%, and a 5 to 9% saving is not worth the generation loss and GPU time
  if (projected >= 0.9) {
    try { fs.appendFileSync('/temp/hc/no-savings.txt', file + '\n'); } catch (e) {}
    args.jobLog('HC skip: sample says this would not be at least 10% smaller');
    return { outputFileObj: args.inputFileObj, outputNumber: 3, variables: args.variables };
  }
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
"""


UNCHANGED = r"""
module.exports = async (args) => {
  const fs = require('fs');
  const u = (args.variables.user = args.variables.user || {});
  // from here on the original may be replaced, so an error handler must never re-encode
  u.hcPast = '1';
  let ok = false;
  try {
    const st = fs.statSync(args.originalLibraryFile._id);
    ok = String(st.size) === u.hcSize && String(Math.floor(st.mtimeMs)) === u.hcMtime;
  } catch (e) {}
  args.jobLog(ok ? 'HC source unchanged, safe to replace' : 'HC source changed or missing since the encode started: not replacing');
  return { outputFileObj: args.inputFileObj, outputNumber: ok ? 1 : 2, variables: args.variables };
};
"""


# Error handler gate. 1: encode failed before the replace step and has not been retried: retry
# once in software (decode + scale on the CPU, encode still on the GPU). 2: the failure came after
# the replace step (for example the arr notify): the file is already converted, so just clear
# the error. 3: the retry also failed: fail for real (original untouched).
RETRY = r"""
module.exports = async (args) => {
  const u = (args.variables.user = args.variables.user || {});
  let out = 1;
  if (u.hcPast === '1') out = 2;
  else if (u.hcRetried === '1') out = 3;
  else { u.hcRetried = '1'; u.hcHw = '0'; }
  args.jobLog(['HC first attempt failed: retrying once with software decode and scaling', 'HC failure after the replace step: clearing the error (file already converted)', 'HC retry also failed: giving up, original untouched'][out - 1]);
  return { outputFileObj: args.inputFileObj, outputNumber: out, variables: args.variables };
};
"""


SIZE = r"""
module.exports = async (args) => {
  const out = Number(args.inputFileObj.file_size) || 0;
  const orig = Number((args.originalLibraryFile || {}).file_size) || 0;
  const pct = orig ? (out / orig) * 100 : 0;
  args.jobLog('HC size: ' + out.toFixed(1) + ' MB vs original ' + orig.toFixed(1) + ' MB (' + pct.toFixed(0) + '%)');
  if (pct >= 95) {
    // Already compact (low-bitrate sources can grow): not worth a generation loss. Keep the original,
    // finish without an error, and remember the path so it is never encoded or fed again.
    try { require('fs').appendFileSync('/temp/hc/no-savings.txt', args.originalLibraryFile._id + '\n'); } catch (e) {}
    args.jobLog('HC: output is not at least 5% smaller, keeping the original');
    return { outputFileObj: args.originalLibraryFile, outputNumber: 3, variables: args.variables };
  }
  // below 5% means something went wrong (the duration check already catches truncation): needs review.
  // 10% was too high: a 4.6 GB WEB-DL legitimately encodes to under 10%.
  return { outputFileObj: args.inputFileObj, outputNumber: pct < 5 ? 2 : 1, variables: args.variables };
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
    node("scale", "customFunction", "Scale to 720p + keyframe interval", {"code": SCALE}, 400, 700)
    node("probe", "customFunction", "Sample probe: would it shrink?", {"code": PROBE}, 400, 750)
    node("cont", "ffmpegCommandSetContainer", "MKV", {"container": "mkv", "forceConform": "false"}, 400, 800)
    node("exec", "ffmpegCommandExecute", "Run ffmpeg", x=400, y=900)
    node("dur", "compareFileDurationRatio", "Duration within 1%", {"greaterThan": "99", "lessThan": "101"}, 400, 1000)
    node("size", "customFunction", "Size check (at least 5% smaller)", {"code": SIZE}, 400, 1100)
    node("nosavings", "comment", "Not smaller: original kept", {}, 800, 1100)
    node("review", "requireReview", "Needs review (original untouched)", {}, 800, 1050)
    node("unchanged", "customFunction", "Source unchanged since start?", {"code": UNCHANGED}, 400, 1150)
    node("replace", "replaceOriginalFile", "Replace original", x=400, y=1200)
    node("notify", "notifyRadarrOrSonarr", "Notify " + arr,
         {"arr": arr, "arr_api_key": "@@ARR_API_KEY@@", "arr_host": "@@ARR_HOST@@"}, 400, 1300)

    # Error branch: second attempt entirely in software decode/scale, rejoining at the checks
    node("onerr", "onFlowError", "On error", {}, 1200, 100)
    node("gate", "customFunction", "Retry gate", {"code": RETRY}, 1200, 200)
    node("reset1", "resetFlowError", "Clear error (retrying)", {}, 1100, 300)
    node("reset2", "resetFlowError", "Clear error (already converted)", {}, 1400, 300)
    node("giveup", "failFlow", "Give up", {}, 1700, 300)
    node("start2", "ffmpegCommandStart", "Begin ffmpeg command (retry)", x=1100, y=400)
    node("lang2", "customFunction", "Language strip (retry)", {"code": LANG}, 1100, 500)
    node("enc2", "ffmpegCommandSetVideoEncoder", "HEVC QSV (sw decode, retry)", enc("false"), 1100, 600)
    node("ten2", "ffmpegCommand10BitVideo", "10-bit (retry)", x=1100, y=700)
    node("scale2", "customFunction", "Scale to 720p + keyframe interval (retry)", {"code": SCALE}, 1100, 800)
    node("cont2", "ffmpegCommandSetContainer", "MKV (retry)", {"container": "mkv", "forceConform": "false"}, 1100, 900)
    node("exec2", "ffmpegCommandExecute", "Run ffmpeg (retry)", x=1100, y=1000)

    edge("onerr", "gate")
    edge("gate", "reset1", "1")
    edge("gate", "reset2", "2")
    edge("gate", "giveup", "3")
    edge("reset1", "start2")
    edge("start2", "lang2")
    edge("lang2", "enc2")
    edge("enc2", "ten2")
    edge("ten2", "scale2")
    edge("scale2", "cont2")
    edge("cont2", "exec2")
    edge("exec2", "dur")

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
    edge("scale", "probe")
    edge("probe", "cont", "1")
    edge("probe", "skipnote", "3")
    edge("cont", "exec")
    edge("exec", "dur")
    edge("dur", "size", "1")
    edge("dur", "review", "2")
    edge("dur", "review", "3")
    edge("size", "unchanged", "1")
    edge("size", "review", "2")
    edge("size", "nosavings", "3")
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
        with open(path, "w") as out:
            json.dump(build(flow_id, name, arr), out, indent=2)
            out.write("\n")
        print("wrote", path.relative_to(OUT_DIR.parent.parent.parent.parent.parent.parent))
