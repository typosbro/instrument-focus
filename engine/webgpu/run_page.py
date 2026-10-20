import os
#!/usr/bin/env python3
"""Drive Chrome (headful under Xvfb, or headless) at the spike page and print JSON results.

usage: run_page.py <auto|webgpu|wasm> <port> <out.json> [headful|headless]
"""
import json, sys, time, pathlib
from playwright.sync_api import sync_playwright

EP = sys.argv[1] if len(sys.argv) > 1 else "auto"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
OUT = sys.argv[3] if len(sys.argv) > 3 else f"results/{EP}.json"
MODE = sys.argv[4] if len(sys.argv) > 4 else "headful"
PROFILE = os.path.expanduser("~/.cache/webgpu-spike-profile-") + EP + "-" + MODE

# Flags verified in gpu_diag.py: under Xvfb this yields WebGPU = Hardware accelerated.
COMMON = [
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--use-vulkan=native",
    "--disable-vulkan-surface",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
]
args = COMMON + (["--headless=new"] if MODE == "headless" else [])

url = f"http://127.0.0.1:{PORT}/index.html" + ("" if EP == "auto" else f"?ep={EP}")

console = []
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        PROFILE, executable_path="/usr/bin/google-chrome",
        headless=(MODE == "headless"), args=args,
        viewport={"width": 1000, "height": 800},
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
    # GPU feature status via browser-level CDP (authoritative)
    try:
        info = ctx.browser.new_browser_cdp_session().send("SystemInfo.getInfo")
        fs = info.get("gpu", {}).get("featureStatus", {})
        gpu_status = {k: fs.get(k) for k in ("webgpu", "vulkan", "opengl", "gpu_compositing")}
    except Exception as e:
        gpu_status = {"error": str(e)[:200]}

    t0 = time.time()
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_function("window.__RESULT !== null && window.__RESULT !== undefined", timeout=600000)
    except Exception as e:
        console.append("WAIT_FAILED: " + str(e)[:300])
    res = page.evaluate("window.__RESULT")
    ctx.close()

payload = {"ep_requested": EP, "mode": MODE, "gpu_feature_status": gpu_status,
           "elapsed_s": round(time.time() - t0, 1), "result": res, "console": console[-40:]}
pathlib.Path(OUT).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(OUT).write_text(json.dumps(payload, indent=2))
print(json.dumps(payload, indent=2)[:12000])
