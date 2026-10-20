#!/usr/bin/env python3
"""
build_song.py - turn ANY YouTube link into an instrument-mixer page.

Pipeline:
  1. download audio            (yt-dlp)
  2. separate into 6 stems     (htdemucs_6s: drums, bass, vocals, other, piano, guitar)
  3. MEASURE each stem         -> which instruments actually exist in this song
  4. encode stems for the web  (mp3, so the page is small)
  5. write manifest.json       -> the page adapts to this, it is never hardcoded

Nothing here assumes a particular song. A song with no guitar simply gets no guitar channel.

Usage:
  python3 build_song.py --url <youtube url> --out songs/<slug>
  python3 build_song.py --audio <local.wav> --out songs/<slug>     # skip download
"""
import argparse, json, os, re, subprocess, sys, shutil
import numpy as np

SILENT_DBFS = -45.0          # below this a stem is treated as absent
LABELS = {"drums": "Drums", "bass": "Bass", "vocals": "Vocals",
          "other": "Other", "piano": "Piano", "guitar": "Guitar"}
ORDER = ["drums", "piano", "guitar", "bass", "vocals", "other"]


def run(cmd, **kw):
    print("  $", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kw)


def download(url, outdir):
    wav = os.path.join(outdir, "source.wav")
    if os.path.exists(wav):
        return wav
    run(["yt-dlp", "-f", "bestaudio", "-x", "--audio-format", "wav",
         "--audio-quality", "0", "-o", os.path.join(outdir, "source.%(ext)s"), url])
    return wav


def separate(wav, outdir):
    stemdir = os.path.join(outdir, "stems_raw", "htdemucs_6s", "source")
    if not os.path.isdir(stemdir) or len(os.listdir(stemdir)) < 6:
        run([sys.executable, "-m", "demucs", "-n", "htdemucs_6s", "-o",
             os.path.join(outdir, "stems_raw"), wav])
    return stemdir


def measure(path):
    """Return integrated RMS in dBFS. Pure measurement - this is what makes the page adapt."""
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True)
    rms = float(np.sqrt((x ** 2).mean()))
    return 20.0 * np.log10(rms + 1e-12), len(x) / sr


def encode(src, dst, bitrate="128k"):
    if os.path.exists(dst):
        return
    run(["ffmpeg", "-v", "error", "-y", "-i", src, "-b:a", bitrate, dst])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="")
    ap.add_argument("--audio", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--window", default="")            # optional "start:end" seconds for the demo loop
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    web = os.path.join(a.out, "stems"); os.makedirs(web, exist_ok=True)

    print("[1/5] audio", flush=True)
    wav = a.audio or download(a.url, a.out)
    if not os.path.exists(wav):
        sys.exit("no audio")

    print("[2/5] separate (htdemucs_6s, CPU, a few minutes)", flush=True)
    stemdir = separate(wav, a.out)

    print("[3/5] measure", flush=True)
    channels, duration = [], 0.0
    for name in ORDER:
        src = os.path.join(stemdir, name + ".wav")
        if not os.path.exists(src):
            continue
        db, dur = measure(src); duration = max(duration, dur)
        present = bool(db > SILENT_DBFS)
        print(f"   {name:7s} {db:7.2f} dBFS  {'present' if present else 'ABSENT'}", flush=True)
        channels.append({"id": name, "label": LABELS[name], "rms_dbfs": round(db, 2),
                         "present": present, "file": "stems/%s.mp3" % name})

    print("[4/5] encode for web", flush=True)
    for c in channels:
        if c["present"]:
            encode(os.path.join(stemdir, c["id"] + ".wav"),
                   os.path.join(web, c["id"] + ".mp3"))

    # demo window: densest stretch, so the A/B is instant and the loop is interesting
    if a.window:
        t0, t1 = [float(x) for x in a.window.split(":")]
    else:
        t0, t1 = 0.0, min(8.0, duration)

    manifest = {
        "source": {"url": a.url, "title": a.title or (a.url or os.path.basename(wav)),
                   "duration": round(duration, 3)},
        "window": [t0, t1],
        "silent_dbfs": SILENT_DBFS,
        "channels": channels,
        "note": "channel list derived by measurement; absent stems are reported, never faked",
    }
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    live = [c["id"] for c in channels if c["present"]]
    dead = [c["id"] for c in channels if not c["present"]]
    print(f"\n[5/5] manifest written to {a.out}/manifest.json", flush=True)
    print(f"   instruments found : {live}", flush=True)
    print(f"   absent in source  : {dead}", flush=True)
    print(f"   window            : {t0}s - {t1}s", flush=True)


if __name__ == "__main__":
    main()
