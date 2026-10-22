#!/usr/bin/env python3
import json, time
from playwright.sync_api import sync_playwright
EXT="<path>"; VID="v6j8ZlhMkeU"
PROFILE="<path>"
URL="https://www.youtube.com/watch?v="+VID+"&hl=en&gl=US"
ARGS=["--no-sandbox","--no-first-run","--enable-unsafe-webgpu","--ignore-gpu-blocklist","--enable-features=Vulkan","--use-vulkan=native","--disable-vulkan-surface","--autoplay-policy=no-user-gesture-required"]
def diag(page):
    try: return page.evaluate("() => { const d=document.getElementById('stems-diag'); try { return d?JSON.parse(d.textContent):null; } catch(e){ return {parseError:String(e)}; } }")
    except Exception as e: return {"evalError":str(e)[:200]}
def ad(page): return page.evaluate("() => { const p=document.querySelector('#movie_player'); return !!(p&&p.classList.contains('ad-showing')); }")
out={}
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context(PROFILE, executable_path="/usr/bin/google-chrome", headless=False,
        args=ARGS, viewport={"width":1280,"height":800}, ignore_default_args=["--disable-extensions"])
    page=ctx.pages[0] if ctx.pages else ctx.new_page()
    ctx.browser.new_browser_cdp_session().send("Extensions.loadUnpacked",{"path":EXT})
    page.goto(URL, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_function("() => !!document.querySelector('video')", timeout=60000)
    page.wait_for_timeout(2500)
    while ad(page): page.wait_for_timeout(1000)
    page.click("#stems-toggle"); page.click("#stems-start")
    for i in range(30):
        d=diag(page)
        if d and d.get("playing"): break
        page.wait_for_timeout(500)
    page.wait_for_timeout(4000)
    out["base"]=diag(page)
    # rate change
    try:
        page.evaluate("() => { const p=document.querySelector('#movie_player'); if(p&&p.setPlaybackRate) p.setPlaybackRate(1.25); const v=document.querySelector('video'); v.playbackRate=1.25; }")
    except Exception as e: out["rateErr"]=str(e)[:200]
    page.wait_for_timeout(4000)
    out["rate125"]=diag(page)
    out["rate125Sources"]=page.evaluate("() => document.querySelectorAll('video').length")
    # back to 1
    try:
        page.evaluate("() => { const p=document.querySelector('#movie_player'); if(p&&p.setPlaybackRate) p.setPlaybackRate(1); const v=document.querySelector('video'); v.playbackRate=1; }")
    except Exception as e: out["rateErr2"]=str(e)[:200]
    page.wait_for_timeout(3000)
    out["rate1"]=diag(page)
    # synthetic ad class
    try:
        page.evaluate("() => document.querySelector('#movie_player').classList.add('ad-showing')")
        page.wait_for_timeout(1500)
        out["adOn"]=diag(page)
        page.evaluate("() => document.querySelector('#movie_player').classList.remove('ad-showing')")
        page.wait_for_timeout(3000)
        out["adOff"]=diag(page)
    except Exception as e: out["adErr"]=str(e)[:300]
    # tab switch
    try:
        other=ctx.new_page()
        other.goto("https://example.com/", wait_until="domcontentloaded", timeout=60000)
        other.bring_to_front()
        time.sleep(5)
        page.bring_to_front()
        page.wait_for_timeout(2500)
        out["afterTab"]=diag(page)
        other.close()
    except Exception as e: out["tabErr"]=str(e)[:300]
    page.screenshot(path=EXT+"/shots/rate_tab.png")
    ctx.close()
for k in ["base","rate125","rate1","adOn","adOff","afterTab"]:
    d=out.get(k) or {}
    print(k, json.dumps({kk:d.get(kk) for kk in ("playing","sources","driftMs","maxDriftMs","reanchors","masterRms","buffering","statusText","anchor","video","error")}, indent=1))
    print(" log", (d.get("reanchorLog") or [])[-6:])
print({k:out[k] for k in out if k.endswith("Err")})
