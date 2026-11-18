// Render signature/JamForCam_Logo.svg to PNGs (400 px wide = 2x for a 200 px display) in each logo color.
// Run: node scripts/make_logo_pngs.js   (needs the `sharp` package)
const path = require('path'), fs = require('fs');
let sharp; try { sharp = require('sharp'); } catch { sharp = require('/opt/npm-tools/node_modules/sharp'); }
const ROOT = path.resolve(__dirname, '..');
const COLORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'signature/logo-colors.json'), 'utf8'));
const svg = fs.readFileSync(path.join(ROOT, 'signature/JamForCam_Logo.svg'), 'utf8');
(async () => {
  for (const c of COLORS) {
    const out = path.join(ROOT, 'docs/signature/logos', `jamforcam-logo-${c.id}.png`);
    await sharp(Buffer.from(svg.replace(/fill="#010101"/g, `fill="${c.hex}"`)), { density: 600 })
      .resize({ width: 400 }).png({ compressionLevel: 9 }).toFile(out);
    console.log('wrote', path.relative(ROOT, out));
  }
})();
