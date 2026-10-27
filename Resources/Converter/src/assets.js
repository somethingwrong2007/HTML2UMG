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
  // A `.ttc` is a collection of faces: `subface` is the FT face index UE needs
  // (FFontData::SubFaceIndex). UE 5.8 imports .ttc/.otc, so a collection is usable.
  simsun: [{ weight: 400, italic: false, file: 'simsun.ttc', subface: 0 }],
  'microsoft yahei': [
    { weight: 300, italic: false, file: 'msyhl.ttc', subface: 0 },
    { weight: 400, italic: false, file: 'msyh.ttc', subface: 0 },
    { weight: 700, italic: false, file: 'msyhbd.ttc', subface: 0 },
  ],
  // Chinese families. The two entries above are TrueType collections, which UE cannot import,
  // so a design whose text is Chinese used to fall back to the engine default font and lose its
  // glyphs. These are single-face files shipped with Windows (Noto Sans SC as a variable font,
  // which UE imports as its default instance).
  'noto sans sc': [
    { weight: 400, italic: false, file: 'NotoSansSC-VF.ttf' },
  ],
  'noto serif sc': [
    { weight: 400, italic: false, file: 'NotoSerifSC-VF.ttf' },
  ],
  simhei: [{ weight: 400, italic: false, file: 'simhei.ttf' }],
  dengxian: [
    { weight: 400, italic: false, file: 'Deng.ttf' },
    { weight: 700, italic: false, file: 'Dengb.ttf' },
  ],
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


// ---------------------------------------------------------------- CJK coverage
//
// A CSS stack such as `"Segoe UI", sans-serif` renders Chinese perfectly in the
// browser: Blink silently substitutes a system CJK face for every glyph the named
// fonts do not carry. UMG has no such substitution — FSlateFontInfo points at ONE
// font file — so those glyphs come out as .notdef boxes ("tofu"). The converter
// therefore records, per font usage, which faces have to be layered behind it, and
// it decides that from two independent sources:
//   * CSS.getPlatformFontsForNode — what the browser ACTUALLY drew this text with;
//   * the font file's own cmap    — whether that file really has the codepoints.
// The cmap check is the deterministic half: it works with no browser at all.

/** Unicode blocks a Latin-only face does not carry. */
const CJK_BLOCKS = [
  { id: 'punct', from: 0x3000, to: 0x303f }, // CJK punctuation (　-〿)
  { id: 'kana', from: 0x3040, to: 0x30ff }, // hiragana + katakana
  { id: 'exta', from: 0x3400, to: 0x4dbf }, // CJK ext A
  { id: 'han', from: 0x4e00, to: 0x9fff }, // CJK unified ideographs
  { id: 'compat', from: 0xf900, to: 0xfaff }, // CJK compatibility ideographs
  { id: 'full', from: 0xff00, to: 0xffef }, // fullwidth forms
];

function cjkBlockOf(codepoint) {
  for (let i = 0; i < CJK_BLOCKS.length; i += 1) {
    const block = CJK_BLOCKS[i];
    if (codepoint >= block.from && codepoint <= block.to) return block.id;
  }
  return null;
}

/** Codepoints of `text` that only a CJK-capable face can draw, sorted, unique. */
function cjkCodepoints(text) {
  const out = new Set();
  const value = String(text === undefined || text === null ? '' : text);
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cjkBlockOf(cp)) out.add(cp);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function hasCjk(text) {
  return cjkCodepoints(text).length > 0;
}

const coverageCache = new Map();

/** Parse a TrueType/OpenType cmap (formats 4, 12, plus 0/6) into sorted ranges. */
function parseFontCoverage(buffer, subfaceIndex) {
  const result = { ranges: [], format: null, glyphCount: 0, isCollection: false, subface: 0, error: null };
  if (!buffer || buffer.length < 12) {
    result.error = 'file too small';
    return result;
  }
  let base = 0;
  if (buffer.toString('ascii', 0, 4) === 'ttcf') {
    // A TrueType collection: pick the requested sub-face. Its table offsets are
    // absolute from the start of the file, so only the header position moves.
    result.isCollection = true;
    const subface = Number.isFinite(subfaceIndex) ? subfaceIndex : 0;
    result.subface = subface;
    let numFonts = 0;
    try {
      numFonts = buffer.readUInt32BE(8);
    } catch (err) {
      result.error = 'truncated TTC header';
      return result;
    }
    if (subface >= numFonts || 12 + subface * 4 + 4 > buffer.length) {
      result.error = `sub-face ${subface} not present (collection has ${numFonts})`;
      return result;
    }
    base = buffer.readUInt32BE(12 + subface * 4);
  }
  let numTables = 0;
  try {
    numTables = buffer.readUInt16BE(base + 4);
  } catch (err) {
    result.error = 'truncated sfnt header';
    return result;
  }
  let cmapOffset = 0;
  let maxpOffset = 0;
  for (let i = 0; i < numTables; i += 1) {
    const record = base + 12 + i * 16;
    if (record + 16 > buffer.length) break;
    const tag = buffer.toString('ascii', record, record + 4);
    const offset = buffer.readUInt32BE(record + 8);
    if (tag === 'cmap') cmapOffset = offset;
    else if (tag === 'maxp') maxpOffset = offset;
  }
  if (maxpOffset && maxpOffset + 6 <= buffer.length) result.glyphCount = buffer.readUInt16BE(maxpOffset + 4);
  if (!cmapOffset || cmapOffset + 4 > buffer.length) {
    result.error = 'no cmap table';
    return result;
  }

  const tableCount = buffer.readUInt16BE(cmapOffset + 2);
  const subtables = [];
  for (let i = 0; i < tableCount; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    if (record + 8 > buffer.length) break;
    subtables.push({
      platform: buffer.readUInt16BE(record),
      encoding: buffer.readUInt16BE(record + 2),
      offset: cmapOffset + buffer.readUInt32BE(record + 4),
    });
  }
  // Unicode full-repertoire subtables first, then BMP, then whatever is left.
  const rank = (sub) => {
    if (sub.platform === 3 && sub.encoding === 10) return 0;
    if (sub.platform === 0 && (sub.encoding === 4 || sub.encoding === 6)) return 1;
    if (sub.platform === 3 && sub.encoding === 1) return 2;
    if (sub.platform === 0) return 3;
    return 9;
  };
  subtables.sort((a, b) => rank(a) - rank(b));

  let bmp = null;
  for (const sub of subtables) {
    if (sub.offset + 2 > buffer.length) continue;
    let format = 0;
    try {
      format = buffer.readUInt16BE(sub.offset);
    } catch (err) {
      continue;
    }
    if (format === 12) {
      const ranges = readCmapFormat12(buffer, sub.offset);
      if (ranges && ranges.length) {
        result.ranges = ranges;
        result.format = 12;
        return result;
      }
    } else if (format === 4 && !bmp) {
      bmp = readCmapFormat4(buffer, sub.offset);
    } else if ((format === 0 || format === 6) && !bmp) {
      bmp = readCmapFormat6(buffer, sub.offset);
    }
  }
  if (bmp && bmp.length) {
    result.ranges = bmp;
    result.format = 4;
    return result;
  }
  result.error = 'no usable cmap subtable';
  return result;
}

function readCmapFormat4(buffer, offset) {
  try {
    const segCount = buffer.readUInt16BE(offset + 6) / 2;
    const endBase = offset + 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    const ranges = [];
    for (let i = 0; i < segCount; i += 1) {
      const end = buffer.readUInt16BE(endBase + i * 2);
      const start = buffer.readUInt16BE(startBase + i * 2);
      if (start === 0xffff && end === 0xffff) continue;
      if (start > end) continue;
      // A single-codepoint segment with idRangeOffset 0 that maps to glyph 0 is the
      // traditional "this code point has no glyph" marker; do not claim coverage.
      if (start === end && rangeBase + i * 2 + 2 <= buffer.length) {
        const rangeOffset = buffer.readUInt16BE(rangeBase + i * 2);
        const delta = buffer.readInt16BE(deltaBase + i * 2);
        if (rangeOffset === 0 && ((start + delta) & 0xffff) === 0) continue;
      }
      ranges.push([start, end]);
    }
    return mergeRanges(ranges);
  } catch (err) {
    return null;
  }
}

function readCmapFormat6(buffer, offset) {
  try {
    const first = buffer.readUInt16BE(offset + 6);
    const count = buffer.readUInt16BE(offset + 8);
    if (!count) return null;
    return [[first, first + count - 1]];
  } catch (err) {
    return null;
  }
}

function readCmapFormat12(buffer, offset) {
  try {
    const groups = buffer.readUInt32BE(offset + 12);
    const ranges = [];
    for (let i = 0; i < groups; i += 1) {
      const at = offset + 16 + i * 12;
      if (at + 12 > buffer.length) break;
      ranges.push([buffer.readUInt32BE(at), buffer.readUInt32BE(at + 4)]);
    }
    return mergeRanges(ranges);
  } catch (err) {
    return null;
  }
}

function mergeRanges(ranges) {
  if (!ranges.length) return ranges;
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const next = sorted[i];
    if (next[0] <= last[1] + 1) {
      if (next[1] > last[1]) last[1] = next[1];
    } else {
      out.push(next.slice());
    }
  }
  return out;
}

/** Binary search over merged ranges. */
function coverageHas(ranges, codepoint) {
  if (!ranges || !ranges.length) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (codepoint < range[0]) hi = mid - 1;
    else if (codepoint > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Fraction of the inclusive range [from,to] covered by merged ranges (no per-point scan). */
function coverageRatioInRange(coverage, from, to) {
  if (!coverage || !coverage.ranges || !coverage.ranges.length || to < from) return 0;
  let lo = 0;
  let hi = coverage.ranges.length - 1;
  let start = coverage.ranges.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (coverage.ranges[mid][1] < from) lo = mid + 1;
    else {
      start = mid;
      hi = mid - 1;
    }
  }
  let covered = 0;
  for (let i = start; i < coverage.ranges.length; i += 1) {
    const range = coverage.ranges[i];
    if (range[0] > to) break;
    const low = Math.max(range[0], from);
    const high = Math.min(range[1], to);
    if (high >= low) covered += high - low + 1;
  }
  return covered / (to - from + 1);
}

/** Coverage of a font file on disk (cached; a CJK face is 17 MB). */
function fontCoverageForFile(absPath, subfaceIndex) {
  if (!absPath) return null;
  const subface = Number.isFinite(subfaceIndex) ? subfaceIndex : 0;
  const cacheKey = `${absPath}#${subface}`;
  const cached = coverageCache.get(cacheKey);
  if (cached) return cached;
  let coverage = null;
  try {
    coverage = parseFontCoverage(fs.readFileSync(absPath), subface);
  } catch (err) {
    coverage = { ranges: [], format: null, glyphCount: 0, isCollection: false, subface, error: err.message };
  }
  coverageCache.set(cacheKey, coverage);
  return coverage;
}

/** Families we can really import for CJK. Single-face files only: .ttc collections
 *  (msyh.ttc, simsun.ttc) cannot be imported by UE, so they are deliberately absent. */
const CJK_FONT_FAMILIES = {
  'noto sans sc': {
    name: 'Noto Sans SC',
    variants: [{ weight: 400, italic: false, file: 'NotoSansSC-VF.ttf' }],
  },
  'noto serif sc': {
    name: 'Noto Serif SC',
    variants: [{ weight: 400, italic: false, file: 'NotoSerifSC-VF.ttf' }],
  },
  dengxian: {
    name: 'DengXian',
    variants: [
      { weight: 300, italic: false, file: 'Dengl.ttf' },
      { weight: 400, italic: false, file: 'Deng.ttf' },
      { weight: 700, italic: false, file: 'Dengb.ttf' },
    ],
  },
  simhei: { name: 'SimHei', variants: [{ weight: 400, italic: false, file: 'simhei.ttf' }] },
  // Japanese designs: Chromium on Windows renders them with Yu Gothic, and only that
  // face reproduces its metrics. Only ever reachable when the text has kana (see
  // isJapaneseFace), so Chinese text can never land here.
  'yu gothic': {
    name: 'Yu Gothic',
    variants: [
      { weight: 300, italic: false, file: 'YuGothL.ttc', subface: 0 },
      { weight: 400, italic: false, file: 'YuGothR.ttc', subface: 0 },
      { weight: 500, italic: false, file: 'YuGothM.ttc', subface: 0 },
      { weight: 700, italic: false, file: 'YuGothB.ttc', subface: 0 },
    ],
    collection: true,
  },
  // SimSun is a SERIF face (宋体); it must not be mapped onto a sans CJK font.
  simsun: {
    name: 'SimSun',
    variants: [{ weight: 400, italic: false, file: 'simsun.ttc', subface: 0 }],
    collection: true,
  },
  'source han sans jp': {
    name: 'Source Han Sans JP',
    variants: [
      { weight: 400, italic: false, file: 'SourceHanSansJP-Normal.otf' },
      { weight: 700, italic: false, file: 'SourceHanSansJP-Bold.otf' },
    ],
  },
  // TrueType collection: only reachable when TTC support is switched on (see
  // AssetRegistry#allowTtc). UE 5.8's FFontData has SubFaceIndex, so a .ttc can be
  // imported per sub-face; that is being verified on the importer side, so the default
  // stays conservative and these two entries are skipped.
  'microsoft yahei': {
    name: 'Microsoft YaHei',
    variants: [
      { weight: 300, italic: false, file: 'msyhl.ttc', subface: 0 },
      { weight: 400, italic: false, file: 'msyh.ttc', subface: 0 },
      { weight: 700, italic: false, file: 'msyhbd.ttc', subface: 0 },
    ],
    collection: true,
  },
};

/** Browser-reported families (what Chrome actually substituted) -> an importable one. */
const CJK_FAMILY_ALIASES = {
  'microsoft yahei': 'noto sans sc',
  'microsoft yahei ui': 'noto sans sc',
  'microsoft jhenghei': 'noto sans sc',
  msyh: 'noto sans sc',
  msyhbd: 'noto sans sc',
  simsun: 'noto serif sc',
  nsimsun: 'noto serif sc',
  simsunb: 'noto serif sc',
  'simsun-extb': 'noto serif sc',
  'noto sans cjk sc': 'noto sans sc',
  'noto sans cjk jp': 'noto sans sc',
  'noto sans cjk tc': 'noto sans sc',
  'source han sans sc': 'noto sans sc',
  'source han sans cjk sc': 'noto sans sc',
  'source han sans cn': 'noto sans sc',
  'pingfang sc': 'noto sans sc',
  'pingfang tc': 'noto sans sc',
  'hiragino sans gb': 'noto sans sc',
  'songti sc': 'noto serif sc',
  'noto serif cjk sc': 'noto serif sc',
  'source han serif sc': 'noto serif sc',
  fangsong: 'noto serif sc',
  kaiti: 'noto serif sc',
  kaiti_sc: 'noto serif sc',
  'kaiti sc': 'noto serif sc',
  stkaiti: 'noto serif sc',
  'hiragino sans': 'source han sans jp',
  'hiragino kaku gothic pro': 'source han sans jp',
  'hiragino kaku gothic prn': 'source han sans jp',
  'yu gothic': 'source han sans jp',
  'yu gothic ui': 'source han sans jp',
  meiryo: 'source han sans jp',
  'meiryo ui': 'source han sans jp',
  'ms pgothic': 'source han sans jp',
  'ms gothic': 'source han sans jp',
  'malgun gothic': 'noto sans sc',
  gulim: 'noto sans sc',
  batang: 'noto serif sc',
};

/**
 * Last-resort chain, most-likely-to-cover first. Microsoft YaHei (.ttc) is only present
 * when TTC sub-face import is enabled; every entry is validated against the text's
 * codepoints before it is used, so a "looks Chinese" family name can never win.
 */
function defaultCjkChain(serif, allowTtc) {
  const sans = allowTtc
    ? ['Microsoft YaHei', 'Noto Sans SC', 'SimHei', 'DengXian']
    : ['Noto Sans SC', 'SimHei', 'DengXian', 'Noto Serif SC'];
  const serifChain = allowTtc
    ? ['Noto Serif SC', 'Microsoft YaHei', 'Noto Sans SC', 'SimHei']
    : ['Noto Serif SC', 'Noto Sans SC', 'SimHei', 'DengXian'];
  return serif ? serifChain : sans;
}

// ------------------------------------------------------------- font licensing
//
// The converter copies font files next to the JSON and the importer embeds them into
// UFontFace assets (bulk data), i.e. they ship inside the game package. Shipping
// Microsoft's YaHei / SimSun / DengXian / SimHei is a licensing problem; Noto Sans SC
// / Noto Serif SC / Source Han Sans are OFL and can be redistributed freely.

/** Files we know to be OFL/UFL/Apache (safe to redistribute). */
const REDISTRIBUTABLE_FONT_FILE_RE =
  // Cascadia Code / Mono is MIT (Microsoft), so it may ship; "Cascadia Mono" is what the
  // skyline reference design asks for through data-ue-font-map.
  /^(notosanssc|notoserifsc|notosanscjk|notoserifcjk|notosansjp|notoserifjp|notosanskr|sourcehansans|sourcehanserif|sourcehan|ibmplex|inter|roboto|opensans|lato|montserrat|firacode|jetbrainsmono|cascadia)/i;

/** Files owned by Microsoft/Apple/Adobe or otherwise not redistributable. */
const PROPRIETARY_FONT_FILE_RE =
  /^(msyh|msyhbd|msyhl|msjh|msjhbd|msjhl|simsun|simsunb|simhei|deng|dengb|dengl|simkai|simfang|fzss|arial|arialbd|ariali|arialbi|segoeui|seguisb|segoeuib|segoeuii|segoeuiz|segoeuil|segoeuisl|tahoma|tahomabd|verdana|verdanab|verdanai|verdanaz|consola|consolab|consolai|consolaz|calibri|calibrib|calibrii|calibriz|cambria|cambriab|georgia|georgiab|georgiai|georgiaz|times|timesbd|timesi|timesbi|cour|courbd|couri|courbi|impact|framd|micross|bahnschrift|candara|corbel|trebuc|yugoth|meiryo|msgothic|msmincho)/i;

/** True for a TrueType/OpenType collection, i.e. a file that needs a sub-face index. */
function isCollectionFile(absPath) {
  return /\.(ttc|otc)$/i.test(String(absPath || ''));
}

/**
 * Which licence a copied font file carries.
 * 'unknown' is only for files the *page* brought in (@font-face / data: URI): their
 * licence is not something the converter can know, so it must be reviewed by hand.
 */
function licenseOf(absPath) {
  const base = path.basename(String(absPath || '')).toLowerCase();
  if (!base) return 'unknown';
  if (REDISTRIBUTABLE_FONT_FILE_RE.test(base)) return 'redistributable';
  if (PROPRIETARY_FONT_FILE_RE.test(base)) return 'proprietary';
  return 'unknown';
}

// Family-level sampling gate. Per-code-point cmap coverage is the authority for the
// actual text; the sample is a fast, family-wide veto so a face that covers only ~61%
// of simplified Chinese (NotoSansJP: 12747/20992) can never sneak in just because a
// particular sentence happens to use the characters it does have.
const SAMPLE_COMMON_39 = '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得';
const SAMPLE_CJK = SAMPLE_COMMON_39 +
  '前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新义各入几口认条平系气题活更别打女变四总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉'
  + '，。！？；：、（）《》“”‘’';

const sampleCache = new Map();

/** Family-level sample coverage of a font file (39 common + wider CJK sample). */
function sampleStatsForFile(absPath, subfaceIndex) {
  const subface = Number.isFinite(subfaceIndex) ? subfaceIndex : 0;
  const key = `${absPath}#${subface}`;
  const cached = sampleCache.get(key);
  if (cached) return cached;
  const coverage = fontCoverageForFile(absPath, subface);
  const cps = (string, out) => {
    for (const ch of string) out.push(ch.codePointAt(0));
    return out;
  };
  const commonCount = (string) => {
    let hit = 0;
    let total = 0;
    for (const ch of string) {
      total += 1;
      if (coverageHas(coverage.ranges, ch.codePointAt(0))) hit += 1;
    }
    return { hit, total };
  };
  const common = commonCount(SAMPLE_COMMON_39);
  const wide = commonCount(SAMPLE_CJK);
  const stats = {
    common: common.total ? common.hit / common.total : 0,
    cjk: wide.total ? wide.hit / wide.total : 0,
    commonHit: common.hit,
    commonTotal: common.total,
    cjkHit: wide.hit,
    cjkTotal: wide.total,
  };
  sampleCache.set(key, stats);
  return stats;
}

const SAMPLE_COMMON_THRESHOLD = 0.95;
const SAMPLE_CJK_THRESHOLD = 0.9;

/** A fallback owns a whole CJK block once it covers at least this much of it. */
const FALLBACK_BLOCK_THRESHOLD = 0.6;

/**
 * A face designed for Japanese. Simplified-Chinese coverage of these is only ~61%
 * (measured on NotoSansJP: 12747/20992 code points, 10 of 39 common simplified
 * characters missing), so they must never be silently used for Chinese text — the
 * cmap check alone would still let a few characters through while the rest come out
 * in Japanese glyph forms. Kana in the text is what makes them a legitimate choice.
 */
function isJapaneseFace(family) {
  const key = String(family || '').toLowerCase();
  if (!key) return false;
  if (/hiragino|yu gothic|yu mincho|meiryo|pgothic|mincho|kozuka|osaka|ms gothic/.test(key)) return true;
  if (/source han (sans|serif) jp/.test(key)) return true;
  if (/noto (sans|serif) (cjk )?jp/.test(key)) return true;
  return /\b(jp|jpn|japan)\b/.test(key) || /jp$/.test(key.replace(/[^a-z]/g, ''));
}

/** Kana means the text really is Japanese (or at least needs a Japanese face). */
function hasKana(text) {
  return /[\u3040-\u30ff\u31f0-\u31ff]/.test(String(text === undefined || text === null ? '' : text));
}

function canonicalCjkFamily(aliasKey) {
  const entry = CJK_FONT_FAMILIES[aliasKey];
  return entry ? entry.name : aliasKey;
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
    this.primaryResolved = new Map(); // family|weight|italic -> {abs, preCopiedFile}
    this.fallbackByKey = new Map(); // family|weight|italic -> font entry
    this.fallbackFileByAbs = new Map(); // source path -> copied file (one copy per file)
    this.warned = new Set(); // de-duplicated warnings
    // 'any' (default) embeds whatever the design asks for; 'redistributable' refuses to
    // embed proprietary faces and switches to OFL ones (Noto Sans SC / Source Han).
    // 'any' embeds whatever the design names; 'redistributable' refuses proprietary faces
    // (and swaps in an OFL candidate); 'engine' embeds only redistributable faces and lets
    // everything else fall back to the UMG default font.
    this.fontPolicy = options.fontPolicy === 'redistributable'
      ? 'redistributable'
      : options.fontPolicy === 'engine'
        ? 'engine'
        : 'any';
    this.embeddedFonts = []; // {family, file, license, role}
    // TrueType collections ARE importable: UFontFileImportFactory accepts ttc/otc and
    // FFontData(Face, SubFaceIndex) selects the face inside the collection (confirmed
    // against UE 5.8 sources). ON by default; --no-ttc-subfaces (or HTML2UMG_TTC_SUBFACES=0)
    // restores the old conservative "skip collections" path.
    this.allowTtc = options.allowTtc === false ? false : process.env.HTML2UMG_TTC_SUBFACES !== '0';
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
    // Texture names are positional, so two designs converted into the SAME assets directory
    // overwrite each other's files and the first one's JSON then points at the second one's
    // pixels. That produced measurements that made no sense (the same page scoring 3.77% alone
    // and 22% when converted next to another) until the directory was inspected.
    try {
      if (!this.warnedSharedDir && fs.existsSync(abs)) {
        const existing = fs.readFileSync(abs);
        if (!existing.equals(buffer)) {
          this.warnedSharedDir = true;
          const where = this.outDir;
          this.warn('asset: ' + where + ' already holds textures from another conversion; ' +
            'positional names collide. Convert each page into its own --assets directory.');
        }
      }
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
   *
   * `usage` carries the two facts needed to decide whether a CJK fallback is needed:
   *   - text:          the string this font will render (drives the cmap check);
   *   - platformFonts: what Chromium actually drew it with (CSS.getPlatformFontsForNode);
   *   - faces:         every @font-face the page declares, so a fallback can use one.
   *
   * The cache key includes which CJK blocks the primary file does NOT cover, because
   * the same family/weight with Latin text needs no fallback at all while Han text
   * does — sharing one entry there is exactly the bug being fixed.
   *
   * @returns {{key:string, family:string, weight:number, italic:boolean, hasFile:boolean, fallbacks:Array}}
   */
  addFont(familyList, weight, italic, fontFaceSrcs, usage) {
    const families = splitFontFamilies(familyList);
    const primary = families.length ? families[0] : 'Segoe UI';
    const weightValue = Number.isFinite(weight) ? weight : 400;
    const italicValue = !!italic;
    const use = usage || {};

    // Resolve the primary face WITHOUT copying yet: the cache key depends on what the
    // file actually covers, which is only known once the face is found.
    const resolved = this._resolvePrimaryFont(families, primary, weightValue, italicValue, fontFaceSrcs);
    const plan = this._cjkPlan(families, primary, resolved, use.text, use, weightValue, italicValue);

    const cacheKey = `${primary.toLowerCase()}|${weightValue}|${italicValue}|${plan.needSig}`;
    const existing = this.fontByKey.get(cacheKey);
    if (existing) return existing;

    // --font-policy=engine: only redistributable faces are embedded. Everything else keeps no
    // file at all (no FontObject -> the UMG default font) and gets no fallback sub-fonts either,
    // because there is no primary typeface to hang them on.
    const primaryAbs = resolved.abs || (plan.promoted && plan.promoted.abs) || '';
    const primaryLicense = primaryAbs ? licenseOf(primaryAbs) : 'unknown';
    const engineDefault = this.fontPolicy === 'engine' && primaryLicense !== 'redistributable';
    if (engineDefault && primaryAbs) {
      this.warnOnce(
        `font: "${primary}" resolves to a ${primaryLicense} face (${path.basename(primaryAbs)}); --font-policy=engine keeps it out of the package and the text uses the UMG default font`
      );
    }
    let file = engineDefault ? null : resolved.preCopiedFile || null;
    let subface = resolved.subface || 0;
    if (!file && !engineDefault && resolved.abs) file = this._copyFontFile(resolved.abs);
    if (!file && !engineDefault && plan.promoted) {
      // A CJK-only design that names a family we cannot import (a .ttc, or a family that
      // is simply not installed) would otherwise reach UMG as the engine default font
      // and lose its glyphs.
      file = this._copyFontFile(plan.promoted.abs);
      if (file) subface = plan.promoted.subface || 0;
      this.warnOnce(
        `font: "${primary}" has no importable face; using ${plan.promoted.family} (${path.basename(plan.promoted.abs)}) as its primary face`
      );
    }

    if (!resolved.abs) {
      const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system)$/i;
      const usable = families.find((f) => !generic.test(f));
      if (usable && !file) {
        this.warn(`font: no file for "${usable}" — the importer will fall back to the engine default font (family recorded for manual mapping)`);
      }
    }

    const license = file ? licenseOf(resolved.abs || plan.promoted && plan.promoted.abs || '') : 'unknown';
    const entry = {
      key: `font_${this.fonts.length}`,
      family: primary,
      weight: weightValue,
      italic: italicValue,
      hasFile: !!file,
      license,
      fallbacks: [],
    };
    const record = {
      key: entry.key,
      family: entry.family,
      weight: entry.weight,
      italic: entry.italic,
      file: file || '',
      license,
    };
    // A collection always states its sub-face, 0 included: "subface: 0" (explicitly face 0)
    // and "no subface" (single-face file) must be distinguishable on the C++ side.
    const primarySource = resolved.abs || (plan.promoted && plan.promoted.abs) || '';
    if (isCollectionFile(primarySource)) {
      entry.subface = subface;
      record.subface = subface;
    }
    // Under --font-policy=engine a family we do not embed must not appear in assets.fonts at all:
    // the array is "what ships in the package", and the engine-default families ship nothing.
    if (!engineDefault) this.fonts.push(record);

    for (const choice of engineDefault ? [] : plan.fallbacks) {
      const sub = this._addFallbackFont(choice);
      if (!sub) continue;
      const item = {
        key: sub.key,
        family: sub.family,
        weight: sub.weight,
        italic: sub.italic,
        file: sub.file,
        license: sub.license,
        source: choice.source,
      };
      if (sub.subface !== undefined) item.subface = sub.subface;
      if (sub.coverage) item.coverage = sub.coverage;
      entry.fallbacks.push(item);
    }
    if (file) this.embeddedFonts.push({ family: primary, file, license, role: 'primary' });
    // The field is omitted entirely when there is nothing to fall back to, so a Latin
    // page produces byte-identical `assets.fonts` to the previous converter.
    if (entry.fallbacks.length) record.fallbacks = entry.fallbacks;
    if (engineDefault) {
      entry.engineDefault = true;
      record.engineDefault = true;
      if (!this.engineDefaultFonts) this.engineDefaultFonts = [];
      this.engineDefaultFonts.push({ family: primary, license: primaryLicense });
    }
    if (!engineDefault && plan.uncovered.length) {
      const first = plan.uncovered[0].toString(16).toUpperCase().padStart(4, '0');
      this.warn(
        `font: no CJK fallback file covers ${plan.uncovered.length} code point(s) of "${primary}" (e.g. U+${first})`
      );
    }

    this.fontByKey.set(cacheKey, entry);
    return entry;
  }

  /** A warning that must not repeat once per text run. */
  warnOnce(message) {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message);
  }

  /** Copy `abs` into the assets dir under a positional name; returns the JSON path. */
  _copyFontFile(absSource) {
    if (!absSource) return null;
    const ext = path.extname(absSource).replace('.', '').toLowerCase() || 'ttf';
    const name = `font_${this.fontCount}.${ext}`;
    this.fontCount += 1;
    try {
      fs.copyFileSync(absSource, path.join(this.outDir, name));
      this.written += 1;
      return this.relFile(name);
    } catch (err) {
      this.failed += 1;
      this.warn(`font: cannot copy ${absSource}: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolve the *primary* face with the same rules the converter always used
   * (@font-face first, then the system table) so Latin pages never change.
   * Returns {abs, preCopiedFile}; abs is null when no importable file exists.
   */
  _resolvePrimaryFont(families, primary, weight, italic, fontFaceSrcs) {
    const cacheKey = `${primary.toLowerCase()}|${weight}|${italic}|${fontFaceSrcs && fontFaceSrcs.length ? 'face' : ''}`;
    if (this.primaryResolved.has(cacheKey)) return this.primaryResolved.get(cacheKey);

    let out = { abs: null, preCopiedFile: null, subface: 0 };
    if (fontFaceSrcs && fontFaceSrcs.length) {
      const resolved = this._resolveFontFaceSrc(fontFaceSrcs, primary, weight, italic);
      // A webfont is 'unknown' licence as far as we can tell, so --font-policy=engine must not
      // embed it either; the same gate the system-font path already uses.
      if (resolved && this._licenseAllowed(resolved.abs, primary, 'primary')) {
        out = { abs: resolved.abs, preCopiedFile: resolved.file || null };
      }
    }
    if (!out.abs) {
      for (const family of families) {
        const known = SYSTEM_FONTS[family.toLowerCase()];
        if (!known) continue;
        const resolvedFile = this._fontFileFor(pickFontVariant(known, weight, italic), family);
        if (!resolvedFile) continue;
        if (!this._licenseAllowed(resolvedFile.abs, family, 'primary')) continue;
        out = { abs: resolvedFile.abs, preCopiedFile: null, subface: resolvedFile.subface };
        break;
      }
    }
    this.primaryResolved.set(cacheKey, out);
    return out;
  }

  /** @font-face sources declared for `family` anywhere in the page. */
  _faceSrcsFor(family, use) {
    const key = String(family || '').toLowerCase();
    const faces = use.faces;
    if (Array.isArray(faces) && faces.length) {
      return faces
        .filter((face) => String(face.family || '').toLowerCase() === key)
        .map((face) => face.src)
        .filter(Boolean)
        .join(',');
    }
    return '';
  }

  /**
   * Decide the fallback chain for one text run.
   * Order: the rest of the CSS stack -> the families Chromium actually substituted ->
   * the known CJK system table. Every candidate must pass the cmap coverage test.
   */
  _cjkPlan(families, primary, primaryResolved, text, use, weight, italic) {
    const plan = { needSig: '', fallbacks: [], promoted: null, uncovered: [] };
    const needed = cjkCodepoints(text);
    if (!needed.length) return plan;

    const primaryAbs = primaryResolved ? primaryResolved.abs : null;
    const coverage = primaryAbs ? fontCoverageForFile(primaryAbs, primaryResolved.subface) : null;
    const missing = [];
    const blocks = new Set();
    for (const cp of needed) {
      if (coverage && coverageHas(coverage.ranges, cp)) continue;
      missing.push(cp);
      const block = cjkBlockOf(cp);
      if (block) blocks.add(block);
    }
    if (!missing.length) return plan; // the primary face already draws them
    plan.needSig = Array.from(blocks).sort().join('+');

    // Two passes. A face that covers EVERY remaining codepoint wins outright; a face
    // with partial coverage (Source Han Sans JP covers ~61% of simplified Chinese) is
    // only accepted after every full-coverage candidate has been ruled out, because
    // accepting it first would silently mix Japanese glyph forms into Chinese text.
    const candidates = this._cjkCandidates(families, primary, use);
    const kana = hasKana(text);
    const resolved = [];
    for (const candidate of candidates) {
      // The candidate list starts with what Chrome *actually* substituted (platformFonts), which is
      // the faithful choice even when it surprises: `monospace` maps to 宋体 (NSimSun) on Windows,
      // so a monospace run with Chinese text legitimately gets a serif CJK face. Only if that face
      // cannot be imported does the chain move on to the CSS stack / the system table.
      const variant = this._resolveCjkFamily(candidate.family, weight, italic, use);
      if (!variant) continue;
      if (isJapaneseFace(candidate.family) || isJapaneseFace(variant.family)) {
        if (!kana) {
          this.warnOnce(
            `font: "${variant.family}" is a Japanese face (~61% simplified-Chinese coverage, e.g. NotoSansJP 12747/20992); skipped as a CJK fallback for "${primary}"`
          );
          continue;
        }
      }
      const fileCoverage = fontCoverageForFile(variant.abs, variant.subface);
      if (!fileCoverage || !fileCoverage.ranges.length) {
        this.warnOnce(`font: "${variant.family}" has no readable cmap; not usable as a fallback`);
        continue;
      }
      // Unless this face actually contains some of the missing codepoints it is simply
      // not a candidate; stay silent about that (it is the common Latin-font case).
      const wouldCover = missing.some((cp) => coverageHas(fileCoverage.ranges, cp));
      if (!wouldCover) continue;
      // Family-level veto before the (authoritative) per-code-point check: a face that
      // covers only ~61% of simplified Chinese must not win just because this sentence
      // happens to use characters it has. Japanese text is exempt (the sample is
      // Chinese); its per-code-point coverage is what decides.
      if (!kana) {
        const sample = sampleStatsForFile(variant.abs, variant.subface);
        if (sample.common < SAMPLE_COMMON_THRESHOLD || sample.cjk < SAMPLE_CJK_THRESHOLD) {
          this.warnOnce(
            `font: "${variant.family}" rejected as a CJK fallback for "${primary}": sample coverage ` +
              `${(sample.common * 100).toFixed(1)}% of ${sample.commonTotal} common chars (${sample.commonHit}), ` +
              `${(sample.cjk * 100).toFixed(1)}% of ${sample.cjkTotal} CJK chars — thresholds 95% / 90%`
          );
          continue;
        }
      }
      resolved.push({ candidate, variant, coverage: fileCoverage });
    }

    let pending = missing;
    let choices = 0;
    const used = new Set();
    const take = (entry) => {
      const uncovered = pending.filter((cp) => !coverageHas(entry.coverage.ranges, cp));
      const choice = {
        family: entry.variant.family,
        abs: entry.variant.abs,
        subface: entry.variant.subface || 0,
        weight,
        italic,
        source: entry.candidate.source,
        _coverage: entry.coverage, // in-memory only; becomes `coverage` below
      };
      if (!plan.promoted && !primaryAbs) plan.promoted = choice;
      else plan.fallbacks.push(choice);
      used.add(entry.candidate.family.toLowerCase());
      pending = uncovered;
      choices += 1;
    };

    for (const entry of resolved) {
      if (!pending.length || choices >= 2) break;
      if (used.has(entry.candidate.family.toLowerCase())) continue;
      const uncovered = pending.filter((cp) => !coverageHas(entry.coverage.ranges, cp));
      if (!uncovered.length) take(entry);
    }
    // Nothing covered the whole remainder: fall back to the best partial face(s) and
    // say so with numbers, never silently.
    let guard = 0;
    while (pending.length && choices < 2 && guard < 4) {
      guard += 1;
      let best = null;
      let bestGain = 0;
      for (const entry of resolved) {
        if (used.has(entry.candidate.family.toLowerCase())) continue;
        const gain = pending.length - pending.filter((cp) => coverageHas(entry.coverage.ranges, cp)).length;
        if (gain > bestGain) {
          bestGain = gain;
          best = entry;
        }
      }
      if (!best) break;
      if (bestGain < pending.length) {
        this.warnOnce(
          `font: "${best.variant.family}" covers only ${bestGain}/${pending.length} remaining code point(s) of "${primary}"; used as a partial fallback`
        );
      }
      take(best);
    }
    plan.uncovered = pending;
    this._assignFallbackCoverage(plan, primary, missing);
    const chosen = plan.promoted || plan.fallbacks[0];
    if (chosen && chosen.source === 'platform') {
      const cssChoice = families
        .slice(1)
        .map((family) => {
          const variant = this._resolveCjkFamily(family, weight, italic, use);
          return variant && variant.family !== chosen.family ? variant : null;
        })
        .find(Boolean);
      if (cssChoice) {
        this.infoOnce(
          `font: CSS asks for "${cssChoice.family}" but the browser rendered this text with "${chosen.family}" (platformFonts); using the browser's face`
        );
      }
    }
    return plan;
  }

  /**
   * Give every fallback a DISJOINT set of code point ranges (`coverage`, closed intervals).
   *
   * Slate resolves overlapping composite-font ranges by "smallest wins, first declared
   * wins", and when the winning face lacks a glyph it jumps straight to the fallback
   * typeface instead of trying the next sub-font. So if two sub-fonts both claim
   * U+4E00-9FFF, the second one can never be reached. Blocks are therefore handed out
   * one at a time, in fallback priority order, and each block belongs to exactly one
   * face. Intervals are INCLUSIVE [lo, hi] and adjacent blocks owned by the same face
   * are merged, but never across a gap.
   */
  _assignFallbackCoverage(plan, primary, missing) {
    const fallbacks = plan.fallbacks || [];
    if (!fallbacks.length) return;
    const owners = new Map(); // block id -> fallback index
    for (const block of CJK_BLOCKS) {
      // Needed glyphs decide first: the block goes to the face that can draw MOST of the
      // code points this text lacks (ties keep the browser-priority order), otherwise
      // those glyphs would be unreachable behind a face that cannot draw them.
      let owner = -1;
      let bestCount = 0;
      for (let i = 0; i < fallbacks.length; i += 1) {
        const coverage = fallbacks[i]._coverage;
        if (!coverage) continue;
        let count = 0;
        for (const cp of missing) {
          if (cp >= block.from && cp <= block.to && coverageHas(coverage.ranges, cp)) count += 1;
        }
        if (count > bestCount) {
          bestCount = count;
          owner = i;
        }
      }
      if (owner >= 0) {
        const lost = missing.filter(
          (cp) => cp >= block.from && cp <= block.to && !coverageHas(fallbacks[owner]._coverage.ranges, cp)
        );
        if (lost.length) {
          this.infoOnce(
            `font: ${lost.length} code point(s) of "${primary}" in the ${block.id} block are missing from ` +
              `"${fallbacks[owner].family}" (which owns that block); Slate leaves them to the fallback typeface`
          );
        }
      }
      // Nothing needed here: hand the block to the first face that covers most of it,
      // so future copy edits inside that block keep working without a reconvert.
      if (owner < 0) {
        for (let i = 0; i < fallbacks.length && owner < 0; i += 1) {
          const ratio = coverageRatioInRange(fallbacks[i]._coverage, block.from, block.to);
          if (ratio >= FALLBACK_BLOCK_THRESHOLD) owner = i;
        }
      }
      if (owner >= 0) owners.set(block.id, owner);
    }

    const kept = [];
    for (let i = 0; i < fallbacks.length; i += 1) {
      const choice = fallbacks[i];
      const coverage = choice._coverage;
      const ranges = [];
      for (const block of CJK_BLOCKS) {
        if (owners.get(block.id) !== i) continue;
        // CLOSED intervals, both ends inclusive: that is what the importer parses
        // (FCharacterRange First/Last). A block [0x4E00,0x9FFF] becomes [19968, 40959].
        const from = block.from;
        const to = block.to;
        const last = ranges[ranges.length - 1];
        if (last && last[1] + 1 === from) last[1] = to; // adjacent blocks of one owner merge
        else ranges.push([from, to]);
        const ratio = coverageRatioInRange(coverage, block.from, block.to);
        if (ratio < 1) {
          this.infoOnce(
            `font: "${choice.family}" covers ${(ratio * 100).toFixed(1)}% of the ${block.id} block for "${primary}"; ` +
              `the whole block is assigned to it and the gap is left to the platform fallback typeface`
          );
        }
      }
      choice.coverage = ranges;
      if (!ranges.length) {
        this.warnOnce(`font: "${choice.family}" would own no code point range for "${primary}"; fallback dropped`);
        continue;
      }
      delete choice._coverage;
      kept.push(choice);
    }
    plan.fallbacks = kept;
  }

  /** Info line that must not repeat once per text run. */
  infoOnce(message) {
    const key = `info:${message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.info(message);
  }

  _cjkCandidates(families, primary, use) {
    const out = [];
    const seen = new Set([String(primary || '').toLowerCase()]);
    const push = (family, source) => {
      const key = String(family || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ family: String(family).trim(), source });
    };
    // The browser's own substitution wins: on Windows, Chromium renders Chinese with
    // Microsoft YaHei even when the stack says "Noto Sans SC", and using the same face
    // keeps glyph outlines AND vertical metrics identical (measured: 15.86% page diff
    // with Noto vs 12.80% with YaHei, Δtop 50px vs 1px). CSS stack and the system table
    // are the fallbacks when the real face cannot be imported, lacks coverage, or the
    // licence policy forbids it.
    const platform = (use.platformFonts || []).slice().sort((a, b) => (b.glyphs || 0) - (a.glyphs || 0));
    for (const hit of platform) push(hit.family, 'platform');
    for (const family of families.slice(1)) push(family, 'css-stack');
    const stackText = families.join(',');
    const serif = /serif/i.test(stackText) && !/sans-serif/i.test(stackText);
    const allowTtc = this.allowTtc && this.fontPolicy !== 'redistributable';
    for (const family of defaultCjkChain(serif, allowTtc)) push(family, 'system');
    return out;
  }

  /**
   * Locate the file behind one variant. Returns {abs, subface} or null.
   * A .ttc is skipped unless allowTtc is on, in which case the sub-face index rides
   * along in the JSON (`subface`) so the importer can pass it to FFontData.
   */
  _fontFileFor(variant, label, quiet) {
    if (!variant) return null;
    const abs = findSystemFontFile(variant.file);
    if (!abs) return null;
    if (/\.ttc$/i.test(abs)) {
      if (!this.allowTtc) {
        // Only the author's own family deserves a warning; a fallback candidate that
        // happens to be a collection is simply skipped (the outcome is reported once).
        if (!quiet) {
          this.warn(
            `font: "${label || variant.file}" resolves to a TrueType collection (${variant.file}); UE cannot import .ttc — register a single-face font instead`
          );
        }
        return null;
      }
      return { abs, subface: Number.isFinite(variant.subface) ? variant.subface : 0 };
    }
    return { abs, subface: 0 };
  }

  /** Resolve one candidate family to an importable file (+ optional .ttc sub-face). */
  _resolveCjkFamily(family, weight, italic, use) {
    const key = String(family || '').trim().toLowerCase();
    if (!key) return null;

    // A webfont declared for that family is the most faithful choice.
    const srcs = this._faceSrcsFor(key, use);
    if (srcs) {
      const resolved = this._resolveFontFaceSrc(srcs, family, weight, italic);
      if (resolved && resolved.abs && this._licenseAllowed(resolved.abs, family, 'fallback')) {
        return {
          family: CJK_FAMILY_ALIASES[key] ? canonicalCjkFamily(CJK_FAMILY_ALIASES[key]) : family,
          abs: resolved.abs,
          subface: 0,
        };
      }
    }

    // Direct table first (so an explicitly requested Microsoft YaHei keeps its own face
    // when TTC support is on), then the browser-name alias.
    const keys = [];
    if (CJK_FONT_FAMILIES[key]) keys.push(key);
    const aliasKey = CJK_FAMILY_ALIASES[key];
    if (aliasKey && aliasKey !== key && CJK_FONT_FAMILIES[aliasKey]) keys.push(aliasKey);
    for (const candidateKey of keys) {
      const table = CJK_FONT_FAMILIES[candidateKey];
      const variant = pickFontVariant(table.variants, weight, italic);
      const resolved = this._fontFileFor(variant, family, true);
      if (resolved && this._licenseAllowed(resolved.abs, family, 'fallback')) {
        return { family: table.name, abs: resolved.abs, subface: resolved.subface };
      }
    }

    const known = SYSTEM_FONTS[key];
    if (known) {
      const resolved = this._fontFileFor(pickFontVariant(known, weight, italic), family, true);
      if (resolved && this._licenseAllowed(resolved.abs, family, 'fallback')) {
        return { family, abs: resolved.abs, subface: resolved.subface };
      }
    }
    return null;
  }

  /**
   * Licence gate. Returns false when the face must be skipped under
   * `--font-policy=redistributable`; `any` (the default) allows everything.
   */
  _licenseAllowed(absPath, family, role) {
    if (this.fontPolicy === 'any') return true;
    const license = licenseOf(absPath);
    if (license === 'redistributable') return true;
    const engine = this.fontPolicy === 'engine';
    this.warnOnce(
      `font: ${engine ? 'not embedding' : 'skipping'} ${license} font "${family}" (${path.basename(String(absPath || ''))}, ${role}) because --font-policy=${this.fontPolicy}; ` +
      (engine ? 'the text uses the UMG default font' : 'trying a redistributable candidate instead')
    );
    return false;
  }

  /** Copy (once) the file behind one fallback choice and register it as a font entry. */
  _addFallbackFont(choice) {
    // The owned ranges are part of the identity: the same face can serve two primaries
    // with different responsibilities for their code point blocks.
    const coverageKey = Array.isArray(choice.coverage) ? JSON.stringify(choice.coverage) : '';
    const key = `${String(choice.family).toLowerCase()}|${choice.weight}|${choice.italic}|${coverageKey}`;
    const cached = this.fallbackByKey.get(key);
    if (cached) return cached;
    // One copy per physical file, not per weight slot: Noto Sans SC is 17 MB and a page
    // routinely needs it for 400/600/700, which would otherwise be three copies.
    let file = this.fallbackFileByAbs.get(choice.abs);
    if (!file) {
      file = this._copyFontFile(choice.abs);
      if (!file) return null;
      this.fallbackFileByAbs.set(choice.abs, file);
    }
    const license = licenseOf(choice.abs);
    const entry = {
      key: `font_${this.fonts.length}`,
      family: choice.family,
      weight: choice.weight,
      italic: choice.italic,
      file,
      license,
    };
    // "These code points are mine" — the importer turns each interval into an
    // FCompositeSubFont CharacterRange; ranges never overlap within one primary font.
    if (Array.isArray(choice.coverage) && choice.coverage.length) entry.coverage = choice.coverage;
    // Collections state their sub-face even when it is 0 (see the primary entry above);
    // single-face files never carry the field.
    if (isCollectionFile(choice.abs)) entry.subface = Number.isFinite(choice.subface) ? choice.subface : 0;
    this.fonts.push(entry);
    this.embeddedFonts.push({ family: choice.family, file, license, role: 'fallback' });
    this.fallbackByKey.set(key, entry);
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

  /** Which copies ended up embedded, grouped by licence, for the release warning. */
  licenseSummary() {
    const counts = { redistributable: 0, proprietary: 0, unknown: 0 };
    const proprietary = [];
    const seen = new Set();
    const filesSeen = new Set();
    for (const used of this.embeddedFonts) {
      const fileKey = `${used.license}|${used.file}`;
      if (!filesSeen.has(fileKey)) {
        filesSeen.add(fileKey);
        counts[used.license] = (counts[used.license] || 0) + 1;
      }
      if (used.license === 'redistributable') continue;
      const key = `${used.license}|${used.family}|${used.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proprietary.push(used);
    }
    return { counts, nonRedistributable: proprietary };
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
  // CJK coverage surface (used by the font report and by the tests)
  CJK_BLOCKS,
  CJK_FONT_FAMILIES,
  CJK_FAMILY_ALIASES,
  cjkBlockOf,
  cjkCodepoints,
  hasCjk,
  parseFontCoverage,
  fontCoverageForFile,
  coverageHas,
  defaultCjkChain,
  isJapaneseFace,
  hasKana,
  licenseOf,
  isCollectionFile,
  coverageRatioInRange,
  sampleStatsForFile,
  SAMPLE_COMMON_THRESHOLD,
  SAMPLE_CJK_THRESHOLD,
  SAMPLE_COMMON_39,
  SAMPLE_CJK,
};
