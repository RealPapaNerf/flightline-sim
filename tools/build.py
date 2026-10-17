#!/usr/bin/env python3
"""Assemble Flightline into single-file pages.

  index.html          full document for GitHub Pages / local use; installable app
  dist/artifact.html  body fragment for publishing as a claude.ai artifact

Sources: src/shell.html (head + markup), then src/physics.js, src/aircraft.js,
src/tutorial.js, src/prompts.js, src/nav.js, src/render.js, src/terrain.js,
src/maps.js, src/ghost.js, src/net.js, src/app.js.
Run from the repo root:  python3 tools/build.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

shell = (SRC / "shell.html").read_text()
js = "\n".join((SRC / f).read_text() for f in ("physics.js", "aircraft.js", "tutorial.js", "prompts.js", "nav.js", "render.js", "terrain.js", "maps.js", "ghost.js", "net.js", "app.js"))
version = __import__("hashlib").sha1(js.encode()).hexdigest()[:8]

split = shell.index('<div id="stage">')
head, body = shell[:split].rstrip(), shell[split:].rstrip()
script = f"<script>\n{js}\n</script>"

# --- GitHub Pages / installable app ---
pwa_head = (
    '<link rel="manifest" href="manifest.webmanifest">\n'
    '<meta name="theme-color" content="#0f1519">\n'
    '<link rel="icon" href="icons/icon-192.png">\n'
    '<link rel="apple-touch-icon" href="icons/icon-192.png">'
)
sw_reg = (
    "<script>\n"
    "if ('serviceWorker' in navigator && location.protocol !== 'file:') "
    "addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));\n"
    "</script>"
)
index = (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    f"<!-- built by tools/build.py from src/ ({version}); edit the sources, not this file -->\n"
    f"{head}\n{pwa_head}\n</head>\n<body>\n{body}\n{script}\n{sw_reg}\n</body>\n</html>\n"
)
(ROOT / "index.html").write_text(index)

# service worker cache name follows the build so updates replace old caches
sw = (SRC / "sw.js").read_text().replace("__VERSION__", version)
(ROOT / "sw.js").write_text(sw)

# --- claude.ai artifact: no doctype/html/head/body, skeleton supplies viewport ---
art_head = re.sub(r'<meta name="viewport"[^>]*>\n?', "", head)
(ROOT / "dist").mkdir(exist_ok=True)
(ROOT / "dist" / "artifact.html").write_text(f"{art_head}\n{body}\n{script}\n")

print(f"built {version}: index.html {len(index)//1024} KB, dist/artifact.html")
