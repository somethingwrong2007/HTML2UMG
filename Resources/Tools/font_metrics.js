#!/usr/bin/env node
// Line-box audit: CSS (measured in Chromium) vs the model Slate will use.
//
//   node Resources/Tools/font_metrics.js
//   node Resources/Tools/font_metrics.js --families "Segoe UI,Noto Sans SC" --sizes 12,14,16,20
//   node Resources/Tools/font_metrics.js --html some.html --json out/metrics.json
//
// Why this exists: mapper.js has to emit UMG's LineHeightPercentage, whose 1.0 means
// "the font's own line box". That box is font-specific, so the converter needs both
// numbers per font:
//   * CSS  -- 'line-height: normal' -> ascent + descent + lineGap, measured here in the
//             same Chromium the converter uses, never assumed.
//   * Slate -- FreeType size metrics scaled by the pixel em and rounded to a whole
//             pixel by FSlateFontRenderer::GetMaxHeight (see Docs/Html2UMG_FontMetrics.md).
// The ratio of the two is the percentage the text control needs.

'use strict';

const fs = require('fs');
const path = require('path');

const CONVERTER = path.join(__dirname, '..', 'Converter');
const { launchBrowser } = require(path.join(CONVERTER, 'src', 'browser'));
const { CDPSession } = require(path.join(CONVERTER, 'src', 'cdp'));
const { SYSTEM_FONTS, findSystemFontFile } = require(path.join(CONVERTER, 'src', 'assets'));
const fontmetrics = require(path.join(CONVERTER, 'src', 'fontmetrics'));

const DEFAULT_FAMILIES = [
  'Segoe UI',
  'Arial',
  'Tahoma',
  'Verdana',
  'Microsoft YaHei',
  'Noto Sans SC',
  'DengXian',
  'SimHei',
  'SimSun',
];
const DEFAULT_SIZES = [12, 13, 14, 16, 20];
// The converter's LineHeightPercentage for 'line-height: normal' before this work,
// kept so the table can show what every font used to be off by.
const LEGACY_PERCENTAGE = 1.3333 / 1.4167;

function parseArgs(argv) {
  const opts = {
    families: DEFAULT_FAMILIES,
    sizes: DEFAULT_SIZES,
    html: null,
    json: null,
    browser: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--families') opts.families = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--sizes') opts.sizes = String(next()).split(',').map((s) => Number(s)).filter((n) => n > 0);
    else if (arg === '--html') opts.html = next();
    else if (arg === '--json') opts.json = next();
    else if (arg === '--browser') opts.browser = next();
    else if (arg === '--spacing') opts.spacing = Number(next());
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: font_metrics.js [--families a,b] [--sizes 12,14] [--html page.html] [--json out.json] [--spacing px]');
      process.exit(0);
    }
  }
  return opts;
}

/** Family -> font file, using the same table the converter uses for imports. */
function fontFileForFamily(family) {
  const known = SYSTEM_FONTS[String(family).toLowerCase()];
  if (known) {
    for (const variant of known) {
      const found = findSystemFontFile(variant.file);
      if (found) return found;
    }
  }
  return null;
}



/**
 * Runs inside the page. Kept as a real function and serialised with toString() so the quoting
 * of the CSS it builds never has to be escaped twice.
 */
function measureProbe(params) {
  const families = params.families;
  const sizes = params.sizes;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden;contain:layout;';
  document.body.appendChild(host);
  const ctx = document.createElement('canvas').getContext('2d');
  const out = [];
  for (const family of families) {
    const safe = String(family).replace(/"/g, '');
    for (const size of sizes) {
      const probe = document.createElement('div');
      probe.style.cssText =
        'display:block;width:max-content;white-space:nowrap;line-height:normal;' +
        'font-size:' + size + 'px;font-family:"' + safe + '";';
      probe.textContent = 'Hxg';
      host.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      ctx.font = size + 'px "' + safe + '"';
      const measured = ctx.measureText('Hxg');
      // CJK: does a 200px box break a space-less Chinese sentence, and how many lines?
      const wrap = document.createElement('div');
      wrap.style.cssText =
        'width:200px;line-height:normal;font-size:' + size + 'px;font-family:"' + safe + '";';
      wrap.textContent = '中国的字体排版在浏览器与游戏引擎之间的差异会逐行累计导致整列错位';
      host.appendChild(wrap);
      const wrapRect = wrap.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(wrap);
      out.push({
        family: family,
        size: size,
        css: rect.height,
        canvasBox: measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent,
        canvasAscent: measured.fontBoundingBoxAscent,
        canvasDescent: measured.fontBoundingBoxDescent,
        cjk: { height: wrapRect.height, lines: range.getClientRects().length },
      });
      host.removeChild(probe);
      host.removeChild(wrap);
    }
  }
  host.remove();
  return out;
}

/**
 * Glyph advances and letter-spacing, measured in the browser.
 *
 * Two questions this answers without Unreal:
 *   * is the CJK advance really 1em for the faces we import? (it decides whether a full-width
 *     column can be reproduced at all)
 *   * CSS adds its letter-spacing after the LAST glyph too, while Slate applies the value as a
 *     per-glyph advance; the difference is one spacing per line and shows up as a line that is
 *     one pixel too short. Measuring widths with and without spacing shows which model Chromium
 *     uses, and the printed delta is the amount Slate has to be trusted to match.
 */
function measureSpacing(params) {
  const families = params.families;
  const sizes = params.sizes;
  const spacing = params.spacing;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden;contain:layout;';
  document.body.appendChild(host);
  const ctx = document.createElement('canvas').getContext('2d');
  const out = [];
  const text = params.text;
  for (const family of families) {
    const safe = String(family).replace(/"/g, '');
    for (const size of sizes) {
      ctx.font = size + 'px "' + safe + '"';
      const cjk = ctx.measureText('\u56fd').width;
      const latin = ctx.measureText('A').width;
      const plain = document.createElement('span');
      plain.style.cssText = 'position:absolute;white-space:pre;font-size:' + size + 'px;font-family:"' + safe + '";';
      plain.textContent = text;
      host.appendChild(plain);
      const widthPlain = plain.getBoundingClientRect().width;
      const spaced = document.createElement('span');
      spaced.style.cssText =
        'position:absolute;white-space:pre;font-size:' + size + 'px;font-family:"' + safe + '";letter-spacing:' +
        spacing + 'px;';
      spaced.textContent = text;
      host.appendChild(spaced);
      const widthSpaced = spaced.getBoundingClientRect().width;
      host.removeChild(plain);
      host.removeChild(spaced);
      out.push({
        family: family,
        size: size,
        cjkAdvance: cjk / size,
        latinAdvance: latin,
        chars: Array.from(text).length,
        widthPlain: widthPlain,
        widthSpaced: widthSpaced,
        added: widthSpaced - widthPlain,
        perChar: (widthSpaced - widthPlain) / Array.from(text).length,
      });
    }
  }
  host.remove();
  return out;
}

async function measureInBrowser(opts) {
  const browser = await launchBrowser({ browser: opts.browser, viewport: { width: 1280, height: 720 } });
  let session = null;
  try {
    session = await CDPSession.connect(browser.pageWsUrl, { timeoutMs: 60000 });
    await session.enable();
    await session.setViewport(1280, 720);
    if (opts.html) {
      await session.navigate(require('url').pathToFileURL(path.resolve(opts.html)).href, 60000);
    } else {
      await session.navigate('about:blank', 30000);
      // about:blank still has a body and a document, so the probes run unchanged.
    }
    if (typeof opts.spacing === 'number' && Number.isFinite(opts.spacing)) {
      const spacingExpression = '(' + measureSpacing.toString() + ')(' +
        JSON.stringify({
          families: opts.families,
          sizes: opts.sizes,
          spacing: opts.spacing,
          text: opts.spacingText || '\u661f\u7a79\u63a7\u5236\u53f0 AVATAR',
        }) + ')';
      return { spacing: await session.evaluate(spacingExpression) };
    }
    const expression = '(' + measureProbe.toString() + ')(' +
      JSON.stringify({ families: opts.families, sizes: opts.sizes }) + ')';
    return await session.evaluate(expression);
  } finally {
    if (session) session.close();
    if (browser && typeof browser.close === 'function') {
      await browser.close();
    }
  }
}

function fmt(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return Number(value).toFixed(digits === undefined ? 2 : digits);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  return measureInBrowser(opts).then((measured) => {
    if (measured && measured.spacing) {
      const header = ['family'.padEnd(18), 'px'.padStart(4), 'CJK adv/em'.padStart(11), 'Latin adv'.padStart(10),
        'chars'.padStart(6), 'plain width'.padStart(12), '%spaced'.padStart(12), 'added'.padStart(9), 'per char'.padStart(9)].join(' ');
      console.log(header);
      console.log('-'.repeat(header.length));
      for (const row of measured.spacing) {
        console.log([
          row.family.padEnd(18),
          String(row.size).padStart(4),
          fmt(row.cjkAdvance, 4).padStart(11),
          fmt(row.latinAdvance, 2).padStart(10),
          String(row.chars).padStart(6),
          fmt(row.widthPlain).padStart(12),
          fmt(row.widthSpaced).padStart(12),
          fmt(row.added).padStart(9),
          fmt(row.perChar).padStart(9),
        ].join(' '));
      }
      // One spacing per character means Chromium adds it after the last glyph as well.
      const trailing = measured.spacing.map((row) => row.added - row.chars * opts.spacing);
      const worst = trailing.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
      console.log('');
      console.log('spacing ' + opts.spacing + 'px: width delta - chars*spacing = ' + fmt(worst) + 'px (0 = trailing spacing present)');
      return measured.spacing;
    }
    const rows = [];
    for (const entry of measured) {
      const file = fontFileForFamily(entry.family);
      const metrics = file ? fontmetrics.readFontFile(file) : null;
      const cssModel = metrics ? fontmetrics.cssLineBox(metrics, entry.size) : null;
      const slateBare = metrics ? fontmetrics.slateLineBox(metrics, entry.size) : null;
      const slateShadowed = metrics ? fontmetrics.slateLineBox(metrics, entry.size, { shadowOffsetY: 1 }) : null;
      const factor = cssModel !== null && slateBare ? cssModel / slateBare : null;
      const factorShadowed = cssModel !== null && slateShadowed ? cssModel / slateShadowed : null;
      rows.push({
        family: entry.family,
        size: entry.size,
        file: file ? path.basename(file) : '',
        // Which tables each engine reads, spelled out: the pair is the whole point of the tool.
        cssMetrics: metrics && metrics.os2 && metrics.os2.useTypoMetrics ? 'typo' : 'win+hheaGap',
        slateMetrics: metrics && metrics.os2 && metrics.os2.useTypoMetrics ? 'typo' : 'hhea',
        cssRatio: metrics ? fontmetrics.cssRatio(metrics) : null,
        slateRatio: metrics ? fontmetrics.slateRatio(metrics) : null,
        browserPx: entry.css,
        canvasBox: entry.canvasBox,
        modelPx: cssModel,
        modelDelta: cssModel === null ? null : entry.css - cssModel,
        slatePx: slateBare,
        slateShadowedPx: slateShadowed,
        factor: factor,
        factorShadowed: factorShadowed,
        legacyPx: slateShadowed && cssModel !== null ? slateShadowed * LEGACY_PERCENTAGE : null,
        legacyError: slateShadowed && cssModel !== null ? slateShadowed * LEGACY_PERCENTAGE - cssModel : null,
        cjkLines: entry.cjk.lines,
        cjkHeight: entry.cjk.height,
      });
    }

    const header = [
      'family'.padEnd(18),
      'px'.padStart(4),
      'font file'.padEnd(20),
      'css ratio'.padStart(9),
      'slate ratio'.padStart(11),
      'tables'.padEnd(12),
      'browser'.padStart(8),
      'model'.padStart(7),
      'd'.padStart(6),
      'slate'.padStart(6),
      'factor'.padStart(7),
      '+shadow'.padStart(7),
      'old err'.padStart(8),
      'cjk lines'.padStart(9),
    ].join(' ');
    if (!opts.quiet) {
      console.log(header);
      console.log('-'.repeat(header.length));
    }
    for (const row of rows) {
      const line = [
        row.family.padEnd(18),
        String(row.size).padStart(4),
        (row.file || '(no file)').padEnd(20),
        fmt(row.cssRatio, 4).padStart(9),
        fmt(row.slateRatio, 4).padStart(11),
        ((row.cssMetrics || '-') + '/' + (row.slateMetrics || '-')).padEnd(12),
        fmt(row.browserPx).padStart(8),
        fmt(row.modelPx).padStart(7),
        fmt(row.modelDelta).padStart(6),
        fmt(row.slatePx, 0).padStart(6),
        fmt(row.factor, 4).padStart(7),
        fmt(row.factorShadowed, 4).padStart(7),
        fmt(row.legacyError).padStart(8),
        String(row.cjkLines).padStart(9),
      ].join(' ');
      if (!opts.quiet) console.log(line);
    }

    const deltas = rows.filter((r) => r.modelDelta !== null).map((r) => Math.abs(r.modelDelta));
    if (deltas.length) {
      const max = Math.max.apply(null, deltas);
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      console.log('');
      console.log('CSS model vs Chromium: mean |error| ' + fmt(mean) + 'px, max ' + fmt(max) + 'px over ' + deltas.length + ' probes');
    }
    const errs = rows.filter((r) => r.legacyError !== null).map((r) => r.legacyError);
    if (errs.length) {
      const absMean = errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length;
      const absMax = errs.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
      console.log('previous single constant: mean |line error| ' + fmt(absMean) + 'px, max ' + fmt(absMax) + 'px per line');
    }

    if (opts.json) {
      const target = path.resolve(opts.json);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ rows, legacyPercentage: LEGACY_PERCENTAGE }, null, 2));
      console.log('wrote ' + target);
    }
    return rows;
  });
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('font_metrics: ' + (err && err.message ? err.message : err));
      process.exit(1);
    }
  );
}

module.exports = { main, fontFileForFamily };
