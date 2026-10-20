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
    for i in range(40):
        d=diag(page)
        if d and d.get("playing"): break
        page.wait_for_timeout(500)
    page.wait_for_timeout(10000)
    out["beforeSeek"]=diag(page)
    out["buffered"]=(out["beforeSeek"].get("video") or {}).get("buffered")
    target=page.evaluate("""() => { const v=document.querySelector('video'); let e=0; for(let i=0;i<v.buffered.length;i++) e=Math.max(e,v.buffered.end(i)); return Math.max(v.currentTime+5, Math.min(e-4, 90)); }""")
    out["target"]=round(target,2)
    page.evaluate("t => { const v=document.querySelector('video'); v.currentTime=t; }", target)
    resumed=False
    for i in range(60):
        page.wait_for_timeout(500)
        d=diag(page); vv=d.get("video") or {}
        if vv.get("readyState",0)>=2 and not vv.get("paused") and vv.get("currentTime",0)>target+1.0:
            resumed=True; break
    out["seekResumed"]=resumed
    page.wait_for_timeout(2500)
    out["afterSeek"]=diag(page)
    # pause/play
    page.evaluate("() => document.querySelector('video').pause()")
    page.wait_for_timeout(1000)
    out["paused"]=diag(page)
    page.evaluate("() => { const v=document.querySelector('video'); const q=v.play(); if(q&&q.catch)q.catch(()=>{}); }")
    page.wait_for_timeout(4000)
    out["resumed"]=diag(page)
    page.screenshot(path=EXT+"/shots/sync_probe.png")
    ctx.close()
for k in ["beforeSeek","afterSeek","paused","resumed"]:
    d=out.get(k) or {}
    print(k, json.dumps({kk:d.get(kk) for kk in ("playing","sources","driftMs","maxDriftMs","reanchors","buffering","statusText","video")}, indent=1))
    print(" log", (d.get("reanchorLog") or [])[-12:])
print("target",out["target"],"resumed",out["seekResumed"],"buffered",out["buffered"])
