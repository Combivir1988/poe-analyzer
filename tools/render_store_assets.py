"""Render store assets with headless Chrome:
  store/demo.html  → store/screenshot_1280x800.png
  store/promo.html → store/promo_tile_440x280.png
"""
import os, shutil, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STORE = os.path.join(ROOT, "store")

CANDIDATES = [
    os.environ.get("CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chrome"),
]
chrome = next((c for c in CANDIDATES if c and os.path.exists(c)), None)
if not chrome:
    sys.exit("Chrome not found; set CHROME=<path to chrome binary>")

JOBS = [("demo.html", "screenshot_1280x800.png", 1280, 800),
        ("promo.html", "promo_tile_440x280.png", 440, 280)]

for src, dst, w, h in JOBS:
    out = os.path.join(STORE, dst)
    url = "file:///" + os.path.join(STORE, src).replace("\\", "/")
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1",
                    f"--window-size={w},{h}", f"--screenshot={out}", url],
                   check=True, capture_output=True, timeout=60)
    print("wrote", out)
