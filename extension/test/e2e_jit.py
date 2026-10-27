#!/usr/bin/env python3
"""E2E for just-in-time separation on a real YouTube watch page.

    python3 extension/test/e2e_jit.py [video_id]

Measures click -> first stems audible, checks the video never pauses, seeks
into an unseparated region and measures how fast stems return there, then
waits for the whole song and reloads it from cache. Needs Playwright and
Google Chrome (macOS or Linux), and the model/vendor assets in extension/.
"""
import json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, ".."))
VID = sys.argv[1] if len(sys.argv) > 1 else "v6j8ZlhMkeU"
URL = "https://www.youtube.com/watch?v=" + VID + "&hl=en&gl=US"
CHROME = next(p for p in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"] if os.path.exists(p))
PROFILE = tempfile.mkdtemp(prefix="stems-e2e-jit-")
ARGS = ["--no-first-run", "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-extension-debugging"]
out = {"video": VID}
logs = []


def diag(page):
    try:
        return page.evaluate("() => { const d=document.getElementById('stems-diag'); try { return d?JSON.parse(d.textContent):null; } catch(e){ return null; } }") or {}
    except Exception:
        return {}


def rss_mb():
    ps = subprocess.run(["ps", "-axo", "rss=,command="], capture_output=True, text=True).stdout
    return round(sum(int(l.split(None, 1)[0]) for l in ps.splitlines() if PROFILE in l) / 1024)


def stems_live(d):
    return bool(d.get("partial") is not None and not d.get("gap") and d.get("sources", 0) > 0 and (d.get("masterRms") or 0) > 1e-4)


def wait_until(page, pred, timeout, every=100):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = diag(page)
        if pred(d):
            return round(time.time() - t0, 2), d
        page.wait_for_timeout(every)
    return None, diag(page)


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(PROFILE, executable_path=CHROME, headless=False, args=ARGS,
                                               viewport={"width": 1280, "height": 800},
                                               ignore_default_args=["--disable-extensions"])
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    out["extension"] = ctx.browser.new_browser_cdp_session().send("Extensions.loadUnpacked", {"path": EXT})
    ctx.add_cookies([{"name": "SOCS", "value": "CAI", "domain": ".youtube.com", "path": "/"},
                     {"name": "CONSENT", "value": "YES+", "domain": ".youtube.com", "path": "/"}])
    page.on("console", lambda m: logs.append(m.type + ": " + m.text[:300]) if "[stems]" in m.text else None)
    page.goto(URL, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function("() => { const v=document.querySelector('video'); return v && v.readyState >= 2; }", timeout=60000)
    page.wait_for_timeout(2500)
    wait_until(page, lambda d: not d.get("ad"), 120, 1000)
    page.evaluate("() => { const v=document.querySelector('video'); v.currentTime = 20; v.play(); }")
    page.wait_for_timeout(1500)
    page.click("#stems-toggle")
    page.wait_for_timeout(300)
    out["rssBeforeMB"] = rss_mb()

    page.click("#stems-start")
    paused_seen = False
    t_first, d = None, {}
    t0 = time.time()
    while time.time() - t0 < 180:
        d = diag(page)
        if (d.get("video") or {}).get("paused"):
            paused_seen = True
        if d.get("error"):
            break
        if stems_live(d):
            t_first = round(time.time() - t0, 2)
            break
        page.wait_for_timeout(100)
    out["clickToStemsSec"] = t_first
    out["atFirstStems"] = {k: d.get(k) for k in ("statusText", "chunksReady", "meta", "masterRms", "error")}
    out["atFirstStems"]["mediaTime"] = (d.get("video") or {}).get("currentTime")
    out["videoPausedDuringStart"] = paused_seen
    if t_first is None:
        shot = os.path.join(tempfile.gettempdir(), "stems-e2e-jit-stall.png")
        page.screenshot(path=shot)
        out["stallScreenshot"] = shot
        out["logs"] = logs
        out["diag"] = d
        ctx.close()
        print(json.dumps(out, indent=1))
        sys.exit(1)

    page.wait_for_timeout(6000)
    d = diag(page)
    out["after6s"] = {"live": stems_live(d), "drift": d.get("driftMs"), "chunksReady": d.get("chunksReady"), "muted": (d.get("video") or {}).get("muted")}

    # seek well ahead of anything separated so far
    page.evaluate("() => { const v=document.querySelector('video'); v.currentTime = 150; }")
    page.wait_for_timeout(300)
    d = diag(page)
    out["seekGapOriginalAudio"] = {"gap": d.get("gap"), "muted": (d.get("video") or {}).get("muted")}
    t_seek, d = wait_until(page, stems_live, 60)
    out["seekToStemsSec"] = t_seek
    out["afterSeek"] = {"mediaTime": (d.get("video") or {}).get("currentTime"), "drift": d.get("driftMs"), "chunksReady": d.get("chunksReady")}

    t_done, d = wait_until(page, lambda d: d.get("partial") is False and d.get("phase") in ("ready", "playing"), 400, 1000)
    out["clickToCompleteSec"] = round(time.time() - t0, 1)
    out["timings"] = d.get("timings")
    out["rssPeakAfterMB"] = rss_mb()
    out["stemRms"] = d.get("stemRms")

    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("() => { const v=document.querySelector('video'); return v && v.readyState >= 2; }", timeout=60000)
    page.wait_for_timeout(2500)
    wait_until(page, lambda d: not d.get("ad"), 120, 1000)
    page.click("#stems-toggle")
    wait_until(page, lambda d: d.get("cached") is True, 10)
    t1 = time.time()
    page.click("#stems-start")
    t_cache, d = wait_until(page, lambda d: d.get("phase") in ("ready", "playing") and d.get("sources", 0) > 0, 20)
    out["cachedReloadToPlayingSec"] = t_cache
    ctx.close()

shutil.rmtree(PROFILE, ignore_errors=True)
out["logsTail"] = logs[-20:]
print(json.dumps(out, indent=1))
