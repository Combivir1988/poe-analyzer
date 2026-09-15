"""Build the Chrome Web Store upload package: dist/poe-analyzer-<version>.zip
containing only runtime files (manifest, popup, src, icons)."""
import json, os, zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RUNTIME = ["manifest.json", "popup.html", "popup.js",
           "src/interceptor.js", "src/bridge.js",
           "icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]

with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
    version = json.load(f)["version"]

dist = os.path.join(ROOT, "dist")
os.makedirs(dist, exist_ok=True)
out = os.path.join(dist, f"poe-analyzer-{version}.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for rel in RUNTIME:
        z.write(os.path.join(ROOT, rel), rel)
print(out, os.path.getsize(out), "bytes")
