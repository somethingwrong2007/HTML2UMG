// Copyright (c) 2026 FPVSkyline. MIT License.
// Asset extraction: <img>, background-image:url(), inline <svg>, fonts.
// Files land in the assets directory; the contract's `assets` block is built here.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const IMAGE_EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
};

/** Sniff an image format from its first bytes; returns an extension or null. */
function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('utf8', 0, 200).replace(/^\uFEFF/, '').trim().startsWith('<svg')) return 'svg';
  if (b.toString('utf8', 0, 400).indexOf('<svg') >= 0) return 'svg';
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'ico';
  if (b.toString('ascii', 0, 4) === 'wOF2') return 'woff2';
  if (b.toString('ascii', 0, 4) === 'wOFF') return 'woff';
  if (b.toString('ascii', 0, 4) === 'OTTO') return 'otf';
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return 'ttf';
  return null;
}

/** Windows/system font lookup table: family -> [{weight, italic, file}] */
const SYSTEM_FONTS = {
  arial: [
    { weight: 400, italic: false, file: 'arial.ttf' },
    { weight: 700, italic: false, file: 'arialbd.ttf' },
    { weight: 400, italic: true, file: 'ariali.ttf' },
    { weight: 700, italic: true, file: 'arialbi.ttf' },
  ],
  'segoe ui': [
    { weight: 400, italic: false, file: 'segoeui.ttf' },
    { weight: 600, italic: false, file: 'seguisb.ttf' },
    { weight: 700, italic: false, file: 'segoeuib.ttf' },
    { weight: 400, italic: true, file: 'segoeuii.ttf' },
    { weight: 700, italic: true, file: 'segoeuiz.ttf' },
  ],
  tahoma: [
    { weight: 400, italic: false, file: 'tahoma.ttf' },
    { weight: 700, italic: false, file: 'tahomabd.ttf' },
  ],
  verdana: [
    { weight: 400, italic: false, file: 'verdana.ttf' },
    { weight: 700, italic: false, file: 'verdanab.ttf' },
    { weight: 400, italic: true, file: 'verdanai.ttf' },
    { weight: 700, italic: true, file: 'verdanaz.ttf' },
  ],
  'times new roman': [
    { weight: 400, italic: false, file: 'times.ttf' },
    { weight: 700, italic: false, file: 'timesbd.ttf' },
    { weight: 400, italic: true, file: 'timesi.ttf' },
    { weight: 700, italic: true, file: 'timesbi.ttf' },
  ],
  'courier new': [
    { weight: 400, italic: false, file: 'cour.ttf' },
    { weight: 700, italic: false, file: 'courbd.ttf' },
    { weight: 400, italic: true, file: 'couri.ttf' },
    { weight: 700, italic: true, file: 'courbi.ttf' },
  ],
  consolas: [
    { weight: 400, italic: false, file: 'consola.ttf' },
    { weight: 700, italic: false, file: 'consolab.ttf' },
    { weight: 400, italic: true, file: 'consolai.ttf' },
    { weight: 700, italic: true, file: 'consolaz.ttf' },
  ],
  georgia: [
    { weight: 400, italic: false, file: 'georgia.ttf' },
    { weight: 700, italic: false, file: 'georgiab.ttf' },
    { weight: 400, italic: true, file: 'georgiai.ttf' },
    { weight: 700, italic: true, file: 'georgiaz.ttf' },
  ],
  'trebuchet ms': [
    { weight: 400, italic: false, file: 'trebuc.ttf' },
    { weight: 700, italic: false, file: 'trebucbd.ttf' },
    { weight: 400, italic: true, file: 'trebucit.ttf' },
    { weight: 700, italic: true, file: 'trebucbi.ttf' },
  ],
  calibri: [
    { weight: 400, italic: false, file: 'calibri.ttf' },
    { weight: 700, italic: false, file: 'calibrib.ttf' },
    { weight: 400, italic: true, file: 'calibrii.ttf' },
    { weight: 700, italic: true, file: 'calibriz.ttf' },
  ],
  cambria: [
    { weight: 400, italic: false, file: 'cambria.ttc' },
    { weight: 700, italic: false, file: 'cambriab.ttf' },
  ],
  candara: [{ weight: 400, italic: false, file: 'candara.ttf' }],
  corbel: [{ weight: 400, italic: false, file: 'corbel.ttf' }],
  impact: [{ weight: 400, italic: false, file: 'impact.ttf' }],
  'franklin gothic medium': [{ weight: 400, italic: false, file: 'framd.ttf' }],
  bahnschrift: [{ weight: 400, italic: false, file: 'bahnschrift.ttf' }],
  'microsoft sans serif': [{ weight: 400, italic: false, file: 'micross.ttf' }],
  simsun: [{ weight: 400, italic: false, file: 'simsun.ttc' }],
  'microsoft yahei': [{ weight: 400, italic: false, file: 'msyh.ttc' }],
};

/** Directories searched for system font files. */
function systemFontDirs() {
  const out = [];
  if (process.env.WINDIR) out.push(path.join(process.env.WINDIR, 'Fonts'));
  if (process.platform === 'win32') out.push('C:/Windows/Fonts');
  else out.push('/System/Library/Fonts', '/Library/Fonts', '/usr/share/fonts/truetype');
  return out;
}

/** Split a CSS font-family list into plain family names. */
function splitFontFamilies(input) {
  const s = String(input || '');
  return s
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter((part) => part.length > 0);
}

/** Decode a data: URI into {buffer, mime}. */
function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);
  const mime = header.split(';')[0] || 'application/octet-stream';
  try {
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { buffer, mime };
  } catch (err) {
    return null;
  }
}

class AssetRegistry {
  /**
   * @param {object} options
   * @param {string} options.outDir        absolute assets directory
   * @param {string} options.relDir        path prefix recorded in JSON (e.g. "assets")
   * @param {string} options.baseDir       directory of the input HTML (relative URL base)
   * @param {(msg:string)=>void} options.warn
   * @param {(msg:string)=>void} [options.info]
   */
  constructor(options) {
    this.outDir = options.outDir;
    this.relDir = (options.relDir || 'assets').replace(/\\/g, '/').replace(/\/+$/, '');
    this.baseDir = options.baseDir;
    this.warn = options.warn || (() => {});
    this.info = options.info || (() => {});
    this.textures = [];
    this.fonts = [];
    this.textureBySource = new Map();
    this.fontByKey = new Map();
    this.seeded = new Map(); // element index -> {key, file}
    this.textureCount = 0;
    this.fontCount = 0;
    this.written = 0;
    this.failed = 0;
    fs.mkdirSync(this.outDir, { recursive: true });
  }

  relFile(name) {
    return this.relDir ? `${this.relDir}/${name}` : name;
  }

  /** Register raw bytes as a texture. Returns {key, file, ext}. */
  addBuffer(buffer, ext, label) {
    if (!buffer || !buffer.length) return null;
    const sniffed = ext || sniffImageExt(buffer);
    if (!sniffed) {
      this.warn(`asset: could not determine the image format of ${label}`);
      return null;
    }
    if (sniffed === 'svg') {
      // SVG is not importable as a UMG texture; it must be rasterised upstream.
      this.warn(`asset: ${label} is an SVG but was not rasterised; register it manually`);
    }
    const name = `tex_${this.textureCount}.${sniffed}`;
    this.textureCount += 1;
    const abs = path.join(this.outDir, name);
    try {
      fs.writeFileSync(abs, buffer);
      this.written += 1;
    } catch (err) {
      this.failed += 1;
      this.warn(`asset: cannot write ${abs}: ${err.message}`);
      return null;
    }
    const key = `tex_${this.textures.length}`;
    const file = this.relFile(name);
    this.textures.push({ key, file });
    return { key, file, ext: sniffed, abs };
  }

  /** Pre-seed a rasterised element (inline <svg>) so the mapper can look it up. */
  seedElementTexture(elementIndex, buffer, label) {
    const added = this.addBuffer(buffer, 'png', label || `inline svg #${elementIndex}`);
    if (!added) return null;
    this.seeded.set(elementIndex, added);
    return added;
  }

  seededFor(elementIndex) {
    return this.seeded.get(elementIndex) || null;
  }

  /**
   * Resolve a CSS url()/img src into a registered texture.
   * Handles data:, file:, relative and http(s) URLs.
   * Returns {key, file, ext} | null.
   */
  addFromUrl(rawUrl, options) {
    const opts = options || {};
    const label = opts.label || 'image';
    if (!rawUrl) return null;
    const url = String(rawUrl).trim();
    if (!url) return null;

    const cached = this.textureBySource.get(url);
    if (cached) return cached;

    // data: URI — decode straight to disk.
    if (/^data:/i.test(url)) {
      const decoded = decodeDataUri(url);
      if (!decoded) {
        this.warn(`asset: cannot decode data URI in ${label}`);
        return null;
      }
      const ext = IMAGE_EXT_BY_MIME[decoded.mime.split(';')[0]] || null;
      const added = this.addBuffer(decoded.buffer, ext, label);
      if (added) this.textureBySource.set(url, added);
      return added;
    }

    // Absolute URL or a path on disk.
    let filePath = null;
    if (/^file:/i.test(url)) {
      try {
        filePath = fileURLToPath(url);
      } catch (err) {
        filePath = null;
      }
    } else if (/^[a-z]+:\/\//i.test(url)) {
      return this._addFromRemote(url, label);
    } else {
      const cleaned = decodeURIComponent(url.split('#')[0].split('?')[0]);
      filePath = path.isAbsolute(cleaned) ? cleaned : path.resolve(this.baseDir, cleaned);
    }

    if (!filePath) {
      this.warn(`asset: cannot resolve ${label} ("${url}")`);
      return null;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (err) {
      this.warn(`asset: cannot read ${label} ("${url}" -> ${filePath})`);
      return null;
    }
    const ext = (path.extname(filePath).replace('.', '') || '').toLowerCase() || null;
    const added = this.addBuffer(buffer, ext && ext.length <= 5 ? ext : null, label);
    if (added) this.textureBySource.set(url, added);
    return added;
  }

  _addFromRemote(url, label) {
    // Best effort: remote assets are fetched with a hard timeout so CI cannot hang.
    try {
      const response = require('child_process'); // eslint-disable-line no-unused-vars
    } catch (e) { /* ignore */ }
    return this.addFromRemoteAsync(url, label) || null;
  }

  /** Synchronous callers cannot await; the CLI pre-fetches remote assets. */
  async prefetchRemote(url, label) {
    const cached = this.textureBySource.get(url);
    if (cached) return cached;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
      const ext = IMAGE_EXT_BY_MIME[contentType] || null;
      const added = this.addBuffer(buffer, ext, label);
      if (added) this.textureBySource.set(url, added);
      return added;
    } catch (err) {
      this.warn(`asset: remote image not embedded (${label}: ${url}) — ${err.message}`);
      return null;
    }
  }

  addFromRemoteAsync() {
    return null;
  }

  /** True when a URL still needs a network fetch (the CLI pre-fetches these). */
  isRemote(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  /**
   * Register a font usage and, when possible, copy a font file next to the json.
   * @returns {{key:string, family:string, weight:number, italic:boolean, hasFile:boolean}}
   */
  addFont(familyList, weight, italic, fontFaceSrcs) {
    const families = splitFontFamilies(familyList);
    const primary = families.length ? families[0] : 'Segoe UI';
    const weightValue = Number.isFinite(weight) ? weight : 400;
    const italicValue = !!italic;
    const cacheKey = `${primary.toLowerCase()}|${weightValue}|${italicValue}`;
    const existing = this.fontByKey.get(cacheKey);
    if (existing) return existing;

    let file = null;
    let absSource = null;

    // 1. A @font-face declared in the page wins (the designer chose that file).
    if (fontFaceSrcs && fontFaceSrcs.length) {
      const resolved = this._resolveFontFaceSrc(fontFaceSrcs, primary, weightValue, italicValue);
      if (resolved) {
        file = resolved.file;
        absSource = resolved.abs;
      }
    }

    // 2. Known system fonts.
    if (!absSource) {
      for (const family of families) {
        const known = SYSTEM_FONTS[family.toLowerCase()];
        if (!known) continue;
        const match = pickFontVariant(known, weightValue, italicValue);
        if (!match) continue;
        const abs = findSystemFontFile(match.file);
        if (!abs) continue;
        if (/\.ttc$/i.test(abs)) {
          this.warn(`font: "${family}" resolves to a TrueType collection (${match.file}); UE cannot import .ttc — register a single-face font instead`);
          continue;
        }
        absSource = abs;
        break;
      }
    }

    if (absSource) {
      const ext = path.extname(absSource).replace('.', '').toLowerCase() || 'ttf';
      const name = `font_${this.fontCount}.${ext}`;
      this.fontCount += 1;
      try {
        fs.copyFileSync(absSource, path.join(this.outDir, name));
        this.written += 1;
        file = this.relFile(name);
      } catch (err) {
        this.failed += 1;
        this.warn(`font: cannot copy ${absSource}: ${err.message}`);
        file = null;
      }
    } else {
      const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system)$/i;
      const usable = families.find((f) => !generic.test(f));
      if (usable) {
        this.warn(`font: no file for "${usable}" — the importer will fall back to the engine default font (family recorded for manual mapping)`);
      }
    }

    const entry = {
      key: `font_${this.fonts.length}`,
      family: primary,
      weight: weightValue,
      italic: italicValue,
      hasFile: !!file,
    };
    this.fonts.push({
      key: entry.key,
      family: entry.family,
      weight: entry.weight,
      italic: entry.italic,
      file: file || '',
    });
    this.fontByKey.set(cacheKey, entry);
    return entry;
  }

  _resolveFontFaceSrc(srcText, family, weight, italic) {
    const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
    let match;
    while ((match = urlRe.exec(srcText)) !== null) {
      const url = (match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3] || '').trim();
      if (!url || /^data:/i.test(url) === false && /^https?:/i.test(url)) {
        if (url && /^https?:/i.test(url)) {
          this.warn(`font: webfont for "${family}" is remote (${url}); dependent on network — not embedded`);
          continue;
        }
        if (!url) continue;
      }
      if (/^data:/i.test(url)) {
        const decoded = decodeDataUri(url);
        if (!decoded) continue;
        const ext = IMAGE_EXT_BY_MIME[decoded.mime] || sniffImageExt(decoded.buffer) || 'ttf';
        const name = `font_${this.fontCount}.${ext}`;
        this.fontCount += 1;
        try {
          fs.writeFileSync(path.join(this.outDir, name), decoded.buffer);
          this.written += 1;
          return { file: this.relFile(name), abs: path.join(this.outDir, name) };
        } catch (err) {
          this.warn(`font: cannot write embedded webfont for "${family}": ${err.message}`);
          return null;
        }
      }
      const cleaned = decodeURIComponent(url.split('#')[0].split('?')[0]);
      const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(this.baseDir, cleaned);
      if (fs.existsSync(abs)) return { file: null, abs };
      this.warn(`font: @font-face source not found for "${family}" (${url})`);
    }
    return null;
  }

  /** Build the contract `assets` object. */
  toJson() {
    return {
      textures: this.textures,
      fonts: this.fonts,
    };
  }

  summary() {
    return { textures: this.textures.length, fonts: this.fonts.length, written: this.written, failed: this.failed };
  }
}

function pickFontVariant(variants, weight, italic) {
  const candidates = variants.filter((v) => v.italic === !!italic);
  const pool = candidates.length ? candidates : variants;
  let best = null;
  let bestDelta = Infinity;
  for (const variant of pool) {
    const delta = Math.abs(variant.weight - weight) + (variant.italic === !!italic ? 0 : 100);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = variant;
    }
  }
  return best;
}

function findSystemFontFile(fileName) {
  for (const dir of systemFontDirs()) {
    const candidate = path.join(dir, fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (err) {
      /* keep looking */
    }
  }
  return null;
}

module.exports = {
  AssetRegistry,
  splitFontFamilies,
  decodeDataUri,
  sniffImageExt,
  SYSTEM_FONTS,
  findSystemFontFile,
  pathToFileURL,
  fileURLToPath,
};
