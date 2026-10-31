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
const { stabilize, captureSnapshot, expandPartials, collectPlatformFonts } = require('../src/snapshot');
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

/**
 * Is this design fluid or pinned to one width?
 *
 * The probes re-snapshot the page at other viewports. A fluid design (percentages, flex, grids)
 * rescales its boxes; a design with `html,body{width:1920px;height:1080px}` reports identical
 * rects forever. `--layout=responsive` can only do its job on the former, so say so instead of
 * silently emitting constraints that cannot move.
 */
function diagnoseDesign(primary, probes) {
  // NOTE on the counter: `scaled` counts boxes whose width *followed* the viewport change. An
  // earlier version counted the ones that did NOT scale and then called a high count "fluid",
  // which reported the pinned 1920x1080 skyline page as fluid.
  const result = { flow: 'unknown', compared: 0, scaled: 0, fixed: 0, scaledFraction: 0 };
  const usable = (probes || []).filter((p) => p && Array.isArray(p.elements) && p.viewport);
  if (!primary || !Array.isArray(primary.elements) || !usable.length) return result;
  for (const probe of usable) {
    const scale = probe.viewport.width / (primary.viewport ? primary.viewport.width : probe.viewport.width);
    if (!(Math.abs(scale - 1) > 0.02)) continue;
    for (const rec of primary.elements) {
      const other = probe.elements[rec.i];
      if (!rec.rect || !other || !other.rect) continue;
      if (rec.rect[2] < 8 || rec.rect[3] < 8) continue;
      result.compared += 1;
      const expected = rec.rect[2] * scale;
      if (Math.abs(other.rect[2] - expected) <= Math.max(4, rec.rect[2] * 0.05)) result.scaled += 1;
      else result.fixed += 1;
    }
  }
  if (result.compared) {
    result.scaledFraction = Math.round((result.scaled / result.compared) * 1000) / 1000;
    result.flow = result.scaledFraction >= 0.5 ? 'fluid' : result.scaledFraction <= 0.1 ? 'rigid' : 'mixed';
  }
  return result;
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
    fontPolicy: opts.fontPolicy,
    allowTtc: opts.ttcSubfaces !== false,
  });

  // Component registry (--components): selector -> widget blueprint. Read up-front so a broken
  // file fails before the browser is even launched.
  const componentRegistry = (() => {
    const raw = opts.components || process.env.HTML2UMG_COMPONENTS;
    if (!raw) return null;
    const file = path.resolve(String(raw));
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`--components: cannot read '${file}': ${err.message}`);
    }
  })();

  // Every knob that changes the output is recorded in layout.settings, so two runs of the
  // same HTML can be diffed (and pixel-audited) without guessing which flags were used.
  const effectiveSettings = {
    fontPolicy: ['redistributable', 'engine'].indexOf(String(opts.fontPolicy)) >= 0 ? String(opts.fontPolicy) : 'any',
    fontMap: (() => {
      const raw = String(opts.fontMap || process.env.HTML2UMG_FONT_MAP || 'ignore').toLowerCase();
      return raw === 'keep' ? 'keep' : 'ignore';
    })(),
    ttcSubfaces: opts.ttcSubfaces !== false,
    wrapTolerance: (() => {
      const raw = opts.wrapTolerance !== null && opts.wrapTolerance !== undefined
        ? opts.wrapTolerance
        : process.env.HTML2UMG_WRAP_TOLERANCE;
      const value = Number(raw);
      return Number.isFinite(value) ? value : 0;
    })(),
    cjkBreaks: (() => {
      const raw = String(opts.cjkBreaks || process.env.HTML2UMG_CJK_BREAKS || 'policy').toLowerCase();
      return raw === 'none' || raw === 'off' ? 'none' : 'policy';
    })(),
    lineHeightModel: (() => {
      const raw = String(opts.lineHeightModel || process.env.HTML2UMG_LINE_HEIGHT_MODEL || 'per-font').toLowerCase();
      return raw === 'legacy' ? 'legacy' : 'per-font';
    })(),
    lineBoxSnap: (() => {
      const raw = String(opts.lineBoxSnap || process.env.HTML2UMG_LINE_BOX_SNAP || 'exact').toLowerCase();
      return raw === 'half' || raw === 'int' || raw === 'font' ? raw : 'exact';
    })(),
    layout: (() => {
      const raw = String(opts.layout || process.env.HTML2UMG_LAYOUT || 'exact').toLowerCase();
      return raw === 'responsive' ? 'responsive' : 'exact';
    })(),
  };

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

    // Which face did the browser actually draw each text element with? The DOM alone
    // cannot tell: a Latin stack silently gains a system CJK face for Han glyphs, and
    // that substitution is what the importer has to reproduce. Runs before the probe
    // snapshots, while data-h2u-idx still matches the primary snapshot's indices.
    log(opts, '      probing platform fonts');
    try {
      const platform = await collectPlatformFonts(session, snapshot, { warn: (message) => warnings.push(message) });
      if (platform && platform.nodes) {
        const top = platform.families.slice(0, 4).map((entry) => `${entry.family}(${entry.glyphs})`).join(', ');
        log(
          opts,
          `      platform fonts: ${platform.queried}/${platform.nodes} text element(s)` +
            `${platform.failed ? ` (${platform.failed} without data)` : ''}${top ? ` — ${top}` : ''}`
        );
      }
    } catch (err) {
      warnings.push(`fonts: platform font probe failed (${err.message}); falling back to cmap coverage only`);
    }

    for (const probe of opts.probes) {
      log(opts, `      probe viewport ${probe.width}x${probe.height}`);
      await session.setViewport(probe.width, probe.height);
      await stabilize(session);
      probes.push(
        await captureSnapshot(session, { width: probe.width, height: probe.height, pseudo: false, declared: false })
      );
    }
    // Fluid or pinned? `--layout=responsive` only pays off on a fluid design, so measure it and
    // record the verdict in settings.design (and warn once when the two disagree).
    const design = diagnoseDesign(snapshot, probes);
    effectiveSettings.design = design;
    if (design.flow !== 'unknown') {
      log(
        opts,
        `      design: ${design.flow} — ${design.scaled} scalable / ${design.fixed} fixed of ${design.compared} boxes`
      );
    }
    if (effectiveSettings.layout === 'responsive' && design.flow === 'rigid') {
      warnings.push(
        'layout: this design is pinned to one width (' + (design.scaledFraction * 100) +
          '% of boxes rescale between probes), so responsive constraints cannot reflow it; ' +
          'either author the page with %/flex, or use --scale-box / --aspects'
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
      options: {
        scaleBox: opts.scaleBox,
        baked,
        pinFlowHeights: opts.pinFlowHeights === true,
        // Typography A/B knobs (see Docs/Html2UMG_FontMetrics.md). The mapper also honours the
        // HTML2UMG_LINE_HEIGHT_MODEL / HTML2UMG_TEXT_SHADOW environment variables.
        lineHeightModel: opts.lineHeightModel,
        textShadow: opts.textShadow,
        lineBoxSnap: opts.lineBoxSnap,
        layout: effectiveSettings.layout,
        fontMap: effectiveSettings.fontMap,
        // Selector -> widget blueprint registry (see --components). The mapper claims matching
        // elements as instances of an already imported WBP instead of expanding them inline.
        components: componentRegistry,
        // --name-verbatim: keep data-ue-name exactly as authored, so a graph copied from the previous
        // import still binds its events and variables. Per element: data-ue-name-verbatim.
        nameVerbatim: opts.nameVerbatim === true,
        // Tree simplification: drop wrapper layers that cannot change a pixel (default on).
        simplify: opts.simplify !== false,
        wrapTolerance: opts.wrapTolerance,
        cjkBreaks: opts.cjkBreaks,
      },
    });
    const root = mapper.map();
    for (const warning of mapper.warnings) warnings.push(warning);

    // CSS motion has no UMG equivalent the importer can synthesise: a UWidgetAnimation is a
    // sequencer asset, and the interesting cases (hover / focus / press) are event driven and would
    // need a generated blueprint graph, which a static converter cannot express. The snapshot reads
    // the authored rules because the stabilize stylesheet forces transition/animation to none.
    const motion = snapshot.motion || { transitions: [], animations: [], keyframes: [] };
    const motionRules = motion.transitions.length + motion.animations.length;
    if (motionRules > 0 || motion.keyframes.length > 0) {
      const bits = [];
      if (motion.transitions.length) bits.push(`${motion.transitions.length} rule(s) with transition (${motion.transitions.slice(0, 3).join(', ')})`);
      if (motion.animations.length) bits.push(`${motion.animations.length} rule(s) with animation (${motion.animations.slice(0, 3).join(', ')})`);
      if (motion.keyframes.length) bits.push(`@keyframes ${motion.keyframes.slice(0, 3).join(', ')}`);
      warnings.push(
        `approximated: CSS motion is not converted - ${bits.join('; ')}. The widgets are imported in their resting state; build the motion in the UMG designer (Widget Animation) or with CommonUI styles`
      );
    }

    const bodyRec = snapshot.elements.find((rec) => rec.tag === 'body');
    const ueBlueprint = bodyRec && bodyRec.ue && bodyRec.ue.blueprint ? String(bodyRec.ue.blueprint) : null;
    const blueprint = opts.blueprint || (ueBlueprint ? ueBlueprint.replace(/\\/g, '/') : defaultBlueprintName(opts.input));

    const layout = {
      contractVersion: 1,
      generator: GENERATOR,
      source: opts.input.replace(/\\/g, '/'),
      blueprint,
      viewport: { width: opts.viewport.width, height: opts.viewport.height },
      // Flags that changed the output. Same HTML + same settings => same JSON.
      settings: effectiveSettings,
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

    // Licensing: everything in assets/ is imported as a UFontFace and therefore ships
    // inside the package. Tell the user once, loudly, instead of letting a proprietary
    // face slip into a release unnoticed. (Kept out of `warnings` on purpose: a single
    // ubiquitous Windows face would otherwise turn every --strict CI run red.)
    const licenses = registry.licenseSummary();
    if (!opts.quiet && licenses.nonRedistributable.length) {
      const list = licenses.nonRedistributable
        .slice(0, 8)
        .map((entry) => `${entry.family} (${path.basename(entry.file)}, ${entry.role}, ${entry.license})`)
        .join(', ');
      const more = licenses.nonRedistributable.length > 8 ? ` + ${licenses.nonRedistributable.length - 8} more` : '';
      process.stderr.write(
        `\n  ! font-license: ${licenses.nonRedistributable.length} non-redistributable font(s) are embedded in the package:\n` +
          `      ${list}${more}\n` +
          `    These files are imported as UFontFace bulk data and ship with the game. Replace them with\n` +
          `    redistributable faces (Noto Sans SC / Source Han) or confirm you hold a licence before release.\n` +
          `    Pass --font-policy=redistributable to refuse embedding them.\n\n`
      );
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
        `  assets     ${stats.textures} texture(s), ${stats.fonts} font(s)` +
          (registry.licenseSummary().counts.proprietary
            ? ` (${registry.licenseSummary().counts.proprietary} proprietary file(s), see the font-license note)`
            : ''),
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
