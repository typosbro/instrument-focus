import re, html, sys
path = sys.argv[1] if len(sys.argv) > 1 else "results/gpu_dom.html"
t = open(path, encoding="utf-8", errors="replace").read()
t = re.sub(r"<script.*?</script>", " ", t, flags=re.S)
t = re.sub(r"<style.*?</style>", " ", t, flags=re.S)
t = re.sub(r"<[^>]+>", "|", t)
parts = [html.unescape(p).strip() for p in t.split("|")]
lines = [p for p in parts if p]
print("tokens", len(lines))
keys = ("webgpu", "dawn", "vulkan", "blocklist", "disabled", "software", "swiftshader", "graphics feature", "gl_renderer", "angle")
seen = set()
for i, l in enumerate(lines):
    ll = l.lower()
    if any(k in ll for k in keys) and l not in seen:
        seen.add(l)
        print(i, l[:200])
