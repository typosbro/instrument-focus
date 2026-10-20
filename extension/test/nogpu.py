#!/usr/bin/env python3
import json, time, shutil
from playwright.sync_api import sync_playwright
EXT="<path>"; VID="v6j8ZlhMkeU"
PROFILE="<path>"; shutil.rmtree(PROFILE, ignore_errors=True)
ARGS=["--no-sandbox","--no-first-run","--autoplay-policy=no-user-gesture-required"]
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context(PROFILE, executable_path="/usr/bin/google-chrome",
        headless=True, args=ARGS, viewport={"width":1280,"height":800}, ignore_default_args=["--disable-extensions"])
    page=ctx.pages[0] if ctx.pages else ctx.new_page()
    cdp=ctx.browser.new_browser_cdp_session(); print("ext", cdp.send("Extensions.loadUnpacked",{"path":EXT}))
    page.goto("https://www.youtube.com/watch?v="+VID, wait_until="domcontentloaded", timeout=90000)
    page.wait_for_timeout(5000)
    print("gpu", page.evaluate("() => typeof navigator.gpu"))
    try: page.click("#stems-toggle", timeout=8000)
    except Exception as e: print("click", str(e)[:200])
    page.wait_for_timeout(1000)
    info=page.evaluate("""() => {
      const root=document.getElementById('stems-yt-root');
      const st=document.getElementById('stems-status');
      const btn=document.getElementById('stems-start');
      return {hasRoot:!!root, status:st?st.textContent:null, disabled:btn?btn.disabled:null,
              label:btn?btn.textContent:null, diag:(document.getElementById('stems-diag')||{}).textContent,
              panelHidden:document.getElementById('stems-panel')?document.getElementById('stems-panel').hidden:null};
    }""")
    print(json.dumps(info, indent=1)[:5000])
    page.screenshot(path=EXT+"/shots/nogpu.png")
    ctx.close()
