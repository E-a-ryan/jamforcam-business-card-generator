"""Build the email signature generator: docs/signature/index.html (GitHub Pages)
and dist/JamforCam_EmailSignature_Generator.html (standalone).

  node scripts/make_logo_pngs.js     # only when the logo or its colors change
  python3 scripts/build_signature.py
"""
import base64, json, runpy
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
if not (ROOT / "build/fonts.json").exists():
    runpy.run_path(str(ROOT / "scripts/prep_fonts.py"))
fonts = json.load(open(ROOT / "build/fonts.json"))
colors = json.load(open(ROOT / "signature/logo-colors.json"))
preview = {c["id"]: "data:image/png;base64," + base64.b64encode(
    (ROOT / f"docs/signature/logos/jamforcam-logo-{c['id']}.png").read_bytes()).decode() for c in colors}
html = (ROOT / "signature/app.template.html").read_text()
html = html.replace("__FONT_REGULAR__", fonts["regular"]["b64"]).replace("__FONT_MEDIUM__", fonts["medium"]["b64"])
html = html.replace("__LOGO_COLORS__", json.dumps(colors)).replace("__LOGO_PREVIEW__", json.dumps(preview))
for out in (ROOT / "docs/signature/index.html", ROOT / "dist/JamforCam_EmailSignature_Generator.html"):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f"Built {out.relative_to(ROOT)} ({len(html)//1024} KB)")
