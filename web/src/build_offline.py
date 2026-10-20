#!/usr/bin/env python3
"""Build one self-contained offline mixer page per song.

    python3 build_offline.py --stems DIR --title "..." --out-html song-a.html \
        [--bitrate 96] [--probe 96,128] [--metrics metrics.json]

Reads the stems in place (never copies the WAVs), measures them, derives the
presets and the -16 LUFS trims, encodes the present stems to MP3, base64s the
payloads into the page and writes one HTML file. Nothing is fetched at runtime.

The manifest schema is the a6 one, with window = the whole song.
"""
import argparse, base64, html, io, json, os, re, shutil, subprocess, sys, time
import numpy as np
import soundfile as sf

PRIORITY = ["drums", "bass", "piano", "guitar", "vocals", "other"]
THRESHOLD = -45.0
EMPHASIS = {"featured_db": 9.0, "others_db": -6.0, "limiter_ceiling_dbtp": -1.0}
TARGET_LUFS = -16.0
SOLO_LUFS = -18.0
# A preset is only allowed to be loud if it still fits under the page's
# limiter ceiling.  The guard is a measurement margin: ffmpeg prints true
# peak to 0.1 dB, and the encoded MP3 mix is measured separately below.
PEAK_CEILING_DBFS = EMPHASIS["limiter_ceiling_dbtp"]
PEAK_GUARD_DB = 0.2
SRC = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(SRC, "template.html")
SCRIPT = os.path.join(SRC, "mixer.es5.js")


def db(x):
    return 20.0 * np.log10(max(float(x), 1e-12))


def measure(path):
    """Whole-file RMS / peak in one streaming pass. No copy, no load."""
    info = sf.info(path)
    acc = 0.0
    n = 0
    peak = 0.0
    for block in sf.blocks(path, blocksize=1 << 20, dtype="float32", always_2d=True):
        b = block.astype(np.float64)
        acc += float(np.sum(b * b))
        n += b.size
        peak = max(peak, float(np.max(np.abs(b))))
    return {"sr": info.samplerate, "channels": info.channels,
            "frames": info.frames, "dur": info.frames / info.samplerate,
            "rms_db": db(np.sqrt(acc / max(n, 1))), "peak_db": db(peak)}


def ff_loudness(files, gains=None, master_db=0.0):
    """Integrated LUFS + true peak of a sum of files, via ffmpeg ebur128.

    gains is a list of dB values, one per file, or None for a single file.
    master_db is the page's whole-mix preset trim, applied after the sum.
    amix normalize=0 is an exact sum, so this is the same arithmetic the page
    does with its GainNodes.
    """
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-v", "info"]
    for f in files:
        cmd += ["-i", f]
    post = ",volume=%.3fdB" % master_db if master_db else ""
    if gains is None or len(files) == 1:
        graph = "volume=%.3fdB,ebur128=peak=true" % master_db if master_db else "ebur128=peak=true"
    else:
        parts = []
        labels = ""
        for i, g in enumerate(gains):
            parts.append("[%d:a]volume=%.3fdB[v%d]" % (i, g, i))
            labels += "[v%d]" % i
        parts.append(labels + "amix=inputs=%d:normalize=0%s,ebur128=peak=true"
                     % (len(files), post))
        graph = ";".join(parts)
    cmd += ["-filter_complex", graph, "-f", "null", "-"]
    p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       text=True, timeout=1800)
    err = p.stderr
    mi = re.search(r"Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?) LUFS", err)
    mt = re.search(r"True peak:\s*\n\s*Peak:\s*(-?\d+(?:\.\d+)?) dBFS", err)
    if not mi or not mt:
        raise SystemExit("could not parse ebur128 for %s\n%s" % (files, err[-3000:]))
    return float(mi.group(1)), float(mt.group(1))


def encode(src, dst, kbps):
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return os.path.getsize(dst)
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", "-i", src,
           "-map_metadata", "-1", "-id3v2_version", "0", "-write_id3v1", "0",
           "-c:a", "libmp3lame", "-b:a", "%dk" % kbps, "-ar", "44100", "-ac", "2", dst]
    subprocess.run(cmd, check=True, timeout=1800)
    return os.path.getsize(dst)


def b64_chunks(data, chunk=96000):
    s = base64.b64encode(data).decode("ascii")
    return [s[i:i + chunk] for i in range(0, len(s), chunk)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stems", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--out-html", required=True)
    ap.add_argument("--bitrate", type=int, default=96)
    ap.add_argument("--probe", default="96,128")
    ap.add_argument("--metrics", default=None)
    ap.add_argument("--source", default=None)
    ap.add_argument("--work", default=None)
    a = ap.parse_args()

    files = sorted(f for f in os.listdir(a.stems) if f.lower().endswith(".wav"))
    if not files:
        raise SystemExit("no wav stems in " + a.stems)

    def rank(f):
        sid = os.path.splitext(f)[0].lower()
        return PRIORITY.index(sid) if sid in PRIORITY else len(PRIORITY)

    files.sort(key=lambda f: (rank(f), f))
    work = a.work or os.path.join(os.path.dirname(os.path.abspath(a.out_html)), "src", "audio",
                                  re.sub(r"[^a-z0-9]+", "-", a.title.lower()).strip("-"))
    os.makedirs(work, exist_ok=True)

    stems = []
    for f in files:
        path = os.path.join(a.stems, f)
        sid = os.path.splitext(f)[0].lower()
        m = measure(path)
        stems.append({"id": sid, "label": sid.upper(), "path": path, "rms_db": m["rms_db"],
                      "peak_db": m["peak_db"], "dur": m["dur"], "sr": m["sr"],
                      "present": bool(m["rms_db"] > THRESHOLD)})
    sr = stems[0]["sr"]
    if any(s["sr"] != sr for s in stems):
        raise SystemExit("stems must share a sample rate")
    present = [s for s in stems if s["present"]]
    absent = [s for s in stems if not s["present"]]
    if not present:
        raise SystemExit("no present stems")
    dur = max(s["dur"] for s in stems)

    for s in present:
        s["lufs"], s["tp"] = ff_loudness([s["path"]])
        s["solo_gain_db"] = SOLO_LUFS - s["lufs"]
    for s in absent:
        s["lufs"] = None
        s["solo_gain_db"] = None

    # ---- encode both probe bitrates, pick the requested one
    # Encoding happens before the preset maths because the page sums the
    # decoded MP3s, not the WAVs.  The clamp is checked against both.
    probe = [int(x) for x in str(a.probe).split(",") if x.strip()]
    if a.bitrate not in probe:
        probe.append(a.bitrate)
    sizes = {k: {} for k in probe}
    for s in present:
        for kbps in probe:
            dst = os.path.join(work, "%s-%dk.mp3" % (s["id"], kbps))
            n = encode(s["path"], dst, kbps)
            sizes[kbps][s["id"]] = {"mp3_bytes": n,
                                    "b64_bytes": 4 * ((n + 2) // 3)}
    for kbps in probe:
        sizes[kbps]["_total"] = {
            "mp3_bytes": sum(v["mp3_bytes"] for k, v in sizes[kbps].items() if k != "_total"),
            "b64_bytes": sum(v["b64_bytes"] for k, v in sizes[kbps].items() if k != "_total"),
        }

    wav_files = [s["path"] for s in present]
    page_files = [os.path.join(work, "%s-%dk.mp3" % (s["id"], a.bitrate))
                  for s in present]

    # ---- presets: one per present instrument + BALANCED.
    # The trim still aims at -16 LUFS, but it is clamped so the resulting true
    # peak cannot exceed the limiter ceiling.  A clamped preset reports the
    # lower LUFS it actually lands at; it is never silently flattened.
    presets = []
    for feat in [s["id"] for s in present] + [None]:
        gains = {}
        for s in stems:
            if feat is None:
                gains[s["id"]] = 0.0
            else:
                gains[s["id"]] = EMPHASIS["featured_db"] if s["id"] == feat else EMPHASIS["others_db"]
        gain_list = [gains[s["id"]] for s in present]
        raw_lufs, raw_tp = ff_loudness(wav_files, gain_list)
        raw_page_lufs, raw_page_tp = ff_loudness(page_files, gain_list)

        lufs_trim = TARGET_LUFS - raw_lufs
        peak_trim = PEAK_CEILING_DBFS - raw_tp
        trim = lufs_trim
        peak_limited = False
        if peak_trim < lufs_trim:
            # The loudness trim would put the true peak above -1 dBTP.
            # Pull this preset back, with a small measurement guard.
            trim = peak_trim - PEAK_GUARD_DB
            peak_limited = True

        # The page hears MP3s.  Measure the encoded mix at the trim we intend
        # to ship; if codec overshoot still breaks the ceiling, pull back more.
        page_lufs, page_tp = ff_loudness(page_files, gain_list, master_db=trim)
        for _ in range(3):
            over = max(page_tp - PEAK_CEILING_DBFS,
                       (raw_tp + trim) - PEAK_CEILING_DBFS)
            if over <= 0:
                break
            trim -= over + PEAK_GUARD_DB
            peak_limited = True
            page_lufs, page_tp = ff_loudness(page_files, gain_list, master_db=trim)
        if max(page_tp, raw_tp + trim) > PEAK_CEILING_DBFS + 1e-9:
            raise SystemExit("preset %s still exceeds %.1f dBFS: page %.2f, wav %.2f"
                             % (feat or "balanced", PEAK_CEILING_DBFS,
                                page_tp, raw_tp + trim))

        presets.append({
            "id": feat or "balanced",
            "label": feat.upper() if feat else "BALANCED",
            "featured": feat,
            "gains": {k: round(v, 2) for k, v in gains.items()},
            "trim_db": round(trim, 3),
            "lufs_trim_db": round(lufs_trim, 3),
            "peak_trim_db": round(peak_trim, 3),
            "peak_limited": peak_limited,
            "lufs_target": TARGET_LUFS,
            "lufs": round(raw_lufs + trim, 2),
            "lufs_measured": round(page_lufs, 2),
            "lufs_miss_db": round((raw_lufs + trim) - TARGET_LUFS, 2),
            "true_peak_dbtp": round(raw_tp + trim, 2),
            "true_peak_measured_dbtp": round(page_tp, 2),
            "raw_lufs": round(raw_lufs, 2),
            "raw_true_peak_dbtp": round(raw_tp, 2),
            "raw_page_lufs": round(raw_page_lufs, 2),
            "raw_page_true_peak_dbtp": round(raw_page_tp, 2),
        })

    peak_limited_presets = [p["id"] for p in presets if p["peak_limited"]]

    manifest = {
        "version": 2,
        "engine": "instrument-focus-mixer-offline",
        "song": a.title,
        "source": a.source,
        "sample_rate": sr,
        "window": {"start": 0.0, "dur": round(dur, 3)},
        "emphasis": EMPHASIS,
        "target_lufs": TARGET_LUFS,
        "peak_ceiling_dbfs": PEAK_CEILING_DBFS,
        "peak_guard_db": PEAK_GUARD_DB,
        "peak_limited_presets": peak_limited_presets,
        "threshold_dbfs": THRESHOLD,
        "stems": [{"id": s["id"], "label": s["label"], "file": None,
                   "rms_db": round(s["rms_db"], 2), "peak_db": round(s["peak_db"], 2),
                   "lufs": None if s["lufs"] is None else round(s["lufs"], 2),
                   "present": s["present"],
                   "solo_gain_db": None if s["solo_gain_db"] is None else round(s["solo_gain_db"], 2)}
                  for s in stems],
        "presets": presets,
    }

    # ---- assemble the page
    payload = {}
    for s in present:
        with open(os.path.join(work, "%s-%dk.mp3" % (s["id"], a.bitrate)), "rb") as fh:
            payload[s["id"]] = b64_chunks(fh.read())
    stem_json = "{" + ",".join(
        json.dumps(sid) + ":[" + ",".join(json.dumps(c) for c in chunks) + "]"
        for sid, chunks in payload.items()) + "}"
    manifest_json = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))

    script = io.open(SCRIPT, encoding="utf-8").read()
    script = script.replace("__MANIFEST_JSON__", manifest_json)
    script = script.replace("__STEM_JSON__", stem_json)
    page = io.open(TEMPLATE, encoding="utf-8").read()
    page = page.replace("__TITLE__", html.escape(a.title))
    page = page.replace("__SCRIPT__", script)
    with io.open(a.out_html, "w", encoding="utf-8") as fh:
        fh.write(page)

    html_bytes = os.path.getsize(a.out_html)
    total_b64 = sizes[a.bitrate]["_total"]["b64_bytes"]
    total_mp3 = sizes[a.bitrate]["_total"]["mp3_bytes"]
    metrics = {
        "song": a.title,
        "stems_dir": a.stems,
        "out_html": os.path.abspath(a.out_html),
        "html_bytes": html_bytes,
        "html_mib": round(html_bytes / 1048576.0, 3),
        "chosen_bitrate_kbps": a.bitrate,
        "duration_s": round(dur, 3),
        "sample_rate": sr,
        "target_lufs": TARGET_LUFS,
        "peak_ceiling_dbfs": PEAK_CEILING_DBFS,
        "peak_guard_db": PEAK_GUARD_DB,
        "peak_limited_presets": peak_limited_presets,
        "present": [s["id"] for s in present],
        "absent": [s["id"] for s in absent],
        "stem_measure": [{"id": s["id"], "present": s["present"], "rms_db": round(s["rms_db"], 2),
                          "peak_db": round(s["peak_db"], 2),
                          "lufs": None if s["lufs"] is None else round(s["lufs"], 2),
                          "solo_gain_db": None if s["solo_gain_db"] is None else round(s["solo_gain_db"], 2)}
                         for s in stems],
        "presets": presets,
        "sizes": {str(k): sizes[k] for k in probe},
        "base64_overhead_bytes": total_b64 - total_mp3,
        "base64_overhead_pct": round(100.0 * (total_b64 - total_mp3) / total_mp3, 2),
        "html_minus_payload_bytes": html_bytes - total_b64,
    }
    print(json.dumps({k: v for k, v in metrics.items() if k != "sizes"}, indent=1, ensure_ascii=False))
    print("\npreset levels (page mix = encoded MP3s, actual trim applied)")
    print("%-9s %8s %8s %8s %8s %6s" %
          ("preset", "target", "actual", "peak", "trim", "clamp"))
    for p in presets:
        print("%-9s %8.2f %8.2f %8.2f %8.3f %6s" %
              (p["id"], TARGET_LUFS, p["lufs_measured"], p["true_peak_measured_dbtp"],
               p["trim_db"], "YES" if p["peak_limited"] else "no"))
    for kbps in probe:
        print("bitrate %dk: mp3=%d b64=%d" % (kbps, sizes[kbps]["_total"]["mp3_bytes"],
                                              sizes[kbps]["_total"]["b64_bytes"]))
    if a.metrics:
        with io.open(a.metrics, "w", encoding="utf-8") as fh:
            json.dump(metrics, fh, indent=1, ensure_ascii=False)
        print("metrics ->", a.metrics)
    print("page ->", a.out_html, html_bytes, "bytes")


if __name__ == "__main__":
    main()
