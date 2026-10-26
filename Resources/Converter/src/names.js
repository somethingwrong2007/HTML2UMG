// Copyright (c) 2026 FPVSkyline. MIT License.
// Widget naming: data-ue-name > id > class > tag, made unique and legal.
// Must agree with Html2UMG::SanitizeWidgetName / MakeUniqueNames on the C++ side.
'use strict';

const LEGAL_RE = /[^A-Za-z0-9_]/g;

/**
 * Turn arbitrary text into a legal UMG widget identifier.
 * "hud-top-left" -> "HudTopLeft", "3d_marker" -> "W3dMarker", "" -> "Widget".
 * Mirrors Html2UMG::SanitizeWidgetName's guarantees (legal, non-empty, no
 * leading digit, no trailing underscore) while producing PascalCase for legibility.
 */
function toIdentifier(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  // "@2x" style decorations and CSS-ish prefixes are not identifiers.
  s = s.replace(/^\s*(?:[.#])/, '');
  const tokens = s.split(/[^A-Za-z0-9]+/).filter((t) => t.length > 0);
  let out = '';
  for (const token of tokens) {
    if (/^[0-9]/.test(token)) {
      out += token;
    } else if (/^[A-Z0-9]{2,4}$/.test(token)) {
      // Keep acronyms like HUD / WBP / FPS readable.
      out += token;
    } else if (/[a-z]/.test(token[0]) && /[A-Z]/.test(token.slice(1))) {
      // camelCase authored by the designer: only capitalise the first letter.
      out += token[0].toUpperCase() + token.slice(1);
    } else {
      out += token[0].toUpperCase() + token.slice(1);
    }
  }
  return sanitize(out);
}

/** Final guard, applied after suffixing as well. */
function sanitize(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).replace(LEGAL_RE, '_');
  s = s.replace(/_+/g, '_');
  s = s.replace(/^_+/, '');
  s = s.replace(/_+$/, '');
  if (!s) return 'Widget';
  if (/^[0-9]/.test(s)) s = 'W' + s;
  return s;
}

/**
 * Derive a base name from a snapshot record, honouring the documented priority
 * chain and the data-ue-name override.
 */
function baseName(rec) {
  // The snapshot stores control attributes in `ue`; `dataUe` is accepted too so
  // callers can hand-hand a record without knowing the wire format.
  const ue = rec.ue || rec.dataUe || {};
  if (ue.name) {
    const n = toIdentifier(ue.name);
    if (n) return n;
  }
  if (rec.id) {
    const n = toIdentifier(rec.id);
    if (n) return n;
  }
  if (rec.cls && rec.cls.length) {
    // Use the first *semantic* class; state classes are not identity.
    for (const cls of rec.cls) {
      if (isStateClass(cls)) continue;
      const n = toIdentifier(cls);
      if (n) return n;
    }
  }
  return toIdentifier(rec.tag || 'Widget') || 'Widget';
}

const STATE_CLASS_RE = /^(?:is-|has-|active$|selected$|hover|focus|open$|disabled$|hidden$|visible$|show$|hide$)/i;
function isStateClass(cls) {
  return STATE_CLASS_RE.test(cls);
}

/**
 * Whole-tree name registry: guarantees uniqueness with _1/_2 suffixes.
 * Uniqueness is checked case-insensitively because UE compares FName (and thus
 * blueprint variable names / BindWidget matches) without case.
 */
class NameRegistry {
  constructor() {
    this.used = new Map(); // lowercase name -> next suffix to try
  }

  /** Reserve an exact name (used for the root / blueprint-derived names). */
  reserve(name) {
    return this.unique(name);
  }

  unique(base) {
    const clean = sanitize(base);
    const key = clean.toLowerCase();
    const seen = this.used.get(key) || 0;
    if (seen === 0) {
      this.used.set(key, 1);
      return clean;
    }
    let suffix = seen;
    let candidate = `${clean}_${suffix}`;
    while (this.used.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${clean}_${suffix}`;
    }
    this.used.set(key, suffix + 1);
    this.used.set(candidate.toLowerCase(), 1);
    return candidate;
  }

  /**
   * Reserve the element's base name and, at the same time, a consistent set of
   * synthetic wrapper names derived from it (so "Card" yields Card_Size/Card_BG
   * /Card_Content without colliding with another element literally named Card_BG).
   */
  family(base, suffixes) {
    const root = this.unique(base);
    const out = { root };
    for (const suffix of suffixes) {
      out[suffix] = this.unique(`${root}_${suffix}`);
    }
    return out;
  }

  has(name) {
    return this.used.has(sanitize(name).toLowerCase());
  }
}

/** "/Game/UI/WBP_Design" default from an input file name. */
function defaultBlueprintName(inputPath) {
  const file = String(inputPath || '').replace(/\\/g, '/').split('/').pop() || 'design';
  const stem = file.replace(/\.[^.]+$/, '');
  // "01-flex" -> "Flex": numeric ordering prefixes are not part of the name.
  const semantic = stem
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token))
    .join('-');
  const id = toIdentifier(semantic || stem) || 'Design';
  return `/Game/UI/WBP_${id}`;
}

module.exports = { toIdentifier, sanitize, baseName, NameRegistry, defaultBlueprintName, isStateClass };
