# Mixer Queue server

Turns any YouTube link into **one self-contained mixer HTML page**. Runs on this
Linux box (a private network address) and is reached from the Mac at
`http://localhost:8484/`.

No new dependencies: Python standard library only, plus the tools that were
already installed (`yt-dlp`, `ffmpeg`, `demucs`). Stem separation runs on CPU,
one job at a time.

## URLs

| URL | What |
| --- | --- |
| `http://localhost:8484/` | queue UI (also `http://127.0.0.1:8484/` on the box) |
| `http://localhost:8484/song/<id>/` | the finished single-file mixer page |
| `http://localhost:8484/library/library page` | existing local song A |
| `http://localhost:8484/library/library page` | existing local song B |
| `http://localhost:8484/healthz` | liveness, queue counters, free disk |

## Restart (exact command)

```bash
the project tree
```

It stops the old supervisor/server, waits for the port, starts the supervisor
detached with `setsid`, and only reports success after `/healthz` answers. It
prints the local and tailnet URLs and the new PID.

Start and restart are the same command; there is no separate "start" path.
Logs are appended, not rotated on restart.

To stop without starting again:

```bash
kill -TERM -- "-$(cat the project tree)"
```

The supervisor (`supervise.sh`) restarts `server.py` if it ever exits with a
non-zero status. Exit code 2 (bad config, missing dependency, port already
taken) is treated as fatal and is not retried.

## API

`POST /api/jobs` — body `{"url": "https://www.youtube.com/watch?v=..."}` —
returns `202 {"id": "...", "status": "queued"}` immediately. Only YouTube
`http(s)` video URLs are accepted; playlists, radio links and non-YouTube hosts
are rejected with 400. The URL is canonicalised to a single video id before it
reaches `yt-dlp`.

`GET /api/jobs/<id>` — the job:

```json
{
  "id": "b3033cdf8cfd",
  "status": "done",
  "stage": "done",
  "pct": 100,
  "title": "a test song (Official HD Video)",
  "duration": 271.36,
  "error": null,
  "page": "/song/b3033cdf8cfd/",
  "channels": [
    {"id": "drums", "label": "DRUMS", "present": true, "rms_dbfs": -20.86, "lufs": -18.5, "solo_gain_db": 0.5}
  ],
  "timings": {"resolving": 2.58, "downloading": 3.88, "separating": 77.72,
              "measuring": 0.92, "preparing": 18.12, "rendering": 38.53,
              "total": 141.7, "queue_wait": 0.0},
  "page_bytes": 26123189
}
```

`status` is one of `queued | running | done | failed`. `stage` is one of
`queued | resolving | downloading | separating | measuring | preparing |
rendering | done | failed`. The `channels` list always contains every stem,
with `present: false` for stems measured below -45 dBFS.

`GET /api/jobs` — `{"jobs": [...], "library": [...]}` for the UI.
`GET /api/jobs/<id>/log` — plain-text pipeline output for that job (last 200 KB).
`GET /song/<id>/` — the built page, served inline.
`GET /library/library page`, `/library/library page` — the two ready-made pages.

## Pipeline

Per job, one worker thread, in `jobs.py`:

1. **resolving** — `yt-dlp --skip-download --print` gets the real title and
   duration. A dead/private video fails here, in seconds, before any download.
2. **downloading** — `engine/build_song.py --url ... --out ...` runs `yt-dlp`
   to a WAV. `[download] NN%` lines become progress.
3. **separating** — the same script runs `demucs htdemucs_6s -d cpu`. The tqdm
   bar is read from stderr (including carriage returns), so the UI moves during
   the ~80 s CPU pass instead of sitting still.
4. **measuring** — `build_song.py` measures every stem and writes its manifest;
   stems below -45 dBFS are marked absent.
5. **preparing** — `build_song.py` also encodes its own 128 kbps preview MP3s.
   This server does not use them, but the script is reused unmodified, so the
   stage is reported honestly instead of hidden.
6. **rendering** — `slice/a7-offline/src/build_offline.py` measures loudness,
   trims the presets to -16 LUFS, encodes the present stems at 96 kbps and
   base64s them into one HTML file. Progress is the number of encoded MP3s
   appearing in the work directory.
7. **done** — page is moved to `data/jobs/<id>/page.html`, temp files deleted,
   job record persisted, page URL returned.

The page itself is the existing a7 template (`template.html` + `mixer.es5.js`);
this server does not modify it. It has no network calls, so the saved HTML also
works from `file://` (verified).

## Data on disk

Everything lives under `engine/server/data/`:

- `jobs.json` — durable job history, newest first (atomic replace on write).
- `jobs/<id>/page.html` — the finished single-file page; this is the keeper.
- `jobs/<id>/metrics.json`, `manifest.json` — small measurement records.
- `logs/<id>.log` — full pipeline output, including tracebacks on failure.
- `tmp/<id>/` — WAVs, stems and MP3 work; deleted in a `finally` block for
  every job, success or failure, and swept again at startup.
- `server.log` (rotating, 4 MB x 3), `server.out` (crash console output),
  `supervisor.log`, `server.pid`, `supervisor.pid`.

Finished pages are not deleted automatically. One 4.5-minute, six-stem song at
96 kbps is about 25 MB. Delete old `jobs/<id>/` directories and their records
if that ever matters.

## Failure handling

- Every stage is wrapped; exceptions set `status: failed`, store a short
  `error`, and append the full traceback to the job log. The worker then takes
  the next job.
- Child processes run in their own process group with a timeout, and are killed
  as a group (including any `ffmpeg` child) on timeout or server shutdown.
- On startup, pipeline processes orphaned by a previous crash are killed, temp
  directories are swept, jobs left `running` are marked failed ("server
  restarted while this job was running"), and jobs left `queued` are re-queued.
- `POST` bodies are capped at 8 KB; the queue is capped at 20 waiting jobs
  (503 when full).
- No `shell=True` anywhere. Commands are argv lists. The only user-controlled
  value that reaches a subprocess is a canonical
  `https://www.youtube.com/watch?v=<11-char-id>` URL.
- Page routes accept only 12-hex job ids; traversal attempts return 404.

## Files

| File | Purpose |
| --- | --- |
| `server.py` | HTTP routes, static/page serving, PID/singleton handling, signals |
| `jobs.py` | job store, URL validation, progress parsing, pipeline, worker |
| `index.html` | plain queue UI (no framework, no external assets) |
| `supervise.sh` | restart loop; started detached by `restart.sh` |
| `restart.sh` | stop + start + health check |
| `verify_e2e.py` | Playwright end-to-end check (frontend, page, audio, file://) |
| `shots/` | screenshots and `verify.json` from the last run |

Reused read-only from the existing project:

- `engine/build_song.py`
- `slice/a7-offline/src/build_offline.py`
- `slice/a7-offline/src/template.html`, `mixer.es5.js`
- `slice/a7-offline/library page`, `library page` (served in place, not copied)

## Notes / known limits

- One job at a time, by design: demucs used about 2 GB RSS and 13 cores on the
  verification job. Running two would fight for the 15 GB box.
- The page for a full song is big (about 25 MB for six stems at 96 kbps). It
  loads in under a second on localhost and is ready in about 4.5 s in Chrome
  while the audio decodes. That is the cost of a no-network single file.
- `yt-dlp` warns that YouTube extraction without a JS runtime (Deno) is
  deprecated. Downloads work today; if YouTube breaks extraction later, install
  Deno or add `--js-runtimes` support. Nothing was installed for this build.
- RAM is the scarce resource on this box, not disk (about 225 GB free). The
  server checks for 4 GB free disk before starting a job; there is no RAM guard.
- The server has no authentication. It is meant for the tailnet; it listens on
  `0.0.0.0:8484`, so anything that can reach this host on that port can queue
  jobs and read pages.
