#!/usr/bin/env python3
"""HTTP front door for the YouTube -> one-file stem mixer.

  GET  /                     plain job queue UI
  POST /api/jobs             {"url": "..."} -> {"id": "..."} (202, enqueued)
  GET  /api/jobs             {"jobs": [...], "library": [...]}
  GET  /api/jobs/<id>        one job record (queued|running|done|failed)
  GET  /api/jobs/<id>/log    pipeline output for that job (text/plain)
  GET  /song/<id>/           the finished self-contained mixer page
  GET  /library/song-a.html  the two existing offline songs
  GET  /healthz              liveness + queue counters

Runs on 0.0.0.0:8484. Standard library only.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from urllib.parse import unquote, urlsplit

import jobs

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = jobs.DATA
JOBS_DIR = jobs.JOBS_DIR
LOG_DIR = jobs.LOG_DIR
INDEX_PATH = os.path.join(HERE, "index.html")
PID_PATH = os.path.join(DATA, "server.pid")
LIBRARY_PAGES = {
    "/library/song-a.html": os.path.join(jobs.OFFLINE_DIR, "song-a.html"),
    "/library/song-b.html": os.path.join(jobs.OFFLINE_DIR, "song-b.html"),
}

HOST = os.environ.get("MIXER_HOST", "0.0.0.0")
PORT = int(os.environ.get("MIXER_PORT", "8484"))
SERVER_VERSION = "mixer/1.0"
STARTED = time.time()
MAX_BODY = 8192

LIBRARY: list = []
LIBRARY_FILES: dict = {}
JOB_URL_RE = re.compile(r"^/song/([a-f0-9]{12})(?:/(?:index\.html)?)?$")


# ------------------------------------------------------------------ helpers --
def _setup_logging():
    os.makedirs(DATA, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(os.path.join(DATA, "server.log"), maxBytes=4 * 1024 * 1024,
                             backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    root.addHandler(fh)
    root.addHandler(sh)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)


def _pid_is_our_server(pid: int) -> bool:
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            raw = fh.read()
    except OSError:
        return False
    args = [a for a in raw.split(b"\0") if a]
    if not any(b"server.py" in a for a in args):
        return False
    try:
        cwd = os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        cwd = ""
    return cwd == HERE or HERE.encode() in raw


def _existing_instance():
    if not os.path.isfile(PID_PATH):
        return None
    try:
        with open(PID_PATH, "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return None
    if pid <= 0 or pid == os.getpid():
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return pid if _pid_is_our_server(pid) else None


def _write_pid():
    tmp = PID_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))
    os.replace(tmp, PID_PATH)


def _remove_pid():
    try:
        with open(PID_PATH, "r", encoding="utf-8") as fh:
            pid = int(fh.read().strip())
        if pid == os.getpid():
            os.remove(PID_PATH)
    except (OSError, ValueError):
        pass


def _load_library():
    """The two songs that already exist, so the page is never empty."""
    global LIBRARY, LIBRARY_FILES
    entries = []
    files = {}
    for sid in ("song-a", "song-b"):
        path = os.path.join(jobs.OFFLINE_DIR, sid + ".html")
        if not os.path.isfile(path):
            continue
        meta = {}
        try:
            with open(os.path.join(jobs.OFFLINE_DIR, "src", "metrics-%s.json" % sid),
                      "r", encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            pass
        present = [str(c).upper() for c in meta.get("present", []) if c]
        entries.append({
            "id": sid,
            "title": meta.get("song") or sid,
            "url": "/library/%s.html" % sid,
            "duration": meta.get("duration_s"),
            "channels": present,
            "page_bytes": os.path.getsize(path),
        })
        files["/library/%s.html" % sid] = path
    LIBRARY = entries
    LIBRARY_FILES = files
    logging.info("library: %d ready-made song(s)", len(entries))


# ------------------------------------------------------------------ handler --
class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = SERVER_VERSION
    protocol_version = "HTTP/1.0"      # one request per connection: no body-drain bugs
    timeout = 60

    # -- plumbing ----------------------------------------------------------
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def log_message(self, fmt, *args):
        try:
            code = int(args[1]) if len(args) > 1 else 0
        except (ValueError, IndexError):
            code = 0
        if code >= 400 or self.command not in ("GET", "HEAD"):
            logging.info("%s %s %s", self.client_address[0], self.command, fmt % args)

    def do_GET(self):
        self._route(head=False)

    def do_HEAD(self):
        self._route(head=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        try:
            self._route_post()
        except HttpError as exc:
            self._send_json({"error": exc.message}, exc.status)
        except Exception:
            logging.exception("POST %s failed", self.path)
            self._send_json({"error": "internal server error"}, 500)

    def _route_post(self):
        path = unquote(urlsplit(self.path).path)
        if path != "/api/jobs":
            raise HttpError(404, "not found")
        length = self.headers.get("Content-Length")
        if self.headers.get("Transfer-Encoding"):
            raise HttpError(411, "Content-Length required")
        if length is None:
            raise HttpError(411, "Content-Length required")
        try:
            n = int(length)
        except ValueError:
            raise HttpError(400, "bad Content-Length")
        if n < 0:
            raise HttpError(400, "bad Content-Length")
        if n > MAX_BODY:
            raise HttpError(413, "request body too large")
        body = self.rfile.read(n)
        if len(body) != n:
            raise HttpError(400, "incomplete request body")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise HttpError(400, "body must be JSON")
        if not isinstance(payload, dict):
            raise HttpError(400, "body must be a JSON object")
        try:
            url = jobs.normalize_youtube_url(payload.get("url"))
        except ValueError as exc:
            raise HttpError(400, str(exc))
        try:
            rec = jobs.submit(url)
        except jobs.QueueFull as exc:
            raise HttpError(503, str(exc))
        self._send_json({"id": rec["id"], "status": "queued"}, 202)

    def _route(self, head: bool):
        try:
            self._route_get(head)
        except HttpError as exc:
            if exc.status == 404:
                self._send_text("not found\n", 404, head=head)
            else:
                self._send_json({"error": exc.message}, exc.status, head=head)
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        except Exception:
            logging.exception("GET %s failed", self.path)
            try:
                self._send_json({"error": "internal server error"}, 500, head=head)
            except (ConnectionResetError, BrokenPipeError):
                pass

    def _route_get(self, head: bool):
        path = unquote(urlsplit(self.path).path)

        if path in ("/", "/index.html"):
            return self._serve_file(INDEX_PATH, head, cache="no-cache")
        if path == "/healthz":
            free = shutil.disk_usage(DATA).free
            return self._send_json({
                "ok": True,
                "pid": os.getpid(),
                "uptime_s": round(time.time() - STARTED, 1),
                "queue": jobs.QUEUE.qsize(),
                "jobs": jobs.STORE.counts() if jobs.STORE else {},
                "free_bytes": free,
            }, 200, head=head)
        if path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/api/jobs":
            return self._send_json({
                "jobs": jobs.STORE.snapshot() if jobs.STORE else [],
                "library": LIBRARY,
            }, 200, head=head)
        if path.startswith("/api/jobs/"):
            parts = path.strip("/").split("/")
            if len(parts) in (3, 4):
                jid = parts[2]
                if not jobs.JOB_ID_RE.fullmatch(jid):
                    raise HttpError(404, "no such job")
                rec = jobs.STORE.get(jid) if jobs.STORE else None
                if rec is None:
                    raise HttpError(404, "no such job")
                if len(parts) == 3:
                    return self._send_json(rec, 200, head=head)
                if parts[3] == "log":
                    return self._serve_log(jid, head)
            raise HttpError(404, "no such job")

        m = JOB_URL_RE.match(path)
        if m:
            jid = m.group(1)
            if not path.endswith("/") and not path.endswith("index.html"):
                return self._redirect("/song/%s/" % jid, head)
            rec = jobs.STORE.get(jid) if jobs.STORE else None
            if rec is None or rec.get("status") != "done":
                raise HttpError(404, "no mixer page for that job")
            page = os.path.join(JOBS_DIR, jid, "page.html")
            if not os.path.isfile(page):
                raise HttpError(404, "the mixer page for that job is missing")
            return self._serve_file(page, head, cache="public, max-age=3600")

        if path in LIBRARY_FILES:
            return self._serve_file(LIBRARY_FILES[path], head, cache="public, max-age=3600")

        raise HttpError(404, "not found")

    # -- responses ---------------------------------------------------------
    def _serve_log(self, jid: str, head: bool):
        path = os.path.join(LOG_DIR, jid + ".log")
        if not os.path.isfile(path):
            raise HttpError(404, "no log for that job")
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                fh.seek(max(0, size - 200_000))
                data = fh.read()
        except OSError:
            raise HttpError(404, "no log for that job")
        self._send_bytes(data, 200, "text/plain; charset=utf-8", "no-store", head)

    def _serve_file(self, path: str, head: bool, cache: str = "no-cache"):
        try:
            fh = open(path, "rb")
            size = os.fstat(fh.fileno()).st_size
        except OSError:
            logging.error("static file missing: %s", path)
            raise HttpError(404, "file not found")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if head:
                return
            shutil.copyfileobj(fh, self.wfile, 64 * 1024)
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        finally:
            fh.close()

    def _send_json(self, obj, status: int, head: bool = False):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(data, status, "application/json; charset=utf-8", "no-store", head)

    def _send_text(self, text: str, status: int, head: bool = False):
        self._send_bytes(text.encode("utf-8"), status, "text/plain; charset=utf-8",
                         "no-store", head)

    def _send_bytes(self, data: bytes, status: int, ctype: str, cache: str, head: bool):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head:
            try:
                self.wfile.write(data)
            except (ConnectionResetError, BrokenPipeError):
                self.close_connection = True

    def _redirect(self, location: str, head: bool):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


# --------------------------------------------------------------------- main --
def main() -> int:
    _setup_logging()
    logging.info("--- mixer server starting pid=%d host=%s port=%d ---",
                 os.getpid(), HOST, PORT)

    existing = _existing_instance()
    if existing:
        logging.error("another mixer server (pid %d) already owns %s", existing, DATA)
        return 2

    missing = jobs.check_dependencies()
    if missing:
        logging.error("missing dependency: %s", ", ".join(missing))
        return 2

    jobs.init()
    _load_library()

    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as exc:
        logging.error("cannot listen on %s:%d: %s", HOST, PORT, exc)
        return 2

    _write_pid()
    logging.info("listening on http://%s:%d/",
                 HOST, PORT, PORT)
    logging.info("data dir: %s", DATA)

    def _stop(signum, frame):
        logging.info("signal %s received; stopping", signum)
        jobs.stop_active_child()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    try:
        httpd.serve_forever(poll_interval=0.5)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        logging.info("shutting down")
        jobs.stop_active_child()
        httpd.server_close()
        _remove_pid()
    return 0


if __name__ == "__main__":
    sys.exit(main())
