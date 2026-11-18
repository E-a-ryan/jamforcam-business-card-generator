"""Build dist/JamforCam_BusinessCard_Generator.html — one self-contained file.

  python3 scripts/build.py

Needs Python 3 with fontTools (pip install fonttools). Subsets the fonts,
extracts metrics + kerning, and inlines fonts, templates, pdf-lib and the app.
"""
import json, runpy
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
runpy.run_path(str(ROOT / "scripts/prep_fonts.py"))
fonts = json.load(open(ROOT / "build/fonts.json"))
data = {}
for k, f in fonts.items():
    d = dict(f); d["kern"] = ";".join(f"{a},{v}" for a, v in f["kern"].items()); data[k] = d
front = (ROOT / "templates/card-front.svg").read_text()
back = (ROOT / "templates/card-back.svg").read_text()
pdflib = (ROOT / "vendor/pdf-lib.min.js").read_text().replace("�", "\\uFFFD")
assert "</script" not in pdflib.lower()
html = (ROOT / "src/app.template.html").read_text()
html = html.replace("/*__PDFLIB__*/", pdflib).replace("/*__ENGINE__*/", (ROOT / "src/engine.js").read_text())
html = html.replace("__FONT_DATA__", json.dumps(data, separators=(",", ":")))
html = html.replace("__FRONT_SVG__", json.dumps(front)).replace("__BACK_SVG__", json.dumps(back))
html = html.replace("__FONT_REGULAR__", fonts["regular"]["b64"]).replace("__FONT_MEDIUM__", fonts["medium"]["b64"])
out = ROOT / "dist/JamforCam_BusinessCard_Generator.html"
out.write_text(html)
print(f"Built {out.relative_to(ROOT)} ({len(html)//1024} KB)")
