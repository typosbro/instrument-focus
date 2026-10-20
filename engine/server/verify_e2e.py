#!/usr/bin/env python3
"""End-to-end proof for the mixer server.

Checks a finished job in a real headless Chrome:
  - frontend renders the ready-made songs plus the finished job
  - the served /song/<id>/ page reaches window.__ready
  - the page's channels match the API manifest
  - clicking play starts a running AudioContext with non-zero signal
  - the same HTML also works from file:// (the keep-it-offline promise)

Writes shots/verify.json plus screenshots. Run it on the box, after a job is done:

  python3 verify_e2e.py --job <id>
"""
import argparse
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")


def get_json(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def wait_for_job(base, jid, timeout=1800):
    started = time.time()
    while time.time() - started < timeout:
        job = get_json(base + "/api/jobs/" + jid)
        if job.get("status") in ("done", "failed"):
            return job
        time.sleep(2)
    raise SystemExit("job %s did not finish within %ss" % (jid, timeout))


def snapshot_job(job):
    return {k: job.get(k) for k in
            ("id", "status", "stage", "pct", "title", "duration", "error", "page",
             "channels", "timings", "page_bytes")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8484")
    parser.add_argument("--job", default="")
    parser.add_argument("--shots", default=os.path.join(HERE, "shots"))
    parser.add_argument("--skip-offline", action="store_true")
    args = parser.parse_args()

    os.makedirs(args.shots, exist_ok=True)
    listing = get_json(args.base + "/api/jobs")
    if args.job:
        job = wait_for_job(args.base, args.job)
    else:
        done = [j for j in listing["jobs"] if j.get("status") == "done"]
        if not done:
            raise SystemExit("no finished job found")
        job = done[0]
    if job.get("status") != "done":
        print(json.dumps({"job": snapshot_job(job)}, indent=1))
        raise SystemExit("job is %s" % job.get("status"))

    out = {"base": args.base, "job": snapshot_job(job), "library": listing.get("library", []),
           "frontend": {}, "page": {}, "offline": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=CHROME,
            args=["--force-color-profile=srgb", "--hide-scrollbars",
                  "--autoplay-policy=user-gesture-required"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900},
                                      device_scale_factor=1)

        # ---------------------------------------------------------- frontend
        page = context.new_page()
        front = {"console": [], "pageerrors": [], "requests": []}
        page.on("console", lambda m: front["console"].append({"type": m.type, "text": m.text}))
        page.on("pageerror", lambda e: front["pageerrors"].append(str(e)))
        page.on("request", lambda r: front["requests"].append(r.url))
        page.goto(args.base + "/", wait_until="load", timeout=60000)
        page.wait_for_selector(".card.job", timeout=60000)
        page.wait_for_timeout(900)
        front["ui"] = page.evaluate("""() => ({
          title: document.title,
          library: Array.from(document.querySelectorAll('.lib')).map(c => ({
            title: c.querySelector('.lt').textContent,
            meta: c.querySelector('.meta').textContent,
            href: (c.querySelector('a.btn') || {}).href,
            download: (c.querySelector('a.save') || {}).getAttribute
              ? c.querySelector('a.save').getAttribute('download') : null
          })),
          jobs: Array.from(document.querySelectorAll('.card.job')).map(c => ({
            title: c.querySelector('.jt').textContent,
            status: c.querySelector('.pill').textContent,
            stage: c.querySelector('.stage span').textContent,
            pct: c.querySelector('.pct').textContent,
            bar: (c.querySelector('.bar i') || {}).style ? c.querySelector('.bar i').style.width : null,
            open: (c.querySelector('a.btn') || {}).href || null,
            error: (c.querySelector('.error') || {}).textContent || null
          })),
          footer: document.getElementById('status').textContent,
          noticeHidden: document.getElementById('notice').hidden
        })""")
        front["screenshot"] = os.path.join(args.shots, "frontend.png")
        page.screenshot(path=front["screenshot"], full_page=True)
        front["console_errors"] = [c for c in front["console"] if c["type"] == "error"]
        front["non_http_requests"] = [u for u in front["requests"]
                                      if not (u.startswith(args.base) or u.startswith("data:"))]
        out["frontend"] = front
        page.close()

        # --------------------------------------------------------- mixer page
        page = context.new_page()
        rec = {"url": args.base + job["page"], "console": [], "pageerrors": [], "requests": []}
        page.on("console", lambda m: rec["console"].append({"type": m.type, "text": m.text}))
        page.on("pageerror", lambda e: rec["pageerrors"].append(str(e)))
        page.on("request", lambda r: rec["requests"].append(r.url))
        t0 = time.time()
        page.goto(args.base + job["page"], wait_until="load", timeout=180000)
        rec["load_s"] = round(time.time() - t0, 2)
        page.wait_for_function("window.__ready === true", timeout=300000)
        rec["ready_s"] = round(time.time() - t0, 2)
        page.wait_for_timeout(500)
        rec["manifest"] = page.evaluate("window.__manifest()")
        rec["strips"] = page.evaluate("""() => Array.from(document.querySelectorAll('.ch')).map(c => ({
          stem: c.getAttribute('data-stem'),
          dead: c.classList.contains('dead'),
          name: (c.querySelector('.ch-name') || {}).textContent || null,
          sub: (c.querySelector('.ch-sub') || {}).textContent || null
        }))""")
        rec["audio_initial"] = page.evaluate("window.__debugAudio()")
        rec["state_initial"] = page.evaluate("window.__state()")

        # Safari-style blocked state, then a real click on the page's own button
        page.evaluate("window.__testBlocked()")
        page.wait_for_timeout(500)
        rec["waiting_before_click"] = {
            "playing": page.evaluate("window.__state().playing"),
            "ctx": page.evaluate("window.__debugAudio().ctx"),
            "tap": page.evaluate("document.getElementById('tap').className"),
        }
        page.click("#play")
        page.wait_for_timeout(1600)
        rec["state_playing"] = page.evaluate("window.__state()")
        rec["audio_playing"] = page.evaluate("window.__debugAudio()")
        page.evaluate("window.__seek(120)")
        page.wait_for_timeout(900)
        levels = []
        for _ in range(14):
            levels.append(page.evaluate("({level:window.__level(), state:window.__state(), audio:window.__debugAudio()})"))
            page.wait_for_timeout(120)
        rec["levels"] = levels
        rec["max_rms"] = max([x["level"]["rms"] for x in levels if x.get("level")] or [0])
        rec["max_peak"] = max([x["level"]["peak"] for x in levels if x.get("level")] or [0])
        rec["state_after_seek"] = page.evaluate("window.__state()")
        rec["screenshot"] = os.path.join(args.shots, "mixer.png")
        page.screenshot(path=rec["screenshot"])
        rec["console_errors"] = [c for c in rec["console"] if c["type"] == "error"]
        rec["console_warnings"] = [c for c in rec["console"] if c["type"] == "warning"]
        rec["non_page_requests"] = [u for u in rec["requests"] if u != rec["url"]]
        out["page"] = rec
        page.close()

        # ------------------------------------------------------------- file://
        if not args.skip_offline:
            offline_path = os.path.join(HERE, "data", "jobs", job["id"], "page.html")
            page = context.new_page()
            orec = {"url": "file://" + offline_path, "console": [], "pageerrors": []}
            page.on("console", lambda m: orec["console"].append({"type": m.type, "text": m.text}))
            page.on("pageerror", lambda e: orec["pageerrors"].append(str(e)))
            t0 = time.time()
            page.goto(orec["url"], wait_until="load", timeout=180000)
            page.wait_for_function("window.__ready === true", timeout=300000)
            orec["ready_s"] = round(time.time() - t0, 2)
            page.evaluate("window.__testBlocked()")
            page.wait_for_timeout(300)
            page.click("#play")
            page.wait_for_timeout(1000)
            page.evaluate("window.__seek(120)")
            page.wait_for_timeout(1200)
            levels = []
            for _ in range(12):
                levels.append(page.evaluate(
                    "({level:window.__level(), audio:window.__debugAudio(), state:window.__state()})"))
                page.wait_for_timeout(120)
            orec["state"] = page.evaluate("window.__state()")
            orec["ctx"] = levels[-1]["audio"]["ctx"]
            orec["max_rms"] = max([x["level"]["rms"] for x in levels if x.get("level")] or [0])
            orec["console_errors"] = [c for c in orec["console"] if c["type"] == "error"]
            out["offline"] = orec
            page.close()

        browser.close()

    with open(os.path.join(args.shots, "verify.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)

    present_api = [c["id"] for c in job.get("channels", []) if c.get("present")]
    present_page = [s.get("stem") for s in out["page"]["strips"] if not s.get("dead")]
    summary = {
        "job": job["id"],
        "title": job["title"],
        "status": job["status"],
        "page": args.base + job["page"],
        "page_bytes": job.get("page_bytes"),
        "timings": job.get("timings"),
        "channels_api": present_api,
        "channels_page": present_page,
        "channels_match": sorted(present_api) == sorted(present_page),
        "frontend_jobs": len(out["frontend"]["ui"]["jobs"]),
        "frontend_library": len(out["frontend"]["ui"]["library"]),
        "frontend_console_errors": len(out["frontend"]["console_errors"]),
        "mixer_load_s": out["page"]["load_s"],
        "mixer_ready_s": out["page"]["ready_s"],
        "mixer_ctx": out["page"]["audio_playing"]["ctx"],
        "mixer_playing": out["page"]["state_playing"]["playing"],
        "mixer_max_rms": round(out["page"]["max_rms"], 6),
        "mixer_console_errors": len(out["page"]["console_errors"]),
        "mixer_pageerrors": len(out["page"]["pageerrors"]),
        "offline_ready_s": out["offline"].get("ready_s"),
        "offline_playing": out["offline"].get("state", {}).get("playing"),
        "offline_ctx": out["offline"].get("ctx"),
        "offline_max_rms": round(out["offline"].get("max_rms") or 0, 6),
        "screenshots": [out["frontend"]["screenshot"], out["page"]["screenshot"]],
    }
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    ok = (job["status"] == "done" and summary["channels_match"]
          and summary["mixer_playing"] and summary["mixer_ctx"] == "running"
          and summary["mixer_max_rms"] > 0.0005
          and not summary["mixer_console_errors"] and not summary["mixer_pageerrors"]
          and summary["frontend_console_errors"] == 0
          and summary["offline_playing"] and summary["offline_ctx"] == "running"
          and summary["offline_max_rms"] > 0.0005)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
