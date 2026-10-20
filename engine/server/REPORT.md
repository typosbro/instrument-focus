# Verification report — mixer server

**Verdict: end-to-end pass on a real third song. 6/6 stems present, page served
and playable, offline copy playable, 141.7 s end to end.**

Date: 2026-10-20 (Asia/Seoul). Box: pc, 20 cores, 15 GB RAM, CPU-only torch.

## The test song

| | |
| --- | --- |
| Title | a test song (Official HD Video) |
| URL | https://www.youtube.com/watch?v=FTQbiNvZqaY |
| Duration | 271.36 s |
| Job id | `b3033cdf8cfd` |
| Page | http://localhost:8484/song/b3033cdf8cfd/ |
| Why this one | not song-a (a test song

Submitted with a single `POST /api/jobs`. Observed
`queued -> running -> downloading -> separating -> measuring -> preparing ->
rendering -> done` with the percentage moving throughout the 78 s demucs pass.

## Stage timings (from the job record)

| Stage | Seconds | What it did |
| --- | ---: | --- |
| queue wait | 0.0 | no job ahead of it |
| resolving | 2.58 | `yt-dlp --skip-download --print`, title + duration |
| downloading | 3.88 | audio to WAV (fast link to YouTube) |
| separating | 77.72 | `demucs htdemucs_6s -d cpu` |
| measuring | 0.92 | per-stem RMS via `build_song.py` |
| preparing | 18.12 | `build_song.py`'s own 128 kbps preview encode (unused by this server) |
| rendering | 38.53 | `build_offline.py`: loudness, MP3s, base64, HTML |
| **total** | **141.7** | 2 min 21.7 s |

The sum of the stages is 141.75 s; total is wall clock from job start. No stage
failed, no retry.

## Page result

| | |
| --- | --- |
| Page size | **26,123,189 bytes (24.91 MiB)** |
| Encoding | 96 kbps MP3 per present stem, base64 inside the HTML |
| Duration in page | 271.36 s |
| Present stems | 6 / 6 |

Stem measurements (dBFS, absent threshold -45):

| Stem | dBFS | Present |
| --- | ---: | --- |
| drums | -20.86 | yes |
| piano | -37.12 | yes |
| guitar | -24.94 | yes |
| bass | -22.80 | yes |
| vocals | -20.36 | yes |
| other | -24.81 | yes |

The page's manifest and the API agree exactly (channel ids and presence). The
mixer strip order in the DOM was drums, bass, piano, guitar, vocals, other;
`FOUND 6/6 STEMS` and `ALL STEMS CARRY SIGNAL` are visible in the screenshot.

## Playback / browser evidence

Served page, headless Chrome, autoplay forced off so the real click path ran:

- load 0.25 s, `window.__ready === true` after 4.36 s (26 MB parse + decode)
- before click: `AudioContext = suspended`, playing false, tap overlay shown
- after clicking `#play`: `AudioContext = running`, playing true
- seek to 120 s, 14 analyser samples: max RMS `0.37802`, max peak 0.9065
- 0 console errors, 0 page errors, 0 requests beyond the page itself

Same HTML from `file://` (the "keep it and open it later" promise):

- ready in 4.8 s
- `AudioContext = running`, playing true
- max RMS `0.389338`, 0 console errors

Frontend at http://127.0.0.1:8484/ (and reachable on the tailnet):

- both ready-made songs listed (song-a 16.5 MB, song-b 13.9 MB)
- the finished test job listed as `DONE`, 100%, "built in 2:22", 24.9 MB,
  "DRUMS · BASS · PIANO · GUITAR · VOCALS · OTHER", Open mixer and download links
- 0 console errors, no external requests

Screenshots (read, not just captured):

- `shots/frontend.png` — queue page with library and finished job
- `shots/mixer.png` — finished mixer at 122.933 s, six strips, all meters live
- `shots/verify.json` — machine-readable full record

## Restart / persistence / failure checks

- `restart.sh`: stopped the old supervisor group, started a new server,
  health check passed. Job record, page URL and both library songs survived.
- `kill -9` on the server PID: supervisor restarted it in about 2.5 s; health
  OK; `/song/b3033cdf8cfd/` still returned 200 with 26,123,189 bytes.
- Dead video id `aaaaaaaaaaa`: job reached `running -> failed` in seconds with
  "could not read the video: ERROR: [youtube] aaaaaaaaaaa: This video is
  unavailable". Server stayed healthy, queue 0. That test record was removed
  from history afterwards so the user's queue stays clean.
- URL validation: non-YouTube hosts, `file://`, credentials, playlist URLs and
  whitespace/control characters rejected with 400. Playlist parameters are
  stripped; only the single video id is passed to `yt-dlp`.
- `/song/../../etc/passwd` and `/song/<id>/../../jobs.json` both 404.
- Tailnet interface: `curl http://localhost:8484/healthz` from the box OK.

## Resource use

- demucs: 2,076,864 KiB RSS (about 2.0 GiB), ~1300% CPU; system available fell
  to about 3 GB during separation.
- Job temp peak: about 0.7 GB (WAV source, six float32 stems, two sets of MP3s).
- After completion: `data/tmp` empty, job directory kept only page.html +
  metrics.json + manifest.json (25 MB total).
- `data/` total after verification: 36 MB. Root filesystem: 225 GB free.
- No swap thrash observed, but the box is already busy; one worker only.

## What broke (and what was fixed)

1. **Temp sweep only removed directories.** Early probe files left directly in
   `data/tmp/` survived startup. Fixed in `jobs.py::_clean_temp` to unlink plain
   files as well as remove directories. `data/tmp` is empty after restart.
2. **Duplicate resolve timing.** The stored first record had both `resolve` and
   `resolving` at 2.58 s because a manual timing was added on top of the stage
   clock. Removed the manual entry in `run_job`; new jobs report only
   `resolving`. The legacy record was normalized.
3. **Offline playback test sampled the first 30 ms.** The first verification
   run measured RMS 4e-06 on the `file://` page because the headless audio clock
   had only advanced 0.03 s when samples were taken. This was a test bug, not a
   page bug: re-running with a seek to 120 s produced RMS 0.389–0.404. The test
   now seeks before sampling and asserts `ctx == "running"`.
4. **`build_song.py` encodes unused preview MP3s for 18.1 s.** Its stage 4 is
   not used by this server because `build_offline.py` re-encodes at 96 kbps. Left
   in place deliberately: the instruction was to reuse the verified script
   unmodified, so the time is reported as its own "preparing" stage rather than
   hidden inside "measuring".
5. **`yt-dlp` warns that YouTube extraction without a JS runtime is deprecated.**
   Bestaudio still worked on this run. If YouTube tightens extraction, a Deno
   runtime (or `--js-runtimes`) will be needed. Not installed.
6. **Page is 25 MB.** Expected at 96 kbps with six full-length stems. 0.26 s to
   load over localhost, 4.5 s to decode in Chrome. Over the tailnet the download
   time will dominate, not the server.
7. **Inherited loudness finding.** `build_offline.py` trims presets to -16 LUFS
   without true-peak limiting; measured preset true peaks were up to +4.5 dBTP
   (piano/other) before the page's `DynamicsCompressor` at -1 dB. The served
   page's pre-limiter analyser peaked at 1.015. This is inherited from the
   existing a7 builder, which was explicitly left unmodified. If the user hears
   clipping on drum/piano emphasis, the fix belongs in `build_offline.py` (a
   limiter pass like `build_manifest.py` uses), not in this server.
8. **Post-build channel merge read the wrong key.** `build_offline.py` writes
   `stem_measure`, but `_metrics_channels()` looked for `stems`, so the API
   silently kept `build_song.py`'s channels and never gained LUFS/solo trims.
   Fixed to accept both keys, and the finished test record was backfilled. A
   19 s regression job ("Me at the zoo", 5e3335440bbb) exercised the fixed path
   end to end: 2 present / 4 absent stems, a 676,042-byte page, 14.5 s total,
   and playback at RMS 0.126 with 0 console errors. That test record and page
   were removed afterwards, so the only job left in history is the real song.

## Exact restart command

```bash
the project tree
```

Server is running now as a supervised background process:

- supervisor `supervise.sh` (setsid, own process group)
- child `python3 -u server.py` listening on `0.0.0.0:8484`
- current PID is in `data/server.pid`; health at `/healthz`
