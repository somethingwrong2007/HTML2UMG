// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Native-control baking: instead of approximating what the browser draws for a
// native widget (select arrow, checkbox tick, slider thumb, progress fill), the
// real pixels are cut out of the browser and shipped as textures.
//
// Pipeline per part:  isolate (injected CSS / forced pseudo state) -> clipped
// CDP screenshot -> decode -> alpha mask (so corners are not opaque) -> encode ->
// `assets.textures`.  Widget type never changes: a ComboBoxString stays a
// ComboBoxString, the texture only replaces what it paints.
'use strict';

const zlib = require('zlib');

// --------------------------------------------------------------------- PNG I/O
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    let c = (crc ^ buffer[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Decode an 8-bit non-interlaced RGB/RGBA PNG into {width, height, data:RGBA}.
 * Returns null for anything else (16-bit, palette, interlaced) so callers can
 * degrade instead of guessing.
 */
function decodePng(buffer) {
  if (!buffer || buffer.length < 8 || !buffer.slice(0, 8).equals(PNG_SIGNATURE)) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.slice(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0 || !width || !height) return null;
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = line[x];
      let result;
      switch (filter) {
        case 0: result = value; break;
        case 1: result = value + left; break;
        case 2: result = value + up; break;
        case 3: result = value + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: return null;
      }
      current[x] = result & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      out[target] = current[source];
      out[target + 1] = current[source + 1];
      out[target + 2] = current[source + 2];
      out[target + 3] = channels === 4 ? current[source + 3] : 255;
    }
    previous = current;
  }
  return { width, height, data: out };
}

/** Encode RGBA pixels as a PNG. Deterministic for identical input. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ image ops
function crop(image, x, y, width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    image.data.copy(out, row * width * 4, from, from + width * 4);
  }
  return { width, height, data: out };
}

/** Bounding box of pixels that differ between two same-sized images. */
function diffBox(a, b, threshold) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  const limit = threshold === undefined ? 12 : threshold;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const i = (y * a.width + x) * 4;
      const delta =
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) +
        Math.abs(a.data[i + 3] - b.data[i + 3]);
      if (delta > limit) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Bounding box of non-transparent pixels. */
function opaqueBox(image, threshold) {
  if (!image) return null;
  const limit = threshold === undefined ? 4 : threshold;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > limit) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Make everything outside the element's rounded-rect silhouette transparent.
 * Baked screenshots always carry the page background in the corners that the
 * element's border-radius leaves uncovered; leaving it opaque would show as a
 * dark rectangle over whatever the UMG widget sits on.
 */
function applyRoundedMask(image, radii, scale) {
  const factor = scale || 1;
  const w = image.width;
  const h = image.height;
  // Corner radii in device pixels, in TL, TR, BR, BL order.
  const r = radii.map((value) => Math.max(0, Math.min(value * factor, Math.min(w, h) / 2)));
  const out = Buffer.from(image.data);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let radius = 0;
      let centerX = 0;
      let centerY = 0;
      const right = cx > w - r[1] && r[1] > 0;
      const bottom = cy > h - r[2] && r[2] > 0;
      if (cx < r[0] && cy < r[0] && r[0] > 0) {
        radius = r[0]; centerX = r[0]; centerY = r[0];
      } else if (right && cy < r[1]) {
        radius = r[1]; centerX = w - r[1]; centerY = r[1];
      } else if (cx > w - r[3] && r[3] > 0 && cy > h - r[3]) {
        radius = r[3]; centerX = w - r[3]; centerY = h - r[3];
      } else if (right && bottom) {
        radius = r[2]; centerX = w - r[2]; centerY = h - r[2];
      }
      if (!radius) continue;
      const dx = cx - centerX;
      const dy = cy - centerY;
      if (dx * dx + dy * dy > radius * radius) {
        out[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Circular alpha mask (used for round slider thumbs). */
function applyCircleMask(image) {
  const w = image.width;
  const h = image.height;
  const out = Buffer.from(image.data);
  const radiusX = w / 2;
  const radiusY = h / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = (x + 0.5 - radiusX) / radiusX;
      const dy = (y + 0.5 - radiusY) / radiusY;
      if (dx * dx + dy * dy > 1.02) out[(y * w + x) * 4 + 3] = 0;
    }
  }
  return { width: w, height: h, data: out };
}

// ----------------------------------------------------------------- page verbs
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keep only the pixels that differ from `reference`; everything else becomes
 * transparent. Used to lift a part (progress fill) off its own background.
 */
function maskByDifference(image, reference, threshold) {
  if (!image || !reference || image.width !== reference.width || image.height !== reference.height) return image;
  const limit = threshold === undefined ? 10 : threshold;
  const out = Buffer.from(image.data);
  for (let i = 0; i < out.length; i += 4) {
    const delta =
      Math.abs(image.data[i] - reference.data[i]) +
      Math.abs(image.data[i + 1] - reference.data[i + 1]) +
      Math.abs(image.data[i + 2] - reference.data[i + 2]) +
      Math.abs(image.data[i + 3] - reference.data[i + 3]);
    if (delta <= limit) out[i + 3] = 0;
  }
  return { width: image.width, height: image.height, data: out };
}

async function settle(session) {
  await session.evaluate(
    'new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(1); }); }); })',
    { awaitPromise: true, returnByValue: true }
  );
}

async function injectCss(session, text) {
  await session.evaluate(
    `(function () {
      var style = document.getElementById('__h2u_bake__');
      if (!style) {
        style = document.createElement('style');
        style.id = '__h2u_bake__';
        document.head.appendChild(style);
      }
      style.textContent = ${JSON.stringify(text)};
      return 1;
    })()`,
    { returnByValue: true }
  );
}

async function clearCss(session) {
  await session.evaluate(
    "(function () { var s = document.getElementById('__h2u_bake__'); if (s) s.textContent = ''; return 1; })()",
    { returnByValue: true }
  );
}

async function setPseudoState(session, nodeId, classes) {
  await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
}

async function queryNodeId(session, rootNodeId, selector) {
  try {
    const result = await session.send('DOM.querySelector', { nodeId: rootNodeId, selector });
    return result.nodeId || 0;
  } catch (err) {
    return 0;
  }
}

// ------------------------------------------------------------------- baking
/**
 * True when the element's border cannot be expressed by a single Slate outline.
 *
 * FSlateBrush carries ONE outline width and ONE colour, so a border that differs per side
 * (only a left rule, a 3px left + 1px elsewhere, four colours) or that uses a non-solid style
 * (dashed / dotted / double) has no faithful brush form. Those elements get their whole box -
 * background, border and radius - rasterised instead.
 */
/**
 * True when the element's border cannot be expressed by a single Slate outline at all.
 *
 * FSlateBrush carries ONE outline width and ONE colour, so a border that differs per side is
 * approximated instead (widest side wins, the rest is padded back - that keeps the geometry and
 * measured close). A non-solid style is different: dashed / dotted / double have NO approximation,
 * they would render as a solid line, so those boxes are rasterised instead.
 *
 * Baking every unequal border was tried and rejected: on a page built from full-bleed frames it
 * turned a 0.57% page into 22.47%, because each capture also picks up whatever sits behind the
 * element.
 */
function borderNeedsPaint(rec) {
  const cs = rec.cs || {};
  if (!cs) return false;
  const px = (value) => {
    const match = /-?[\d.]+/.exec(String(value || '0'));
    return match ? Number(match[0]) : 0;
  };
  const widths = [cs.borderLeftWidth, cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth].map(px);
  if (!widths.some((value) => value > 0)) return false;
  const styles = [cs.borderLeftStyle, cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle];
  if (styles.some((style) => style && style !== 'none' && style !== 'solid')) return true;

  // Unequal sides or four different colours: the outline cannot say it, and the padding-collapse
  // approximation leaves the border drawn on the wrong edges. Bake it - but only for a box of
  // reasonable size. A large capture also picks up whatever is behind the element, which is why
  // baking every such border unconditionally wrecked the frame-heavy test page.
  const rect = rec.rect || [0, 0, 0, 0];
  if (!(rect[2] >= 1) || !(rect[3] >= 1)) return false;
  // A capture only stands on its own when the element is opaque: then the texture contains just
  // the element (background + border) and can be dropped onto whatever is behind it. A
  // transparent element would bake its surroundings into the texture instead, which is what
  // wrecked the frame-heavy test page when every unequal border was baked unconditionally.
  // A small element is kept as a second chance, since its footprint is barely visible either way.
  const opaque = isOpaqueBackground(cs.backgroundColor);
  if (!opaque) return false;
  const longEdge = Math.max(rect[2], rect[3]);
  if (longEdge > 2048) return false;
  // How wide a box may be before the capture is not worth it. A wide bar WITH children measures
  // worse when baked, because the texture replaces a brush that also carried the collapsed-outline
  // padding compensation and its text ends up a pixel off across the whole width. A wide box with
  // no children has nothing to shift, and baking it is a straight win (a 1920x3 frame line, say).
  // The capture is only trusted up to the bake-max edge; beyond that the texture would be
  // downscaled and the border would blur.
  if (longEdge > 2048) return false;

  const uniformWidth = widths.every((value) => Math.abs(value - widths[0]) < 0.01);
  const colours = [cs.borderLeftColor, cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor];
  const uniformColour = colours.every((colour) => colour === colours[0]);
  return !uniformWidth || !uniformColour;
}

/** True when a CSS colour fills its box completely (no alpha channel, or alpha 1). */
function isOpaqueBackground(value) {
  const text = String(value || '').trim();
  if (!text || text === 'transparent' || text === 'rgba(0, 0, 0, 0)') return false;
  const match = /^rgba\(([^)]+)\)$/.exec(text);
  if (match) {
    const parts = match[1].split(',');
    const alpha = Number(parts[3]);
    return Number.isFinite(alpha) ? alpha >= 0.99 : true;
  }
  return true;
}

/**
 * A gradient background is a paint Slate has no model for: FSlateBrush can only
 * fill a shape with a single tint or an image. Rather than approximate a
 * linear-gradient with one flat colour (the old behaviour), the element's own
 * background is rasterised into a texture, exactly like a native control part.
 * Returns the gradient function name when the element needs a paint bake.
 */
function gradientPaintOf(rec) {
  const cs = rec.cs || {};
  const image = String(cs.backgroundImage || '');
  if (!image || image === 'none') return null;
  // url() backgrounds already travel through the image-asset path, and a gradient
  // layered under a url() is not worth splitting: bail out and keep the photo.
  if (/url\(/i.test(image)) return null;
  const match = /((?:repeating-)?(?:linear|radial|conic)-gradient)/i.exec(image);
  return match ? match[1].toLowerCase() : null;
}

function bakeTarget(rec) {
  const tag = rec.tag;
  const type = (rec.form && rec.form.type) || '';
  if (tag === 'select') return 'select';
  if (tag === 'progress') return 'progress';
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return 'checkbox';
  if (tag === 'input' && type === 'range') return 'range';
  // A shadow is baked over an EXPANDED rect that also contains the element's own background,
  // so it subsumes a gradient paint on the same element.
  if (shadowOf(rec)) return 'shadow';
  if (gradientPaintOf(rec)) return 'paint';
  if (borderNeedsPaint(rec)) return 'paint';
  return null;
}

/**
 * Growth of the painted footprint caused by the first outer box-shadow, per side
 * [l, t, r, b] in CSS px - or null. Mirrors Mapper#shadowExtentsOf so the bake and the
 * layout agree on how much bigger the texture has to be.
 */
function shadowOf(rec) {
  const cs = rec.cs || {};
  const text = String(cs.boxShadow || '').trim();
  if (!text || text === 'none' || /inset/i.test(text)) return null;
  if (/url\(/i.test(String(cs.backgroundImage || ''))) return null;
  const first = text.split(/,(?![^(]*\))/)[0] || '';
  const lengths = first.match(/-?[\d.]+px/g) || [];
  if (lengths.length < 2) return null;
  const num = (index) => {
    const match = /-?[\d.]+/.exec(lengths[index] || '0');
    return match ? Number(match[0]) : 0;
  };
  const dx = num(0);
  const dy = num(1);
  const blur = num(2);
  const spread = num(3);
  const grow = blur + spread;
  const out = [
    Math.max(0, grow - dx),
    Math.max(0, grow - dy),
    Math.max(0, grow + dx),
    Math.max(0, grow + dy),
  ];
  return out.some((value) => value > 0) ? { extents: out } : null;
}

function effectiveScale(rect, requested, maxEdge, warn, label) {
  let scale = requested;
  const width = Math.max(1, Math.round(rect[2]));
  const height = Math.max(1, Math.round(rect[3]));
  while (scale > 1 && (width * scale > maxEdge || height * scale > maxEdge)) scale /= 2;
  if (width * scale > maxEdge || height * scale > maxEdge) {
    warn(`bake: '${label}' is ${width}x${height}px, larger than --bake-max ${maxEdge}; texture may be oversized`);
  } else if (scale !== requested) {
    warn(`bake: '${label}' reduced bake scale ${requested} -> ${scale} to stay within --bake-max ${maxEdge}`);
  }
  return scale;
}

function roundRect(x, y, width, height) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** Clipped screenshot; `rect` is in CSS px and `scale` is the CDP clip scale. */
async function shot(session, rect, scale) {
  const clip = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    scale: scale || 1,
  };
  return session.screenshot({ format: 'png', clip, captureBeyondViewport: true });
}

/**
 * Bake the native parts of every control in the snapshot.
 * Returns Map<recordIndex, {kind, parts:{...}, imageSize:{...}}>.
 */
async function bakeControls(options) {
  const { session, snapshot, assets, warn } = options;
  const scale = Math.max(1, Math.min(4, options.scale || 2));
  const maxEdge = Math.max(64, options.maxEdge || 2048);
  const output = new Map();

  const targets = snapshot.elements.filter((rec) => bakeTarget(rec));
  if (!targets.length) return output;

  await session.send('DOM.enable').catch(() => {});
  await session.send('CSS.enable').catch(() => {});
  let rootNodeId = 0;
  try {
    const doc = await session.send('DOM.getDocument', { depth: -1 });
    rootNodeId = doc.root ? doc.root.nodeId : 0;
  } catch (err) {
    warn(`bake: DOM.getDocument failed (${err.message}); native controls kept vector styling`);
    return output;
  }

  const originalValues = new Map();

  // The scale a texture was ACTUALLY captured at. effectiveScale() lowers it when a big
  // element would exceed --bake-max, so dividing by the requested scale instead labels the
  // brush with half its real design size (an 1110x120 strip came out as imageSize 555x60).
  let activeScale = scale;

  const register = (baked, label, scaleForSize) => {
    if (!baked) return null;
    if (baked.width > maxEdge || baked.height > maxEdge) {
      warn(`bake: '${label}' texture is ${baked.width}x${baked.height}px, above --bake-max ${maxEdge}`);
    }
    const added = assets.addBuffer(encodePng(baked.width, baked.height, baked.data), 'png', `bake on '${label}'`);
    if (!added) return null;
    const divisor = scaleForSize || activeScale || 1;
    // Design size (CSS px) so the brush draws at the authored size, not at the
    // rasterisation scale.
    added.designWidth = Math.round((baked.width / divisor) * 100) / 100;
    added.designHeight = Math.round((baked.height / divisor) * 100) / 100;
    return added;
  };

  try {
    for (const rec of targets) {
      const kind = bakeTarget(rec);
      const selector = `[data-h2u-idx="${rec.i}"]`;
      const nodeId = rootNodeId ? await queryNodeId(session, rootNodeId, selector) : 0;
      if (!nodeId) {
        warn(`bake: could not resolve the DOM node for '${rec.tag}' #${rec.i}; kept vector styling`);
        continue;
      }
      const rect = rec.rect;
      if (!(rect[2] >= 1) || !(rect[3] >= 1)) {
        warn(`bake: '${rec.tag}' #${rec.i} has no layout box; kept vector styling`);
        continue;
      }
      const label = labelOf(rec);
      const localScale = effectiveScale(rect, scale, maxEdge, warn, label);
      activeScale = localScale;
      // getBoundingClientRect is viewport-relative; Page.captureScreenshot clips are
      // document (page) coordinates, so add the scroll offset captured with the snapshot.
      const scrollX = (snapshot.scroll && snapshot.scroll.x) || 0;
      const scrollY = (snapshot.scroll && snapshot.scroll.y) || 0;
      const baseClip = roundRect(rect[0] + scrollX, rect[1] + scrollY, rect[2], rect[3]);
      const radii = radiusOf(rec);
      const imageSize = [Math.round(rect[2]), Math.round(rect[3])];

      try {
        if (kind === 'select') {
          output.set(rec.i, { kind, parts: await bakeSelect(session, nodeId, rec, baseClip, localScale, radii, register, label, warn, originalValues) });
        } else if (kind === 'checkbox') {
          output.set(rec.i, { kind, parts: await bakeCheckbox(session, nodeId, rec, baseClip, localScale, radii, register, label, warn, originalValues) });
        } else if (kind === 'progress') {
          output.set(rec.i, { kind, parts: await bakeProgress(session, rec, baseClip, localScale, radii, register, label, warn, originalValues) });
        } else if (kind === 'range') {
          output.set(rec.i, { kind, parts: await bakeRange(session, rec, baseClip, localScale, radii, register, label, warn, originalValues) });
        } else if (kind === 'paint') {
          output.set(rec.i, { kind, parts: await bakePaint(session, rec, baseClip, localScale, radii, register, label, warn) });
        } else if (kind === 'shadow') {
          const growth = shadowOf(rec).extents;
          const expanded = roundRect(
            baseClip.x - growth[0],
            baseClip.y - growth[1],
            baseClip.width + growth[0] + growth[2],
            baseClip.height + growth[1] + growth[3]
          );
          output.set(rec.i, { kind, parts: await bakeShadow(session, rec, expanded, localScale, register, label, warn) });
          if (output.get(rec.i)) output.get(rec.i).imageSize = [expanded.width, expanded.height];
        }
      } catch (err) {
        warn(`bake: '${label}' could not be baked (${err.message}); kept vector styling`);
      } finally {
        await setPseudoState(session, nodeId, []).catch(() => {});
        await restore(session, rec, originalValues).catch(() => {});
        await clearCss(session).catch(() => {});
      }
      if (output.get(rec.i)) output.get(rec.i).imageSize = imageSize;
    }
  } finally {
    await clearCss(session).catch(() => {});
  }
  return output;
}

function labelOf(rec) {
  let out = rec.tag || '?';
  if (rec.id) out += `#${rec.id}`;
  return out;
}

function radiusOf(rec) {
  const cs = rec.cs || {};
  const px = (value) => {
    const match = /^(-?[\d.]+)px/.exec(String(value || '0'));
    return match ? parseFloat(match[1]) : 0;
  };
  return [px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius)];
}

async function rememberOriginal(session, rec, store) {
  const selector = `[data-h2u-idx="${rec.i}"]`;
  const state = await session.evaluate(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var selected = el.options ? el.selectedIndex : -1;
      var caption = el.options && el.options[selected] ? el.options[selected].textContent : null;
      return { value: el.value === undefined ? null : String(el.value), checked: !!el.checked, disabled: !!el.disabled,
               selectedIndex: selected, caption: caption };
    })()`,
    { returnByValue: true }
  );
  if (state) store.set(rec.i, state);
}

async function restore(session, rec, store) {
  const state = store.get(rec.i);
  if (!state) return;
  const selector = `[data-h2u-idx="${rec.i}"]`;
  await session.evaluate(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 0;
      el.disabled = ${state.disabled ? 'true' : 'false'};
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = ${state.checked ? 'true' : 'false'};
      if (el.options && ${state.caption === null ? 'false' : 'true'} && el.options[${state.selectedIndex}]) {
        el.options[${state.selectedIndex}].textContent = ${JSON.stringify(state.caption === null ? '' : state.caption)};
        el.selectedIndex = ${state.selectedIndex};
      }
      if (${state.value === null ? 'true' : 'false'}) return 1;
      try { el.value = ${JSON.stringify(state.value)}; } catch (e) { /* ignore */ }
      return 1;
    })()`,
    { returnByValue: true }
  );
  store.delete(rec.i);
}

async function bakeSelect(session, nodeId, rec, clip, scale, radii, register, label, warn, store) {
  await rememberOriginal(session, rec, store);
  // The selected caption must not end up in the texture: UMG draws its own text
  // from ForegroundColor, and baked-in text would double up. The caption is
  // emptied instead of being made transparent, because Chromium paints the native
  // dropdown arrow from the same colour — a transparent caption also erases the
  // caret, which is why the baked select had no arrow.
  await session.evaluate(
    `(function () {
      var el = document.querySelector('[data-h2u-idx="${rec.i}"]');
      if (!el || !el.options || el.selectedIndex < 0) return 0;
      var option = el.options[el.selectedIndex];
      if (option) option.textContent = '';
      return 1;
    })()`,
    { returnByValue: true }
  );
  await settle(session);
  const parts = {};
  const capture = async (name) => {
    const png = await shot(session, clip, scale);
    const decoded = decodePng(png);
    if (!decoded) {
      warn(`bake: could not decode the ${name} screenshot of '${label}'`);
      return null;
    }
    return register(applyRoundedMask(decoded, radii, scale), `${label} ${name}`);
  };

  const normal = await capture('normal');
  if (normal) parts.normal = normal;
  await setPseudoState(session, nodeId, ['hover']);
  await settle(session);
  const hovered = await capture('hover');
  if (hovered) parts.hovered = hovered;
  await setPseudoState(session, nodeId, ['active']);
  await settle(session);
  const pressed = await capture('pressed');
  if (pressed) parts.pressed = pressed;
  await setPseudoState(session, nodeId, []);
  await session.evaluate(
    `(function () { var el = document.querySelector('[data-h2u-idx="${rec.i}"]'); if (el) el.disabled = true; return 1; })()`,
    { returnByValue: true }
  );
  await settle(session);
  const disabled = await capture('disabled');
  if (disabled) parts.disabled = disabled;
  await session.evaluate(
    `(function () { var el = document.querySelector('[data-h2u-idx="${rec.i}"]'); if (el) el.disabled = false; return 1; })()`,
    { returnByValue: true }
  );
  return parts;
}

async function bakeCheckbox(session, nodeId, rec, clip, scale, radii, register, label, warn, store) {
  await rememberOriginal(session, rec, store);
  await clearCss(session);
  await settle(session);
  const parts = {};
  const setChecked = async (checked) => {
    await session.evaluate(
      `(function () { var el = document.querySelector('[data-h2u-idx="${rec.i}"]'); if (el) el.checked = ${checked ? 'true' : 'false'}; return 1; })()`,
      { returnByValue: true }
    );
    await settle(session);
  };
  const capture = async (name) => {
    const png = await shot(session, clip, scale);
    const decoded = decodePng(png);
    if (!decoded) {
      warn(`bake: could not decode the ${name} screenshot of '${label}'`);
      return null;
    }
    // A radio is a circle; a checkbox is a rounded rectangle when the author gave
    // it a radius and a plain rectangle otherwise. Falling back to a circular mask
    // for a radius-less checkbox clipped every oblong box into an ellipse, which is
    // what made the imported check image stop being rectangular.
    const isRadio = ((rec.form && rec.form.type) || '').toLowerCase() === 'radio';
    let masked;
    if (radii.some((value) => value > 0)) masked = applyRoundedMask(decoded, radii, scale);
    else if (isRadio) masked = applyCircleMask(decoded);
    else masked = decoded;
    return register(masked, `${label} ${name}`);
  };

  await setChecked(false);
  const unchecked = await capture('unchecked');
  if (unchecked) parts.unchecked = unchecked;
  await setPseudoState(session, nodeId, ['hover']);
  await settle(session);
  const uncheckedHover = await capture('unchecked-hover');
  if (uncheckedHover) parts.uncheckedHovered = uncheckedHover;
  await setPseudoState(session, nodeId, []);
  await setChecked(true);
  const checked = await capture('checked');
  if (checked) parts.checked = checked;
  await setPseudoState(session, nodeId, ['hover']);
  await settle(session);
  const checkedHover = await capture('checked-hover');
  if (checkedHover) parts.checkedHovered = checkedHover;
  await setPseudoState(session, nodeId, []);
  return parts;
}

async function bakeProgress(session, rec, clip, scale, radii, register, label, warn, store) {
  await rememberOriginal(session, rec, store);
  const parts = {};
  // Track: hide the fill.
  await injectCss(session, `[data-h2u-idx="${rec.i}"]::-webkit-progress-value { opacity: 0 !important; }`);
  await settle(session);
  const trackPng = await shot(session, clip, scale);
  const trackImage = decodePng(trackPng);
  if (trackImage) {
    const added = register(applyRoundedMask(trackImage, radii, scale), `${label} track`);
    if (added) parts.track = added;
  } else {
    warn(`bake: could not decode the progress track of '${label}'`);
  }

  // Fill: run to 100% with everything visible so the texture is the authored fill
  // colour (UMG clips FillImage to Percent at runtime) and lift it off the track by
  // difference. Hiding ::-webkit-progress-bar here captured the element's own
  // background instead of the fill, so no colour from the value ever reached it.
  const max = Number(rec.form && rec.form.max) || 1;
  await injectCss(session, `[data-h2u-idx="${rec.i}"]::-webkit-progress-value { opacity: 1 !important; }`);
  await session.evaluate(
    `(function () { var el = document.querySelector('[data-h2u-idx="${rec.i}"]'); if (el) el.value = ${max}; return 1; })()`,
    { returnByValue: true }
  );
  await settle(session);
  const fillPng = await shot(session, clip, scale);
  const fillImage = decodePng(fillPng);
  if (fillImage) {
    // Lift the fill off its own background: pixels that did not change belong to
    // the track, so they become transparent and the corners stay clean.
    const lifted = trackImage ? maskByDifference(fillImage, trackImage) : fillImage;
    const masked = applyRoundedMask(lifted, radii, scale);
    const added = register(masked, `${label} fill`);
    if (added) parts.fill = added;
  } else {
    warn(`bake: could not decode the progress fill of '${label}'`);
  }
  await clearCss(session);
  await restore(session, rec, store);
  return parts;
}

/**
 * Rasterise just this element's own background paint (a CSS gradient) into a texture.
 *
 * Children are hidden first, so what lands in the texture is the background and the
 * border only - the element's TextBlock/child widgets are drawn by UMG on top, and if
 * they were baked in they would be painted twice. The corners are masked with the
 * element's border-radius, which also makes the texture carry the rounded shape, so the
 * brush needs no corner radii of its own.
 */
async function bakePaint(session, rec, clip, scale, radii, register, label, warn) {
  const selector = `[data-h2u-idx="${rec.i}"]`;
  // Every direct child is a separate UMG widget (text runs included).
  await injectCss(session, `${selector} > * { visibility: hidden !important; }`);
  await settle(session);

  const png = await shot(session, clip, scale);
  const decoded = decodePng(png);
  if (!decoded) {
    warn(`bake: could not decode the gradient paint of '${label}'`);
    return null;
  }
  const shaped = radii && radii.some((value) => value > 0)
    ? applyRoundedMask(decoded, radii, scale)
    : decoded;
  const added = register(shaped, `${label} paint`);
  return added ? { paint: added } : null;
}
/**
 * Bake an element WITH its box-shadow, over the rect expanded by the shadow footprint.
 *
 * The shadow fades into whatever is behind it, so the texture has to be captured over the
 * expanded rect: there is no Slate brush that can paint a blurred outline. Children are hidden
 * (they are separate widgets), and no rounded mask is applied - the outer silhouette here is the
 * shadow, not the element's own rounded box.
 */
async function bakeShadow(session, rec, clip, scale, register, label, warn) {
  const selector = `[data-h2u-idx="${rec.i}"]`;
  await injectCss(session, `${selector} > * { visibility: hidden !important; }`);
  await settle(session);
  const png = await shot(session, clip, scale);
  const decoded = decodePng(png);
  if (!decoded) {
    warn(`bake: could not decode the box-shadow paint of '${label}'`);
    return null;
  }
  const added = register(decoded, `${label} shadow`);
  return added ? { shadow: added } : null;
}
async function bakeRange(session, rec, clip, scale, radii, register, label, warn, store) {
  await rememberOriginal(session, rec, store);
  const parts = {};
  const width = Math.round(rec.rect[2]);
  const height = Math.round(rec.rect[3]);

  // 1. Track: hide the thumb.
  await injectCss(session, `[data-h2u-idx="${rec.i}"]::-webkit-slider-thumb { opacity: 0 !important; }`);
  await settle(session);
  const trackPng = await shot(session, clip, scale);
  const trackImage = decodePng(trackPng);
  if (trackImage) {
    const added = register(applyRoundedMask(trackImage, radii, scale), `${label} track`);
    if (added) parts.track = added;
  } else {
    warn(`bake: could not decode the slider track of '${label}'`);
  }

  // 2. Locate the thumb: the slider is rendered at min and at max with the thumb
  // visible; the per-position diff against the track isolates it. The clip is
  // padded because a thumb is usually taller than the track box.
  const pad = Math.max(12, height * 2);
  const paddedClip = roundRect(rec.rect[0] - pad, rec.rect[1] - pad, width + pad * 2, height + pad * 2);
  await clearCss(session);
  const setValue = async (value) => {
    await session.evaluate(
      `(function () { var el = document.querySelector('[data-h2u-idx="${rec.i}"]'); if (el) el.value = ${value}; return 1; })()`,
      { returnByValue: true }
    );
    await settle(session);
  };
  await setValue(0);
  const atMin = decodePng(await shot(session, paddedClip, scale));
  const min = Number(rec.form && rec.form.min);
  const max = Number(rec.form && rec.form.max);
  await setValue(Number.isFinite(max) ? max : 100);
  const atMax = decodePng(await shot(session, paddedClip, scale));

  if (trackImage && atMin && atMax) {
    // Compare the padded captures against each other: only the thumb moved.
    const moved = diffBox(atMin, atMax);
    if (moved && moved.width > 1 && moved.height > 1) {
      // Thumb footprint at the minimum position: diff the padded min capture
      // against a thumb-less padded capture.
      await injectCss(session, `[data-h2u-idx="${rec.i}"]::-webkit-slider-thumb { opacity: 0 !important; }`);
      await setValue(Number.isFinite(min) ? min : 0);
      const paddedTrack = decodePng(await shot(session, paddedClip, scale));
      await clearCss(session);
      const box = paddedTrack ? diffBox(paddedTrack, atMin) : null;
      const footprint = box || moved;
      const thumbClip = roundRect(
        paddedClip.x + footprint.x / scale,
        paddedClip.y + footprint.y / scale,
        footprint.width / scale,
        footprint.height / scale
      );
      const thumbPng = await shot(session, thumbClip, scale);
      const thumbImage = decodePng(thumbPng);
      if (thumbImage) {
        // A round thumb is masked to a circle; a square one keeps its corners.
        const near = Math.abs(footprint.width - footprint.height) <= Math.max(2, footprint.height * 0.08);
        const added = register(near ? applyCircleMask(thumbImage) : thumbImage, `${label} thumb`);
        if (added) parts.thumb = added;
      } else {
        warn(`bake: could not decode the slider thumb of '${label}'; kept vector approximation`);
      }
    } else {
      warn(`bake: could not isolate the slider thumb on '${label}'; kept vector approximation`);
    }
  } else {
    warn(`bake: could not isolate the slider thumb on '${label}'; kept vector approximation`);
  }
  await clearCss(session);
  await restore(session, rec, store);
  return parts;
}

module.exports = {
  bakeControls,
  bakeTarget,
  decodePng,
  encodePng,
  crop,
  diffBox,
  opaqueBox,
  maskByDifference,
  applyRoundedMask,
  applyCircleMask,
  effectiveScale,
};