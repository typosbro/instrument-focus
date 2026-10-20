#!/usr/bin/env python3
"""Job store and the single-worker pipeline for the stem-mixer server.

The heavy lifting is deliberately NOT reimplemented here. Two scripts that were
already verified on this box do it:

  engine/build_song.py
      yt-dlp -> wav -> demucs htdemucs_6s -> measure every stem -> manifest.json
  slice/a7-offline/src/build_offline.py
      measure + loudness-trim + mp3 encode + base64 -> one self-contained HTML

This module only orchestrates them, turns their stdout/stderr into honest
progress, keeps a durable job history, and makes sure one bad job cannot take
the server down.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
ULTRA = os.path.dirname(ENGINE)

BUILD_SONG = os.path.join(ENGINE, "build_song.py")
OFFLINE_DIR = os.path.join(ULTRA, "slice", "a7-offline")
BUILD_OFFLINE = os.path.join(OFFLINE_DIR, "src", "build_offline.py")

DATA = os.path.abspath(os.environ.get("MIXER_DATA") or os.path.join(HERE, "data"))
JOBS_DIR = os.path.join(DATA, "jobs")
TMP_DIR = os.path.join(DATA, "tmp")
LOG_DIR = os.path.join(DATA, "logs")
STORE_PATH = os.path.join(DATA, "jobs.json")

YTDLP = shutil.which("yt-dlp") or os.path.expanduser("~/.local/bin/yt-dlp")

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be",
}
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
JOB_ID_RE = re.compile(r"^[a-f0-9]{12}$")

DL_PCT_RE = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
TQDM_PCT_RE = re.compile(r"(\d{1,3})%\|")

MAX_QUEUE = 20
PAGE_BITRATE = 96           # kbps, same as the two existing offline songs
MIN_FREE_BYTES = 4 * 1024 ** 3
BUILD_SONG_TIMEOUT = 90 * 60
BUILD_PAGE_TIMEOUT = 30 * 60
RESOLVE_TIMEOUT = 120

QUEUE: "queue.Queue[str]" = queue.Queue()
STORE = None                # type: ignore[assignment]
_active_lock = threading.Lock()
_active = {"proc": None}    # type: ignore[dict]
_worker = None
_queue_lock = threading.Lock()


class StageError(Exception):
    """A pipeline stage failed in a way that is safe to show to the user."""


class QueueFull(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------- url --
def normalize_youtube_url(raw) -> str:
    """Validate and canonicalise a YouTube video URL.

    Only a single video is ever accepted: playlist / radio parameters are
    stripped, so a URL cannot turn one job into a 200-track download. Returns a
    plain https://www.youtube.com/watch?v=ID string; raises ValueError.
    """
    if not isinstance(raw, str):
        raise ValueError("url must be a string")
    url = raw.strip()
    if not url:
        raise ValueError("url is empty")
    if len(url) > 2048:
        raise ValueError("url is too long")
    for ch in url:
        if ch.isspace() or ord(ch) < 32:
            raise ValueError("url contains whitespace or control characters")
    try:
        p = urlsplit(url)
    except ValueError:
        raise ValueError("url could not be parsed")
    if p.scheme.lower() not in ("http", "https"):
        raise ValueError("url must start with http:// or https://")
    if p.username or p.password:
        raise ValueError("url must not contain credentials")
    host = (p.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        raise ValueError("not a YouTube URL (host must be youtube.com or youtu.be)")
    try:
        port = p.port
    except ValueError:
        raise ValueError("url has an invalid port")
    if port not in (None, 80, 443):
        raise ValueError("url uses an unexpected port")

    vid = None
    if host in ("youtu.be", "www.youtu.be"):
        vid = p.path.strip("/").split("/")[0]
    else:
        qs = parse_qs(p.query)
        got = qs.get("v")
        if got:
            vid = got[0]
        else:
            m = re.match(r"^/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})(?:/|$)", p.path)
            if m:
                vid = m.group(1)
    if not vid or not VIDEO_ID_RE.fullmatch(vid):
        raise ValueError("could not find a video id in that URL")
    return "https://www.youtube.com/watch?v=" + vid


# ------------------------------------------------------------------- store --
class Store:
    """In-memory jobs, newest first, mirrored atomically to data/jobs.json."""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.RLock()
        self.jobs: dict = {}
        self.order: list = []
        self._load()

    def _load(self):
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            logging.exception("could not read %s; starting with an empty history", self.path)
            try:
                os.replace(self.path, self.path + ".corrupt-%d" % int(time.time()))
            except OSError:
                pass
            return
        jobs = data.get("jobs") if isinstance(data, dict) else None
        if not isinstance(jobs, list):
            logging.warning("%s has no jobs list; ignoring", self.path)
            return
        for rec in jobs:
            if not isinstance(rec, dict):
                continue
            jid = rec.get("id")
            if not isinstance(jid, str) or not JOB_ID_RE.fullmatch(jid):
                continue
            rec.setdefault("status", "failed")
            rec.setdefault("stage", rec["status"])
            rec.setdefault("pct", 0)
            rec.setdefault("title", None)
            rec.setdefault("duration", None)
            rec.setdefault("error", None)
            rec.setdefault("page", None)
            rec.setdefault("channels", [])
            rec.setdefault("timings", {})
            rec.setdefault("created_at", now_iso())
            rec.setdefault("queued_at", rec["created_at"])
            rec.setdefault("started_at", None)
            rec.setdefault("finished_at", None)
            rec.setdefault("page_bytes", None)
            self.jobs[jid] = rec
            self.order.append(jid)
        logging.info("loaded %d job(s) from %s", len(self.order), self.path)

    def _save_locked(self):
        data = {
            "version": 1,
            "saved_at": now_iso(),
            "jobs": [self.jobs[i] for i in self.order if i in self.jobs],
        }
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def create(self, url: str) -> dict:
        with self.lock:
            jid = uuid.uuid4().hex[:12]
            while jid in self.jobs:
                jid = uuid.uuid4().hex[:12]
            rec = {
                "id": jid,
                "url": url,
                "title": None,
                "status": "queued",
                "stage": "queued",
                "pct": 0,
                "duration": None,
                "error": None,
                "page": None,
                "channels": [],
                "created_at": now_iso(),
                "queued_at": now_iso(),
                "started_at": None,
                "finished_at": None,
                "timings": {},
                "page_bytes": None,
            }
            self.jobs[jid] = rec
            self.order.insert(0, jid)
            self._save_locked()
            return copy.deepcopy(rec)

    def update(self, jid: str, **fields):
        with self.lock:
            rec = self.jobs.get(jid)
            if rec is None:
                return None
            rec.update(fields)
            rec["updated_at"] = now_iso()
            self._save_locked()
            return copy.deepcopy(rec)

    def get(self, jid: str):
        with self.lock:
            rec = self.jobs.get(jid)
            return copy.deepcopy(rec) if rec else None

    def snapshot(self) -> list:
        with self.lock:
            return [copy.deepcopy(self.jobs[i]) for i in self.order if i in self.jobs]

    def counts(self) -> dict:
        out = {"queued": 0, "running": 0, "done": 0, "failed": 0}
        with self.lock:
            for rec in self.jobs.values():
                status = rec.get("status")
                if status in out:
                    out[status] += 1
        return out

    def recover(self):
        """Called once at startup, before the worker starts.

        A job that was running when the process died cannot be resumed safely:
        its temp directory is gone. Mark it failed. Queued jobs are re-queued.
        """
        queued = []
        changed = False
        with self.lock:
            for jid in self.order:
                rec = self.jobs.get(jid)
                if not rec:
                    continue
                if rec.get("status") == "running":
                    rec.update(
                        status="failed",
                        stage="failed",
                        error="server restarted while this job was running",
                        finished_at=now_iso(),
                        updated_at=now_iso(),
                    )
                    changed = True
                elif rec.get("status") == "queued":
                    queued.append(jid)
            if changed:
                self._save_locked()
        for jid in reversed(queued):
            QUEUE.put(jid)
        if queued:
            logging.info("re-queued %d job(s) after restart", len(queued))


# --------------------------------------------------------------- progress --
class Progress:
    """Thread-safe progress snapshot, flushed to the store at most ~1/s."""

    def __init__(self, jid: str):
        self.jid = jid
        self.lock = threading.RLock()
        self.stage = "starting"
        self.pct = 1
        self.title = None
        self.duration = None
        self.timings = {}
        self._since = time.monotonic()
        self._last_flush = 0.0
        self._dirty = True
        self._closed = False

    def set(self, stage=None, pct=None, title=None, duration=None):
        with self.lock:
            if stage is not None and stage != self.stage:
                now = time.monotonic()
                if self.stage != "starting":
                    self.timings[self.stage] = round(
                        self.timings.get(self.stage, 0.0) + (now - self._since), 2)
                self._since = now
                self.stage = stage
            if pct is not None:
                self.pct = max(self.pct, int(round(pct)))
            if title is not None:
                self.title = title
            if duration is not None:
                self.duration = duration
            self._dirty = True

    def add_timing(self, name: str, seconds: float):
        with self.lock:
            self.timings[name] = round(seconds, 2)

    def flush(self, force: bool = False):
        with self.lock:
            if self._closed or not self._dirty:
                return
            if not force and (time.monotonic() - self._last_flush) < 0.9:
                return
            fields = {"stage": self.stage, "pct": self.pct}
            if self.title is not None:
                fields["title"] = self.title
            if self.duration is not None:
                fields["duration"] = self.duration
            self._dirty = False
            self._last_flush = time.monotonic()
        STORE.update(self.jid, **fields)

    def close(self):
        with self.lock:
            if self._closed:
                return
            now = time.monotonic()
            if self.stage not in ("starting",):
                self.timings[self.stage] = round(
                    self.timings.get(self.stage, 0.0) + (now - self._since), 2)
            self._since = now
            self._closed = True

    def timings_snapshot(self) -> dict:
        with self.lock:
            return {k: v for k, v in self.timings.items()
                    if k not in ("starting", "done", "failed")}


# -------------------------------------------------------------- subprocess --
def _kill_proc(p: subprocess.Popen):
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            p.kill()
        except Exception:
            pass


def stop_active_child():
    with _active_lock:
        p = _active.get("proc")
    if p is not None and p.poll() is None:
        logging.warning("killing active pipeline child pid=%s", p.pid)
        _kill_proc(p)


def _pump(fd: int, log_path: str, on_line):
    """Read a merged output pipe, split on CR *and* LF, call on_line per item.

    tqdm (demucs) uses carriage returns, so a plain readline() would sit on the
    progress bar until the process exited.
    """
    buf = b""
    lf = open(log_path, "ab", buffering=0)
    try:
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            lf.write(chunk)
            buf += chunk
            parts = re.split(rb"[\r\n]+", buf)
            buf = parts.pop()
            if len(buf) > 2_000_000:
                buf = b""
            for raw in parts:
                text = raw.decode("utf-8", "replace").strip()
                if text:
                    try:
                        on_line(text)
                    except Exception:
                        logging.exception("progress handler failed")
        if buf:
            text = buf.decode("utf-8", "replace").strip()
            if text:
                try:
                    on_line(text)
                except Exception:
                    logging.exception("progress handler failed")
    finally:
        try:
            lf.close()
        except OSError:
            pass


def run_cmd(cmd, log_path: str, on_line, tick=None, timeout: int = 3600) -> int:
    """Run a command with an argv list (never a shell), streamed into log_path."""
    with open(log_path, "ab") as lf:
        lf.write(("\n\n=== %s\n$ %s\n" % (now_iso(), " ".join(cmd))).encode("utf-8"))
    p = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        start_new_session=True,
    )
    with _active_lock:
        _active["proc"] = p
    reader = threading.Thread(target=_pump, args=(p.stdout.fileno(), log_path, on_line),
                              name="pipe-%s" % os.path.basename(cmd[0]), daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    try:
        while True:
            rc = p.poll()
            if rc is not None:
                break
            if time.monotonic() > deadline:
                logging.error("command timed out after %ss: %s", timeout, cmd[:3])
                _kill_proc(p)
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
                reader.join(timeout=5)
                raise StageError("stage timed out after %d minutes" % (timeout // 60))
            if tick is not None:
                try:
                    tick()
                except Exception:
                    logging.exception("progress tick failed")
            time.sleep(0.5)
        reader.join(timeout=10)
        return p.returncode if p.returncode is not None else -1
    finally:
        with _active_lock:
            if _active.get("proc") is p:
                _active["proc"] = None
        try:
            p.stdout.close()
        except Exception:
            pass


def _tail_error(tail, rc: int) -> str:
    for line in reversed(tail):
        low = line.lower()
        if line.startswith("ERROR:") or "error:" in low or "traceback" in low:
            return line[:400]
    for line in reversed(tail):
        if line.strip():
            return line[:400]
    return "exit code %s" % rc


# ------------------------------------------------------------------ stages --
def _resolve(url: str):
    cmd = [YTDLP, "--no-playlist", "--skip-download", "--no-warnings", "--no-progress",
           "--print", "%(title)s|||%(duration)s", url]
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True, timeout=RESOLVE_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise StageError("YouTube took too long to answer")
    if p.returncode != 0:
        msg = (p.stderr or "").strip().splitlines()
        raise StageError("could not read the video: " + (msg[-1][:300] if msg else "yt-dlp failed"))
    lines = [ln for ln in (p.stdout or "").strip().splitlines() if ln.strip()]
    if not lines:
        raise StageError("YouTube returned no video information")
    line = lines[-1]
    if "|||" not in line:
        raise StageError("could not parse video information")
    title, dur = line.rsplit("|||", 1)
    title = title.strip() or "Untitled"
    duration = None
    try:
        duration = float(dur)
        if duration <= 0:
            duration = None
    except ValueError:
        duration = None
    return title, duration


def _run_build_song(job: dict, title: str, prog: Progress, build_dir: str, log_path: str):
    cmd = [sys.executable, "-u", BUILD_SONG, "--url", job["url"], "--out", build_dir,
           "--title", title]
    state = {"tail": [], "measures": 0}

    def on_line(line: str):
        state["tail"].append(line)
        del state["tail"][:-8]
        if "[1/5]" in line:
            prog.set(stage="downloading", pct=4)
            return
        if "[2/5]" in line:
            prog.set(stage="separating", pct=22)
            return
        if "[3/5]" in line:
            prog.set(stage="measuring", pct=80)
            return
        if "[4/5]" in line:
            prog.set(stage="preparing", pct=86)
            return
        if "[5/5]" in line:
            prog.set(pct=89)
            return
        if prog.stage == "downloading":
            m = DL_PCT_RE.search(line)
            if m:
                prog.set(pct=4 + 18 * min(100.0, float(m.group(1))) / 100.0)
        elif prog.stage == "separating":
            m = TQDM_PCT_RE.search(line)
            if m:
                prog.set(pct=22 + 58 * min(100, int(m.group(1))) / 100.0)
        elif prog.stage == "measuring":
            if "dBFS" in line:
                state["measures"] += 1
                prog.set(pct=80 + 6 * min(1.0, state["measures"] / 6.0))

    rc = run_cmd(cmd, log_path, on_line, tick=prog.flush, timeout=BUILD_SONG_TIMEOUT)
    if rc != 0:
        raise StageError("download/separation failed: " + _tail_error(state["tail"], rc))


def _run_build_page(job: dict, title: str, prog: Progress, stems_dir: str,
                    page_path: str, work_dir: str, metrics_path: str, log_path: str,
                    present_count: int):
    cmd = [sys.executable, "-u", BUILD_OFFLINE, "--stems", stems_dir, "--title", title,
           "--out-html", page_path, "--bitrate", str(PAGE_BITRATE),
           "--probe", str(PAGE_BITRATE), "--metrics", metrics_path,
           "--work", work_dir, "--source", job["url"]]
    state = {"tail": []}
    expected = max(1, present_count)

    def on_line(line: str):
        state["tail"].append(line)
        del state["tail"][:-8]

    def tick():
        try:
            n = len([f for f in os.listdir(work_dir) if f.endswith(".mp3")])
        except OSError:
            n = 0
        prog.set(pct=90 + 8 * min(1.0, n / expected))
        prog.flush()

    prog.set(stage="rendering", pct=90)
    prog.flush(force=True)
    rc = run_cmd(cmd, log_path, on_line, tick=tick, timeout=BUILD_PAGE_TIMEOUT)
    if rc != 0:
        raise StageError("page build failed: " + _tail_error(state["tail"], rc))
    if not os.path.isfile(page_path) or os.path.getsize(page_path) < 100_000:
        raise StageError("page build produced no usable HTML")


def _measure_channels(manifest: dict) -> list:
    out = []
    for ch in manifest.get("channels", []):
        if not isinstance(ch, dict) or not ch.get("id"):
            continue
        out.append({
            "id": ch["id"],
            "label": ch.get("label") or ch["id"].upper(),
            "present": bool(ch.get("present")),
            "rms_dbfs": ch.get("rms_dbfs"),
        })
    return out


def _metrics_channels(metrics: dict) -> list:
    out = []
    # build_offline.py calls this list "stem_measure"; accept both spellings so
    # a future template change cannot silently drop the loudness numbers.
    for ch in (metrics.get("stem_measure") or metrics.get("stems") or []):
        if not isinstance(ch, dict) or not ch.get("id"):
            continue
        out.append({
            "id": ch["id"],
            "label": ch.get("label") or ch["id"].upper(),
            "present": bool(ch.get("present")),
            "rms_dbfs": ch.get("rms_db"),
            "lufs": ch.get("lufs"),
            "solo_gain_db": ch.get("solo_gain_db"),
        })
    return out


# ------------------------------------------------------------------- job ----
def _fail(jid: str, prog: Progress, log_path: str, message: str,
          tb: str, t0: float, page_path=None):
    logging.error("job %s failed: %s", jid, message)
    try:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("\n\n=== FAILED %s\n%s\n%s\n" % (now_iso(), message, tb))
    except OSError:
        pass
    if page_path and os.path.exists(page_path):
        try:
            os.remove(page_path)
        except OSError:
            pass
    prog.set(stage="failed")
    prog.flush(force=True)
    prog.close()
    timings = prog.timings_snapshot()
    timings["total"] = round(time.monotonic() - t0, 1)
    try:
        STORE.update(jid, status="failed", stage="failed", error=message[:600],
                     page=None, timings=timings, finished_at=now_iso())
    except Exception:
        logging.exception("could not record failure for %s", jid)


def run_job(jid: str):
    rec = STORE.get(jid)
    if not rec:
        logging.warning("job %s vanished before it ran", jid)
        return
    t0 = time.monotonic()
    prog = Progress(jid)
    tmp = os.path.join(TMP_DIR, jid)
    jobdir = os.path.join(JOBS_DIR, jid)
    log_path = os.path.join(LOG_DIR, jid + ".log")
    page_path = os.path.join(jobdir, "page.html")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(jobdir, exist_ok=True)
    started = now_iso()
    logging.info("job %s started: %s", jid, rec.get("url"))
    STORE.update(jid, status="running", stage="resolving", pct=1, error=None,
                 page=None, started_at=started)
    prog.set(stage="resolving", pct=1)
    prog.flush(force=True)

    try:
        free = shutil.disk_usage(DATA).free
        if free < MIN_FREE_BYTES:
            raise StageError("not enough free disk for this job (%.1f GB available)" %
                             (free / 1024 ** 3))

        t = time.monotonic()
        title, duration = _resolve(rec["url"])
        prog.set(stage="downloading", pct=4, title=title, duration=duration)
        prog.flush(force=True)
        logging.info("job %s resolved: %r (%.1fs)", jid, title, duration or -1)

        build_dir = os.path.join(tmp, "build")
        _run_build_song(rec, title, prog, build_dir, log_path)

        manifest_path = os.path.join(build_dir, "manifest.json")
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest = json.load(fh)
        except Exception:
            raise StageError("build_song finished but wrote no readable manifest.json")

        channels = _measure_channels(manifest)
        present = [c for c in channels if c["present"]]
        if not present:
            raise StageError("no audible stems were found in this video")
        measured_dur = (manifest.get("source") or {}).get("duration")
        if measured_dur:
            duration = float(measured_dur)

        stems_dir = os.path.join(build_dir, "stems_raw", "htdemucs_6s", "source")
        if not os.path.isdir(stems_dir):
            raise StageError("demucs produced no stem directory")

        work_dir = os.path.join(tmp, "pagework")
        metrics_path = os.path.join(jobdir, "metrics.json")
        _run_build_page(rec, title, prog, stems_dir, page_path, work_dir,
                        metrics_path, log_path, len(present))

        try:
            with open(metrics_path, "r", encoding="utf-8") as fh:
                metrics = json.load(fh)
        except Exception:
            raise StageError("page was built but its metrics are unreadable")

        final_channels = _metrics_channels(metrics)
        if final_channels:
            if (sorted(c["id"] for c in final_channels if c["present"]) !=
                    sorted(c["id"] for c in present)):
                logging.warning("job %s: build_song and build_offline disagree on present stems",
                                jid)
            channels = final_channels
        duration = float(metrics.get("duration_s") or duration or 0.0) or None

        try:
            shutil.copyfile(manifest_path, os.path.join(jobdir, "manifest.json"))
        except OSError:
            pass

        page_bytes = os.path.getsize(page_path)
        prog.set(stage="done", pct=100)
        prog.flush(force=True)
        prog.close()
        timings = prog.timings_snapshot()
        timings["total"] = round(time.monotonic() - t0, 1)
        try:
            started_dt = datetime.fromisoformat(rec["created_at"])
            timings["queue_wait"] = round(max(0.0, (
                datetime.fromisoformat(started) - started_dt).total_seconds()), 1)
        except (ValueError, KeyError):
            pass
        STORE.update(
            jid, status="done", stage="done", pct=100, title=title, duration=duration,
            page="/song/%s/" % jid, channels=channels, page_bytes=page_bytes,
            timings=timings, finished_at=now_iso(), error=None,
        )
        logging.info("job %s done in %.1fs: %s (%d bytes, %s)", jid,
                     time.monotonic() - t0, title, page_bytes,
                     ",".join(c["id"] for c in channels if c["present"]))
    except StageError as exc:
        _fail(jid, prog, log_path, str(exc), traceback.format_exc(), t0, page_path)
    except Exception as exc:
        _fail(jid, prog, log_path, "internal error: %s" % exc,
              traceback.format_exc(), t0, page_path)
    finally:
        try:
            prog.close()
        except Exception:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ worker --
def _worker_loop():
    logging.info("job worker started (one job at a time)")
    while True:
        jid = QUEUE.get()
        try:
            rec = STORE.get(jid)
            if rec and rec.get("status") == "queued":
                run_job(jid)
            else:
                logging.info("skipping queued id %s (status=%s)", jid,
                             rec.get("status") if rec else "missing")
        except Exception:
            logging.exception("worker crashed outside the pipeline for job %s", jid)
            try:
                STORE.update(jid, status="failed", stage="failed",
                             error="worker crashed; see the job log",
                             finished_at=now_iso())
            except Exception:
                logging.exception("could not mark job %s failed", jid)
        finally:
            QUEUE.task_done()


def submit(url: str) -> dict:
    with _queue_lock:
        if QUEUE.qsize() >= MAX_QUEUE:
            raise QueueFull("queue is full; wait for the current jobs to finish")
        rec = STORE.create(url)
        QUEUE.put(rec["id"])
    logging.info("queued job %s: %s", rec["id"], url)
    return rec


# --------------------------------------------------------------- lifecycle --
def _kill_orphans():
    """Kill pipeline processes from an earlier server process, if any."""
    needle = os.path.abspath(TMP_DIR)
    me = os.getpid()
    try:
        pids = [int(p) for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return
    for pid in pids:
        if pid == me:
            continue
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        args = [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
        if not args or not any(needle in a for a in args):
            continue
        joined = " ".join(args)
        if not re.search(r"(demucs|yt-dlp|ffmpeg|build_song|build_offline)", joined):
            continue
        logging.warning("killing orphaned pipeline process pid=%d: %s", pid, joined[:240])
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _clean_temp():
    try:
        names = os.listdir(TMP_DIR)
    except OSError:
        names = []
    for name in names:
        path = os.path.join(TMP_DIR, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                os.remove(path)
            except OSError:
                pass
    try:
        job_names = os.listdir(JOBS_DIR)
    except OSError:
        job_names = []
    for name in job_names:
        for sub in ("build", "work", "pagework"):
            shutil.rmtree(os.path.join(JOBS_DIR, name, sub), ignore_errors=True)


def init():
    global STORE, _worker
    for d in (DATA, JOBS_DIR, TMP_DIR, LOG_DIR):
        os.makedirs(d, exist_ok=True)
    _kill_orphans()
    _clean_temp()
    STORE = Store(STORE_PATH)
    STORE.recover()
    _worker = threading.Thread(target=_worker_loop, name="job-worker", daemon=True)
    _worker.start()


def check_dependencies():
    missing = []
    if not os.path.isfile(BUILD_SONG):
        missing.append(BUILD_SONG)
    if not os.path.isfile(BUILD_OFFLINE):
        missing.append(BUILD_OFFLINE)
    if not YTDLP or not os.path.isfile(YTDLP):
        missing.append("yt-dlp")
    for tool in ("ffmpeg",):
        if not shutil.which(tool):
            missing.append(tool)
    return missing
