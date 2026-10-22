#!/usr/bin/env python3
import json, time, shutil
from playwright.sync_api import sync_playwright
EXT="<path>"; VID="v6j8ZlhMkeU"
PROFILE="<path>"; shutil.rmtree(PROFILE, ignore_errors=True)
ARGS=["--no-sandbox","--no-first-run","--enable-unsafe-webgpu","--ignore-gpu-blocklist","--enable-features=Vulkan","--use-vulkan=native","--disable-vulkan-surface","--autoplay-policy=no-user-gesture-required"]
logs=[]
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context(PROFILE, executable_path="/usr/bin/google-chrome", headless=False,
        args=ARGS, viewport={"width":1280,"height":800}, ignore_default_args=["--disable-extensions"])
    page=ctx.pages[0] if ctx.pages else ctx.new_page()
    ctx.browser.new_browser_cdp_session().send("Extensions.loadUnpacked",{"path":EXT})
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append("pageerror: "+str(e)))
    # start on the home page (SPA navigation into a watch page)
    page.goto("https://www.youtube.com/", wait_until="domcontentloaded", timeout=90000)
    page.wait_for_timeout(3000)
    print("home has root:", page.evaluate("() => !!document.getElementById('stems-yt-root')"))
    # click a video card
    page.goto("https://www.youtube.com/results?search_query=JP+Saxe+3+Minutes", wait_until="domcontentloaded", timeout=90000)
    page.wait_for_timeout(3000)
    link=page.evaluate("""() => { const a=document.querySelector('a#video-title, a#thumbnail'); return a?{href:a.href,text:a.textContent.trim()}:null; }""")
    print("link", link)
    if link:
        page.click("a#video-title, a#thumbnail", timeout=10000)
    page.wait_for_timeout(7000)
    info=page.evaluate("""() => {
      const root=document.getElementById('stems-yt-root');
      const st=document.getElementById('stems-status');
      return {url:location.href, hasRoot:!!root, status:st?st.textContent:null,
              panel:document.getElementById('stems-panel')?!document.getElementById('stems-panel').hidden:null,
              diag:(document.getElementById('stems-diag')||{}).textContent};
    }""")
    print(json.dumps(info, indent=1)[:4000])
    page.screenshot(path=EXT+"/shots/spa_nav.png")
    ctx.close()
print("logs", json.dumps([l for l in logs if "stems" in l.lower() or "error" in l.lower()][-20:], indent=1)[:3000])
