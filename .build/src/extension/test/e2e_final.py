#!/usr/bin/env python3
"""Final E2E: fresh separation, playback, seek, pause/play, emphasis, cache reload."""
import json, sys, time, shutil, os, subprocess
from playwright.sync_api import sync_playwright

EXT = "<path>"
VID = sys.argv[1] if len(sys.argv) > 1 else "v6j8ZlhMkeU"
PROFILE = "<path>"
if len(sys.argv) < 3 or sys.argv[2] != "reuse":
    shutil.rmtree(PROFILE, ignore_errors=True)
URL = "https://www.youtube.com/watch?v=" + VID + "&hl=en&gl=US"
ARGS = ["--no-sandbox","--no-first-run","--enable-unsafe-webgpu","--ignore-gpu-blocklist",
        "--enable-features=Vulkan","--use-vulkan=native","--disable-vulkan-surface",
        "--autoplay-policy=no-user-gesture-required"]
logs = []
out = {"video": VID, "profile": PROFILE}

def diag(page):
    try:
        return page.evaluate("() => { const d=document.getElementById('stems-diag'); try { return d?JSON.parse(d.textContent):null; } catch(e){ return {parseError:String(e)}; } }")
    except Exception as e:
        return {"evalError": str(e)[:200]}
def ad(page):
    return page.evaluate("() => { const p=document.querySelector('#movie_player'); return !!(p&&p.classList.contains('ad-showing')); }")
def wait_no_ad(page, timeout=90):
    end=time.time()+timeout
    while time.time()<end:
        if not ad(page): return True
        page.wait_for_timeout(1000)
    return False
def rss_mb():
    try:
        out = subprocess.check_output(["ps","-eo","rss=,args="], text=True)
        total = 0
        for line in out.splitlines():
            if PROFILE in line:
                total += int(line.strip().split()[0])
        return round(total/1024,1)
    except Exception:
        return None

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(PROFILE, executable_path="/usr/bin/google-chrome",
        headless=False, args=ARGS, viewport={"width":1280,"height":800},
        ignore_default_args=["--disable-extensions"])
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    cdp = ctx.browser.new_browser_cdp_session()
    out["extension"] = cdp.send("Extensions.loadUnpacked", {"path": EXT})
    ctx.add_cookies([{"name":"SOCS","value":"CAI","domain":".youtube.com","path":"/"},
                     {"name":"CONSENT","value":"YES+","domain":".youtube.com","path":"/"}])
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)))
    page.goto(URL, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function("() => !!document.querySelector('video') && document.querySelector('video').readyState >= 2", timeout=60000)
    page.wait_for_timeout(2500)
    page.click("#stems-toggle")
    page.wait_for_timeout(300)
    out["cacheBefore"] = diag(page).get("cached")
    wait_no_ad(page)
    out["rssBeforeMB"] = rss_mb()
    t0 = time.time()
    page.click("#stems-start")
    out["clickedAt"] = time.strftime("%H:%M:%S")
    first = None
    last_print = 0
    deadline = time.time() + 300
    while time.time() < deadline:
        d = diag(page)
        if d and d.get("phase") in ("ready", "playing", "error"):
            first = d
            break
        pr = (d or {}).get("progress")
        if pr and time.time()-last_print > 8:
            print("progress", pr.get("done"), "/", pr.get("total"), "rtf", round(pr.get("rtf") or 0,3), "eta", round((pr.get("etaMs") or 0)/1000), flush=True)
            last_print = time.time()
        page.wait_for_timeout(1000)
    out["readyWaitSec"] = round(time.time()-t0, 1)
    out["rssAfterSeparateMB"] = rss_mb()
    out["afterReady"] = first

    if not first or first.get("phase") == "error":
        out["error"] = (first or {}).get("error") or "no ready state"
        page.screenshot(path=EXT+"/shots/final_fail.png")
        print(json.dumps(out, indent=1)[:12000])
        print("LOGS", json.dumps(logs[-30:], indent=1)[:5000])
        ctx.close(); raise SystemExit(1)

    # wait for playing
    for i in range(20):
        page.wait_for_timeout(500)
        d = diag(page)
        if d and d.get("playing"): break
    if not diag(page).get("playing"):
        try:
            page.evaluate("() => { const pl=document.querySelector('#movie_player'); if(pl&&pl.playVideo) pl.playVideo(); const v=document.querySelector('video'); if(v&&v.paused){const q=v.play(); if(q&&q.catch)q.catch(()=>{});} }")
        except Exception as e:
            out["playNudgeErr"] = str(e)[:200]
        page.wait_for_timeout(2500)
    out["playing"] = diag(page)
    out["rssPlayingMB"] = rss_mb()

    # seek to a buffered point (within the current buffered range if possible)
    try:
        target = page.evaluate("""() => {
          const v=document.querySelector('video'); let best=null;
          for (let i=0;i<v.buffered.length;i++){ const s=v.buffered.start(i), e=v.buffered.end(i); if (s <= v.currentTime && e > v.currentTime+4) best={s,e}; }
          if (!best) return Math.min(v.duration-8, v.currentTime+20);
          return Math.min(best.e-6, Math.max(v.currentTime+5, best.s+10));
        }""")
        out["seekTarget"] = round(target,2)
        re_before = diag(page).get("reanchors")
        page.evaluate("t => { const v=document.querySelector('video'); v.currentTime=t; }", target)
        # wait for playback to resume from buffer
        resumed = False
        for i in range(40):
            page.wait_for_timeout(500)
            d = diag(page)
            v = d.get("video") or {}
            if v.get("readyState",0) >= 2 and not v.get("paused") and (v.get("currentTime",0) > target + 0.3):
                resumed = True; break
        out["seekResumed"] = resumed
        page.wait_for_timeout(3000)
        out["afterSeek"] = diag(page)
        out["seekReanchorDelta"] = (out["afterSeek"].get("reanchors") or 0) - (re_before or 0)
    except Exception as e:
        out["seekErr"] = str(e)[:300]

    # pause / play
    try:
        page.evaluate("() => document.querySelector('video').pause()")
        page.wait_for_timeout(1200)
        out["paused"] = diag(page)
        page.evaluate("() => { const v=document.querySelector('video'); const q=v.play(); if(q&&q.catch)q.catch(()=>{}); }")
        page.wait_for_timeout(2500)
        out["resumed"] = diag(page)
    except Exception as e:
        out["pausePlayErr"] = str(e)[:300]

    # emphasis vocals
    try:
        page.click('[data-stem="3"]')
        page.wait_for_timeout(2000)
        out["emphVocals"] = diag(page)
        page.screenshot(path=EXT+"/shots/final_playing.png")
    except Exception as e:
        out["emphErr"] = str(e)[:300]

    out["logsFirstRun"] = logs[-50:]
    out["totalFirstRunSec"] = round(time.time()-t0, 1)

    # ---- cache reload ----
    print("reloading for cache test", flush=True)
    page.reload(wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function("() => !!document.querySelector('video')", timeout=60000)
    page.wait_for_timeout(2500)
    page.click("#stems-toggle"); page.wait_for_timeout(300)
    wait_no_ad(page)
    out["cacheBeforeReload"] = diag(page).get("cached")
    t2 = time.time()
    page.click("#stems-start")
    cached = None
    for i in range(60):
        d = diag(page)
        if d and d.get("phase") in ("ready", "playing", "error"):
            cached = d; break
        page.wait_for_timeout(250)
    out["cacheWaitSec"] = round(time.time()-t2, 2)
    out["cacheReady"] = cached
    out["cacheHit"] = bool(cached and cached.get("cached"))
    page.wait_for_timeout(4500)
    out["cachePlaying"] = diag(page)
    out["rssCacheMB"] = rss_mb()
    page.screenshot(path=EXT+"/shots/final_cache.png")
    out["totalSec"] = round(time.time()-t0, 1)
    out["logsTail"] = logs[-25:]
    ctx.close()

# summarize
r = out.get("afterReady") or {}
t = r.get("timings") or {}
out["summary"] = {
    "readyWaitSec": out.get("readyWaitSec"),
    "separateSec": round((t.get("separateMs") or 0)/1000,1),
    "rtfWorker": t.get("rtf"),
    "chunks": t.get("chunks"),
    "engineSec": round((t.get("engineMs") or 0)/1000,1),
    "cacheWriteSec": round((t.get("cacheWriteMs") or 0)/1000,1),
    "audioSec": round((r.get("meta") or {}).get("duration") or 0,1),
    "stemRms": (r.get("stats") or {}).get("stemRms") or r.get("stemRms"),
    "stemPeak": (r.get("stats") or {}).get("stemPeak") or r.get("stemPeak"),
    "corrMin": r.get("corrMin"), "corrMax": r.get("corrMax"),
    "masterTrimDb": (out.get("playing") or {}).get("masterTrimDb"),
    "playRms": (out.get("playing") or {}).get("masterRms"),
    "playPeak": (out.get("playing") or {}).get("masterPeak"),
    "seekDriftMs": (out.get("afterSeek") or {}).get("driftMs"),
    "seekMaxDriftMs": (out.get("afterSeek") or {}).get("maxDriftMs"),
    "seekReanchorDelta": out.get("seekReanchorDelta"),
    "resumedPlaying": (out.get("resumed") or {}).get("playing"),
    "cacheWaitSec": out.get("cacheWaitSec"),
    "cacheHit": out.get("cacheHit"),
    "cachePlayRms": (out.get("cachePlaying") or {}).get("masterRms"),
    "rssAfterSeparateMB": out.get("rssAfterSeparateMB"),
    "rssPlayingMB": out.get("rssPlayingMB"),
}
os.makedirs(EXT+"/test/results", exist_ok=True)
open(EXT+"/test/results/final.json","w").write(json.dumps(out, indent=1))
print(json.dumps(out["summary"], indent=1))
print("FULL RESULTS SAVED", EXT+"/test/results/final.json")
