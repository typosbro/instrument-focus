import os
import json, sys
from playwright.sync_api import sync_playwright

DEEP_JS = """(() => {
  const chunks = [];
  const stack = [document];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.shadowRoot) stack.push(node.shadowRoot);
    if (node.children) for (const c of node.children) stack.push(c);
    if (node.textContent) chunks.push(node.textContent);
  }
  return chunks.join(String.fromCharCode(10));
})()"""

FLAGSETS = {
    "v1_native": ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=native", "--disable-vulkan-surface", "--ignore-gpu-blocklist"],
    "v2_angle": ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan,VulkanFromANGLE", "--use-angle=vulkan", "--ignore-gpu-blocklist"],
    "v3_gpusandbox": ["--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=native", "--ignore-gpu-blocklist", "--enable-gpu"],
}

name = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "headless"
args = list(FLAGSETS[name])
if mode == "headless":
    args.append("--headless=new")
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        os.path.expanduser("~/.cache/webgpu-spike-diag-") + name,
        executable_path="/usr/bin/google-chrome", headless=False, args=args)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    s = ctx.browser.new_browser_cdp_session()
    gpu = s.send("SystemInfo.getInfo").get("gpu", {})
    fs = gpu.get("featureStatus", {})
    print(name, mode, "| webgpu:", fs.get("webgpu"), "| vulkan:", fs.get("vulkan"), "| gl:", fs.get("opengl"), "| compositing:", fs.get("gpu_compositing"))
    print("devices:", [d.get("deviceString") for d in gpu.get("devices", [])])
    probe = page.evaluate("(async()=>{ if(!navigator.gpu) return {hasGPU:false}; const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}); return {hasGPU:true, adapter: a? {vendor:a.info.vendor, arch:a.info.architecture, device:a.info.device}:null}; })()")
    print("probe:", json.dumps(probe))
    page.goto("chrome://gpu")
    page.wait_for_timeout(2500)
    txt = page.evaluate(DEEP_JS)
    keep = [l.strip() for l in txt.splitlines() if l.strip() and any(k in l.lower() for k in ("webgpu", "vulkan", "dawn", "error", "fail", "blocklist"))]
    print("GPUPAGE:", json.dumps(keep[:25], indent=1)[:2500])
    ctx.close()
