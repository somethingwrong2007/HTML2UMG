// Copyright (c) 2026 FPVSkyline. MIT License.
// CLI parsing for cli/convert.js. No dependencies.
'use strict';

const path = require('path');

const USAGE = `Html2UMG converter — HTML/CSS -> Html2UMG layout JSON (contract v1)

Usage:
  node cli/convert.js <input.html> -o <out.json> [options]

Options:
  --viewport WxH            Design viewport used for measurement (default 1920x1080)
  --probe WxH,WxH           Extra viewports used to infer canvas anchors.
                            Defaults to 0.75x and 1.25x of --viewport; "none" disables.
  --browser <exe>           Chromium-based browser executable (default: autodetect)
  --assets <dir>            Asset output directory, relative to the json (default: assets)
  --shot <png>              Also save a browser screenshot (fidelity comparison)
  --blueprint <path>        Override data-ue-blueprint / /Game/UI/WBP_<Name>
  --scale-box <mode>        Wrap the root in a ScaleBox: fit|fill|fitx|fity
  --bake / --no-bake        Bake native control pixels (select arrow, checkbox tick,
                            slider thumb, progress fill) into textures (default: on)
  --bake-scale <n>          Rasterisation scale for baked textures (default 2, max 4)
  --pin-flow                Pin each vertical-flow leaf to its measured height. Long document-style
                            pages drift less (a 7081px page: 7.97% -> 4.81% with every child pinned),
                            but form/flex screens measure worse, so it is off by default.
  --bake-max <px>           Max edge of a single baked texture (default 2048)
  --line-height-model <m>   per-font (default): LineHeightPercentage is computed from each font's
                            own file metrics (hhea for Slate, OS/2 + hhea gap for Chromium).
                            legacy: the old single global constant, for A/B-ing a page.
  --line-box-snap <m>       font (default) = Chromium's own number: ascent/descent/lineGap each
                            rounded to a whole pixel and added. exact keeps the fractional sum;
                            half / int round the *sum* to 0.5 / 1 px (A/B knobs).
  --text-shadow <m>         zero (default): TextBlocks get ShadowOffset [0,0] when the design has
                            no text-shadow, so the line box is the font's own metric.
                            default: keep UMG's (1,1) and count its extra pixel in the line box.
  --ttc-subfaces /          Import TrueType collections (.ttc/.otc) through their sub-face
    --no-ttc-subfaces       index instead of skipping them (default: on; UE 5.8 supports it).
  --wrap-tolerance <px>     Add this many px to an emitted WrapTextAt so a font that measures a
                            hair wider than the browser still fits on the same line (default 0).
  --aspects <list>          Emit one WBP variant per breakpoint, each measured at its own viewport:
                            21:9,16:9,4:3 (height from --viewport) or 2560x1080,1920x1080.
                            Assets stay in ONE directory with globally unique keys.
  --layout <mode>           exact (default): the design is baked at --viewport.
                            responsive: no baked WrapTextAt (text wraps at run time), percentage/
                            flex widths kept, single-child centre becomes an Overlay.
                            Output is stock UMG only - the plugin ships no runtime module, so a
                            converted blueprint keeps working after the plugin is removed.
  --cjk-breaks <m>          policy (default): tell Slate to apply its own CJK break policy.
                            none: no break opportunities are requested for CJK runs.
  --font-policy <mode>      any (default): embed whatever the design asks for.
                            redistributable: refuse proprietary font files and switch to
                            OFL candidates (Noto Sans SC / Source Han) instead.
                            engine: embed ONLY redistributable faces; everything else keeps no
                            font asset and uses the UMG default font (no CJK sub-fonts either).
  --font-map <mode>         ignore (default): drop data-ue-font-map, so a design never points at
                            the authoring project's own font assets (licensing / portability).
                            keep: honour the map, as before.
  --strict                  Exit 2 when the conversion produced warnings
  -q, --quiet               Only print the summary line on stdout
  --dump-snapshot <file>    Write the raw DOM snapshot(s) to <file> for debugging
  --keep-profile            Keep the temporary browser profile directory
  --timeout <ms>            Per-step browser timeout (default 30000)
  -h, --help                Show this help

Exit codes: 0 success, 1 failure, 2 --strict and warnings were produced.
`;

class ArgError extends Error {}

const SCALE_BOX_MODES = {
  fit: 'ScaleToFit',
  fill: 'Fill',
  fitx: 'ScaleToFitX',
  fity: 'ScaleToFitY',
};

function parseViewport(text, what) {
  const m = /^(\d{2,5})[x*×](\d{2,5})$/i.exec(String(text || '').trim());
  if (!m) {
    throw new ArgError(`${what}: expected WxH (e.g. 1920x1080), got "${text}"`);
  }
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (width < 16 || height < 16) {
    throw new ArgError(`${what}: viewport too small (${width}x${height})`);
  }
  return { width, height };
}

/**
 * Parse argv (without node/script). Returns a plain options object.
 * Throws ArgError with a human readable message on bad input.
 */
function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    viewport: { width: 1920, height: 1080 },
    probes: null, // null = auto
    browser: null,
    assetsDir: 'assets',
    shot: null,
    blueprint: null,
    scaleBox: null,
    bake: true,
    bakeScale: 2,
    pinFlowHeights: false,
    bakeMax: 2048,
    lineHeightModel: 'per-font',
    textShadow: 'zero',
    lineBoxSnap: 'exact',
    layout: 'exact',
    aspects: null,
    fontPolicy: 'any',
    fontMap: 'ignore',
    ttcSubfaces: true,
    wrapTolerance: null,
    cjkBreaks: 'policy',
    strict: false,
    quiet: false,
    dumpSnapshot: null,
    keepProfile: false,
    timeout: 30000,
    help: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith('-') && value.length > 1 && !/^-\d/.test(value))) {
        throw new ArgError(`${arg}: missing value`);
      }
      i += 1;
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-o' || arg === '--out' || arg === '--output') {
      opts.output = takeValue();
    } else if (arg === '--viewport') {
      opts.viewport = parseViewport(takeValue(), '--viewport');
    } else if (arg === '--probe') {
      const raw = takeValue().trim();
      if (raw === '' || /^none$/i.test(raw)) {
        opts.probes = [];
      } else {
        opts.probes = raw.split(',').map((p) => parseViewport(p, '--probe'));
      }
    } else if (arg === '--browser') {
      opts.browser = takeValue();
    } else if (arg === '--assets') {
      opts.assetsDir = takeValue();
    } else if (arg === '--shot') {
      opts.shot = takeValue();
    } else if (arg === '--blueprint') {
      opts.blueprint = takeValue();
    } else if (arg === '--scale-box') {
      const mode = takeValue().toLowerCase();
      if (!SCALE_BOX_MODES[mode]) {
        throw new ArgError(`--scale-box: expected one of ${Object.keys(SCALE_BOX_MODES).join('|')}, got "${mode}"`);
      }
      opts.scaleBox = { mode, stretch: SCALE_BOX_MODES[mode] };
    } else if (arg === '--bake') {
      opts.bake = true;
    } else if (arg === '--no-bake') {
      opts.bake = false;
    } else if (arg === '--bake-scale') {
      const value = parseFloat(takeValue());
      if (!Number.isFinite(value) || value < 1 || value > 4) throw new ArgError('--bake-scale: expected 1..4');
      opts.bakeScale = value;
    } else if (arg === '--bake-max') {
      const value = parseInt(takeValue(), 10);
      if (!Number.isFinite(value) || value < 64) throw new ArgError('--bake-max: expected pixels >= 64');
      opts.bakeMax = value;
    } else if (arg === '--line-box-snap' || arg.startsWith('--line-box-snap=')) {
      const inline = arg.startsWith('--line-box-snap=') ? arg.slice('--line-box-snap='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'font' && mode !== 'exact' && mode !== 'half' && mode !== 'int') {
        throw new ArgError('--line-box-snap: expected font|exact|half|int, got "' + mode + '"');
      }
      opts.lineBoxSnap = mode;
    } else if (arg === '--pin-flow') {
      opts.pinFlowHeights = true;
    } else if (arg === '--line-height-model' || arg.startsWith('--line-height-model=')) {
      const inline = arg.startsWith('--line-height-model=') ? arg.slice('--line-height-model='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'per-font' && mode !== 'legacy') {
        throw new ArgError('--line-height-model: expected per-font|legacy, got "' + mode + '"');
      }
      opts.lineHeightModel = mode;
    } else if (arg === '--text-shadow' || arg.startsWith('--text-shadow=')) {
      const inline = arg.startsWith('--text-shadow=') ? arg.slice('--text-shadow='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'zero' && mode !== 'default') {
        throw new ArgError('--text-shadow: expected zero|default, got "' + mode + '"');
      }
      opts.textShadow = mode;
    } else if (arg === '--ttc-subfaces') {
      opts.ttcSubfaces = true;
    } else if (arg === '--no-ttc-subfaces') {
      opts.ttcSubfaces = false;
    } else if (arg === '--wrap-tolerance' || arg.startsWith('--wrap-tolerance=')) {
      const inline = arg.startsWith('--wrap-tolerance=') ? arg.slice('--wrap-tolerance='.length) : null;
      const value = parseFloat(inline === null ? takeValue() : inline);
      if (!Number.isFinite(value) || value < -32 || value > 32) {
        throw new ArgError('--wrap-tolerance: expected a number of px between -32 and 32');
      }
      opts.wrapTolerance = value;
    } else if (arg === '--cjk-breaks' || arg.startsWith('--cjk-breaks=')) {
      const inline = arg.startsWith('--cjk-breaks=') ? arg.slice('--cjk-breaks='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'policy' && mode !== 'none' && mode !== 'off') {
        throw new ArgError('--cjk-breaks: expected policy|none, got "' + mode + '"');
      }
      opts.cjkBreaks = mode === 'policy' ? 'policy' : 'none';
    } else if (arg === '--font-policy' || arg.startsWith('--font-policy=')) {
      const inline = arg.startsWith('--font-policy=') ? arg.slice('--font-policy='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'any' && mode !== 'redistributable' && mode !== 'engine') {
        throw new ArgError('--font-policy: expected any|redistributable|engine, got "' + mode + '"');
      }
      opts.fontPolicy = mode;
    } else if (arg === '--layout' || arg.startsWith('--layout=')) {
      const inline = arg.startsWith('--layout=') ? arg.slice('--layout='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'exact' && mode !== 'responsive') {
        throw new ArgError('--layout: expected exact|responsive, got "' + mode + '"');
      }
      opts.layout = mode;
    } else if (arg === '--aspects' || arg.startsWith('--aspects=')) {
      const inline = arg.startsWith('--aspects=') ? arg.slice('--aspects='.length) : null;
      opts.aspects = String(inline === null ? takeValue() : inline).trim();
    } else if (arg === '--font-map' || arg.startsWith('--font-map=')) {
      const inline = arg.startsWith('--font-map=') ? arg.slice('--font-map='.length) : null;
      const mode = (inline === null ? takeValue() : inline).toLowerCase();
      if (mode !== 'ignore' && mode !== 'keep') {
        throw new ArgError('--font-map: expected ignore|keep, got "' + mode + '"');
      }
      opts.fontMap = mode;
    } else if (arg === '--strict') {
      opts.strict = true;
    } else if (arg === '-q' || arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--dump-snapshot') {
      opts.dumpSnapshot = takeValue();
    } else if (arg === '--keep-profile') {
      opts.keepProfile = true;
    } else if (arg === '--timeout') {
      const value = parseInt(takeValue(), 10);
      if (!Number.isFinite(value) || value < 1000) throw new ArgError('--timeout: expected milliseconds >= 1000');
      opts.timeout = value;
    } else if (arg.startsWith('--')) {
      throw new ArgError(`unknown option: ${arg}`);
    } else if (arg.startsWith('-') && arg.length > 1) {
      throw new ArgError(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (opts.help) return opts;

  if (positional.length === 0) throw new ArgError('missing <input.html>');
  if (positional.length > 1) throw new ArgError(`unexpected extra argument: ${positional[1]}`);
  opts.input = path.resolve(positional[0]);

  if (!opts.output) {
    opts.output = opts.input.replace(/\.html?$/i, '') + '.json';
  }
  opts.output = path.resolve(opts.output);

  // Blueprint path must be a /Game/... package path.
  if (opts.blueprint) {
    opts.blueprint = opts.blueprint.replace(/\\/g, '/');
    if (!opts.blueprint.startsWith('/')) {
      throw new ArgError(`--blueprint: expected a package path starting with "/Game/", got "${opts.blueprint}"`);
    }
  }

  if (!opts.probes) {
    opts.probes = autoProbes(opts.viewport);
  }

  return opts;
}

/** Two extra viewports around the design size; deterministic for a given viewport. */
function autoProbes(viewport) {
  const clampDim = (v) => Math.max(320, Math.round(v));
  const small = { width: clampDim(viewport.width * 0.75), height: clampDim(viewport.height * 0.75) };
  const large = { width: clampDim(viewport.width * 1.25), height: clampDim(viewport.height * 1.25) };
  const same = (a, b) => a.width === b.width && a.height === b.height;
  const out = [];
  if (!same(small, viewport)) out.push(small);
  if (!same(large, viewport) && !out.some((p) => same(p, large))) out.push(large);
  return out;
}

module.exports = { parseArgs, ArgError, USAGE, SCALE_BOX_MODES, autoProbes, parseViewport };
