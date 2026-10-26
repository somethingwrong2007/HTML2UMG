#!/usr/bin/env node
// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Html2UMG converter CLI: HTML/CSS design  ->  layout JSON (contract v1).
// Zero dependencies; drives a local Chromium (Edge by default) over CDP.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { parseArgs, ArgError, USAGE } = require('../src/args');
const { launchBrowser } = require('../src/browser');
const { CDPSession } = require('../src/cdp');
const { stabilize, captureSnapshot, expandPartials } = require('../src/snapshot');
const { AssetRegistry } = require('../src/assets');
const { bakeControls } = require('../src/bake');
const { Mapper } = require('../src/mapper');
const { defaultBlueprintName } = require('../src/names');

const GENERATOR = 'html2umg-converter/0.1.0';

function log(opts, message) {
  if (opts.quiet) return;
  process.stderr.write(`${message}\n`);
}

/** Collect remote http(s) image URLs (img src + background-image) in DOM order. */
function collectRemoteUrls(snapshot) {
  const out = [];
  const seen = new Set();
  const add = (url, label) => {
    if (!url || seen.has(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    seen.add(url);
    out.push({ url, label });
  };
  for (const rec of snapshot.elements) {
    if (rec.img) {
      add(rec.img.currentSrc || rec.img.src, `img on '${rec.tag}'`);
    }
    const bg = rec.cs && rec.cs.backgroundImage;
    if (bg && bg !== 'none') {
      const match = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g;
      let m;
      while ((m = match.exec(bg)) !== null) {
        add((m[1] || m[2] || m[3] || '').trim(), `background-image on '${rec.tag}'`);
      }
    }
  }
  return out;
}

/** Elements that need the browser to rasterise them (inline SVG, .svg images). */
function collectRasterTargets(snapshot) {
  const targets = [];
  for (const rec of snapshot.elements) {
    if (rec.tag === 'svg') {
      targets.push(rec);
      continue;
    }
    if (rec.tag === 'img' && rec.img) {
      const src = rec.img.currentSrc || rec.img.src || '';
      if (/^data:image\/svg\+xml/i.test(src) || /\.svg(\?|#|$)/i.test(src)) targets.push(rec);
    }
  }
  return targets;
}

/** Render one element to PNG at `scale`x using a clipped CDP screenshot. */
async function rasterizeElement(session, rec, scale, warn) {
  const rect = rec.rect;
  const width = rect[2];
  const height = rect[3];
  if (!(width > 1) || !(height > 1)) {
    warn(`asset: '${rec.tag}' has no layout box; cannot rasterise it`);
    return null;
  }
  let effectiveScale = scale;
  const maxPixels = 16 * 1024 * 1024;
  while (effectiveScale > 1 && width * effectiveScale * height * effectiveScale > maxPixels) {
    effectiveScale /= 2;
  }
  try {
    return await session.screenshot({
      format: 'png',
      clip: { x: rect[0], y: rect[1], width, height, scale: effectiveScale },
    });
  } catch (err) {
    warn(`asset: cannot rasterise '${rec.tag}' (${err.message})`);
    return null;
  }
}

/** Deep-clean a tree: no undefined values, every number finite. */
function sanitizeTree(value, warnings, trail) {
  const where = trail || 'root';
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = sanitizeTree(value[i], warnings, `${where}[${i}]`);
      if (item !== undefined) out.push(item);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const item = sanitizeTree(value[key], warnings, `${where}.${key}`);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      warnings.push(`value: non-finite number at ${where} replaced with 0`);
      return 0;
    }
    return value;
  }
  return value;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return 1;
    }
    throw err;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (!fs.existsSync(opts.input)) {
    process.stderr.write(`error: input file not found: ${opts.input}\n`);
    return 1;
  }
  const stat = fs.statSync(opts.input);
  if (!stat.isFile()) {
    process.stderr.write(`error: input is not a file: ${opts.input}\n`);
    return 1;
  }

  const started = Date.now();
  const outDir = path.dirname(opts.output);
  fs.mkdirSync(outDir, { recursive: true });

  const assetsAbs = path.isAbsolute(opts.assetsDir) ? opts.assetsDir : path.join(outDir, opts.assetsDir);
  let assetsRel = path.relative(outDir, assetsAbs).replace(/\\/g, '/');
  if (!assetsRel) assetsRel = 'assets';

  const warnings = [];
  const registry = new AssetRegistry({
    outDir: assetsAbs,
    relDir: assetsRel,
    baseDir: path.dirname(opts.input),
    warn: (message) => warnings.push(message),
    info: (message) => log(opts, `  ${message}`),
  });

  let browser = null;
  let session = null;
  let snapshot = null;
  let probes = [];
  let pngShot = null;

  try {
    log(opts, `[1/6] launching browser (${opts.viewport.width}x${opts.viewport.height})`);
    browser = await launchBrowser({
      browser: opts.browser,
      viewport: opts.viewport,
      timeoutMs: opts.timeout,
      keepProfile: opts.keepProfile,
    });
    log(opts, `      ${browser.version || 'chromium'} via ${browser.source} (${browser.launchMs} ms)`);

    log(opts, '[2/6] loading page');
    session = await CDPSession.connect(browser.pageWsUrl, { timeoutMs: opts.timeout });
    await session.enable();
    await session.setViewport(opts.viewport.width, opts.viewport.height);
    const url = pathToFileURL(opts.input).href;
    await session.navigate(url, opts.timeout);
    // Author-time fragments are inlined before anything is measured.
    const partials = await expandPartials(session);
    if (partials && partials.results) {
      for (const entry of partials.results) {
        if (entry.ok) log(opts, `      inlined partial ${entry.partial} (${entry.nodes} node(s))`);
        else warnings.push(`partial: could not inline '${entry.partial}' (${entry.error}); replaced with an empty div`);
      }
      if (partials.remaining) {
        warnings.push(`partial: ${partials.remaining} data-ue-partial placeholder(s) survived inlining (nested or cyclic?)`);
      }
    }
    const stable = await stabilize(session);
    if (stable && stable.scrollWidth > stable.width + 1) {
      warnings.push(
        `note: the document is ${stable.scrollWidth}px wide at a ${stable.width}px viewport (horizontal overflow); the design assumes a wider canvas`
      );
    }
    if (stable && stable.scrollHeight > stable.height + 1) {
      warnings.push(
        `note: the document is ${stable.scrollHeight}px tall at a ${stable.height}px viewport (vertical overflow)`
      );
    }

    log(opts, '[3/6] capturing DOM snapshot');
    snapshot = await captureSnapshot(session, {
      width: opts.viewport.width,
      height: opts.viewport.height,
      pseudo: true,
      declared: true,
    });
    if (snapshot.truncated) warnings.push('snapshot: element limit reached; the tree was truncated');
    if (snapshot.skippedHidden) {
      warnings.push(`note: ${snapshot.skippedHidden} element(s) with display:none were skipped`);
    }
    if (snapshot.inaccessibleSheets) {
      warnings.push(`note: ${snapshot.inaccessibleSheets} stylesheet(s) could not be read (cross-origin); declared sizes may be missed`);
    }

    for (const probe of opts.probes) {
      log(opts, `      probe viewport ${probe.width}x${probe.height}`);
      await session.setViewport(probe.width, probe.height);
      await stabilize(session);
      probes.push(
        await captureSnapshot(session, { width: probe.width, height: probe.height, pseudo: false, declared: false })
      );
    }
    if (opts.probes.length) {
      await session.setViewport(opts.viewport.width, opts.viewport.height);
      await stabilize(session);
    }

    log(opts, '[4/6] extracting assets');
    // Remote images first (needs the network, not the DOM).
    for (const remote of collectRemoteUrls(snapshot)) {
      await registry.prefetchRemote(remote.url, remote.label);
    }
    // Inline SVG / .svg images are rasterised through the browser at 4x.
    for (const rec of collectRasterTargets(snapshot)) {
      const png = await rasterizeElement(session, rec, 4, (message) => warnings.push(message));
      if (png) registry.seedElementTexture(rec.i, png, `inline svg on <${rec.tag}>`);
    }

    // Native control parts (select arrow, checkbox tick, slider thumb, progress
    // fill) are cut straight out of the browser so the widget paints exactly what
    // the design shows instead of an engine default.
    let baked = new Map();
    if (opts.bake) {
      log(opts, '      baking native control parts');
      baked = await bakeControls({
        session,
        snapshot,
        assets: registry,
        scale: opts.bakeScale,
        maxEdge: opts.bakeMax,
        warn: (message) => warnings.push(message),
      });
      if (baked.size) log(opts, `      baked ${baked.size} native control(s)`);
    }

    if (opts.shot) {
      log(opts, '      capturing screenshot');
      pngShot = await session.screenshot({ format: 'png' });
    }

    if (opts.dumpSnapshot) {
      const dump = { primary: snapshot, probes };
      fs.writeFileSync(opts.dumpSnapshot, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
      log(opts, `      raw snapshot -> ${opts.dumpSnapshot}`);
    }

    log(opts, '[5/6] mapping to the layout contract');
    const mapper = new Mapper({
      snapshot,
      probes,
      assets: registry,
      options: { scaleBox: opts.scaleBox, baked },
    });
    const root = mapper.map();
    for (const warning of mapper.warnings) warnings.push(warning);

    const bodyRec = snapshot.elements.find((rec) => rec.tag === 'body');
    const ueBlueprint = bodyRec && bodyRec.ue && bodyRec.ue.blueprint ? String(bodyRec.ue.blueprint) : null;
    const blueprint = opts.blueprint || (ueBlueprint ? ueBlueprint.replace(/\\/g, '/') : defaultBlueprintName(opts.input));

    const layout = {
      contractVersion: 1,
      generator: GENERATOR,
      source: opts.input.replace(/\\/g, '/'),
      blueprint,
      viewport: { width: opts.viewport.width, height: opts.viewport.height },
      assets: registry.toJson(),
      warnings: [],
      root,
    };

    const cleaned = sanitizeTree(layout, warnings);
    cleaned.warnings = warnings.slice();

    log(opts, '[6/6] writing output');
    fs.writeFileSync(opts.output, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
    if (pngShot) {
      fs.mkdirSync(path.dirname(path.resolve(opts.shot)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.shot), pngShot);
    }

    const stats = summarize(cleaned);
    const elapsed = Date.now() - started;
    process.stdout.write(
      [
        `Html2UMG converted ${path.basename(opts.input)} -> ${path.relative(process.cwd() === outDir ? '.' : process.cwd(), opts.output).replace(/\\/g, '/')}`,
        `  viewport   ${opts.viewport.width}x${opts.viewport.height}${opts.probes.length ? ` (+${opts.probes.length} probes)` : ''}`,
        `  blueprint  ${blueprint}`,
        `  widgets    ${stats.total} (${stats.depth} deep)`,
        `  classes    ${stats.classes}`,
        `  assets     ${stats.textures} texture(s), ${stats.fonts} font(s)`,
        `  warnings   ${warnings.length}`,
        `  elapsed    ${elapsed} ms`,
      ].join('\n') + '\n'
    );
    if (warnings.length && !opts.quiet) {
      for (const warning of warnings.slice(0, 12)) process.stderr.write(`  ! ${warning}\n`);
      if (warnings.length > 12) process.stderr.write(`  ! ... ${warnings.length - 12} more warning(s)\n`);
    }
    if (opts.shot) process.stdout.write(`  screenshot ${path.resolve(opts.shot)}\n`);

    if (opts.strict && warnings.length) {
      process.stderr.write(`error: --strict is set and ${warnings.length} warning(s) were produced\n`);
      return 2;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err && err.message ? err.message : err}\n`);
    if (process.env.HTML2UMG_DEBUG && err && err.stack) process.stderr.write(`${err.stack}\n`);
    return 1;
  } finally {
    if (session) {
      try {
        session.close();
      } catch (err) {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        /* ignore */
      }
    }
  }
}

function summarize(layout) {
  const counts = new Map();
  let total = 0;
  let maxDepth = 0;
  const walk = (node, depth) => {
    if (!node) return;
    total += 1;
    maxDepth = Math.max(maxDepth, depth);
    const key = String(node.class || '?').split('.').pop();
    counts.set(key, (counts.get(key) || 0) + 1);
    for (const child of node.children || []) walk(child, depth + 1);
  };
  walk(layout.root, 1);
  const classes = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}x${count}`)
    .join(' ');
  return {
    total,
    depth: maxDepth,
    classes,
    textures: (layout.assets.textures || []).length,
    fonts: (layout.assets.fonts || []).length,
  };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main, summarize, collectRemoteUrls, collectRasterTargets, sanitizeTree };
