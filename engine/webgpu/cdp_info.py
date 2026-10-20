import os
import json
from playwright.sync_api import sync_playwright

DEEP = """(() => {
  const out = [];
  function walk(root, depth) {
    if (!root || depth > 6) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { out.push(el.shadowRoot.textContent || ''); walk(el.shadowRoot, depth+1); }
    }
  }
  walk(document, 0);
  out.push(document.documentElement.innerText || '');
  return out.join('\n');
})()"""

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        os.path.expanduser("~/.cache/webgpu-spike-profile-cdp"),
        executable_path="/usr/bin/google-chrome", headless=False,
        args=["--headless=new", "--no-sandbox", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist",
              "--enable-features=Vulkan", "--disable-vulkan-surface"],
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    try:
        b = ctx.browser
        print("browser obj:", b is not None)
        if b:
            s = b.new_browser_cdp_session()
            info = s.send("SystemInfo.getInfo")
            gpu = info.get("gpu", {})
            print("featureStatus:", json.dumps(gpu.get("featureStatus", {}), indent=1))
            print("devices:", json.dumps([d.get("vendorId"), d.get("deviceId"), d.get("deviceString")] for d in gpu.get("devices", [])))
            print("aux:", json.dumps(gpu.get("auxAttributes", {}), indent=1)[:600])
    except Exception as e:
        print("cdp err", str(e)[:400])
    page.goto("chrome://gpu")
    page.wait_for_timeout(2000)
    txt = page.evaluate(DEEP)
    lines = [l.strip() for l in txt.splitlines() if l.strip()]
    keep = [l for l in lines if any(k in l.lower() for k in ("webgpu", "dawn", "vulkan", "blocklist", "software", "swiftshader"))]
    print("GPU PAGE MATCHES:", json.dumps(keep[:40], indent=1)[:4000])
    ctx.close()
