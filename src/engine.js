/* ==========================================================================
   Card engine — template parsing, text layout, SVG preview, vector PDF.
   Works in the browser (uses DOMParser + PDFLib globals).
   ========================================================================== */
(function (global) {
  'use strict';

  // ---- Print spec (points; 72pt = 1in) -----------------------------------
  const SPEC = {
    trimW: 252, trimH: 144,     // 3.5 x 2 in
    bleed: 9,                   // 0.125 in
    safe: 9,                    // 0.125 in inside trim
    markOffset: 9,              // crop marks start 0.125 in from trim (at bleed edge)
    markLength: 18,             // 0.25 in
    margin: 36,                 // page margin around trim = offset + length + 9pt air
    markWeight: 0.25,
  };

  const CONTACT = ['title', 'email', 'phone'];
  const FIELDS = ['firstname', 'lastname'].concat(CONTACT);

  // ---- Fonts ---------------------------------------------------------------
  const FONTS = {};
  function loadFonts(data) {
    for (const key of Object.keys(data)) {
      const f = data[key];
      const kern = new Map();
      if (f.kern) {
        for (const rec of f.kern.split(';')) {
          if (!rec) continue;
          const [a, b, v] = rec.split(',');
          kern.set(((+a) << 12) | (+b), +v);
        }
      }
      const cmap = new Map();
      for (const u of Object.keys(f.cmap)) cmap.set(+u, f.cmap[u]);
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      FONTS[key] = { key, name: f.name, upm: f.upm, adv: f.adv, kern, cmap, bytes,
        ascent: f.ascent, descent: f.descent, capHeight: f.capHeight, bbox: f.bbox, b64: f.b64 };
    }
  }

  // Lay out a string: per-glyph x offsets using the font's own advance widths + GPOS kerning.
  function layoutText(fontKey, str, size) {
    const f = FONTS[fontKey];
    const s = size / f.upm;
    const glyphs = [];
    const missing = [];
    let x = 0, prev = -1;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      let gid = f.cmap.get(cp);
      if (gid === undefined) { missing.push(ch); gid = 0; }
      let k = 0;
      if (prev >= 0) k = f.kern.get((prev << 12) | gid) || 0;
      x += k * s;
      glyphs.push({ gid, ch, x, kern: k });
      x += f.adv[gid] * s;
      prev = gid;
    }
    return { glyphs, width: x, missing };
  }

  // ---- Color ---------------------------------------------------------------
  // Colors are { hex, cmyk:[c,m,y,k] } with cmyk 0–1. CMYK is what goes in the PDF.
  function hexToColor(hex) {
    if (!hex || hex === 'none') return null;
    hex = hex.trim().toLowerCase();
    if (hex === 'white') hex = '#ffffff';
    if (hex === 'black') hex = '#000000';
    if (/^#[0-9a-f]{3}$/.test(hex)) hex = '#' + hex.slice(1).split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    // Illustrator exports 100K black as #231f20 / #010101 — treat any near-neutral dark as pure K.
    if (Math.max(r, g, b) < 0x30 && Math.max(r, g, b) - Math.min(r, g, b) < 0x10) return { hex: '#1f1f1d', cmyk: [0, 0, 0, 1] }; // soft proof of 100K
    if (r > 0xf8 && g > 0xf8 && b > 0xf8) return { hex: '#ffffff', cmyk: [0, 0, 0, 0] };
    const k = 1 - Math.max(r, g, b) / 255;
    const c = (1 - r / 255 - k) / (1 - k), m = (1 - g / 255 - k) / (1 - k), y = (1 - b / 255 - k) / (1 - k);
    return { hex, cmyk: [c, m, y, k].map(v => Math.round(v * 1000) / 1000) };
  }
  const isPaper = c => !c || c.cmyk.every(v => v === 0);

  // ---- Matrices ------------------------------------------------------------
  const I = [1, 0, 0, 1, 0, 0];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  function parseTransform(t) {
    let m = I.slice();
    if (!t) return m;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    let r;
    while ((r = re.exec(t))) {
      const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let n;
      switch (r[1]) {
        case 'matrix': n = a; break;
        case 'translate': n = [1, 0, 0, 1, a[0], a[1] || 0]; break;
        case 'scale': n = [a[0], 0, 0, a[1] === undefined ? a[0] : a[1], 0, 0]; break;
        case 'rotate': {
          const rad = a[0] * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
          n = [c, s, -s, c, 0, 0];
          if (a.length > 2) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
          break;
        }
        case 'skewX': n = [1, 0, Math.tan(a[0] * Math.PI / 180), 1, 0, 0]; break;
        case 'skewY': n = [1, Math.tan(a[0] * Math.PI / 180), 0, 1, 0, 0]; break;
      }
      m = mul(m, n);
    }
    return m;
  }

  // ---- SVG path → absolute M/L/C/Z ------------------------------------------
  function parsePath(d) {
    const out = [];
    let i = 0;
    const n = d.length;
    const ws = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
    const num = () => {
      ws();
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i, i + 40));
      if (!m) return null;
      i += m[0].length;
      return parseFloat(m[0]);
    };
    const flag = () => { ws(); const c = d[i++]; return c === '1' ? 1 : 0; };
    let cx = 0, cy = 0, sx = 0, sy = 0, lc = null, lq = null, cmd = null;
    while (true) {
      ws();
      if (i >= n) break;
      if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
      else if (cmd === null) break;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'Z') { out.push(['Z']); cx = sx; cy = sy; lc = lq = null; continue; }
      const start = i;
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      if (C === 'M' || C === 'L' || C === 'T') {
        const x = num(); if (x === null) { i = start; cmd = null; continue; }
        const y = num(); const X = ox + x, Y = oy + y;
        if (C === 'M') { out.push(['M', X, Y]); sx = X; sy = Y; cmd = rel ? 'l' : 'L'; lc = lq = null; }
        else if (C === 'L') { out.push(['L', X, Y]); lc = lq = null; }
        else { // T
          const qx = lq ? 2 * cx - lq[0] : cx, qy = lq ? 2 * cy - lq[1] : cy;
          out.push(['C', cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), X + 2 / 3 * (qx - X), Y + 2 / 3 * (qy - Y), X, Y]);
          lq = [qx, qy]; lc = null;
        }
        cx = X; cy = Y;
      } else if (C === 'H' || C === 'V') {
        const v = num(); if (v === null) { cmd = null; continue; }
        if (C === 'H') cx = (rel ? cx : 0) + v; else cy = (rel ? cy : 0) + v;
        out.push(['L', cx, cy]); lc = lq = null;
      } else if (C === 'C' || C === 'S') {
        let x1, y1;
        if (C === 'C') { x1 = num(); if (x1 === null) { cmd = null; continue; } y1 = num(); x1 += ox; y1 += oy; }
        else { x1 = lc ? 2 * cx - lc[0] : cx; y1 = lc ? 2 * cy - lc[1] : cy; }
        const x2 = num(); if (x2 === null) { cmd = null; continue; }
        const y2 = num(), x = num(), y = num();
        out.push(['C', x1, y1, ox + x2, oy + y2, ox + x, oy + y]);
        lc = [ox + x2, oy + y2]; lq = null; cx = ox + x; cy = oy + y;
      } else if (C === 'Q') {
        const qx0 = num(); if (qx0 === null) { cmd = null; continue; }
        const qy = oy + num(), qx = ox + qx0, x = ox + num(), y = oy + num();
        out.push(['C', cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y]);
        lq = [qx, qy]; lc = null; cx = x; cy = y;
      } else if (C === 'A') {
        const rx = num(); if (rx === null) { cmd = null; continue; }
        const ry = num(), rot = num(), la = flag(), sw = flag(), x = ox + num(), y = oy + num();
        for (const c of arcToCubics(cx, cy, rx, ry, rot, la, sw, x, y)) out.push(c);
        cx = x; cy = y; lc = lq = null;
      } else { cmd = null; i++; }
    }
    return out;
  }

  function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
    if (rx === 0 || ry === 0) return [['L', x2, y2]];
    rx = Math.abs(rx); ry = Math.abs(ry);
    const p = phi * Math.PI / 180, cp = Math.cos(p), sp = Math.sin(p);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num / den)); if (fa === fs) co = -co;
    const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    let t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
    const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
    const out = [], d = dt / segs, k = 4 / 3 * Math.tan(d / 4);
    const pt = (t) => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp];
    const dv = (t) => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp, -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp];
    for (let s = 0; s < segs; s++) {
      const a = t1 + s * d, b = a + d;
      const P0 = pt(a), P3 = pt(b), D0 = dv(a), D3 = dv(b);
      out.push(['C', P0[0] + k * D0[0], P0[1] + k * D0[1], P3[0] - k * D3[0], P3[1] - k * D3[1], P3[0], P3[1]]);
    }
    return out;
  }

  function shapeToPath(el) {
    const g = (a) => parseFloat(el.getAttribute(a) || 0);
    switch (el.tagName.toLowerCase()) {
      case 'path': return parsePath(el.getAttribute('d') || '');
      case 'rect': {
        const x = g('x'), y = g('y'), w = g('width'), h = g('height');
        return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
      }
      case 'circle': case 'ellipse': {
        const cx = g('cx'), cy = g('cy');
        const rx = el.tagName.toLowerCase() === 'circle' ? g('r') : g('rx');
        const ry = el.tagName.toLowerCase() === 'circle' ? g('r') : g('ry');
        return parsePath(`M${cx - rx},${cy}A${rx},${ry} 0 1 1 ${cx + rx},${cy}A${rx},${ry} 0 1 1 ${cx - rx},${cy}Z`);
      }
      case 'polygon': case 'polyline': {
        const p = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
        const out = [];
        for (let i = 0; i + 1 < p.length; i += 2) out.push([i ? 'L' : 'M', p[i], p[i + 1]]);
        if (el.tagName.toLowerCase() === 'polygon') out.push(['Z']);
        return out;
      }
      case 'line': return [['M', g('x1'), g('y1')], ['L', g('x2'), g('y2')]];
    }
    return null;
  }

  function transformPath(segs, m) {
    return segs.map(s => {
      if (s[0] === 'Z') return s;
      const o = [s[0]];
      for (let i = 1; i < s.length; i += 2) { const p = apply(m, s[i], s[i + 1]); o.push(p[0], p[1]); }
      return o;
    });
  }

  // ---- Template parsing ------------------------------------------------------
  function normId(el) {
    const raw = el.getAttribute && (el.getAttribute('data-name') || el.getAttribute('id'));
    if (!raw) return '';
    return raw.toLowerCase().replace(/[-_]\d+$/, '').replace(/[^a-z]/g, '');
  }
  const ROLE = { frontbg: 'bg', backbg: 'bg', bg: 'bg', background: 'bg', logo: 'logo', guides: 'skip', guide: 'skip' };
  const FIELD_ALIAS = { firstname: 'firstname', first: 'firstname', lastname: 'lastname', last: 'lastname',
    title: 'title', email: 'email', phone: 'phone' };

  function parseTemplate(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    const css = {};
    for (const st of svg.querySelectorAll('style')) {
      const re = /([^{}]+)\{([^}]*)\}/g; let r;
      while ((r = re.exec(st.textContent))) {
        const decl = {};
        r[2].split(';').forEach(p => { const [k, v] = p.split(':'); if (k && v) decl[k.trim()] = v.trim(); });
        r[1].split(',').forEach(sel => { sel = sel.trim(); if (sel[0] === '.') css[sel.slice(1)] = Object.assign(css[sel.slice(1)] || {}, decl); });
      }
    }
    const prop = (el, name) => {
      const style = el.getAttribute('style');
      if (style) { const m = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)').exec(style); if (m) return m[1].trim(); }
      const cls = (el.getAttribute('class') || '').split(/\s+/);
      for (const c of cls) if (css[c] && css[c][name]) return css[c][name];
      return el.getAttribute(name);
    };
    const items = [];
    (function walk(el, m, ctx) {
      for (const child of el.children) {
        const tag = child.tagName.toLowerCase();
        if (['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'symbol'].includes(tag)) continue;
        if (prop(child, 'display') === 'none' || prop(child, 'visibility') === 'hidden') continue;
        const id = normId(child);
        const c = Object.assign({}, ctx);
        if (ROLE[id] === 'skip') continue;
        if (ROLE[id]) c.role = ROLE[id];
        if (FIELD_ALIAS[id]) c.field = FIELD_ALIAS[id];
        const f = prop(child, 'fill'); if (f) c.fill = f;
        const fr = prop(child, 'fill-rule'); if (fr) c.rule = fr;
        const fam = prop(child, 'font-family'); if (fam) c.family = fam;
        const fw = prop(child, 'font-weight'); if (fw) c.weight = fw;
        const fs = prop(child, 'font-size'); if (fs) c.size = parseFloat(fs);
        const cm = mul(m, parseTransform(child.getAttribute('transform')));
        if (tag === 'g' || tag === 'svg') { walk(child, cm, c); continue; }
        if (tag === 'text') {
          const first = child.querySelector('tspan');
          const x = parseFloat((first && first.getAttribute('x')) || child.getAttribute('x') || 0);
          const y = parseFloat((first && first.getAttribute('y')) || child.getAttribute('y') || 0);
          const p = apply(cm, x, y);
          const scale = Math.sqrt(Math.abs(cm[0] * cm[3] - cm[1] * cm[2]));
          const fam2 = (c.family || '') + ' ' + (c.weight || '');
          const font = /medium|bold|semi|[5-9]00/i.test(fam2) ? 'medium' : 'regular';
          items.push({ type: 'text', field: c.field || null, x: p[0], y: p[1], size: (c.size || 12) * scale,
            font, color: hexToColor(c.fill || '#000'), sample: child.textContent.replace(/\s+/g, ' ').trim() });
          continue;
        }
        const segs = shapeToPath(child);
        if (segs && (c.fill || '#000') !== 'none') {
          items.push({ type: 'shape', role: c.role || null, segs: transformPath(segs, cm),
            color: hexToColor(c.fill || '#000'), rule: c.rule === 'evenodd' ? 'evenodd' : 'nonzero' });
        }
      }
    })(svg, I, {});
    return { items };
  }

  // ---- Content helpers -------------------------------------------------------
  function smartQuotes(s) {
    return s.replace(/(^|[\s(\[{“‘-])'/g, '$1‘').replace(/'/g, '’')
      .replace(/(^|[\s(\[{‘-])"/g, '$1“').replace(/"/g, '”');
  }
  function formatPhone(s) {
    const digits = s.replace(/\D/g, '');
    if (/^[\d\s().\-–]+$/.test(s) && digits.length === 10)
      return digits.slice(0, 3) + '–' + digits.slice(3, 6) + '–' + digits.slice(6);
    return s.replace(/(\d)\s*-\s*(?=\d)/g, '$1–');
  }
  function cleanValue(field, v) {
    v = (v || '').replace(/\s+/g, ' ').trim();
    if (!v) return '';
    if (field === 'phone') return formatPhone(v);
    if (field === 'email') return v;
    return smartQuotes(v);
  }

  // ---- Build a renderable card side -----------------------------------------
  // values: {firstname,...}; colors: {bg, logo, name, text} (each color or null = use template)
  function buildSide(tpl, values, colors, opts) {
    opts = opts || {};
    const W = SPEC.trimW, H = SPEC.trimH;
    let bg = colors.bg || null;
    const shapes = [], texts = [], warnings = {};
    const tplBg = tpl.items.find(it => it.type === 'shape' && it.role === 'bg');
    if (!bg && tplBg) bg = tplBg.color;

    for (const it of tpl.items) {
      if (it.type !== 'shape' || it.role === 'bg') continue;
      const color = it.role === 'logo' && colors.logo ? colors.logo : it.color;
      shapes.push({ segs: it.segs, color, rule: it.rule });
    }

    const tfields = {};
    for (const it of tpl.items) if (it.type === 'text' && it.field && !tfields[it.field]) tfields[it.field] = it;

    // Contact block is anchored to the bottom line of the template; empty fields collapse.
    const slots = CONTACT.filter(f => tfields[f] && tpl.items.includes(tfields[f])).map(f => tfields[f].y).sort((a, b) => a - b);
    const bottom = slots.length ? slots[slots.length - 1] : H - 9;
    const leading = slots.length > 1 ? (slots[slots.length - 1] - slots[0]) / (slots.length - 1) : 15;
    const filled = CONTACT.filter(f => tfields[f] && cleanValue(f, values[f]));

    for (const field of FIELDS) {
      const t = tfields[field];
      if (!t) continue;
      let str = cleanValue(field, values[field]);
      let placeholder = false;
      if (!str && (field === 'firstname' || field === 'lastname') && opts.placeholders) { str = t.sample; placeholder = true; }
      if (!str) continue;
      let y = t.y;
      if (CONTACT.includes(field)) y = bottom - (filled.length - 1 - filled.indexOf(field)) * leading;
      const isName = field === 'firstname' || field === 'lastname';
      const color = (isName ? colors.name : colors.text) || t.color;
      const lay = layoutText(t.font, str, t.size);
      const right = t.x + lay.width;
      const w = [];
      if (lay.missing.length) w.push({ level: 'block', msg: 'Special Gothic has no “' + [...new Set(lay.missing)].join(' ') + '”' });
      if (right > W) w.push({ level: 'block', msg: 'Too long — runs off the card' });
      else if (right > W - SPEC.safe) w.push({ level: 'warn', msg: 'Too long — past the safe area' });
      if (w.length && !placeholder) warnings[field] = w;
      texts.push({ field, str, x: t.x, y, size: t.size, font: t.font, color, glyphs: lay.glyphs, width: lay.width, placeholder });
    }
    return { bg, shapes, texts, warnings };
  }

  // ---- SVG preview --------------------------------------------------------------
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const f2 = v => (Math.round(v * 1000) / 1000).toString();
  function segsToD(segs) {
    return segs.map(s => s[0] === 'Z' ? 'Z' : s[0] + s.slice(1).map(f2).join(' ')).join('');
  }
  function sideToSVG(side, guides, uid) {
    const W = SPEC.trimW, H = SPEC.trimH, B = SPEC.bleed, S = SPEC.safe;
    const vb = guides ? `${-B} ${-B} ${W + 2 * B} ${H + 2 * B}` : `0 0 ${W} ${H}`;
    let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" class="card${guides ? ' guides' : ''}">`;
    o += `<defs><clipPath id="clip-${uid}"><rect x="${-B}" y="${-B}" width="${W + 2 * B}" height="${H + 2 * B}"/></clipPath></defs>`;
    o += `<g clip-path="url(#clip-${uid})">`;
    o += `<rect x="${-B}" y="${-B}" width="${W + 2 * B}" height="${H + 2 * B}" fill="${side.bg ? side.bg.hex : '#fff'}"/>`;
    for (const sh of side.shapes) o += `<path d="${segsToD(sh.segs)}" fill="${sh.color.hex}" fill-rule="${sh.rule}"/>`;
    for (const t of side.texts) {
      const xs = t.glyphs.map(g => f2(t.x + g.x)).join(' ');
      o += `<text x="${xs}" y="${f2(t.y)}" font-family="SG-${t.font}" font-size="${t.size}" fill="${t.color.hex}"${t.placeholder ? ' opacity="0.25"' : ''} style="font-kerning:none;font-feature-settings:'liga' 0,'kern' 0">${esc(t.glyphs.map(g => g.ch).join(''))}</text>`;
    }
    o += `</g>`;
    if (guides) {
      o += `<path d="M${-B} ${-B}H${W + B}V${H + B}H${-B}Z M0 0V${H}H${W}V0Z" fill="#fff" fill-opacity="0.55" fill-rule="evenodd"/>`;
      o += `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#111" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
      o += `<rect x="${S}" y="${S}" width="${W - 2 * S}" height="${H - 2 * S}" fill="none" stroke="#999" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`;
      o += `<rect x="${-B}" y="${-B}" width="${W + 2 * B}" height="${H + 2 * B}" fill="none" stroke="#ccc" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    }
    return o + '</svg>';
  }

  // ---- Vector PDF ----------------------------------------------------------------
  const n3 = v => (Math.round(v * 1000) / 1000).toString();
  const cmykOp = (c, op) => c.cmyk.map(n3).join(' ') + ' ' + op;

  function embedFont(doc, f) {
    const { PDFName, PDFString } = global.PDFLib;
    const ctx = doc.context;
    const base = 'JFCSGB+' + f.name; // subset tag (font is pre-subset to Latin)
    const file = ctx.register(ctx.flateStream(f.bytes, { Length1: f.bytes.length }));
    const desc = ctx.register(ctx.obj({
      Type: 'FontDescriptor', FontName: base, Flags: 32, FontBBox: f.bbox, ItalicAngle: 0,
      Ascent: f.ascent, Descent: f.descent, CapHeight: f.capHeight, StemV: f.key === 'medium' ? 100 : 80, FontFile2: file,
    }));
    const widths = f.adv.map(a => Math.round(a * 1000 / f.upm));
    const cid = ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'CIDFontType2', BaseFont: base,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: desc, W: [0, widths], DW: 1000, CIDToGIDMap: 'Identity',
    }));
    // ToUnicode so the text stays searchable / copyable.
    const pairs = [];
    for (const [u, g] of f.cmap) if (u < 0x10000) pairs.push([g, u]);
    pairs.sort((a, b) => a[0] - b[0]);
    const seen = new Set(); const uniq = pairs.filter(p => !seen.has(p[0]) && seen.add(p[0]));
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');
    let cm = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < uniq.length; i += 100) {
      const chunk = uniq.slice(i, i + 100);
      cm += chunk.length + ' beginbfchar\n' + chunk.map(p => `<${h4(p[0])}> <${h4(p[1])}>`).join('\n') + '\nendbfchar\n';
    }
    cm += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    const tu = ctx.register(ctx.flateStream(cm));
    return ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: base, Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: tu }));
  }

  async function sideToPDF(side, meta) {
    const { PDFDocument, PDFName } = global.PDFLib;
    const W = SPEC.trimW, H = SPEC.trimH, B = SPEC.bleed, M = SPEC.margin;
    const PW = W + 2 * M, PH = H + 2 * M;
    const doc = await PDFDocument.create();
    doc.setTitle(meta.title); doc.setAuthor('Jam for Cam'); doc.setCreator('Jam for Cam Business Card Generator');
    doc.setProducer('Jam for Cam Business Card Generator (pdf-lib)'); doc.setSubject(meta.subject || '');
    const page = doc.addPage([PW, PH]);
    page.setBleedBox(M - B, M - B, W + 2 * B, H + 2 * B);
    page.setTrimBox(M, M, W, H);
    page.setArtBox(M, M, W, H);

    const used = [...new Set(side.texts.map(t => t.font))];
    const fname = {};
    used.forEach((k, i) => { fname[k] = 'F' + (i + 1); page.node.setFontDictionary(PDFName.of(fname[k]), embedFont(doc, FONTS[k])); });

    let s = '';
    // Artwork: flip to SVG coords with origin at trim top-left, clip to bleed.
    s += `q\n1 0 0 -1 ${M} ${PH - M} cm\n${-B} ${-B} ${W + 2 * B} ${H + 2 * B} re W n\n`;
    if (side.bg && !isPaper(side.bg)) s += `${cmykOp(side.bg, 'k')}\n${-B} ${-B} ${W + 2 * B} ${H + 2 * B} re f\n`;
    for (const sh of side.shapes) {
      s += cmykOp(sh.color, 'k') + '\n';
      for (const g of sh.segs) {
        if (g[0] === 'M') s += `${n3(g[1])} ${n3(g[2])} m\n`;
        else if (g[0] === 'L') s += `${n3(g[1])} ${n3(g[2])} l\n`;
        else if (g[0] === 'C') s += g.slice(1).map(n3).join(' ') + ' c\n';
        else s += 'h\n';
      }
      s += (sh.rule === 'evenodd' ? 'f*' : 'f') + '\n';
    }
    for (const t of side.texts) {
      if (t.placeholder) continue;
      const parts = [];
      t.glyphs.forEach((g, i) => {
        if (i && g.kern) parts.push(String(-g.kern * 1000 / FONTS[t.font].upm));
        parts.push('<' + g.gid.toString(16).toUpperCase().padStart(4, '0') + '>');
      });
      s += `BT\n${cmykOp(t.color, 'k')}\n/${fname[t.font]} ${n3(t.size)} Tf\n1 0 0 -1 ${n3(t.x)} ${n3(t.y)} Tm\n[${parts.join(' ')}] TJ\nET\n`;
    }
    s += 'Q\n';
    // Crop marks in registration (100/100/100/100), outside the bleed.
    const o = SPEC.markOffset, L = SPEC.markLength;
    s += `q\n${SPEC.markWeight} w 0 J\n1 1 1 1 K\n`;
    const xs = [M, M + W], ys = [M, M + H];
    for (const x of xs) for (const y of ys) {
      const dx = x === M ? -1 : 1, dy = y === M ? -1 : 1;
      s += `${n3(x + dx * o)} ${n3(y)} m ${n3(x + dx * (o + L))} ${n3(y)} l S\n`;
      s += `${n3(x)} ${n3(y + dy * o)} m ${n3(x)} ${n3(y + dy * (o + L))} l S\n`;
    }
    s += 'Q\n';
    const ref = doc.context.register(doc.context.flateStream(s));
    page.node.addContentStream(ref);
    return await doc.save({ useObjectStreams: false });
  }

  global.CardEngine = { SPEC, FIELDS, CONTACT, loadFonts, layoutText, parseTemplate, buildSide, sideToSVG, sideToPDF, hexToColor, cleanValue, FONTS };
})(typeof window !== 'undefined' ? window : globalThis);
