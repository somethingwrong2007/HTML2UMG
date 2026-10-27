// Copyright (c) 2026 FPVSkyline. MIT License.
// Value helpers: CSS -> contract value types (see Docs/Html2UMG_LayoutContract.md §3).
'use strict';

const EPS = 1e-6;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** sRGB [0..1] channel -> linear [0..1]. */
function srgbToLinear(c) {
  const v = clamp(c, 0, 1);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function round(v, digits) {
  const d = digits === undefined ? 2 : digits;
  const f = Math.pow(10, d);
  const r = Math.round(v * f) / f;
  // Avoid "-0" which would make two otherwise identical runs differ.
  return r === 0 ? 0 : r;
}

/**
 * Parse a CSS color string into sRGB components {r,g,b,a} (0..1), or null.
 * Computed styles normally give rgb()/rgba(), but we accept hex, transparent,
 * color(srgb ...) and the modern space-separated / slash syntax too.
 */
function parseColor(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().toLowerCase();
  if (!s || s === 'none') return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  if (s[0] === '#') {
    const hex = s.slice(1);
    const expand = (h) => {
      const out = [];
      for (let i = 0; i < h.length; i += 1) {
        out.push(parseInt(h[i] + h[i], 16) / 255);
      }
      return out;
    };
    if (hex.length === 3 || hex.length === 4) {
      const c = expand(hex);
      return { r: c[0], g: c[1], b: c[2], a: hex.length === 4 ? c[3] : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
      return { r, g, b, a };
    }
    return null;
  }

  const fnMatch = /^(rgba?|color)\((.*)\)$/.exec(s);
  if (!fnMatch) return null;
  const fn = fnMatch[1];
  const inner = fnMatch[2].trim();
  let parts;
  if (inner.indexOf(',') >= 0) {
    parts = inner.split(',').map((p) => p.trim());
  } else {
    parts = inner.replace(/\s*\/\s*/g, ' / ').split(/\s+/).filter(Boolean);
  }
  let alpha = 1;
  const slash = parts.indexOf('/');
  if (slash >= 0) {
    const a = parts[slash + 1];
    parts = parts.slice(0, slash);
    alpha = a === undefined ? 1 : percentOrNumber(a);
  } else if (fn === 'rgba' && parts.length === 4) {
    alpha = percentOrNumber(parts[3]);
    parts = parts.slice(0, 3);
  }

  if (fn === 'color') {
    // color(srgb r g b)
    if (parts[0] !== 'srgb' || parts.length < 4) return null;
    const ch = parts.slice(1, 4).map(percentOrNumber);
    return { r: clamp(ch[0], 0, 1), g: clamp(ch[1], 0, 1), b: clamp(ch[2], 0, 1), a: clamp(alpha, 0, 1) };
  }

  if (parts.length < 3) return null;
  const ch = parts.slice(0, 3).map((p) => percentOrNumber(p));
  if (ch.some((v) => v === null || Number.isNaN(v))) return null;
  return {
    r: clamp(ch[0] / 255, 0, 1),
    g: clamp(ch[1] / 255, 0, 1),
    b: clamp(ch[2] / 255, 0, 1),
    a: clamp(alpha === null ? 1 : alpha, 0, 1),
  };
}

/** "50%" -> 0.5 (in 0..1 for alpha), plain number -> number. */
function percentOrNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * CSS color -> [r,g,b,a] in *linear* space, which is what FLinearColor wants.
 * Returns null if unparseable.
 */
function colorToLinear(input) {
  const c = parseColor(input);
  if (!c) return null;
  return [
    round(srgbToLinear(c.r), 4),
    round(srgbToLinear(c.g), 4),
    round(srgbToLinear(c.b), 4),
    round(clamp(c.a, 0, 1), 4),
  ];
}

/** True when a computed color string is fully transparent. */
function isTransparent(input) {
  const c = parseColor(input);
  return !c || c.a <= EPS;
}

/** "12px" -> 12, " 0 " -> 0, "auto"/"" -> null. */
function parsePx(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s || s === 'auto' || s === 'none' || s === 'normal') return null;
  const m = /^(-?[\d.]+(?:e[-+]?\d+)?)(px)?$/i.exec(s);
  if (!m) {
    if (/^0+$/.test(s)) return 0;
    return null;
  }
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** "50%" -> {percent:50}, "12px" -> {px:12}; null otherwise. */
function parseLength(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  const pct = /^(-?[\d.]+)%$/.exec(s);
  if (pct) return { percent: parseFloat(pct[1]) };
  const px = /^(-?[\d.]+)px$/i.exec(s);
  if (px) return { px: parseFloat(px[1]) };
  const num = /^(-?[\d.]+)$/.exec(s);
  if (num) return { px: parseFloat(num[1]) };
  if (s.endsWith('rem') || s.endsWith('em')) {
    // Computed styles are resolved to px, but tolerate authored values.
    const v = parseFloat(s);
    if (Number.isFinite(v)) return { em: v, unit: s.slice(-3) };
  }
  return null;
}

/** Split a CSS value on a separator that is not inside parens/brackets. */
function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  const s = String(text === null || text === undefined ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** "1px 2px 3px 4px" -> [1,2,3,4] as top/right/bottom/left. Missing values repeat. */
function parseBox4(input) {
  const parts = splitTopLevel(input || '', ' ').map(parsePx);
  if (parts.some((p) => p === null)) return null;
  if (parts.length === 0) return [0, 0, 0, 0];
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

/**
 * border-radius (possibly per-corner, possibly elliptical with a slash)
 * -> [topLeft, topRight, bottomRight, bottomLeft] horizontal radii in px.
 */
function parseBorderRadius(input) {
  const s = String(input || '').trim();
  if (!s) return [0, 0, 0, 0];
  const horizontal = s.split('/')[0].trim();
  const box = parseBox4(horizontal);
  if (!box) return [0, 0, 0, 0];
  // CSS box order is TL, TR, BR, BL already.
  return [box[0], box[1], box[2], box[3]];
}

/**
 * grid-template-columns computed value -> [{px} | {fr} | {percent}]
 * e.g. "100px 100px 1fr" or "0px 0px 0px 0px [x]".
 */
function parseGridTracks(input) {
  const s = String(input || '').trim();
  if (!s || s === 'none') return [];
  const parts = s.replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^(-?[\d.]+)(px|fr|%)?$/.exec(p);
    if (!m) continue;
    const raw = parseFloat(m[1]);
    if (!Number.isFinite(raw)) continue;
    if (m[2] === 'fr') out.push({ fr: raw });
    else if (m[2] === '%') out.push({ percent: raw });
    else out.push({ px: raw });
  }
  return out;
}

/** font-weight computed value -> 100..900 int. */
function parseFontWeight(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s === 'normal' || s === '') return 400;
  if (s === 'bold' || s === 'bolder') return 700;
  if (s === 'lighter') return 300;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n) : 400;
}

/** "1.2px" letter-spacing -> Slate's 1/1000 em units. */
function letterSpacingToSlate(input, fontSizePx) {
  const px = parsePx(input);
  if (px === null || !fontSizePx) return 0;
  return round((px / fontSizePx) * 1000, 1);
}

/** "24px" line-height -> percentage of font size (UMG LineHeightPercentage). */
/**
 * First outer box-shadow -> { dx, dy, blur, spread } in CSS px, or null.
 * `inset` shadows are not mapped (they would need a second, inner paint layer).
 */
function parseBoxShadow(input) {
  const text = String(input || '').trim();
  if (!text || text === 'none') return null;
  const first = text.split(/,(?![^(]*\))/)[0] || '';
  if (/inset/i.test(first)) return null;
  const lengths = first.match(/-?[\d.]+px/g) || [];
  if (lengths.length < 2) return null;
  const value = (index) => {
    const px = parsePx(lengths[index]);
    return px === null ? null : px;
  };
  const dx = value(0);
  const dy = value(1);
  if (dx === null || dy === null) return null;
  return {
    dx,
    dy,
    blur: value(2) || 0,
    spread: value(3) || 0,
  };
}

function lineHeightToPercent(input, fontSizePx) {
  const px = parsePx(input);
  if (px === null || !fontSizePx) return null;
  return round((px / fontSizePx) * 100, 1);
}

/**
 * Extract url(...) targets from a background-image computed value, in order.
 * Gradient functions are reported separately so the caller can warn about them.
 */
function parseBackgroundImage(input) {
  const s = String(input || '').trim();
  const result = { urls: [], gradients: [] };
  if (!s || s === 'none') return result;
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
  let m;
  while ((m = urlRe.exec(s)) !== null) {
    const url = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) || '';
    if (url) result.urls.push(url.trim());
  }
  const gradRe = /((?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(/g;
  while ((m = gradRe.exec(s)) !== null) result.gradients.push(m[1]);
  return result;
}

/** "cover" | "contain" | "100px 50px" -> rough {mode,size}. */
function parseBackgroundSize(input) {
  const s = String(input || '').trim();
  if (!s || s === 'auto') return { mode: 'auto' };
  if (s === 'cover' || s === 'contain') return { mode: s };
  const parts = s.split(/\s+/).filter(Boolean);
  const first = parseLength(parts[0]);
  const second = parts[1] ? parseLength(parts[1]) : null;
  if (!first) return { mode: 'auto' };
  return {
    mode: 'explicit',
    width: first.px !== undefined ? first.px : null,
    height: second && second.px !== undefined ? second.px : null,
  };
}

/** Number that is safe for JSON output (finite). */
function finite(v, fallback) {
  return Number.isFinite(v) ? v : fallback === undefined ? 0 : fallback;
}

module.exports = {
  EPS,
  clamp,
  srgbToLinear,
  round,
  parseColor,
  colorToLinear,
  isTransparent,
  parsePx,
  parseLength,
  splitTopLevel,
  parseBox4,
  parseBorderRadius,
  parseGridTracks,
  parseFontWeight,
  letterSpacingToSlate,
  lineHeightToPercent,
  parseBoxShadow,
  parseBackgroundImage,
  parseBackgroundSize,
  finite,
};
