'use strict';

/**
 * layout.json -> Slate C++ source.
 *
 * The UMG path bakes colour changes into textures: a button's hover/pressed colours, a checkbox's
 * track and knob, a gradient. Slate does not need that, because Slate draws from FSlateBrush values
 * that are CONSTRUCTED IN CODE. The layout JSON already holds exactly those values - brush.tint,
 * cornerRadii, outlineWidth, WidgetStyle.Normal/Hovered/Pressed are FSlateBrush fields - so this
 * emitter writes them as C++ expressions instead of loading a PNG.
 *
 * Real design images (an <img>, a background-image) stay textures and are referenced by their UObject
 * path from the layout's asset list.
 *
 * Two JSON dialects are accepted, because the tool emits both: the converter writes nested objects
 * (properties.Font.Size) and the WBP exporter writes dotted keys ('Font.Size'). Every read goes
 * through pget(), which tries the dotted key first and then walks the nested path.
 */

const ALIGN_H = { Left: 'HAlign_Left', Center: 'HAlign_Center', Right: 'HAlign_Right', Fill: 'HAlign_Fill' };
const ALIGN_V = { Top: 'VAlign_Top', Center: 'VAlign_Center', Bottom: 'VAlign_Bottom', Fill: 'VAlign_Fill' };
const JUSTIFY = { Left: 'ETextJustify::Left', Center: 'ETextJustify::Center', Right: 'ETextJustify::Right' };

function f(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.f';
  const rounded = Math.round(n * 10000) / 10000;
  return (Number.isInteger(rounded) ? rounded + '.0' : String(rounded)) + 'f';
}

function lc(c) {
  const a = Array.isArray(c) ? c : [1, 1, 1, 1];
  return 'FLinearColor(' + f(a[0]) + ', ' + f(a[1]) + ', ' + f(a[2]) + ', ' + f(a[3]) + ')';
}

function txt(s) { return 'TEXT(' + JSON.stringify(String(s)) + ')'; }
function str(s) { return JSON.stringify(String(s)); }

function warn(list, message) {
  if (list.indexOf(message) < 0) list.push(message);
}

/** Read a property written either as a nested object or as a dotted key. */
function pget(props, dotted) {
  if (!props) return undefined;
  if (Object.prototype.hasOwnProperty.call(props, dotted)) return props[dotted];
  const parts = String(dotted).split('.');
  let cur = props;
  for (let i = 0; i < parts.length; i += 1) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/** Normalise the two brush shapes into one. */
function normBrush(b) {
  if (!b || typeof b !== 'object') return null;
  const tint = b.tint || b.TintColor;
  if (!Array.isArray(tint)) return null;
  const radii = b.cornerRadii || (b.OutlineSettings && b.OutlineSettings.CornerRadii) || [0, 0, 0, 0];
  return {
    tint: tint,
    radii: Array.isArray(radii) ? radii : [0, 0, 0, 0],
    outlineWidth: Number(b.outlineWidth || (b.OutlineSettings && b.OutlineSettings.Width) || 0),
    outlineColor: b.outlineColor || (b.OutlineSettings && b.OutlineSettings.Color) || [0, 0, 0, 0],
    texture: b.texture || b.ResourceObject || null,
  };
}

/** Brush stored under props[base], in either dialect. */
function propsBrush(props, base) {
  const direct = pget(props, base);
  if (direct && typeof direct === 'object') return normBrush(direct);
  const flat = {
    TintColor: pget(props, base + '.TintColor'),
    DrawAs: pget(props, base + '.DrawAs'),
    OutlineSettings: pget(props, base + '.OutlineSettings.CornerRadii') !== undefined
      ? {
        CornerRadii: pget(props, base + '.OutlineSettings.CornerRadii'),
        Width: pget(props, base + '.OutlineSettings.Width'),
        Color: pget(props, base + '.OutlineSettings.Color'),
      }
      : undefined,
    ResourceObject: pget(props, base + '.ResourceObject'),
  };
  return normBrush(flat);
}

module.exports = { pget, normBrush, propsBrush, f, lc, txt, str, warn, ALIGN_H, ALIGN_V, JUSTIFY };