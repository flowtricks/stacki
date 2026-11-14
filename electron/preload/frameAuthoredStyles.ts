// Preserve the winning declaration's units without reimplementing CSS specificity,
// layers, nesting, or conditional rules. Temporary custom properties beside the
// real declarations let Chromium choose the same winner; numeric tokens preserve
// var() and calc() verbatim instead of evaluating them. Cleanup is synchronous.
import { assert } from '../../shared/core/assert';
import { PRELOAD_LIMITS } from './frameBasics';
import { inheritedProperty } from './styleInheritance';

const STYLE_LIMITS = { rulesMax: 20_000, propertiesMax: 512, workMax: 200_000 } as const;
type Probe = { readonly inherited: string; readonly local: string };
const registrations = new Map<string, Probe>();
// Every probe name takes the next numbers from this counter, so the custom-property probes and the
// property probes never share one and `authoredStyleMutation` recognizes both by their digits.
let probeCounter = 0;
const prefix = `--stacki-inspect-${Math.random().toString(36).slice(2)}-`;
type InlineStyle = { readonly element: HTMLElement | SVGElement; readonly text: string };
type CollectedStyles = {
  readonly declarations: readonly CSSStyleDeclaration[];
  readonly inline: readonly InlineStyle[];
};
type Declaration = { readonly value: string; readonly priority: string };

export type AuthoredInspection = {
  readonly values: Readonly<Record<string, string | undefined>>;
  readonly sources: Readonly<Record<string, Element | undefined>>;
};

export function authoredProperties(element: Element, properties: readonly string[]) {
  return inspectAuthoredProperties(element, properties).values;
}

export function inspectAuthoredProperties(element: Element, properties: readonly string[]): AuthoredInspection {
  const empty: AuthoredInspection = { values: {}, sources: {} };
  if (typeof window.CSS?.registerProperty !== 'function') {
    return empty;
  }
  if (properties.length === 0 || properties.length > STYLE_LIMITS.propertiesMax) {
    return empty;
  }
  const styles = authoredStyles(element);
  if (styles === undefined) {
    return empty;
  }
  if (styles.declarations.length * properties.length * 2 > STYLE_LIMITS.workMax) {
    return empty;
  }
  const values: string[] = [];
  const patches = new Map<CSSStyleDeclaration, AuthoredPatch>();
  const names = properties.map((property) => ({ property, probe: registeredProbe(property) }));
  try {
    for (const { property, probe } of names) {
      if (probe !== undefined) {
        for (const style of styles.declarations) {
          const declaration = sourceDeclaration(style, property);
          if (declaration.value) {
            const token = probeToken(declaration.value, values.length);
            values.push(declaration.value);
            const patch = patches.get(style) ?? authoredPatch(style);
            patches.set(style, patch);
            for (const name of [probe.inherited, probe.local]) {
              const value = name === probe.local ? localToken(token, property) : token;
              style.setProperty(name, value, declaration.priority);
              patch.probes.add(name);
            }
          }
        }
      }
    }
    assert(patches.size <= styles.declarations.length, 'Each declaration has one saved original');
    assert(values.length * 2 <= STYLE_LIMITS.workMax, 'Authored probe writes are bounded');
    return inspectProbeResults(element, names, values);
  } finally {
    restoreAuthoredStyles(patches, styles.inline);
  }
}

// The noninheriting twin distinguishes a declaration on this element from the
// same rule inherited from an ancestor, even when their values happen to match.
function localToken(token: string, property: string): string {
  const keyword = token.trim().toLowerCase();
  if (keyword === 'inherit') {
    return 'initial';
  }
  if (keyword === 'unset' && inheritedProperty(property)) {
    return 'initial';
  }
  return token;
}

function inspectProbeResults(
  element: Element,
  names: readonly { readonly property: string; readonly probe: Probe | undefined }[],
  declarations: readonly string[],
): AuthoredInspection {
  const computed = getComputedStyle(element);
  const values: Record<string, string | undefined> = {};
  const sources: Record<string, Element | undefined> = {};
  for (const { property, probe } of names) {
    if (probe === undefined) {
      continue;
    }
    const token = computed.getPropertyValue(probe.inherited).trim();
    const index = /^\d+$/.test(token) ? Number(token) : -1;
    if (Number.isSafeInteger(index) && declarations[index] !== undefined) {
      values[property] = declarations[index];
      sources[property] = probeSource(element, probe.local, token);
    }
  }
  return { values, sources };
}

function probeSource(element: Element, name: string, token: string): Element | undefined {
  let ancestor: Element | undefined = element;
  for (let depth = 0; depth < PRELOAD_LIMITS.domDepthMax; depth += 1) {
    if (ancestor === undefined) {
      return undefined;
    }
    if (getComputedStyle(ancestor).getPropertyValue(name).trim() === token) {
      return ancestor;
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  return undefined;
}

// What one declaration block held before probing: the names written into it,
// and its text for the one case removing them cannot restore.
interface AuthoredPatch {
  readonly text: string;
  readonly all: boolean;
  readonly probes: Set<string>;
}

function authoredPatch(style: CSSStyleDeclaration): AuthoredPatch {
  return { text: style.cssText, all: style.getPropertyValue('all') !== '', probes: new Set() };
}

function restoreAuthoredStyles(patches: ReadonlyMap<CSSStyleDeclaration, AuthoredPatch>, inline: readonly InlineStyle[]): void {
  assert(patches.size <= STYLE_LIMITS.workMax, 'Authored probe cleanup is bounded');
  // Remove only the probes. Reassigning cssText loses a shorthand that holds a
  // var() followed by one of its longhands (`font: 800 2rem var(--f);
  // font-variant-numeric: …`): Chromium serializes the shorthand's longhands as
  // empty while substitution is pending, and writing that text back drops them
  // (issue #71).
  for (const [style, patch] of patches) {
    assert(patch.probes.size > 0, 'A saved declaration was probed');
    for (const name of patch.probes) {
      style.removeProperty(name);
    }
    // Chromium can expand `all` while editing registered custom properties; only
    // then is the complete text restored, to keep its shorthand order and resets.
    if (patch.all) {
      if (style.cssText !== patch.text) {
        style.cssText = patch.text;
      }
    }
  }
  for (const { element, text } of inline) {
    if (element.getAttribute('style') !== text) {
      element.setAttribute('style', text);
    }
  }
}

// Probe writes must not look like a project CSS edit to the canvas observer.
// Compare normalized declarations after removing only this module's own tokens;
// a simultaneous change to a real property still invalidates the style cache.
export function authoredStyleMutation(record: MutationRecord): boolean {
  if (record.attributeName !== 'style') {
    return false;
  }
  if (!(record.target instanceof Element)) {
    return false;
  }
  const normalize = (text: string) => {
    const style = document.createElement('span').style;
    style.cssText = text.replace(new RegExp(`${prefix}\\d+\\s*:[^;]*;?`, 'g'), '');
    return style.cssText;
  };
  return normalize(record.oldValue ?? '') === normalize(record.target.getAttribute('style') ?? '');
}

function registeredProbe(property: string): Probe | undefined {
  const known = registrations.get(property);
  if (known !== undefined) {
    return known;
  }
  if (registrations.size >= STYLE_LIMITS.propertiesMax) {
    return undefined;
  }
  // Custom properties can have project-defined inheritance via @property. Leave
  // those to the computed fallback rather than guessing their registration.
  if (property.startsWith('--')) {
    return undefined;
  }
  if (typeof window.CSS?.registerProperty !== 'function') {
    return undefined;
  }
  const probe = newProbe({ inherits: inheritedProperty(property) });
  registrations.set(property, probe);
  return probe;
}

function probeToken(value: string, index: number): string {
  switch (value.trim().toLowerCase()) {
    case 'inherit':
    case 'initial':
    case 'unset':
    case 'revert':
    case 'revert-layer':
      return value;
    default:
      return String(index);
  }
}

function authoredDeclaration(style: CSSStyleDeclaration, property: string): Declaration {
  return { value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) };
}

function sourceDeclaration(style: CSSStyleDeclaration, property: string): Declaration {
  const declared = authoredDeclaration(style, property);
  if (property === 'direction' || property === 'unicode-bidi' || property.startsWith('--')) {
    return declared;
  }
  const reset = authoredDeclaration(style, 'all');
  if (!reset.value) {
    return declared;
  }
  if (!declared.value) {
    return reset;
  }
  if (declared.priority !== reset.priority) {
    return declared.priority === 'important' ? declared : reset;
  }
  const properties = Array.from(style);
  return properties.indexOf(property) > properties.indexOf('all') ? declared : reset;
}

// An inaccessible sheet could contain the winner. Fall back to computed values
// for the whole query instead of reporting an accessible but losing declaration.
function sheetRules(sheet: CSSStyleSheet): CSSRuleList | undefined {
  try {
    return sheet.cssRules;
  } catch {
    return undefined;
  }
}

function authoredStyles(element: Element): CollectedStyles | undefined {
  const styles: CSSStyleDeclaration[] = [];
  const sheets = [...Array.from(document.styleSheets), ...document.adoptedStyleSheets].filter((sheet) => {
    const owner = sheet.ownerNode;
    return !(owner instanceof Element && /^avb-(design-style|vh-override)$/.test(owner.id));
  });
  if (sheets.length > STYLE_LIMITS.rulesMax) {
    return undefined;
  }
  const pending: CSSRule[] = [];
  for (const sheet of sheets) {
    const rules = sheetRules(sheet);
    if (rules === undefined) {
      return undefined;
    }
    if (pending.length + rules.length > STYLE_LIMITS.rulesMax) {
      return undefined;
    }
    pending.push(...Array.from(rules));
  }
  for (let index = 0; index < pending.length; index += 1) {
    const rule = pending[index];
    assert(rule !== undefined, 'The rule queue index is in bounds');
    if (rule instanceof CSSStyleRule) {
      styles.push(rule.style);
    }
    if (typeof CSSNestedDeclarations !== 'undefined') {
      if (rule instanceof CSSNestedDeclarations) {
        styles.push(rule.style);
      }
    }
    const children = authoredChildRules(rule);
    if (children === undefined) {
      return undefined;
    }
    if (pending.length + children.length > STYLE_LIMITS.rulesMax) {
      return undefined;
    }
    pending.push(...Array.from(children));
  }
  const inline: InlineStyle[] = [];
  let ancestor: Element | undefined = element;
  for (let depth = 0; ancestor !== undefined; depth += 1) {
    if (depth >= PRELOAD_LIMITS.domDepthMax) {
      return undefined;
    }
    if (ancestor instanceof HTMLElement || ancestor instanceof SVGElement) {
      const text = ancestor.getAttribute('style');
      if (text !== null) {
        styles.push(ancestor.style);
        inline.push({ element: ancestor, text });
      }
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  return { declarations: styles, inline };
}

function authoredChildRules(rule: CSSRule): CSSRuleList | readonly CSSRule[] | undefined {
  if (rule instanceof CSSImportRule) {
    return rule.styleSheet ? sheetRules(rule.styleSheet) : [];
  }
  if (rule instanceof CSSGroupingRule) {
    return rule.cssRules;
  }
  if (rule instanceof CSSStyleRule) {
    return rule.cssRules;
  }
  return [];
}

// Registered carriers for one probe: a property registered once stays registered, so the probes
// are numbered and reused rather than made per question.
function newProbe({ inherits }: { readonly inherits: boolean }): Probe {
  const probe = { inherited: `${prefix}${probeCounter}`, local: `${prefix}${probeCounter + 1}` };
  probeCounter += 2;
  window.CSS.registerProperty({ name: probe.inherited, syntax: '*', inherits });
  window.CSS.registerProperty({ name: probe.local, syntax: '*', inherits: false });
  return probe;
}

// ---- The winning declaration of a custom property, traced up from an element ----

/** The most custom properties one question may ask about, and the most probe writes it may make. */
export const WINNING_LIMITS = { namesMax: 512, writesMax: 200_000 } as const;

/** A custom property's winning declaration for one element, as written. */
export interface WinningDeclaration {
  /** The declaration's value text, trimmed and whitespace-normalized, never resolved. */
  readonly expression: string;
  /** The rule's selector list, or `style` for an inline declaration. */
  readonly selector: string;
  /** The stylesheet's file (a link's address or a development style tag's id), when it has one. */
  readonly file?: string;
  /** How many parents up the declaring element is: 0 is the element itself. */
  readonly depth: number;
  /** The declaring element's own label (`.theme-dark`, `#hero`, a tag). */
  readonly ancestor: string;
}

// Custom property probes: pairs of registered carriers, reused from the front of this pool by index.
const customProbes: Probe[] = [];

function customProbe(index: number): Probe | undefined {
  if (typeof window.CSS?.registerProperty !== 'function') {
    return undefined;
  }
  while (customProbes.length <= index) {
    if (customProbes.length >= WINNING_LIMITS.namesMax) {
      return undefined;
    }
    // A custom property inherits unless registered otherwise, so its carrier does too.
    customProbes.push(newProbe({ inherits: true }));
  }
  return customProbes[index];
}

type DeclaredSource = { readonly style: CSSStyleDeclaration; readonly expression: string };

/**
 * For each custom property, the declaration that wins for `element`, found the way the browser finds
 * it: every declaration of the property in an accessible stylesheet or inline style is mirrored into
 * a registered carrier custom property (same rule, same priority), so the cascade (importance,
 * specificity, order, layers, media and other conditions) is Chromium's own, and the carrier's
 * value at the element names the winning declaration. The nearest element up the parent chain that
 * holds it locally is the declaring one: a custom property inherits, so the nearest declaring
 * ancestor-or-self wins. Reads nothing from the computed value of the property itself. An
 * inaccessible stylesheet or an exhausted bound answers nothing rather than a false winner.
 */
export function inspectWinningDeclarations(element: Element, names: readonly string[]): Readonly<Record<string, WinningDeclaration>> {
  const wanted = [...new Set(names.filter((name) => name.startsWith('--')))];
  if (wanted.length === 0 || wanted.length > WINNING_LIMITS.namesMax) {
    return {};
  }
  const styles = authoredStyles(element);
  if (styles === undefined) {
    return {};
  }
  const probes = wanted.map((_, index) => customProbe(index));
  if (probes.some((probe) => probe === undefined)) {
    return {};
  }
  const indexOf = new Map(wanted.map((name, index) => [name, index]));
  const declared: DeclaredSource[] = [];
  const patches = new Map<CSSStyleDeclaration, AuthoredPatch>();
  try {
    for (const style of styles.declarations) {
      for (const name of Array.from(style).filter((candidate) => indexOf.has(candidate))) {
        const probe = probes[indexOf.get(name) ?? -1];
        if (probe === undefined || declared.length * 2 >= WINNING_LIMITS.writesMax) {
          return {};
        }
        const value = style.getPropertyValue(name);
        const token = probeToken(value, declared.length);
        const patch = patches.get(style) ?? authoredPatch(style);
        patches.set(style, patch);
        style.setProperty(probe.inherited, token, style.getPropertyPriority(name));
        style.setProperty(probe.local, localToken(token, name), style.getPropertyPriority(name));
        patch.probes.add(probe.inherited);
        patch.probes.add(probe.local);
        declared.push({ style, expression: value });
      }
    }
    return readWinners(element, wanted, probes, declared);
  } finally {
    restoreAuthoredStyles(patches, styles.inline);
  }
}

function readWinners(
  element: Element,
  names: readonly string[],
  probes: ReadonlyArray<Probe | undefined>,
  declared: readonly DeclaredSource[],
): Record<string, WinningDeclaration> {
  // The element and its parents, each read once; the ancestors' own labels come from them.
  const chain: Element[] = [];
  for (let node: Element | undefined = element; node !== undefined && chain.length < PRELOAD_LIMITS.domDepthMax; node = node.parentElement ?? undefined) {
    chain.push(node);
  }
  const computed = chain.map((node) => getComputedStyle(node));
  const winners: Record<string, WinningDeclaration> = {};
  names.forEach((name, position) => {
    const probe = probes[position];
    const atElement = probe === undefined ? '' : (computed[0]?.getPropertyValue(probe.inherited).trim() ?? '');
    const index = /^\d+$/.test(atElement) ? Number(atElement) : -1;
    const source = declared[index];
    if (probe === undefined || source === undefined) {
      return;
    }
    const depth = computed.findIndex((style) => style.getPropertyValue(probe.local).trim() === atElement);
    const owner = chain[depth];
    if (depth < 0 || owner === undefined) {
      return;
    }
    const where = describeDeclaration(source.style);
    winners[name] = {
      expression: source.expression.replace(/\s+/g, ' ').trim(),
      selector: where.selector,
      ...(where.file === undefined ? {} : { file: where.file }),
      depth,
      ancestor: elementLabel(owner),
    };
  });
  return winners;
}

function elementLabel(element: Element): string {
  if (element.id) {
    return `#${element.id}`;
  }
  const classes = Array.from(element.classList).map((name) => `.${name}`);
  return classes.length > 0 ? classes.join('') : element.tagName.toLowerCase();
}

// The rule a declaration block belongs to: its selector list and the file of its stylesheet.
function describeDeclaration(style: CSSStyleDeclaration): { readonly selector: string; readonly file: string | undefined } {
  let rule: CSSRule | undefined = style.parentRule ?? undefined;
  if (rule === undefined) {
    return { selector: 'style', file: undefined };
  }
  let selector = '';
  for (let depth = 0; rule !== undefined && depth < PRELOAD_LIMITS.cssRuleDepthMax; depth += 1) {
    if (rule instanceof CSSStyleRule) {
      selector = selector === '' ? rule.selectorText : `${rule.selectorText} ${selector}`;
    }
    if (rule.parentRule === null) {
      return { selector, file: sheetFile(rule.parentStyleSheet ?? undefined) };
    }
    rule = rule.parentRule;
  }
  return { selector, file: undefined };
}

function sheetFile(sheet: CSSStyleSheet | undefined): string | undefined {
  if (sheet === undefined) {
    return undefined;
  }
  const owner = sheet.ownerNode;
  const id = owner instanceof HTMLElement ? owner.dataset['viteDevId'] : undefined;
  const file = id ?? sheet.href ?? undefined;
  if (file === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(file, document.baseURI);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.pathname.slice(0, 1024) : file.slice(0, 1024);
  } catch {
    return file.slice(0, 1024);
  }
}
