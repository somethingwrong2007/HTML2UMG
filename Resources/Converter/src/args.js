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
  --bake-max <px>           Max edge of a single baked texture (default 2048)
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
    bakeMax: 2048,
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
