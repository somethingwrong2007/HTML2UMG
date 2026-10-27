// Font vertical metrics read straight out of the font file.
//
// The converter needs two numbers per font that CSS never spells out:
//
//   * the CSS line box for 'line-height: normal'
//   * the natural line box Slate gives the same font
//
// Both engines start from the same table -- FreeType's face->ascender,
// face->descender and face->height -- but they round differently (CSS keeps
// 1/64px, Slate rounds the whole line box to an integer) and they disagree about
// which table wins when OS/2.fsSelection asks for the typo metrics. So the file
// is parsed here, once, and every text style asks this module for its numbers
// instead of the old single global constant.
//
// No dependencies: the sfnt container is small and fully specified.

'use strict';

const fs = require('fs');

const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // 'true'
const SFNT_CFF = 0x4f54544f; // 'OTTO'
const SFNT_TTC = 0x74746366; // 'ttcf'

function readTableDirectory(buffer, offset) {
  if (offset + 12 > buffer.length) return null;
  const version = buffer.readUInt32BE(offset);
  const numTables = buffer.readUInt16BE(offset + 4);
  if (offset + 12 + numTables * 16 > buffer.length) return null;
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const entry = offset + 12 + i * 16;
    const tag = buffer.toString('ascii', entry, entry + 4);
    tables.set(tag, {
      offset: buffer.readUInt32BE(entry + 8),
      length: buffer.readUInt32BE(entry + 12),
    });
  }
  return { version, numTables, tables };
}

function isFontSignature(buffer, offset) {
  if (offset + 4 > buffer.length) return false;
  const version = buffer.readUInt32BE(offset);
  return version === SFNT_TRUETYPE || version === SFNT_TRUE || version === SFNT_CFF;
}

/**
 * @param {string} file absolute path
 * @param {{index?:number, buffer?:Buffer}} [options] index = face inside a .ttc
 * @returns {object|null} metrics, or null when the file is not a readable sfnt
 */
function readFontFile(file, options) {
  const opts = options || {};
  let buffer = opts.buffer;
  if (!buffer) {
    try {
      buffer = fs.readFileSync(file);
    } catch (err) {
      return null;
    }
  }
  if (!buffer || buffer.length < 12) return null;

  let faceOffset = 0;
  const signature = buffer.readUInt32BE(0);
  if (signature === SFNT_TTC) {
    const numFonts = buffer.readUInt32BE(8);
    const index = Math.max(0, Math.min(opts.index || 0, numFonts - 1));
    faceOffset = buffer.readUInt32BE(12 + index * 4);
    if (!isFontSignature(buffer, faceOffset)) return null;
  } else if (!isFontSignature(buffer, 0)) {
    return null; // woff/woff2/eot are not sfnt containers
  }

  const dir = readTableDirectory(buffer, faceOffset);
  if (!dir) return null;

  const metrics = {
    file,
    index: opts.index || 0,
    upem: 0,
    hhea: null,
    os2: null,
    cmap: null,
  };

  const head = dir.tables.get('head');
  if (head && head.offset + 20 <= buffer.length) {
    metrics.upem = buffer.readUInt16BE(head.offset + 18) || 0;
    metrics.bbox = {
      xMin: buffer.readInt16BE(head.offset + 36),
      yMin: buffer.readInt16BE(head.offset + 38),
      xMax: buffer.readInt16BE(head.offset + 40),
      yMax: buffer.readInt16BE(head.offset + 42),
    };
  }

  const hhea = dir.tables.get('hhea');
  if (hhea && hhea.offset + 10 <= buffer.length) {
    metrics.hhea = {
      ascender: buffer.readInt16BE(hhea.offset + 4),
      descender: buffer.readInt16BE(hhea.offset + 6),
      lineGap: buffer.readInt16BE(hhea.offset + 8),
    };
  }

  const os2 = dir.tables.get('OS/2');
  if (os2 && os2.offset + 78 <= buffer.length) {
    const table = os2.offset;
    const version = buffer.readUInt16BE(table);
    const fsSelection = buffer.readUInt16BE(table + 62);
    metrics.os2 = {
      version,
      fsSelection,
      // Bit 7 tells rasterisers to lay the font out with the typo metrics.
      useTypoMetrics: (fsSelection & 0x80) !== 0,
      typoAscender: buffer.readInt16BE(table + 68),
      typoDescender: buffer.readInt16BE(table + 70),
      typoLineGap: buffer.readInt16BE(table + 72),
      winAscent: buffer.readUInt16BE(table + 74),
      winDescent: buffer.readUInt16BE(table + 76),
    };
  }

  const name = dir.tables.get('name');
  if (name) metrics.family = readFamilyName(buffer, name.offset, name.length);

  const cmap = dir.tables.get('cmap');
  if (cmap) metrics.cmap = readCmapTables(buffer, cmap.offset, cmap.length);

  return metrics.upem > 0 ? metrics : null;
}

function readFamilyName(buffer, offset, length) {
  try {
    const count = buffer.readUInt16BE(offset + 2);
    const stringOffset = offset + buffer.readUInt16BE(offset + 4);
    let fallback = '';
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 6 + i * 12;
      if (entry + 12 > buffer.length) break;
      const platformId = buffer.readUInt16BE(entry);
      const nameId = buffer.readUInt16BE(entry + 6);
      if (nameId !== 1 && nameId !== 16) continue;
      const len = buffer.readUInt16BE(entry + 8);
      const strOffset = stringOffset + buffer.readUInt16BE(entry + 10);
      if (strOffset + len > buffer.length || len <= 0) continue;
      let text;
      if (platformId === 3) {
        const units = [];
        for (let k = 0; k + 1 < len; k += 2) units.push(buffer.readUInt16BE(strOffset + k));
        text = String.fromCharCode.apply(null, units);
      } else {
        text = buffer.toString('latin1', strOffset, strOffset + len);
      }
      if (nameId === 16) return text; // typographic family wins over the legacy one
      if (!fallback) fallback = text;
    }
    return fallback;
  } catch (err) {
    return '';
  }
}

/** Unicode cmap subtables, kept as a compact {start,end,delta} range list. */
function readCmapTables(buffer, offset, length) {
  try {
    const count = buffer.readUInt16BE(offset + 2);
    let best = null;
    for (let i = 0; i < count; i += 1) {
      const record = offset + 4 + i * 8;
      if (record + 8 > offset + length) break;
      const platformId = buffer.readUInt16BE(record);
      const encodingId = buffer.readUInt16BE(record + 2);
      const subOffset = offset + buffer.readUInt32BE(record + 4);
      const unicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
      if (!unicode) continue;
      const format = buffer.readUInt16BE(subOffset);
      if (format === 4 || format === 12) {
        if (!best || format > best.format) best = { format, subOffset };
      }
    }
    if (!best) return null;
    const groups = best.format === 12 ? readCmap12(buffer, best.subOffset) : readCmap4(buffer, best.subOffset);
    return { format: best.format, groups };
  } catch (err) {
    return null;
  }
}

function readCmap12(buffer, offset) {
  const groups = [];
  const nGroups = buffer.readUInt32BE(offset + 12);
  for (let i = 0; i < nGroups; i += 1) {
    const entry = offset + 16 + i * 12;
    if (entry + 12 > buffer.length) break;
    groups.push({
      start: buffer.readUInt32BE(entry),
      end: buffer.readUInt32BE(entry + 4),
      startGlyph: buffer.readUInt32BE(entry + 8),
    });
  }
  return groups;
}

function readCmap4(buffer, offset) {
  const segCount = buffer.readUInt16BE(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const groups = [];
  for (let i = 0; i < segCount; i += 1) {
    const end = buffer.readUInt16BE(endCodes + i * 2);
    const start = buffer.readUInt16BE(startCodes + i * 2);
    if (start > end || start === 0xffff) continue;
    groups.push({ start, end });
  }
  return groups;
}

/** Which of these code points does the font have a glyph for? */
function covers(metrics, codePoints) {
  const cmap = metrics && metrics.cmap;
  const supported = [];
  const missing = [];
  for (const cp of codePoints) {
    const found = cmap ? cmapHas(cmap, cp) : false;
    if (found) supported.push(cp);
    else missing.push(cp);
  }
  return { supported, missing };
}

function cmapHas(cmap, cp) {
  if (cmap.format === 12) {
    return cmap.groups.some((group) => cp >= group.start && cp <= group.end);
  }
  if (cp > 0xffff) return false;
  return cmap.groups.some((group) => cp >= group.start && cp <= group.end);
}

/**
 * Slate's line box ratio: FreeType's face->height over unitsPerEm.
 *
 * FSlateFontRenderer::GetMaxHeight returns
 *   Convert26Dot6ToRoundedPixel(GetScaledHeight(face))
 * and GetScaledHeight is FT_MulFix(face->height, y_scale) for a scalable face. FreeType fills
 * face->height from hhea (ascender - descender + lineGap), or from the OS/2 typo trio when
 * fsSelection asks for it. FTextLayout then reports MaxAboveBaseline + MaxBelowBaseline, which
 * collapses back to exactly that height, so the line box is this ratio times the pixel em,
 * rounded once to whole pixels.
 */
function slateRatio(metrics) {
  if (!metrics || !metrics.upem) return null;
  const upem = metrics.upem;
  if (metrics.os2 && metrics.os2.useTypoMetrics) {
    const os2 = metrics.os2;
    return (os2.typoAscender - os2.typoDescender + os2.typoLineGap) / upem;
  }
  if (!metrics.hhea) return null;
  return (metrics.hhea.ascender - metrics.hhea.descender + metrics.hhea.lineGap) / upem;
}

/**
 * Chromium's line box ratio on Windows, measured in this repo's audit tool.
 *
 * DirectWrite hands back the GDI-compatible pair for fonts that do not ask for the typo metrics
 * (usWinAscent + usWinDescent), and hhea's lineGap on top; fonts with USE_TYPO_METRICS get the
 * OS/2 typo trio instead. Verified against Chromium for Segoe UI / Arial / Microsoft YaHei /
 * Noto Sans SC at 12..100px (Docs/Html2UMG_FontMetrics.md has the table).
 */
function cssRatio(metrics) {
  if (!metrics || !metrics.upem) return null;
  const upem = metrics.upem;
  if (metrics.os2 && metrics.os2.useTypoMetrics) {
    const os2 = metrics.os2;
    return (os2.typoAscender - os2.typoDescender + os2.typoLineGap) / upem;
  }
  if (!metrics.os2 || !metrics.hhea) return null;
  return (metrics.os2.winAscent + metrics.os2.winDescent + metrics.hhea.lineGap) / upem;
}

/** The baseline offset from the top of the Slate line box, as a ratio of the em. */
function slateAscentRatio(metrics) {
  if (!metrics || !metrics.upem) return null;
  if (metrics.os2 && metrics.os2.useTypoMetrics) {
    return (metrics.os2.typoAscender + metrics.os2.typoLineGap) / metrics.upem;
  }
  if (!metrics.hhea) return null;
  return (metrics.hhea.ascender + metrics.hhea.lineGap) / metrics.upem;
}

/**
 * FSlateFontInfo::Size is points and Slate renders at 96 dpi, so the pixel em it rasterises is
 * round(Size * 96 / 72) (FreeTypeUtils::ComputeFontPixelSize, FontConstants::RenderDPI = 96).
 * mapper.js emits Size with two decimals, so that rounding is mirrored here exactly.
 */
function slatePixelEm(fontPx) {
  const sizePt = Math.round((fontPx / (96 / 72)) * 100) / 100;
  // ConvertPixelTo26Dot6 truncates, then ((x * 96) + 36) / 72 and Convert26Dot6ToRoundedPixel.
  const fixed = Math.trunc(sizePt * 64);
  const required = Math.trunc((fixed * 96 + 36) / 72);
  return Math.max(1, (required + 32) >> 6);
}

/** Exact reproduction of the engine's rounding: 26.6 y_scale, FT_MulFix, then round to px. */
function slateLineBox(metrics, fontPx, options) {
  const ratio = slateRatio(metrics);
  if (ratio === null) return null;
  const opts = options || {};
  const upem = metrics.upem;
  const ppem = opts.pixelEm || slatePixelEm(fontPx);
  const yScale = Math.round((ppem * 64 * 65536) / upem);
  const heightUnits = opts.units !== undefined ? opts.units : ratio * upem;
  const scaled = Math.trunc((heightUnits * yScale + 0x8000) / 65536);
  const rounded = Math.trunc((scaled + 32) / 64);
  // FSlateTextRun::GetMaxHeight adds |ShadowOffset.Y|; UTextBlock defaults it to (1,1).
  return rounded + Math.abs(opts.shadowOffsetY || 0);
}

/**
 * Chromium's line box for 'line-height: normal', which is NOT `ratio * px`.
 *
 * DirectWrite hands back an ascent, a descent and a line gap; Blink rounds **each of the three to a
 * whole pixel** and adds them, so the sum can be a pixel away from `round(ratio * px)`:
 *
 *   Segoe UI 17px : round(18.35) + round(4.27) = 18 + 4 = 22   (ratio*px = 22.61, round = 23)
 *   Segoe UI 26px : round(28.06) + round(6.53) = 28 + 7 = 35   (ratio*px = 34.58, round = 35)
 *   Arial 16px    : 14 + 3 + round(0.52) = 18                  (ratio*px = 18.40, round = 18)
 *
 * Measured against Chromium for Segoe UI / Arial / Noto Sans SC / Microsoft YaHei at 11..32px:
 * this formula matches every probe, while `round(ratio*px)` misses the 17px and Noto 16px cases and
 * the fractional value misses most of Arial.
 */
function cssLineBox(metrics, fontPx) {
  const sides = cssSidesRatio(metrics);
  if (!sides) return null;
  return Math.round(sides.ascent * fontPx) + Math.round(sides.descent * fontPx) + Math.round(sides.gap * fontPx);
}

/** Ascent/descent/lineGap in em, as Chromium takes them (usWin pair + hhea gap, or OS/2 typo). */
function cssSidesRatio(metrics) {
  if (!metrics || !metrics.upem) return null;
  const upem = metrics.upem;
  if (metrics.os2 && metrics.os2.useTypoMetrics) {
    const os2 = metrics.os2;
    return {
      ascent: os2.typoAscender / upem,
      descent: -os2.typoDescender / upem,
      gap: os2.typoLineGap / upem,
    };
  }
  if (!metrics.os2 || !metrics.hhea) return null;
  return {
    ascent: metrics.os2.winAscent / upem,
    descent: metrics.os2.winDescent / upem,
    gap: metrics.hhea.lineGap / upem,
  };
}

/** The old fractional value (sum of the three, unrounded), kept for the --line-box-snap=exact A/B. */
function cssLineBoxExact(metrics, fontPx) {
  const ratio = cssRatio(metrics);
  return ratio === null ? null : ratio * fontPx;
}

/** Backwards compatible alias: the ratio a rasteriser derives, in em. */
function heightRatio(metrics) {
  return slateRatio(metrics);
}

module.exports = {
  readFontFile,
  covers,
  slateRatio,
  cssRatio,
  slateAscentRatio,
  slatePixelEm,
  slateLineBox,
  cssLineBox,
  cssLineBoxExact,
  cssSidesRatio,
  heightRatio: slateRatio,
};
