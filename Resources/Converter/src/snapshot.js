// Copyright (c) 2026 FPVSkyline. MIT License.
// DOM snapshot: one Runtime.evaluate round trip that flattens the whole document
// into an array of plain records (geometry + computed style + declared style).
'use strict';

/**
 * This function is stringified and evaluated *inside* the page, so it must not
 * reference anything from the Node scope (no requires, no closures).
 * `opts`: { pseudo: bool, declared: bool, maxElements: number, width, height }
 */
function pageSnapshot(opts) {
  'use strict';

  var STYLE_PROPS = [
    'display', 'position', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems',
    'alignSelf', 'alignContent', 'gap', 'rowGap', 'columnGap', 'order',
    'flexGrow', 'flexShrink', 'flexBasis',
    'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundRepeat', 'backgroundPosition',
    'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
    'textAlign', 'textTransform', 'textDecorationLine', 'whiteSpace', 'textOverflow', 'wordBreak',
    'overflowX', 'overflowY', 'zIndex', 'opacity', 'visibility',
    'boxShadow', 'filter', 'backdropFilter', 'transform', 'mixBlendMode', 'clipPath', 'maskImage',
    'outlineWidth', 'textShadow', 'objectFit', 'objectPosition', 'listStyleType', 'direction',
    'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'gridColumnStart', 'gridRowStart',
    'boxSizing'
  ];

  // Values that carry no information for the converter; pruning keeps the
  // snapshot small and the JSON diffable.
  var PRUNE = {
    flexGrow: '0', flexShrink: '1', flexBasis: 'auto', order: '0', flexWrap: 'nowrap',
    justifyContent: 'normal', alignItems: 'normal', alignSelf: 'auto', alignContent: 'normal',
    gap: 'normal', rowGap: 'normal', columnGap: 'normal',
    minWidth: 'auto', minHeight: 'auto', maxWidth: 'none', maxHeight: 'none',
    marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
    borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
    borderTopColor: 'rgba(0, 0, 0, 0)', borderRightColor: 'rgba(0, 0, 0, 0)',
    borderBottomColor: 'rgba(0, 0, 0, 0)', borderLeftColor: 'rgba(0, 0, 0, 0)',
    borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
    backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: '0% 0%',
    letterSpacing: 'normal', lineHeight: 'normal', textOverflow: 'clip',
    textDecorationLine: 'none', textTransform: 'none', whiteSpace: 'normal', wordBreak: 'normal',
    overflowX: 'visible', overflowY: 'visible', zIndex: 'auto', opacity: '1', visibility: 'visible',
    boxShadow: 'none', filter: 'none', backdropFilter: 'none', transform: 'none',
    mixBlendMode: 'normal', clipPath: 'none', maskImage: 'none', outlineWidth: '0px',
    textShadow: 'none', objectFit: 'fill', objectPosition: '50% 50%',
    listStyleType: 'disc', direction: 'ltr',
    gridTemplateColumns: 'none', gridTemplateRows: 'none', gridAutoFlow: 'row',
    gridColumnStart: 'auto', gridRowStart: 'auto'
  };

  var SKIP_TAGS = {
    script: 1, style: 1, link: 1, meta: 1, title: 1, head: 1, base: 1,
    noscript: 1, template: 1,
    // <option>/<optgroup> are not layout boxes; their colours are collected on the
    // owning <select> (see captureControl) instead of becoming widgets.
    option: 1, optgroup: 1, datalist: 1
  };

  // Only the declarations the mapper actually reasons about are kept, so the
  // snapshot stays small and immune to injected/noise rules.
  var DECL_KEEP = {
    display: 1, position: 1,
    top: 1, right: 1, bottom: 1, left: 1,
    inset: 1, 'inset-block': 1, 'inset-inline': 1,
    width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1,
    'aspect-ratio': 1, 'box-sizing': 1,
    flex: 1, 'flex-grow': 1, 'flex-shrink': 1, 'flex-basis': 1, order: 1, 'align-self': 1,
    'justify-self': 1,
    gap: 1, 'row-gap': 1, 'column-gap': 1,
    'grid-template-columns': 1, 'grid-template-rows': 1, 'grid-auto-flow': 1,
    'grid-column': 1, 'grid-row': 1, 'grid-column-start': 1, 'grid-column-end': 1,
    'grid-row-start': 1, 'grid-row-end': 1,
    overflow: 1, 'overflow-x': 1, 'overflow-y': 1,
    'white-space': 1, 'text-wrap': 1,
    // Visual declarations are kept too: native form controls ignore some of them
    // (a checkbox drops background/border unless appearance:none), so the design
    // intent can only be recovered from what was *declared*, not what was painted.
    background: 1, 'background-color': 1, 'background-image': 1,
    color: 1, opacity: 1, 'accent-color': 1, appearance: 1,
    border: 1, 'border-width': 1, 'border-style': 1, 'border-color': 1,
    'border-top': 1, 'border-right': 1, 'border-bottom': 1, 'border-left': 1,
    'border-top-width': 1, 'border-right-width': 1, 'border-bottom-width': 1, 'border-left-width': 1,
    'border-top-color': 1, 'border-right-color': 1, 'border-bottom-color': 1, 'border-left-color': 1,
    'border-top-style': 1, 'border-right-style': 1, 'border-bottom-style': 1, 'border-left-style': 1,
    'border-radius': 1, 'border-top-left-radius': 1, 'border-top-right-radius': 1,
    'border-bottom-right-radius': 1, 'border-bottom-left-radius': 1,
    padding: 1, 'padding-top': 1, 'padding-right': 1, 'padding-bottom': 1, 'padding-left': 1
  };

  var normWs = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  };

  // ---------------------------------------------------------------- CSS rules
  // We need to know which properties were actually *declared* (not merely
  // resolved by the engine) to decide "fixed size" vs "filled by parent".
  var ruleIndex = [];
  // Rules that only apply in an interaction state are indexed separately, because the layout
  // whitelist above deliberately keeps sizing/positioning properties only - a ":hover" rule
  // that just changes a colour would be dropped entirely by it.
  var stateRuleIndex = [];
  var STATE_DECL_KEEP = {
    background: 1, 'background-color': 1,
    border: 1, 'border-color': 1, 'border-width': 1, 'border-style': 1, 'border-radius': 1,
    'border-top': 1, 'border-right': 1, 'border-bottom': 1, 'border-left': 1,
    'border-top-color': 1, 'border-right-color': 1, 'border-bottom-color': 1, 'border-left-color': 1,
    'border-top-width': 1, 'border-right-width': 1, 'border-bottom-width': 1, 'border-left-width': 1,
    'border-top-style': 1, 'border-right-style': 1, 'border-bottom-style': 1, 'border-left-style': 1,
    'outline-color': 1, opacity: 1, color: 1, 'accent-color': 1, 'background-image': 1
  };
  var STATE_PSEUDO = /:(hover|active|disabled|focus|focus-within|focus-visible|checked)|:nth-child\((?:odd|even)\)|:nth-of-type\((?:odd|even)\)|:first-child|:last-child/i;
  // Every style rule, with its state pseudo-classes split off (`stem` + `suffix`),
  // so control skins can be resolved for elements that are not in the document
  // (a dropdown row that only exists as CSS) as well as for real ones.
  var allRules = [];
  // Selector text is normalised by the CSSOM (`:nth-child(odd)` comes back as
  // `:nth-child(2n+1)`), so parity must be parsed as an An+B expression.
  var STATE_SUFFIX_RE = /(:hover|:active|:focus-within|:focus-visible|:focus|:checked|:disabled|:nth-child\([^)]*\)|:nth-of-type\([^)]*\)|:first-child|:last-child|\.selected|\.is-selected|\[aria-selected(?:=(?:"true"|'true'|true))?\])$/i;
  var ruleOrder = 0;
  var inaccessibleSheets = 0;
  var fontFaces = [];

  var specificityOf = function (selector) {
    var ids = (selector.match(/#[-\w]+/g) || []).length;
    var classes = (selector.match(/\.[-\w]+/g) || []).length;
    var attrs = (selector.match(/\[[^\]]+\]/g) || []).length;
    var pseudos = (selector.match(/:(?!:)[-\w]+(\([^{}]*\))?/g) || []).length;
    var rest = selector
      .replace(/#[-\w]+/g, ' ')
      .replace(/\.[-\w]+/g, ' ')
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/:(?!:)[-\w]+(\([^{}]*\))?/g, ' ');
    var types = (rest.match(/[A-Za-z][-\w]*/g) || []).length;
    return ids * 1000000 + (classes + attrs + pseudos) * 1000 + types;
  };

  var splitSelectors = function (text) {
    var parts = [];
    var depth = 0;
    var cur = '';
    for (var i = 0; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  };

  var addRule = function (selectorText, style, active) {
    if (!active || !selectorText || !style || !style.length) return;
    var parts = splitSelectors(selectorText);
    for (var i = 0; i < parts.length; i += 1) {
      var sel = parts[i].trim();
      if (!sel) continue;
      // Pseudo-element selectors never match an element node.
      if (/(::?(before|after|first-line|first-letter|selection|placeholder|marker|backdrop))\b/i.test(sel)) continue;
      var props = Object.create(null);
      var stateProps = Object.create(null);
      var isStateSelector = STATE_PSEUDO.test(sel);
      for (var j = 0; j < style.length; j += 1) {
        var name = style.item(j);
        var value = style.getPropertyValue(name);
        if (!value) continue;
        value = value.trim();
        if (DECL_KEEP[name]) props[name] = value;
        if (isStateSelector && STATE_DECL_KEEP[name]) stateProps[name] = value;
      }
      if (Object.keys(props).length) {
        ruleIndex.push({ selector: sel, spec: specificityOf(sel), order: (ruleOrder += 1), props: props });
      }
      if (Object.keys(stateProps).length) {
        stateRuleIndex.push({ selector: sel, spec: specificityOf(sel), order: (ruleOrder += 1), props: stateProps });
      }
      // Full visual declaration set + split stem/suffix, for control skins.
      var allProps = Object.create(null);
      var allCount = 0;
      for (var k = 0; k < style.length; k += 1) {
        var allName = style.item(k);
        var allValue = style.getPropertyValue(allName);
        if (!allValue) continue;
        allProps[allName] = allValue.trim();
        allCount += 1;
      }
      if (allCount) {
        var suffix = '';
        var stem = sel;
        var suffixMatch = STATE_SUFFIX_RE.exec(stem);
        if (suffixMatch) {
          suffix = suffixMatch[1].toLowerCase();
          stem = stem.slice(0, stem.length - suffixMatch[1].length).trim();
        }
        allRules.push({
          selector: sel,
          stem: stem,
          suffix: suffix,
          spec: specificityOf(sel),
          order: (ruleOrder += 1),
          props: allProps
        });
      }
    }
  };

  /**
   * 'even' | 'odd' when a zebra rule actually applies to this element, else null.
   * Decided by testing whether the An+B expression covers index 2.
   */
  var parityOf = function (el) {
    for (var i = 0; i < allRules.length; i += 1) {
      var rule = allRules[i];
      if (!rule.suffix) continue;
      if (!/:nth-child|:nth-of-type|:first-child|:last-child/.test(rule.suffix)) continue;
      var ok = false;
      try {
        ok = el.matches(rule.stem);
      } catch (err) {
        ok = false;
      }
      if (!ok || !parityMatches(el, rule.suffix)) continue;
      var nth = /:nth-child\(([^)]*)\)/.exec(rule.suffix);
      if (nth) return matchesAnB(2, nth[1]) ? 'even' : 'odd';
      return 'odd';
    }
    return null;
  };

  var safeRules = function (sheetOrRule) {
    try {
      return sheetOrRule.cssRules || null;
    } catch (err) {
      inaccessibleSheets += 1;
      return null;
    }
  };

  var readFontFace = function (rule) {
    try {
      var style = rule.style;
      var family = (style.getPropertyValue('font-family') || '').replace(/['"]/g, '').trim();
      if (!family) return;
      fontFaces.push({
        family: family,
        weight: (style.getPropertyValue('font-weight') || '400').trim(),
        style: (style.getPropertyValue('font-style') || 'normal').trim(),
        src: (style.getPropertyValue('src') || '').trim()
      });
    } catch (err) {
      /* ignore */
    }
  };

  var walkRuleList = function (list, active) {
    if (!list) return;
    for (var i = 0; i < list.length; i += 1) {
      var rule = list[i];
      try {
        var type = rule.type;
        if (type === 1) {
          addRule(rule.selectorText, rule.style, active);
        } else if (type === 3) {
          if (rule.styleSheet) walkRuleList(safeRules(rule.styleSheet), active);
        } else if (type === 5) {
          if (active) readFontFace(rule);
        } else if (rule.cssRules) {
          var ok = active;
          try {
            if (rule.media && rule.media.mediaText) {
              ok = active && window.matchMedia(rule.media.mediaText).matches;
            } else if (rule.conditionText) {
              var kind = rule.constructor && rule.constructor.name;
              if (kind === 'CSSSupportsRule') ok = active && !!(window.CSS && CSS.supports(rule.conditionText));
              else if (kind === 'CSSMediaRule') ok = active && window.matchMedia(rule.conditionText).matches;
            }
          } catch (err) {
            ok = active;
          }
          walkRuleList(safeRules(rule), ok);
        }
      } catch (err) {
        /* ignore malformed rules */
      }
    }
  };

  (function buildRuleIndex() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i += 1) {
      var sheet = sheets[i];
      // The stabilisation sheet injected by the converter is not design intent.
      try {
        if (sheet.ownerNode && sheet.ownerNode.id === '__html2umg_stabilize__') continue;
      } catch (err) {
        /* ignore */
      }
      var rules = safeRules(sheet);
      if (!rules) continue;
      walkRuleList(rules, true);
    }
  })();

  // Resolve declared properties per element. querySelectorAll is used once per
  // rule (native, fast) instead of matching every rule against every element.
  var declaredMap = new Map();
  if (opts.declared !== false) {
    for (var ri = 0; ri < ruleIndex.length; ri += 1) {
      var rule = ruleIndex[ri];
      var nodes;
      try {
        nodes = document.querySelectorAll(rule.selector);
      } catch (err) {
        continue;
      }
      for (var ni = 0; ni < nodes.length; ni += 1) {
        var elRef = nodes[ni];
        var bucket = declaredMap.get(elRef);
        if (!bucket) {
          bucket = Object.create(null);
          declaredMap.set(elRef, bucket);
        }
        for (var prop in rule.props) {
          var prev = bucket[prop];
          if (!prev || rule.spec > prev.spec || (rule.spec === prev.spec && rule.order > prev.order)) {
            bucket[prop] = { spec: rule.spec, order: rule.order, value: rule.props[prop] };
          }
        }
      }
    }
  }

  var declaredFor = function (el) {
    var out = Object.create(null);
    var bucket = declaredMap.get(el);
    if (bucket) {
      for (var prop in bucket) out[prop] = bucket[prop].value;
    }
    // Inline style is the designer's direct intent: always wins.
    var inline = el.style;
    if (inline && inline.length) {
      for (var i = 0; i < inline.length; i += 1) {
        var name = inline.item(i);
        var value = inline.getPropertyValue(name);
        if (value) out[name] = value.trim();
      }
    }
    return out;
  };

  /**
   * Declarations from rules that only apply in an interaction state (:hover, :active,
   * :disabled). Slate can express those as UButton brush states, so they are worth carrying
   * across; a single computed snapshot cannot see them.
   */
  var stateDeclaredFor = function (el, pseudo) {
    var hits = [];
    for (var i = 0; i < stateRuleIndex.length; i += 1) {
      var rule = stateRuleIndex[i];
      if (rule.selector.indexOf(pseudo) < 0) continue;
      // ":hover .child" still would not style this element, so drop the pseudo and match the
      // remainder; selectors that reduce to nothing (plain ":hover") are skipped.
      var base = rule.selector.split(pseudo).join('').trim();
      if (!base) continue;
      var ok = false;
      try {
        ok = el.matches(base);
      } catch (err) {
        ok = false;
      }
      if (ok) hits.push(rule);
    }
    if (!hits.length) return null;
    // Lower specificity first so the winner is applied last.
    hits.sort(function (a, b) { return a.spec - b.spec || a.order - b.order; });
    var out = Object.create(null);
    var count = 0;
    for (var h = 0; h < hits.length; h += 1) {
      for (var prop in hits[h].props) {
        out[prop] = hits[h].props[prop];
        count += 1;
      }
    }
    return count ? out : null;
  };

  // ------------------------------------------------------- visual resolution
  // Native form controls ignore a lot of author CSS (a checkbox drops background
  // and border unless appearance:none), and state rules (:hover, :checked) never
  // apply to a plain snapshot. Both are recovered by replaying the *declared*
  // declarations onto a throwaway absolutely positioned probe that inherits the
  // same custom properties, then reading the resolved values back.
  var VISUAL_PROPS = [
    'backgroundColor', 'backgroundImage', 'color', 'opacity', 'accentColor',
    'fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'letterSpacing', 'lineHeight', 'textAlign',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
  ];

  var pickVisual = function (cs) {
    var out = {};
    for (var i = 0; i < VISUAL_PROPS.length; i += 1) {
      var prop = VISUAL_PROPS[i];
      var value = cs[prop];
      if (value === undefined || value === null || value === '') continue;
      out[prop] = value;
    }
    return out;
  };

  /** Does this resolved visual paint anything? (used to reject empty pseudo styles) */
  var paints = function (visual) {
    if (!visual) return false;
    var bg = visual.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
    if (visual.backgroundImage && visual.backgroundImage !== 'none') return true;
    var sides = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
    for (var i = 0; i < sides.length; i += 1) {
      var w = parseFloat(visual[sides[i]] || '0');
      if (w > 0) return true;
    }
    return false;
  };

  /** Replay an ordered declaration list onto a probe and read the visual back. */
  var visualOf = function (decls, anchorEl) {
    var list = [];
    if (decls) {
      for (var d = 0; d < decls.length; d += 1) if (decls[d]) list.push(decls[d]);
    }
    if (!list.length) return null;
    var parent = (anchorEl && anchorEl.parentNode) || document.body || document.documentElement;
    var probe = document.createElement('div');
    probe.setAttribute('data-html2umg-probe', '1');
    // position:absolute keeps it out of flow, so probing cannot disturb layout.
    probe.style.cssText =
      'position:absolute;left:-99999px;top:0;width:0;height:0;min-width:0;min-height:0;' +
      'margin:0;padding:0;pointer-events:none;visibility:hidden;';
    if (anchorEl && anchorEl.nextSibling) parent.insertBefore(probe, anchorEl.nextSibling);
    else parent.appendChild(probe);
    for (var l = 0; l < list.length; l += 1) {
      for (var key in list[l]) {
        try {
          probe.style.setProperty(key, list[l][key]);
        } catch (err) {
          /* ignore unsupported declaration */
        }
      }
    }
    var out = pickVisual(window.getComputedStyle(probe));
    if (probe.parentNode) probe.parentNode.removeChild(probe);
    return out;
  };

  /** An+B matcher for :nth-child()/:nth-of-type() (`odd` -> `2n+1` in the CSSOM). */
  var matchesAnB = function (index, expr) {
    var text = String(expr === undefined ? '' : expr).trim().toLowerCase();
    if (text === 'odd') return index % 2 === 1;
    if (text === 'even') return index % 2 === 0;
    var exprMatch = /^([+-]?\d*)n\s*(?:([+-])\s*(\d+))?$/.exec(text);
    if (exprMatch) {
      var step = exprMatch[1] === '' || exprMatch[1] === '+' ? 1 : (exprMatch[1] === '-' ? -1 : parseInt(exprMatch[1], 10));
      var offset = exprMatch[2] ? (exprMatch[2] === '-' ? -parseInt(exprMatch[3], 10) : parseInt(exprMatch[3], 10)) : 0;
      if (!step) return index === offset;
      var n = (index - offset) / step;
      return n >= 0 && n === Math.floor(n);
    }
    var plain = parseInt(text, 10);
    return Number.isFinite(plain) ? index === plain : false;
  };

  var parityMatches = function (el, suffix) {
    var text = String(suffix || '');
    var nthChild = /:nth-child\(([^)]*)\)/.exec(text);
    if (nthChild) {
      var siblings = el.parentNode ? el.parentNode.children : null;
      if (!siblings) return false;
      return matchesAnB(Array.prototype.indexOf.call(siblings, el) + 1, nthChild[1]);
    }
    var nthType = /:nth-of-type\(([^)]*)\)/.exec(text);
    if (nthType) {
      var parent = el.parentNode;
      if (!parent) return false;
      var peers = Array.prototype.filter.call(parent.children, function (node) {
        return node.tagName === el.tagName;
      });
      return matchesAnB(peers.indexOf(el) + 1, nthType[1]);
    }
    if (/:first-child/.test(text)) return el.previousElementSibling === null;
    if (/:last-child/.test(text)) return el.nextElementSibling === null;
    return true;
  };

  /** Ordered declaration lists for a real element under the given states. */
  var rulesFor = function (el, stateList, options) {
    var opts = options || {};
    var hits = [];
    for (var i = 0; i < allRules.length; i += 1) {
      var rule = allRules[i];
      var include = false;
      if (!rule.suffix) include = true;
      else if (/:nth-child|:nth-of-type|:first-child|:last-child/.test(rule.suffix)) {
        // Zebra striping is extracted into its own brush; while resolving an
        // interaction state it must not shadow :hover just because the zebra rule
        // happens to come later in the sheet (same specificity in CSS).
        include = opts.excludeParity ? false : parityMatches(el, rule.suffix);
      } else if (stateList && stateList.indexOf(rule.suffix) >= 0) include = true;
      if (!include) continue;
      var ok = false;
      try {
        ok = el.matches(rule.stem);
      } catch (err) {
        ok = false;
      }
      if (ok) hits.push(rule);
    }
    hits.sort(function (a, b) {
      return a.spec - b.spec || a.order - b.order;
    });
    var out = [];
    for (var h = 0; h < hits.length; h += 1) out.push(hits[h].props);
    return out;
  };

  /** Does any author rule with exactly this state suffix apply to the element? */
  var hasStateRule = function (el, suffix) {
    for (var i = 0; i < allRules.length; i += 1) {
      if (allRules[i].suffix !== suffix) continue;
      var ok = false;
      try {
        ok = el.matches(allRules[i].stem);
      } catch (err) {
        ok = false;
      }
      if (ok) return true;
    }
    return false;
  };

  var visualFor = function (el, stateList, options) {
    var decls = rulesFor(el, stateList, options);
    return decls.length ? visualOf(decls, el) : null;
  };

  /** Visual for a state, but only when the author actually declared that state. */
  var stateVisualFor = function (el, suffix) {
    if (!hasStateRule(el, suffix)) return null;
    return visualFor(el, [suffix], { excludeParity: true });
  };

  var multiStateVisualFor = function (el, suffixes) {
    for (var i = 0; i < suffixes.length; i += 1) {
      if (!hasStateRule(el, suffixes[i])) return null;
    }
    return visualFor(el, suffixes, { excludeParity: true });
  };

  /** First of the given states the author actually declared. */
  var anyStateVisualFor = function (el, suffixes) {
    for (var i = 0; i < suffixes.length; i += 1) {
      if (!hasStateRule(el, suffixes[i])) continue;
      var visual = visualFor(el, [suffixes[i]], { excludeParity: true });
      if (visual) return visual;
    }
    return null;
  };

  /** Ordered declaration lists for a selector stem that has no DOM element. */
  var rulesForStem = function (stem, suffixes) {
    var hits = [];
    for (var i = 0; i < allRules.length; i += 1) {
      var rule = allRules[i];
      if (rule.stem !== stem) continue;
      if (!rule.suffix || (suffixes && suffixes.indexOf(rule.suffix) >= 0)) hits.push(rule);
    }
    hits.sort(function (a, b) {
      return a.spec - b.spec || a.order - b.order;
    });
    return hits;
  };

  var visualOfStem = function (stem, suffixes, anchorEl) {
    var hits = rulesForStem(stem, suffixes);
    if (!hits.length) return null;
    var decls = [];
    for (var i = 0; i < hits.length; i += 1) decls.push(hits[i].props);
    return visualOf(decls, anchorEl);
  };

  /**
   * Guess the CSS stem used for the rows of a hand-rolled dropdown, e.g.
   * `.combo` -> `.combo-list .item`. Only rules whose ancestor class extends one of
   * the control's own classes are considered, so it cannot wander far.
   */
  var guessRowStem = function (el) {
    var tokens = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    var counts = Object.create(null);
    for (var i = 0; i < allRules.length; i += 1) {
      var stem = allRules[i].stem;
      var classes = stem.match(/\.[-\w]+/g) || [];
      if (classes.length < 2) continue;
      var ancestor = classes[0].slice(1);
      var related = false;
      for (var t = 0; t < tokens.length; t += 1) {
        if (ancestor === tokens[t]) related = true;
        if (ancestor.indexOf(tokens[t] + '-') === 0 || ancestor.indexOf(tokens[t] + '_') === 0) related = true;
      }
      if (!related) continue;
      counts[stem] = (counts[stem] || 0) + 1;
    }
    var best = null;
    var bestCount = 0;
    for (var key in counts) {
      if (counts[key] > bestCount) {
        best = key;
        bestCount = counts[key];
      }
    }
    return best;
  };

  var findStemEndingWith = function (fragment) {
    var trimmed = String(fragment || '').trim();
    if (!trimmed) return null;
    var counts = Object.create(null);
    for (var i = 0; i < allRules.length; i += 1) {
      var stem = allRules[i].stem;
      if (stem === trimmed || stem.slice(-trimmed.length - 1) === ' ' + trimmed) {
        counts[stem] = (counts[stem] || 0) + 1;
      }
    }
    var best = null;
    var bestCount = 0;
    for (var key in counts) {
      if (counts[key] > bestCount) {
        best = key;
        bestCount = counts[key];
      }
    }
    return best;
  };

  /**
   * Everything the mapper needs to style one non-trivial control: the box as the
   * designer wrote it, the per-state overrides, pseudo-element paint, option rows
   * and (for hand-rolled dropdowns) the CSS-only row stem.
   */
  var captureControl = function (el, tag, ue) {
    var ctl = {};
    var cs = window.getComputedStyle(el);
    if (cs.accentColor && cs.accentColor !== 'auto') ctl.accent = cs.accentColor;

    // The box the designer asked for, not the one the UA painted.
    var declaredVisual = visualOf([declaredFor(el)], el);
    ctl.box = declaredVisual;
    if (!ctl.box || !paints(ctl.box)) ctl.box = pickVisual(cs);
    ctl.computed = pickVisual(cs);
    // Native controls report the UA's field-text colour (usually black) for `color`,
    // so keep the colour the control would inherit from its own context: a checkbox
    // has no text of its own, and black on a dark theme is simply wrong.
    if (declaredVisual && declaredVisual.color) ctl.inheritedColor = declaredVisual.color;

    var states = [
      ['hover', ':hover'],
      ['focus', ':focus'],
      ['active', ':active'],
      ['checked', ':checked'],
      ['disabled', ':disabled']
    ];
    var stateVisuals = null;
    for (var i = 0; i < states.length; i += 1) {
      // Only when the author wrote a rule for that state: a "checked" look that is
      // merely the base look would mask the accent-color fallback.
      var visual = stateVisualFor(el, states[i][1]);
      if (visual) {
        stateVisuals = stateVisuals || {};
        stateVisuals[states[i][0]] = visual;
      }
    }
    // `checked` + `hover` together is what ActiveHoveredBrush / CheckedHoveredImage need.
    var checkedHover = multiStateVisualFor(el, [':checked', ':hover']);
    if (checkedHover) {
      stateVisuals = stateVisuals || {};
      stateVisuals.checkedHover = checkedHover;
    }
    if (stateVisuals) ctl.states = stateVisuals;

    try {
      var before = pickVisual(window.getComputedStyle(el, '::before'));
      if (paints(before)) ctl.before = before;
      var after = pickVisual(window.getComputedStyle(el, '::after'));
      if (paints(after)) ctl.after = after;
    } catch (err) {
      /* ignore */
    }

    if (tag === 'progress') {
      try {
        var bar = pickVisual(window.getComputedStyle(el, '::-webkit-progress-bar'));
        if (paints(bar)) ctl.progressBar = bar;
        var value = pickVisual(window.getComputedStyle(el, '::-webkit-progress-value'));
        if (paints(value)) ctl.progressValue = value;
      } catch (err) {
        /* ignore */
      }
    }

    if (tag === 'select') {
      var options = [];
      for (var oi = 0; oi < el.options.length; oi += 1) {
        var opt = el.options[oi];
        var item = {
          label: normWs(opt.textContent),
          value: String(opt.value),
          selected: !!opt.selected,
          index: oi,
          base: visualFor(opt, []),
          // Plain row look without the zebra override: FTableRowStyle keeps the
          // zebra pattern in its own even/odd brushes.
          baseNoParity: visualFor(opt, [], { excludeParity: true }),
          hover: stateVisualFor(opt, ':hover'),
          checked: stateVisualFor(opt, ':checked'),
          checkedHover: multiStateVisualFor(opt, [':checked', ':hover']),
          // Keyboard focus row (FTableRowStyle.SelectorFocusedBrush).
          focus: anyStateVisualFor(opt, [':focus', ':focus-visible'])
        };
        var parity = parityOf(opt);
        if (parity) {
          // The base visual already carries the zebra override.
          item.parity = parity;
          item.parityVisual = item.base;
        }
        options.push(item);
      }
      if (options.length) ctl.options = options;
    }

    // Hand-rolled dropdown: the rows are CSS-only, so resolve them by stem.
    var controlKind = (ue && ue.control ? String(ue.control) : '').toLowerCase();
    if (controlKind === 'combobox' || controlKind === 'select' || controlKind === 'dropdown') {
      var explicit = ue && ue['item-class'];
      var stem = explicit ? findStemEndingWith(explicit) : guessRowStem(el);
      if (stem) {
        var row = { stem: stem };
        row.base = visualOfStem(stem, [], el);
        row.hover = visualOfStem(stem, [':hover'], el);
        row.selected = visualOfStem(stem, ['.selected', ':checked', '[aria-selected]', '[aria-selected="true"]'], el);
        row.selectedHover = visualOfStem(stem, ['.selected', ':hover'], el);
        row.focus = visualOfStem(stem, [':focus', ':focus-visible'], el);
        var spaceAt = stem.lastIndexOf(' ');
        if (spaceAt > 0) {
          var listStem = stem.slice(0, spaceAt).trim();
          row.listStem = listStem;
          row.list = visualOfStem(listStem, [], el);
        }
        row.explicit = !!explicit;
        ctl.row = row;
      }
    }
    return ctl;
  };

  // -------------------------------------------------- switcher pages (display:none)
  //
  // A tabbed page hides its inactive pages with display:none, so a plain walk never sees them and
  // the importer has nothing to build the other WidgetSwitcher children from. Only containers the
  // author marked with data-ue-switcher are touched: their hidden children are laid out for
  // measurement (position:absolute + visibility:hidden, so they do not disturb the visible page),
  // then everything is restored exactly as it was.
  var revealedSwitchers = [];
  var revealSwitcherPages = function () {
    var switchers = document.querySelectorAll('[data-ue-switcher]');
    for (var s = 0; s < switchers.length; s += 1) {
      var container = switchers[s];
      var kids = container.children || [];
      var hidden = [];
      for (var c = 0; c < kids.length; c += 1) {
        var kid = kids[c];
        if (window.getComputedStyle(kid).display !== 'none') continue;
        const before = window.getComputedStyle(kid);
        hidden.push({
          el: kid,
          cssText: kid.style.cssText,
          wasHidden: true
        });
        kid.__h2uOrig = {
          display: before.display,
          position: before.position,
          visibility: before.visibility
        };
        // A hidden page often declares its own display, and overriding it with "block" would lose
        // e.g. flex-direction: an HBox page came back as a VBox. data-ue-display lets the author (and
        // the WBP->HTML writer) state the display the page has while it is visible.
        const declaredDisplay = kid.getAttribute('data-ue-display');
        kid.style.display = declaredDisplay || 'block';
        // Both left and right pinned: an absolutely positioned box with auto width would
        // shrink-to-fit (measured 131px instead of the 520px page width).
        kid.style.position = 'absolute';
        kid.style.left = '0px';
        kid.style.right = '0px';
        kid.style.top = '0px';
        kid.style.visibility = 'hidden';
        kid.style.pointerEvents = 'none';
        kid.__h2uWasHidden = true;
        // Force a synchronous layout so the next getBoundingClientRect is real.
        void kid.getBoundingClientRect();
      }
      if (hidden.length > 0) {
        revealedSwitchers.push({ hidden: hidden });
      }
    }
  };

  var restoreSwitcherPages = function () {
    for (var s = 0; s < revealedSwitchers.length; s += 1) {
      var hidden = revealedSwitchers[s].hidden;
      for (var c = 0; c < hidden.length; c += 1) {
        hidden[c].el.style.cssText = hidden[c].cssText;
        hidden[c].el.__h2uWasHidden = false;
      }
    }
    revealedSwitchers = [];
  };

  revealSwitcherPages();

  // -------------------------------------------------------------- DOM traversal
  var elements = [];
  var skippedHidden = 0;
  var maxElements = opts.maxElements || 8000;
  var capturePseudo = opts.pseudo !== false;
  var captureDeclared = opts.declared !== false;
  var truncated = false;

  var isInlineDisplay = function (display) {
    return display === 'inline' || display === 'inline-block' || display === 'inline-flex' ||
      display === 'inline-grid' || display === 'contents' || display === 'inline-table';
  };

  var readForm = function (el, tag) {
    var form = null;
    if (tag === 'input') {
      form = {
        type: (el.getAttribute('type') || 'text').toLowerCase(),
        value: el.value !== undefined ? String(el.value) : '',
        placeholder: el.getAttribute('placeholder') || '',
        checked: !!el.checked,
        min: el.getAttribute('min'),
        max: el.getAttribute('max'),
        step: el.getAttribute('step'),
        name: el.getAttribute('name') || ''
      };
    } else if (tag === 'select') {
      form = { value: el.value !== undefined ? String(el.value) : '', options: [] };
      for (var i = 0; i < el.options.length; i += 1) {
        form.options.push({ label: normWs(el.options[i].textContent), value: el.options[i].value });
      }
    } else if (tag === 'progress') {
      form = { value: el.value, max: el.max };
    } else if (tag === 'textarea') {
      form = { value: el.value !== undefined ? String(el.value) : '', placeholder: el.getAttribute('placeholder') || '' };
    } else if (tag === 'button') {
      form = { type: (el.getAttribute('type') || 'submit').toLowerCase() };
    }
    return form;
  };

  var readImage = function (el, tag) {
    if (tag !== 'img' && tag !== 'picture' && tag !== 'source') return null;
    var src = el.getAttribute('src') || '';
    return {
      src: src,
      currentSrc: el.currentSrc || src,
      naturalWidth: el.naturalWidth || 0,
      naturalHeight: el.naturalHeight || 0,
      complete: !!el.complete
    };
  };

  var visit = function (el, parentIndex, depth) {
    if (elements.length >= maxElements) {
      truncated = true;
      return -1;
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (SKIP_TAGS[tag] === 1) return -1;
    // Nested SVG primitives are rasterised together with their root <svg>.
    if (el.namespaceURI === 'http://www.w3.org/2000/svg' && tag !== 'svg') return -1;

    var cs;
    try {
      cs = window.getComputedStyle(el);
    } catch (err) {
      return -1;
    }
    if (cs.display === 'none') {
      skippedHidden += 1;
      return -1;
    }

    var rect = el.getBoundingClientRect();
    var parent = el.parentElement;
    var prect = parent
      ? parent.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

    var idx = elements.length;
    var rec = {
      i: idx,
      p: parentIndex,
      k: [],
      tag: tag,
      id: el.id || '',
      cls: (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      rect: [rect.left, rect.top, rect.width, rect.height],
      prect: [prect.left, prect.top, prect.width, prect.height],
      cs: {},
      decl: {},
      runs: [],
      text: null,
      blockKids: 0,
      inlineKids: 0,
      elemKids: 0
    };
    elements.push(rec);
    // Stable handle for later CDP work (the bake pass needs a real DOM nodeId and
    // CDP only understands nodeIds, never our own indices).
    try {
      el.setAttribute('data-h2u-idx', String(idx));
    } catch (err) {
      /* ignore */
    }

    for (var s = 0; s < STYLE_PROPS.length; s += 1) {
      var prop = STYLE_PROPS[s];
      var value = cs[prop];
      if (value === undefined || value === null || value === '') continue;
      if (PRUNE[prop] !== undefined && value === PRUNE[prop]) continue;
      rec.cs[prop] = value;
    }

    // A revealed switcher page was forced into position:absolute / block / hidden just so it could
    // be measured. Report the styles the author actually wrote, otherwise the converter treats the
    // page as an absolutely positioned child of a canvas instead of a plain block page.
    if (el.__h2uWasHidden && el.__h2uOrig) {
      // A page hidden with display:none becomes a block once the hiding is lifted, which is what the
      // author's rule means - unless the page says otherwise with data-ue-display. Without that a
      // flex page was recorded as display:block and came back as a VerticalBox instead of an HBox.
      const declaredDisplay = el.getAttribute ? el.getAttribute('data-ue-display') : null;
      rec.cs.display = declaredDisplay || (el.__h2uOrig.display === 'none' ? 'block' : el.__h2uOrig.display || 'block');
      rec.cs.position = el.__h2uOrig.position || 'static';
      rec.cs.visibility = el.__h2uOrig.visibility || 'visible';
    }

    if (captureDeclared) rec.decl = declaredFor(el);

    // data-ue-* control attributes must be known before the control capture.
    if (el.attributes) {
      var ueAttrs = null;
      for (var a0 = 0; a0 < el.attributes.length; a0 += 1) {
        var ueAttr = el.attributes[a0];
        if (ueAttr.name.indexOf('data-ue-') !== 0) continue;
        if (!ueAttrs) ueAttrs = {};
        ueAttrs[ueAttr.name.slice(8)] = ueAttr.value;
      }
      if (ueAttrs) rec.ue = ueAttrs;
    }

    // Control skin capture: interaction states plus the authored box, for widgets
    // whose look is driven by a style struct (and for hand-rolled controls).
    var isControlTag = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' ||
      tag === 'textarea' || tag === 'progress';
    var forcedControl = rec.ue && (rec.ue.control || rec.ue.options);
    if (captureDeclared && (isControlTag || forcedControl)) {
      var stateMap = null;
      var hoverDecl = stateDeclaredFor(el, ':hover');
      if (hoverDecl) { stateMap = stateMap || {}; stateMap.hover = hoverDecl; }
      var activeDecl = stateDeclaredFor(el, ':active');
      if (activeDecl) { stateMap = stateMap || {}; stateMap.active = activeDecl; }
      var disabledDecl = stateDeclaredFor(el, ':disabled');
      if (disabledDecl) { stateMap = stateMap || {}; stateMap.disabled = disabledDecl; }
      if (stateMap) rec.states = stateMap;

      try {
        var control = captureControl(el, tag, rec.ue || null);
        if (control && (control.accent || control.box || control.states || control.before ||
            control.after || control.options || control.row || control.progressBar || control.progressValue)) {
          rec.control = control;
        }
      } catch (err) {
        /* a styling failure must never break the whole conversion */
      }
    }

    if (el.attributes) {
      var ue = null;
      var attrMap = null;
      for (var a = 0; a < el.attributes.length; a += 1) {
        var attr = el.attributes[a];
        if (attr.name.indexOf('data-ue-') === 0) {
          if (!ue) ue = {};
          ue[attr.name.slice(8)] = attr.value;
          continue;
        }
        // Plain attributes are kept for one reason: a component registry matches on them
        // ([data-kind="stat"]). class/id/style would only duplicate fields already recorded (and
        // style dwarfs everything), so they are skipped.
        if (attr.name === 'class' || attr.name === 'id' || attr.name === 'style') continue;
        if (!attrMap) attrMap = {};
        attrMap[attr.name] = attr.value;
      }
      if (ue) rec.ue = ue;
      if (attrMap) rec.attr = attrMap;
    }
    // Inactive switcher pages were laid out only for measurement (see revealSwitcherPages).
    if (el.__h2uWasHidden) rec.wasHidden = true;

    // Classify children before descending (needed for the text-merge decision).
    var childElements = [];
    for (var n = 0; n < el.childNodes.length; n += 1) {
      var node = el.childNodes[n];
      if (node.nodeType !== 1) continue;
      if (SKIP_TAGS[node.tagName ? node.tagName.toLowerCase() : ''] === 1) continue;
      childElements.push(node);
    }
    rec.elemKids = childElements.length;
    for (var c = 0; c < childElements.length; c += 1) {
      var childDisplay = 'block';
      try {
        childDisplay = window.getComputedStyle(childElements[c]).display;
      } catch (err) {
        /* ignore */
      }
      if (isInlineDisplay(childDisplay)) rec.inlineKids += 1;
      else rec.blockKids += 1;
    }

    // Ordered text runs: strings for text nodes, {r:index} pointing into rec.k.
    for (var t = 0; t < el.childNodes.length; t += 1) {
      var child = el.childNodes[t];
      if (child.nodeType === 3) {
        // Keep the RAW text run: the mapper collapses whitespace *after* joining,
        // which preserves the single space between two inline elements.
        var raw = child.nodeValue;
        if (raw) rec.runs.push(raw);
      } else if (child.nodeType === 1) {
        var childTag = child.tagName ? child.tagName.toLowerCase() : '';
        if (SKIP_TAGS[childTag] === 1) continue;
        var childIndex = visit(child, idx, depth + 1);
        if (childIndex >= 0) {
          rec.runs.push({ r: rec.k.length });
          rec.k.push(childIndex);
        }
      }
    }

    if (rec.elemKids === 0) {
      var own = normWs(el.textContent);
      if (own) rec.text = own;
    }

    if (tag === 'img' || tag === 'picture' || tag === 'source') rec.img = readImage(el, tag);
    var form = readForm(el, tag);
    if (form) rec.form = form;
    if (tag === 'svg') rec.svg = true;
    if (el.scrollTop || el.scrollLeft) rec.scroll = [el.scrollLeft, el.scrollTop];
    if (el.shadowRoot) rec.shadow = true;

    if (capturePseudo && elements.length < 2000) {
      try {
        var before = window.getComputedStyle(el, '::before');
        var after = window.getComputedStyle(el, '::after');
        var pseudo = null;
        if (before && before.content && before.content !== 'none' && before.content !== 'normal') {
          pseudo = pseudo || {};
          pseudo.before = { content: before.content, display: before.display };
        }
        if (after && after.content && after.content !== 'none' && after.content !== 'normal') {
          pseudo = pseudo || {};
          pseudo.after = { content: after.content, display: after.display };
        }
        if (pseudo) rec.pseudo = pseudo;
      } catch (err) {
        /* ignore */
      }
    }

    return idx;
  };

  var rootIndex = -1;
  if (document.documentElement) rootIndex = visit(document.documentElement, -1, 0);

  var loadedFonts = [];
  try {
    if (document.fonts && document.fonts.forEach) {
      document.fonts.forEach(function (face) {
        loadedFonts.push({
          family: String(face.family || '').replace(/['"]/g, ''),
          weight: String(face.weight || '400'),
          style: String(face.style || 'normal'),
          status: String(face.status || '')
        });
      });
    }
  } catch (err) {
    /* ignore */
  }

  // Every switcher page has been measured; put the DOM back the way the author wrote it so the
  // bake pass and the reference screenshot see the real page.
  restoreSwitcherPages();

  // CSS motion. The stabilize stylesheet sets transition/animation to none on everything so a
  // snapshot is deterministic, which means computed styles can never report it - read the authored
  // rules instead. UMG has no equivalent the importer can synthesise, so this only drives a warning.
  var collectMotion = function () {
    var out = { transitions: [], animations: [], keyframes: [] };
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i += 1) {
      var sheet = sheets[i];
      if (sheet.ownerNode && sheet.ownerNode.id === '__html2umg_stabilize__') continue;
      var rules;
      try {
        rules = sheet.cssRules;
      } catch (err) {
        continue; // cross-origin sheet: not readable, not our problem
      }
      if (!rules) continue;
      for (var r = 0; r < rules.length; r += 1) {
        var rule = rules[r];
        if (rule.type === 7 && rule.name) {
          out.keyframes.push(String(rule.name));
          continue;
        }
        var decl = rule.style;
        if (!decl) continue;
        var selector = rule.selectorText || '';
        if (decl.transition && decl.transition !== 'none' && out.transitions.length < 40) {
          out.transitions.push(selector);
        }
        if ((decl.animation && decl.animation !== 'none') || (decl.animationName && decl.animationName !== 'none')) {
          if (out.animations.length < 40) out.animations.push(selector);
        }
      }
    }
    return out;
  };

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    designViewport: { width: opts.width, height: opts.height },
    // Device pixel offset of the document origin: bake clips are page coordinates.
    scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
    dpr: window.devicePixelRatio || 1,
    title: document.title || '',
    rootIndex: rootIndex,
    elements: elements,
    fontFaces: fontFaces,
    loadedFonts: loadedFonts,
    ruleCount: ruleIndex.length,
    inaccessibleSheets: inaccessibleSheets,
    skippedHidden: skippedHidden,
    motion: collectMotion(),
    truncated: truncated,
    bodyStyle: (function () {
      if (!document.body) return null;
      var bodyCs = window.getComputedStyle(document.body);
      return { margin: bodyCs.margin, overflowX: bodyCs.overflowX, overflowY: bodyCs.overflowY, backgroundColor: bodyCs.backgroundColor };
    })(),
    htmlBackground: document.documentElement
      ? window.getComputedStyle(document.documentElement).backgroundColor
      : null
  };
}

const STABILIZE_SOURCE = `(async () => {
  const STYLE_ID = '__html2umg_stabilize__';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = \`
      *, *::before, *::after {
        animation: none !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition: none !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      html { scroll-behavior: auto !important; }
    \`;
    (document.head || document.documentElement).appendChild(style);
  }
  const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  // Measurements are taken from the document origin: pin the scroll position.
  try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
  }
  await raf();
  await raf();
  // Force a synchronous reflow so every pending layout is flushed.
  void document.documentElement.offsetHeight;
  const images = Array.from(document.images || []);
  const pending = images.filter((img) => !img.complete);
  if (pending.length) {
    await Promise.race([
      Promise.all(pending.map((img) => new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }))),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    await raf();
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    images: images.length,
    pendingImages: pending.length,
    fonts: document.fonts ? document.fonts.size : 0,
  };
})()`;

/**
 * Author-time fragment inlining (`data-ue-partial`). Runs before stabilisation so
 * the snapshot sees the composed document. `file://` fragments work because the
 * browser is launched with --allow-file-access-from-files.
 */
const EXPAND_PARTIALS_SOURCE = `(async () => {
  const attribute = 'data-ue-partial';
  const results = [];
  var passes = 0;
  for (passes = 0; passes < 3; passes += 1) {
    const hosts = Array.from(document.querySelectorAll('[' + attribute + ']'));
    if (!hosts.length) break;
    for (const host of hosts) {
      const raw = host.getAttribute(attribute) || '';
      let url = '';
      try {
        url = new URL(raw, document.baseURI).href;
      } catch (err) {
        results.push({ partial: raw, ok: false, error: 'bad path' });
        host.replaceWith(document.createElement('div'));
        continue;
      }
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const text = await response.text();
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const nodes = Array.from(doc.body.childNodes)
          .filter((node) => node.nodeType === 1 || (node.nodeType === 3 && node.nodeValue.trim()))
          .map((node) => document.importNode(node, true));
        if (!nodes.length) throw new Error('fragment is empty');
        const firstElement = nodes.find((node) => node.nodeType === 1);
        if (firstElement) {
          // The placeholder's identity (data-ue-name, class, ...) wins so
          // data-ue-name on the placeholder keeps naming the fragment root.
          for (const attr of Array.from(host.attributes)) {
            if (attr.name === attribute) continue;
            if (firstElement.hasAttribute(attr.name)) continue;
            firstElement.setAttribute(attr.name, attr.value);
          }
        }
        host.replaceWith.apply(host, nodes);
        results.push({ partial: raw, ok: true, nodes: nodes.length });
      } catch (err) {
        results.push({ partial: raw, ok: false, error: String((err && err.message) || err) });
        host.replaceWith(document.createElement('div'));
      }
    }
  }
  const remaining = document.querySelectorAll('[' + attribute + ']').length;
  return { results: results, remaining: remaining, passes: passes };
})()`;

/** Expand every `data-ue-partial` in the loaded page. */
async function expandPartials(session) {
  return session.evaluate(EXPAND_PARTIALS_SOURCE, { awaitPromise: true, returnByValue: true });
}

/** Inject determinism CSS, wait for fonts/images, force reflow. */
async function stabilize(session) {
  return session.evaluate(STABILIZE_SOURCE, { awaitPromise: true, returnByValue: true });
}

function snapshotExpression(options) {
  const opts = Object.assign({ pseudo: true, declared: true, maxElements: 8000 }, options || {});
  return `(${pageSnapshot.toString()})(${JSON.stringify(opts)})`;
}


/**
 * Ask Chromium which fonts it ACTUALLY used for every element that owns text.
 *
 * The browser substitutes a system CJK face silently when the CSS stack has no glyph
 * for a codepoint, which is exactly the layer the converter could not see: the DOM
 * snapshot only knows the requested `font-family`, never the resolved face. One
 * CSS.getPlatformFontsForNode per text element closes that gap, and the result is
 * attached to the record as `platformFonts: [{family, glyphs, custom}]` so it also
 * shows up in --dump-snapshot.
 *
 * The element is looked up by the `data-h2u-idx` attribute the snapshot pass wrote,
 * so no object handles have to be kept alive between round trips.
 */
async function collectPlatformFonts(session, snapshot, options) {
  const opts = options || {};
  const warn = opts.warn || (() => {});
  const maxNodes = opts.maxNodes || 1500;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency || 6));
  const stats = { nodes: 0, queried: 0, failed: 0, skipped: 0, families: [] };
  if (!snapshot || !Array.isArray(snapshot.elements)) return stats;

  let targets = snapshot.elements.filter(
    (rec) => rec && rec.i !== undefined && typeof rec.text === 'string' && rec.text.trim().length > 0
  );
  stats.nodes = targets.length;
  if (!targets.length) return stats;
  if (targets.length > maxNodes) {
    stats.skipped = targets.length - maxNodes;
    warn(`fonts: only the first ${maxNodes} of ${targets.length} text element(s) were probed for platform fonts`);
    targets = targets.slice(0, maxNodes);
  }

  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
  } catch (err) {
    warn(`fonts: the CSS/DOM domains are unavailable (${err.message}); platform font data skipped`);
    return stats;
  }
  const doc = await session.send('DOM.getDocument', { depth: 0 }).catch(() => null);
  const rootNodeId = doc && doc.root ? doc.root.nodeId : 0;
  if (!rootNodeId) {
    warn('fonts: DOM.getDocument returned no root; platform font data skipped');
    return stats;
  }

  const familyGlyphs = new Map();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const rec = targets[index];
      try {
        const found = await session.send('DOM.querySelector', {
          nodeId: rootNodeId,
          selector: `[data-h2u-idx="${rec.i}"]`,
        });
        if (!found || !found.nodeId) {
          stats.failed += 1;
          continue; // detached node, or one the snapshot synthesised
        }
        const result = await session.send('CSS.getPlatformFontsForNode', { nodeId: found.nodeId });
        const fonts = ((result && result.fonts) || []).filter((font) => (font.glyphCount || 0) > 0);
        if (!fonts.length) {
          stats.failed += 1;
          continue;
        }
        rec.platformFonts = fonts.map((font) => ({
          family: String(font.familyName || ''),
          glyphs: font.glyphCount || 0,
          custom: !!font.isCustomFont,
        }));
        stats.queried += 1;
        for (const font of rec.platformFonts) {
          const key = font.family;
          familyGlyphs.set(key, (familyGlyphs.get(key) || 0) + font.glyphs);
        }
      } catch (err) {
        stats.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  stats.families = Array.from(familyGlyphs.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([family, glyphs]) => ({ family, glyphs }));
  return stats;
}

/** One round trip: returns the flattened snapshot object. */
async function captureSnapshot(session, options) {
  const opts = options || {};
  const expression = snapshotExpression(opts);
  const result = await session.evaluate(expression, { awaitPromise: true, returnByValue: true });
  if (!result || !Array.isArray(result.elements)) {
    throw new Error('snapshot: page returned no element list (did the page load?)');
  }
  return result;
}

/** Index a snapshot's records by document order for stable cross-viewport pairing. */
function indexSnapshot(snapshot) {
  const byIndex = new Map();
  for (const rec of snapshot.elements) byIndex.set(rec.i, rec);
  return byIndex;
}

module.exports = {
  pageSnapshot,
  snapshotExpression,
  captureSnapshot,
  stabilize,
  expandPartials,
  collectPlatformFonts,
  indexSnapshot,
  STABILIZE_SOURCE,
  EXPAND_PARTIALS_SOURCE,
};
