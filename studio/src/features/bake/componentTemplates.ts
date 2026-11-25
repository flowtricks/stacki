// A component's rendering without Astro. At bake time each component instance on a
// page, and each insertion recipe, is rendered many more times by the real build:
// once per reachable state, each twice with different sentinel strings standing in for
// the string and number props. A state is a combination: every choice prop (a boolean
// or an enum) at one of its value classes, with at most one text prop (a string, a
// number or a slot's presence) moved off its own class, so a variant together with the
// props that only that variant shows renders as it would with Astro. Where both
// sentinel runs agree once the sentinels are cut out, the output is a template:
// literal HTML with holes for those props, for the instance's path and for its slots.
// A prop that is transformed, computed from or used in logic makes the two runs
// disagree, so that state carries no template and an edit that needs it is refused
// instead of guessed. This module is the contract between the bake and the demo: it
// runs in Node and in the browser and imports neither.
import type { Attr } from '../../../vendor/stacki/shared/page/pageNodeTypes';
import { assert } from '../../../vendor/stacki/shared/core/assert';

export const TEMPLATE_LIMITS = {
  templatesMax: 4_000,
  /** The states one instance renders: every combination of its choice props the
   * component's types allow, nearest the instance's own values first, each with at
   * most one text prop or slot moved. Past it the farthest combinations refuse. */
  statesMax: 1_536,
  /** Distinct outputs among one template's states. */
  outputsMax: 1_536,
  propsMax: 32,
  optionsMax: 16,
  holesMax: 512,
  slotsMax: 16,
  /** The longest list of strings a list prop renders from a template; one class per length. */
  listItemsMax: 12,
  /** One state's HTML. A larger component is left to Astro. */
  htmlCharsMax: 300_000,
  /** One template's distinct renderings together. Past it the farthest combinations
   * that need a rendering of their own refuse; the nearest are kept. */
  templateCharsMax: 320_000,
  /** Every template together, so a large site cannot outgrow its snapshot. */
  totalCharsMax: 20_000_000,
  instancesMax: 20_000,
} as const satisfies Record<string, number>;

/** Stands for the instance's page path in every rendering. */
export const PATH_SENTINEL = 'stkpathsentinelq';
const HOLE_OPEN = '';
const HOLE_CLOSE = '';
const HOLE = /(\d+)/g;
const SLOT_MARKER = /<template data-stacki-slot="([\w-]+)"><\/template>/g;

/** Stands for a slot's content in a probe. An inert element, not a comment: components
 * commonly strip comments from slot content, and one that then found its slot empty
 * would render as if nothing had been written into it. */
export function slotMarker(name: string): string {
  assert(/^[\w-]+$/.test(name), 'A slot name is a plain word');
  return `<template data-stacki-slot="${name}"></template>`;
}

export type PropKind =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly options: readonly string[]; readonly numeric: boolean }
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  /** An array of strings written as a literal: one state per length, one hole per item. */
  | { readonly kind: 'list' };

export type Hole =
  | { readonly kind: 'prop'; readonly name: string; readonly mode: 'escaped' | 'raw' }
  | { readonly kind: 'slot'; readonly name: string }
  | { readonly kind: 'path' }
  /** A view-transition scope (`astro-<hash>-<n>`): Astro counts them per page render, so
   * each rendering numbers them anew. Filled in order from the page's own run. */
  | { readonly kind: 'scope' };

/** A transition attribute whose value Astro numbers per render. */
export const TRANSITION_SCOPE = /(data-astro-transition-(?:persist|scope)=")(astro-[a-z0-9]+-\d+)(")/g;

/** The transition scopes a run of baked HTML holds, in order, for filling scope holes. */
export function transitionScopes(html: string): readonly string[] {
  return [...html.matchAll(TRANSITION_SCOPE)].map((match) => match[2] ?? '').slice(0, TEMPLATE_LIMITS.holesMax);
}

/** A rendering's HTML, kept as its difference from the base state's: the base's first
 * `prefix` and last `suffix` characters around `middle`, or, where a change touches a
 * few places far apart (a layout's variant), the base with each hunk's span replaced. */
export interface TemplateDifference {
  readonly prefix: number;
  readonly suffix: number;
  readonly middle: string;
  /** Base start, base end and replacement text, in order and apart; with them, the
   * three fields above are 0, 0 and ''. */
  readonly hunks?: readonly TemplateHunk[];
}

export type TemplateHunk = readonly [start: number, end: number, text: string];

/** One combination of value classes, by its key (stateKey), and what it renders. */
export interface TemplateState {
  readonly key: string;
  /** The index of its HTML in the template's outputs. */
  readonly output: number;
  /** Props that are holes in this state. Every other prop renders its class's value. */
  readonly templated: readonly string[];
}

/** The base with one prop as a hole, for a base whose shared run disagreed. */
export interface TemplateSingle extends TemplateDifference {
  readonly templated: readonly string[];
}

export interface TemplateProp {
  readonly kind: PropKind;
  /** The value the base renders with, as written; absent when the prop is not set. */
  readonly attr?: Attr;
}

export interface ComponentTemplate {
  readonly file: string;
  readonly slots: readonly string[];
  readonly props: Readonly<Record<string, TemplateProp>>;
  /** Attributes no state varies. An edit to one is refused. */
  readonly fixed: Readonly<Record<string, Attr>>;
  readonly holes: readonly Hole[];
  /** The base state's HTML, or undefined when its two runs disagreed. */
  readonly base: string | undefined;
  /** Choice props whose explicit default the bake saw render exactly as their absence,
   * by the explicit default's class. Such a value is looked up as absent, which is how
   * Studio writes a default on an instance. */
  readonly collapsed: Readonly<Record<string, string>>;
  /** Each distinct rendering once; states point into it. */
  readonly outputs: readonly TemplateDifference[];
  readonly states: readonly TemplateState[];
  /** One prop as a hole and every other at its base value, for a base whose shared run
   * disagreed because of another prop. */
  readonly singles: Readonly<Record<string, TemplateSingle>>;
}

/** The instances key of one entry of a template page: its file and its built document.
 * An instance whose rendering depends on the entry has a template per entry, under this
 * key; one that does not is shared by every entry, under the file. */
export function entryInstancesKey(file: string, document: string): string {
  assert(file.length > 0, 'An entry belongs to a file');
  assert(document.length > 0, 'An entry has a document');
  return `${file}#${document}`;
}

export interface ComponentCatalog {
  readonly templates: readonly ComponentTemplate[];
  /** Page file (or entryInstancesKey), then baked page path, to the instance's own template. */
  readonly instances: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export const EMPTY_CATALOG: ComponentCatalog = { templates: [], instances: {} };

export type Literal = string | number | boolean;

/** What an attribute holds when it is a value the demo can know without running code. */
export type AttrValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'literal'; readonly value: Literal }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'code' };

/** The hole name of a list prop's item. */
export function listItemName(prop: string, index: number): string {
  assert(Number.isSafeInteger(index), 'An item index is an integer');
  assert(index < TEMPLATE_LIMITS.listItemsMax, 'An item index stays within the list limit');
  return `${prop}.${index}`;
}

/** The values a prop fills holes with: its literal, or each of its list's items. */
export function holeValues(name: string, value: AttrValue): readonly (readonly [string, Literal])[] {
  if (value.kind === 'literal') {
    return [[name, value.value]];
  }
  if (value.kind === 'list') {
    return value.items.map((item, index) => [listItemName(name, index), item] as const);
  }
  return [];
}

const STRING_LITERAL = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$\\]*)`)$/;

export function attrValue(attr: Attr | undefined): AttrValue {
  if (attr === undefined) {
    return { kind: 'absent' };
  }
  switch (attr.type) {
    case 'string':
      return { kind: 'literal', value: attr.value };
    case 'bare':
      return { kind: 'literal', value: true };
    case 'spread':
      return { kind: 'code' };
    case 'expr':
      return expressionValue(attr.value.trim());
    default: {
      const exhaustive: never = attr;
      return exhaustive;
    }
  }
}

function expressionValue(code: string): AttrValue {
  if (code === 'true' || code === 'false') {
    return { kind: 'literal', value: code === 'true' };
  }
  if (code === 'undefined') {
    return { kind: 'absent' };
  }
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(code)) {
    return { kind: 'literal', value: Number(code) };
  }
  if (code.startsWith('[')) {
    return listValue(code);
  }
  const quoted = STRING_LITERAL.exec(code);
  if (quoted === null) {
    return { kind: 'code' };
  }
  const double = quoted[1];
  if (double !== undefined) {
    const parsed: unknown = JSON.parse(`"${double}"`);
    return typeof parsed === 'string' ? { kind: 'literal', value: parsed } : { kind: 'code' };
  }
  const single = quoted[2] ?? quoted[3] ?? '';
  return single.includes('\\') ? { kind: 'code' } : { kind: 'literal', value: single };
}

const LIST_ITEM = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$\\]*`)\s*(,|$)/y;

/** An array literal of plain strings, the one list a template can fill; anything else is code. */
function listValue(code: string): AttrValue {
  if (!code.endsWith(']')) {
    return { kind: 'code' };
  }
  const inner = code.slice(1, -1);
  const items: string[] = [];
  LIST_ITEM.lastIndex = 0;
  for (let index = 0; index <= TEMPLATE_LIMITS.listItemsMax && LIST_ITEM.lastIndex < inner.length; index++) {
    const start = LIST_ITEM.lastIndex;
    const match = LIST_ITEM.exec(inner);
    if (match === null) {
      return inner.slice(start).trim() === '' ? { kind: 'list', items } : { kind: 'code' };
    }
    const item = expressionValue(match[1] ?? '');
    if (item.kind !== 'literal' || typeof item.value !== 'string') {
      return { kind: 'code' };
    }
    items.push(item.value);
  }
  if (LIST_ITEM.lastIndex < inner.length && inner.slice(LIST_ITEM.lastIndex).trim() !== '') {
    return { kind: 'code' };
  }
  return items.length <= TEMPLATE_LIMITS.listItemsMax ? { kind: 'list', items } : { kind: 'code' };
}

/** The value class a prop's rendering can depend on. Within one class only string and
 * number props vary, and only through their holes. */
export function valueClass(kind: PropKind, value: AttrValue): string | undefined {
  if (value.kind === 'absent') {
    return 'absent';
  }
  if (value.kind === 'code') {
    return undefined;
  }
  if (value.kind === 'list') {
    return kind.kind === 'list' ? `items:${value.items.length}` : undefined;
  }
  const literal = value.value;
  switch (kind.kind) {
    case 'boolean':
      return typeof literal === 'boolean' ? String(literal) : undefined;
    case 'enum':
      return kind.options.includes(String(literal)) ? `option:${String(literal)}` : undefined;
    case 'string':
      return typeof literal === 'string' ? (literal === '' ? 'empty' : 'value') : undefined;
    case 'number':
      return typeof literal === 'number' && Number.isFinite(literal) ? (literal === 0 ? 'zero' : 'value') : undefined;
    case 'list':
      return undefined;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Every class a prop can take, in a fixed order, so states are enumerated the same
 * way at bake time and when reading them. */
export function valueClasses(kind: PropKind): readonly string[] {
  switch (kind.kind) {
    case 'boolean':
      return ['true', 'false', 'absent'];
    case 'enum':
      return [...kind.options.slice(0, TEMPLATE_LIMITS.optionsMax).map((option) => `option:${option}`), 'absent'];
    case 'string':
      return ['value', 'empty', 'absent'];
    case 'number':
      return ['value', 'zero', 'absent'];
    case 'list':
      return [...Array.from({ length: TEMPLATE_LIMITS.listItemsMax + 1 }, (_, length) => `items:${length}`), 'absent'];
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The classes a state key indexes: 'code' (a value only the page's code knows, kept
 * as written), then every class the prop can take. */
export function stateClasses(kind: PropKind): readonly string[] {
  return ['code', ...valueClasses(kind)];
}

/** Whether a prop picks between pre-rendered states rather than filling a hole. */
export function isChoiceKind(kind: PropKind): boolean {
  return kind.kind === 'boolean' || kind.kind === 'enum';
}

const KEY_RADIX = 36;

/** A state's key: one character per prop, in the template's prop order, naming its
 * class in stateClasses, then one per slot the template knows, 1 when it is filled.
 * The bake and the demo build it the same way, so a lookup is one string compare. */
export function stateKey(
  props: Readonly<Record<string, TemplateProp>>,
  slots: readonly string[],
  classOf: (name: string) => string,
  filled: (slot: string) => boolean,
): string {
  let key = '';
  for (const [name, prop] of Object.entries(props)) {
    const index = stateClasses(prop.kind).indexOf(classOf(name));
    assert(index >= 0, 'A state key names a class the prop can take');
    assert(index < KEY_RADIX, 'A class index fits one key character');
    key += index.toString(KEY_RADIX);
  }
  for (const slot of slots) {
    key += filled(slot) ? '1' : '0';
  }
  return key;
}

/** Whether a class renders the prop through a hole. */
export function isTemplatedClass(kind: PropKind, value: string): boolean {
  if (kind.kind === 'list') {
    return value.startsWith('items:') && value !== 'items:0';
  }
  return value === 'value' && (kind.kind === 'string' || kind.kind === 'number');
}

/** Astro's own escaping for text and attribute values (html-escaper). */
export function escapeHTML(text: string): string {
  return text.replace(/[&<>'"]/g, (character) => ESCAPES[character] ?? character);
}
const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };

export function holeToken(index: number): string {
  assert(Number.isSafeInteger(index), 'A hole index is an integer');
  assert(index < TEMPLATE_LIMITS.holesMax, 'Holes stay within their limit');
  return `${HOLE_OPEN}${index}${HOLE_CLOSE}`;
}

export function containsHoleCharacters(text: string): boolean {
  return text.includes(HOLE_OPEN) || text.includes(HOLE_CLOSE);
}

/** Splits the slot markers of a rendering out into holes. */
export function slotHoles(html: string, hole: (name: string) => string): string {
  return html.replace(SLOT_MARKER, (_marker, name: string) => hole(name));
}

/** A rendering's HTML from its difference with the base. */
export function stateHTML(template: ComponentTemplate, state: TemplateDifference): string | undefined {
  if (state.hunks !== undefined) {
    return template.base === undefined ? undefined : applyHunks(template.base, state.hunks);
  }
  if (state.prefix === 0 && state.suffix === 0) {
    return state.middle;
  }
  const base = template.base;
  if (base === undefined) {
    return undefined;
  }
  assert(state.prefix + state.suffix <= base.length, 'A state keeps no more of the base than it has');
  return base.slice(0, state.prefix) + state.middle + base.slice(base.length - state.suffix);
}

/** Encodes `html` as its difference from `base`. */
export function stateDifference(base: string | undefined, html: string): TemplateDifference {
  if (base === undefined) {
    return { prefix: 0, suffix: 0, middle: html };
  }
  let prefix = 0;
  const shortest = Math.min(base.length, html.length);
  while (prefix < shortest && base[prefix] === html[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (suffix < shortest - prefix && base[base.length - 1 - suffix] === html[html.length - 1 - suffix]) {
    suffix++;
  }
  // A cut inside a hole token would leave half a token on each side.
  while (prefix > 0 && isInsideHole(base, prefix)) {
    prefix--;
  }
  while (suffix > 0 && isInsideHole(base, base.length - suffix)) {
    suffix--;
  }
  const middle = html.slice(prefix, html.length - suffix);
  const hunks = lineHunks(base, prefix, base.length - suffix, middle);
  // Hunks only where they are much smaller than the one span they would replace.
  if (hunks !== undefined && hunkChars(hunks) * 2 < middle.length) {
    return { prefix: 0, suffix: 0, middle: '', hunks };
  }
  return { prefix, suffix, middle };
}

/** The characters a difference stores, for the bake's budgets. */
export function differenceChars(difference: TemplateDifference): number {
  return difference.hunks === undefined ? difference.middle.length : hunkChars(difference.hunks);
}

function hunkChars(hunks: readonly TemplateHunk[]): number {
  return hunks.reduce((total, [, , text]) => total + text.length + 16, 0);
}

function applyHunks(base: string, hunks: readonly TemplateHunk[]): string {
  let html = '';
  let position = 0;
  for (const [start, end, text] of hunks) {
    assert(start >= position, 'Hunks are in order and apart');
    assert(end <= base.length, 'A hunk stays within the base');
    html += base.slice(position, start) + text;
    position = end;
  }
  return html + base.slice(position);
}

const LINE_DIFF_LIMITS = {
  /** Lines on either side; past it the single span is kept. */
  linesMax: 20_000,
  /** Edit distance in lines (Myers' D); past it the single span is kept. */
  editsMax: 400,
  hunksMax: 2_000,
} as const satisfies Record<string, number>;

/** The line-level hunks that turn base[start, end) into `middle`, by Myers' diff, or
 * undefined past its bounds. Whole lines only, so no hunk cuts a hole token in two. */
function lineHunks(base: string, start: number, end: number, middle: string): readonly TemplateHunk[] | undefined {
  const before = splitLines(base.slice(start, end));
  const after = splitLines(middle);
  if (before.length > LINE_DIFF_LIMITS.linesMax || after.length > LINE_DIFF_LIMITS.linesMax) {
    return undefined;
  }
  const script = myers(before, after);
  if (script === undefined) {
    return undefined;
  }
  const offsets = [start];
  for (const line of before) {
    offsets.push((offsets[offsets.length - 1] ?? start) + line.length);
  }
  const hunks: TemplateHunk[] = [];
  for (const [beforeStart, beforeEnd, afterStart, afterEnd] of script) {
    if (hunks.length >= LINE_DIFF_LIMITS.hunksMax) {
      return undefined;
    }
    hunks.push([offsets[beforeStart] ?? start, offsets[beforeEnd] ?? end, after.slice(afterStart, afterEnd).join('')]);
  }
  assert(applyHunks(base, hunks) === base.slice(0, start) + middle + base.slice(end), 'Hunks rebuild the rendering');
  return hunks;
}

function splitLines(text: string): readonly string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Myers' O((N+M)D) diff over lines: each changed region as [before start, before end,
 * after start, after end], or undefined when the edit distance passes its bound. */
function myers(before: readonly string[], after: readonly string[]): readonly (readonly [number, number, number, number])[] | undefined {
  const size = before.length + after.length;
  const offset = size + 1;
  const trace: Int32Array[] = [];
  const frontier = new Int32Array(2 * offset + 1);
  let found = -1;
  for (let edits = 0; edits <= Math.min(size, LINE_DIFF_LIMITS.editsMax) && found < 0; edits++) {
    trace.push(frontier.slice());
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      const down = diagonal === -edits || (diagonal !== edits && (frontier[offset + diagonal - 1] ?? 0) < (frontier[offset + diagonal + 1] ?? 0));
      let x = down ? (frontier[offset + diagonal + 1] ?? 0) : (frontier[offset + diagonal - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
      }
      frontier[offset + diagonal] = x;
      if (x >= before.length && y >= after.length) {
        found = edits;
        break;
      }
    }
  }
  if (found < 0) {
    return undefined;
  }
  // Walk the trace back into matched runs, then the gaps between them are the hunks.
  const matches: [number, number, number][] = [];
  let x = before.length;
  let y = after.length;
  for (let edits = found; edits > 0; edits--) {
    const previous = trace[edits] ?? frontier;
    const diagonal = x - y;
    const down = diagonal === -edits || (diagonal !== edits && (previous[offset + diagonal - 1] ?? 0) < (previous[offset + diagonal + 1] ?? 0));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = previous[offset + previousDiagonal] ?? 0;
    const previousY = previousX - previousDiagonal;
    const startX = down ? previousX : previousX + 1;
    const startY = down ? previousY + 1 : previousY;
    if (x > startX) {
      matches.push([startX, startY, x - startX]);
    }
    x = previousX;
    y = previousY;
  }
  if (x > 0) {
    matches.push([0, 0, x]);
  }
  matches.reverse();
  const regions: [number, number, number, number][] = [];
  let beforeAt = 0;
  let afterAt = 0;
  for (const [matchX, matchY, length] of [...matches, [before.length, after.length, 0] as [number, number, number]]) {
    if (matchX > beforeAt || matchY > afterAt) {
      regions.push([beforeAt, matchX, afterAt, matchY]);
    }
    beforeAt = matchX + length;
    afterAt = matchY + length;
  }
  return regions;
}

function isInsideHole(text: string, position: number): boolean {
  const open = text.lastIndexOf(HOLE_OPEN, position - 1);
  return open >= 0 && text.indexOf(HOLE_CLOSE, open) >= position;
}

/** A rendering with every hole but the slots filled. Slots stay as named gaps. */
export type TemplateOutput = readonly (string | { readonly slot: string })[];

export type RenderRefusal = 'slots' | 'attribute' | 'combination' | 'state';

export type RenderResult = { readonly ok: true; readonly output: TemplateOutput } | { readonly ok: false; readonly reason: RenderRefusal };

const IGNORED_ATTRIBUTE = /^(slot|data-avb-[pd])$/;

function sameAttr(left: Attr | undefined, right: Attr | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface Change {
  readonly name: string;
  /** The class the instance now has, after collapsing an explicit default. */
  readonly after: string;
}

/** The instance as `attrs` and `slots` describe it, from this template, or why not. */
export function renderTemplate(
  template: ComponentTemplate,
  attrs: Readonly<Record<string, Attr>>,
  slots: readonly string[],
  path: string,
  scopes: readonly string[] = [],
): RenderResult {
  if (slots.some((slot) => !template.slots.includes(slot))) {
    return { ok: false, reason: 'slots' };
  }
  const names = new Set([...Object.keys(attrs), ...Object.keys(template.fixed)].filter((name) => !IGNORED_ATTRIBUTE.test(name)));
  for (const name of names) {
    if (template.props[name] === undefined && !sameAttr(attrs[name], template.fixed[name])) {
      return { ok: false, reason: 'attribute' };
    }
  }
  const values = new Map<string, Literal>();
  const classes = new Map<string, string>();
  const changes: Change[] = [];
  for (const [name, prop] of Object.entries(template.props)) {
    const base = attrValue(prop.attr);
    const baseClass = valueClass(prop.kind, base) ?? 'code';
    if (sameAttr(attrs[name], prop.attr)) {
      classes.set(name, baseClass);
      for (const [hole, literal] of holeValues(name, base)) {
        values.set(hole, literal);
      }
      continue;
    }
    const value = attrValue(attrs[name]);
    const after = valueClass(prop.kind, value);
    if (after === undefined) {
      return { ok: false, reason: 'attribute' };
    }
    for (const [hole, literal] of holeValues(name, value)) {
      values.set(hole, literal);
    }
    const collapsed = template.collapsed[name] === after ? 'absent' : after;
    classes.set(name, collapsed);
    changes.push({ name, after: collapsed });
  }
  const key = stateKey(
    template.props,
    template.slots,
    (name) => classes.get(name) ?? 'code',
    (slot) => slots.includes(slot),
  );
  const chosen = chooseState(template, key, changes);
  if (chosen === undefined) {
    return { ok: false, reason: changes.length > 1 ? 'combination' : 'state' };
  }
  const html = stateHTML(template, chosen.difference);
  if (html === undefined) {
    return { ok: false, reason: 'state' };
  }
  return { ok: true, output: fillHoles(template, html, values, path, scopes) };
}

interface ChosenState {
  readonly difference: TemplateDifference;
  readonly templated: readonly string[];
}

const stateIndexes = new WeakMap<ComponentTemplate, ReadonlyMap<string, TemplateState>>();

/** The template's states by key, built once per template. */
function statesByKey(template: ComponentTemplate): ReadonlyMap<string, TemplateState> {
  let index = stateIndexes.get(template);
  if (index === undefined) {
    index = new Map(template.states.map((state) => [state.key, state]));
    stateIndexes.set(template, index);
  }
  return index;
}

function chooseState(template: ComponentTemplate, key: string, changes: readonly Change[]): ChosenState | undefined {
  const state = statesByKey(template).get(key);
  const difference = state === undefined ? undefined : template.outputs[state.output];
  if (state !== undefined && difference !== undefined && changes.every((change) => !isTextChange(template, change) || state.templated.includes(change.name))) {
    return { difference, templated: state.templated };
  }
  // The shared run disagreed, or a number kept its class but not its value. One changed
  // prop can still use its own single, which holds every other prop at its base value
  // and every slot as the base filled it. A single renders its prop through a hole, so
  // it serves only a change that keeps the prop's text class: a prop moved to another
  // class (an absent title) or a slot left empty is another state, and refuses here so
  // the caller can try another template of the file.
  if (!slotsAsBase(template, key)) {
    return undefined;
  }
  const [only] = changes;
  if (changes.length === 1 && only !== undefined) {
    const single = isTextChange(template, only) ? template.singles[only.name] : undefined;
    return single === undefined ? undefined : { difference: single, templated: single.templated };
  }
  const single = changes.length === 0 ? Object.values(template.singles)[0] : undefined;
  return single === undefined ? undefined : { difference: single, templated: single.templated };
}

/** Whether a state key fills every slot the template knows, as its base does. */
function slotsAsBase(template: ComponentTemplate, key: string): boolean {
  const propCount = Object.keys(template.props).length;
  assert(key.length === propCount + template.slots.length, 'A state key has one character per prop and slot');
  return /^1*$/.test(key.slice(propCount));
}

/** A change that stays within its class: only a hole can show it. */
function isTextChange(template: ComponentTemplate, change: Change): boolean {
  const prop = template.props[change.name];
  return prop !== undefined && isTemplatedClass(prop.kind, change.after);
}

function fillHoles(template: ComponentTemplate, html: string, values: ReadonlyMap<string, Literal>, path: string, scopes: readonly string[]): TemplateOutput {
  const output: (string | { slot: string })[] = [];
  let position = 0;
  let scope = 0;
  for (const match of html.matchAll(HOLE)) {
    const hole = template.holes[Number(match[1])];
    assert(hole !== undefined, 'Every hole token names a hole');
    output.push(html.slice(position, match.index));
    position = match.index + match[0].length;
    switch (hole.kind) {
      case 'path':
        output.push(path);
        break;
      case 'scope':
        // A new rendering with more scopes than the page had numbers them past it.
        output.push(scopes[scope] ?? `astro-stacki-${scope}`);
        scope++;
        break;
      case 'slot':
        output.push({ slot: hole.name });
        break;
      case 'prop': {
        const value = values.get(hole.name);
        assert(value !== undefined, 'A prop hole is filled only for a prop that has a value');
        output.push(hole.mode === 'escaped' ? escapeHTML(String(value)) : String(value));
        break;
      }
      default: {
        const exhaustive: never = hole;
        return exhaustive;
      }
    }
  }
  output.push(html.slice(position));
  return output;
}

/** The output as one string, each slot given by `slot`. */
export function joinOutput(output: TemplateOutput, slot: (name: string) => string): string {
  return output.map((part) => (typeof part === 'string' ? part : slot(part.slot))).join('');
}

/** The slots an instance fills: children grouped by their `slot` attribute. */
export function filledSlots(
  children: readonly { readonly kind: string; readonly value?: string | undefined; readonly props?: Readonly<Record<string, Attr>> | undefined }[],
): readonly string[] | undefined {
  const names = new Set<string>();
  for (const child of children) {
    if (child.kind === 'text' && (child.value ?? '').trim() === '') {
      continue;
    }
    if (child.kind === 'comment') {
      continue;
    }
    const slot = child.props?.['slot'];
    if (slot === undefined) {
      names.add('default');
    } else if (slot.type === 'string' && /^[\w-]+$/.test(slot.value)) {
      names.add(slot.value);
    } else {
      return undefined; // A slot named by code: only Astro knows where it goes.
    }
  }
  return [...names].sort();
}

/** The component file a page's import resolves to, as the bake and the demo read it. */
export function componentFileOf(page: string, specifier: string): string | undefined {
  const path = specifier.startsWith('@/')
    ? `src/${specifier.slice(2)}`
    : specifier.startsWith('.')
      ? `${page.split('/').slice(0, -1).join('/')}/${specifier}`
      : undefined;
  if (path === undefined || !path.endsWith('.astro')) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

// The snapshot carries the catalog across the network, so every part is checked and
// bounded before a template is trusted to fill a page.
function object(input: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`Component catalog ${where}: expected an object`);
  }
  return Object.fromEntries(Object.entries(input));
}

function text(input: unknown, where: string, maximum: number): string {
  if (typeof input !== 'string' || input.length > maximum) {
    throw new Error(`Component catalog ${where}: expected text within ${maximum} characters`);
  }
  return input;
}

function count(input: unknown, where: string, maximum: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > maximum) {
    throw new Error(`Component catalog ${where}: expected a count within ${maximum}`);
  }
  return input;
}

function array(input: unknown, where: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new Error(`Component catalog ${where}: expected a list within ${maximum}`);
  }
  return input;
}

function parseAttr(input: unknown, where: string): Attr {
  const data = object(input, where);
  const type = data['type'];
  if (type === 'bare') {
    return { type };
  }
  if (type === 'string' || type === 'expr' || type === 'spread') {
    return { type, value: text(data['value'], `${where}.value`, TEMPLATE_LIMITS.htmlCharsMax) };
  }
  throw new Error(`Component catalog ${where}: unknown attribute type`);
}

function parseKind(input: unknown, where: string): PropKind {
  const data = object(input, where);
  switch (data['kind']) {
    case 'boolean':
    case 'string':
    case 'number':
    case 'list':
      return { kind: data['kind'] };
    case 'enum':
      return {
        kind: 'enum',
        options: array(data['options'], `${where}.options`, TEMPLATE_LIMITS.optionsMax).map((option, index) => text(option, `${where}.options[${index}]`, 200)),
        numeric: data['numeric'] === true,
      };
    default:
      throw new Error(`Component catalog ${where}: unknown prop kind`);
  }
}

function parseHole(input: unknown, where: string): Hole {
  const data = object(input, where);
  switch (data['kind']) {
    case 'path':
      return { kind: 'path' };
    case 'scope':
      return { kind: 'scope' };
    case 'slot':
      return { kind: 'slot', name: text(data['name'], `${where}.name`, 100) };
    case 'prop': {
      const mode = data['mode'];
      if (mode !== 'escaped' && mode !== 'raw') {
        throw new Error(`Component catalog ${where}: unknown hole mode`);
      }
      return { kind: 'prop', name: text(data['name'], `${where}.name`, 200), mode };
    }
    default:
      throw new Error(`Component catalog ${where}: unknown hole`);
  }
}

function parseTemplated(input: unknown, where: string, props: Readonly<Record<string, TemplateProp>>): readonly string[] {
  const templated = array(input, `${where}.templated`, TEMPLATE_LIMITS.propsMax).map((name, index) => text(name, `${where}.templated[${index}]`, 200));
  for (const name of templated) {
    if (props[name] === undefined) {
      throw new Error(`Component catalog ${where}: a hole for a prop the template does not have`);
    }
  }
  return templated;
}

function parseDifference(input: unknown, where: string): TemplateDifference {
  const data = object(input, where);
  if (data['hunks'] !== undefined) {
    let position = 0;
    const hunks = array(data['hunks'], `${where}.hunks`, LINE_DIFF_LIMITS.hunksMax).map((hunk, index): TemplateHunk => {
      const parts = array(hunk, `${where}.hunks[${index}]`, 3);
      const start = count(parts[0], `${where}.hunks[${index}][0]`, TEMPLATE_LIMITS.htmlCharsMax);
      const end = count(parts[1], `${where}.hunks[${index}][1]`, TEMPLATE_LIMITS.htmlCharsMax);
      if (start < position || end < start) {
        throw new Error(`Component catalog ${where}: hunks out of order`);
      }
      position = end;
      return [start, end, text(parts[2], `${where}.hunks[${index}][2]`, TEMPLATE_LIMITS.htmlCharsMax)];
    });
    return { prefix: 0, suffix: 0, middle: '', hunks };
  }
  return {
    prefix: count(data['prefix'], `${where}.prefix`, TEMPLATE_LIMITS.htmlCharsMax),
    suffix: count(data['suffix'], `${where}.suffix`, TEMPLATE_LIMITS.htmlCharsMax),
    middle: text(data['middle'], `${where}.middle`, TEMPLATE_LIMITS.htmlCharsMax),
  };
}

function parseState(input: unknown, where: string, template: Pick<ComponentTemplate, 'props' | 'slots'>, outputs: number): TemplateState {
  const data = object(input, where);
  const key = text(data['key'], `${where}.key`, TEMPLATE_LIMITS.propsMax + TEMPLATE_LIMITS.slotsMax);
  // Pair with stateKey: one character per prop, each naming a class the prop has, then one per slot.
  const props = Object.values(template.props);
  if (key.length !== props.length + template.slots.length) {
    throw new Error(`Component catalog ${where}: a key of the wrong length`);
  }
  props.forEach((prop, index) => {
    const position = Number.parseInt(key[index] ?? '', KEY_RADIX);
    if (!(position < stateClasses(prop.kind).length)) {
      throw new Error(`Component catalog ${where}: a key names a class the prop does not have`);
    }
  });
  if (!/^[01]*$/.test(key.slice(props.length))) {
    throw new Error(`Component catalog ${where}: a key's slots are not 0 or 1`);
  }
  return { key, output: count(data['output'], `${where}.output`, outputs - 1), templated: parseTemplated(data['templated'], where, template.props) };
}

function parseTemplate(input: unknown, where: string): ComponentTemplate {
  const data = object(input, where);
  const props: Record<string, TemplateProp> = {};
  const propEntries = Object.entries(object(data['props'], `${where}.props`));
  if (propEntries.length > TEMPLATE_LIMITS.propsMax) {
    throw new Error(`Component catalog ${where}: too many props`);
  }
  for (const [name, value] of propEntries) {
    const prop = object(value, `${where}.props.${name}`);
    const kind = parseKind(prop['kind'], `${where}.props.${name}.kind`);
    props[name] = prop['attr'] === undefined ? { kind } : { kind, attr: parseAttr(prop['attr'], `${where}.props.${name}.attr`) };
  }
  const fixed: Record<string, Attr> = {};
  for (const [name, value] of Object.entries(object(data['fixed'], `${where}.fixed`)).slice(0, TEMPLATE_LIMITS.propsMax * 4)) {
    fixed[name] = parseAttr(value, `${where}.fixed.${name}`);
  }
  const collapsed: Record<string, string> = {};
  for (const [name, value] of Object.entries(object(data['collapsed'], `${where}.collapsed`))) {
    const prop = props[name];
    const explicit = text(value, `${where}.collapsed.${name}`, 300);
    if (prop === undefined || !isChoiceKind(prop.kind) || !valueClasses(prop.kind).includes(explicit) || explicit === 'absent') {
      throw new Error(`Component catalog ${where}: a collapsed default the prop cannot take`);
    }
    collapsed[name] = explicit;
  }
  const singles: Record<string, TemplateSingle> = {};
  for (const [name, value] of Object.entries(object(data['singles'], `${where}.singles`)).slice(0, TEMPLATE_LIMITS.propsMax)) {
    if (props[name] === undefined) {
      throw new Error(`Component catalog ${where}: a single for a prop the template does not have`);
    }
    singles[name] = {
      ...parseDifference(value, `${where}.singles.${name}`),
      templated: parseTemplated(object(value, where)['templated'], `${where}.singles.${name}`, props),
    };
  }
  const holes = array(data['holes'], `${where}.holes`, TEMPLATE_LIMITS.holesMax).map((hole, index) => parseHole(hole, `${where}.holes[${index}]`));
  const slots = array(data['slots'], `${where}.slots`, TEMPLATE_LIMITS.slotsMax).map((slot, index) => text(slot, `${where}.slots[${index}]`, 100));
  const outputs = array(data['outputs'], `${where}.outputs`, TEMPLATE_LIMITS.outputsMax).map((output, index) =>
    parseDifference(output, `${where}.outputs[${index}]`),
  );
  const states = array(data['states'], `${where}.states`, TEMPLATE_LIMITS.statesMax).map((state, index) =>
    parseState(state, `${where}.states[${index}]`, { props, slots }, outputs.length),
  );
  if (new Set(states.map((state) => state.key)).size !== states.length) {
    throw new Error(`Component catalog ${where}: two states share a key`);
  }
  const template: ComponentTemplate = {
    file: text(data['file'], `${where}.file`, 500),
    slots,
    props,
    fixed,
    holes,
    base: data['base'] === undefined ? undefined : text(data['base'], `${where}.base`, TEMPLATE_LIMITS.htmlCharsMax),
    collapsed,
    outputs,
    states,
    singles,
  };
  // Pair with the producer: every hunk stays within the base, and every hole token in
  // every rendering names a hole. The renderings are checked piece by piece (the base
  // once, then each difference's own text) rather than rebuilt: rebuilding them all
  // was about 170 million characters for the demo's site, most of the snapshot's load.
  const baseValid = template.base === undefined || namesOnlyHoles(template.base, holes.length);
  for (const difference of [...template.outputs, ...Object.values(template.singles)]) {
    const last = difference.hunks?.[difference.hunks.length - 1];
    if (difference.hunks !== undefined && (template.base === undefined || (last !== undefined && last[1] > template.base.length))) {
      throw new Error(`Component catalog ${where}: a hunk outside the base`);
    }
    if (!renderingNamesOnlyHoles(template, difference, baseValid, holes.length)) {
      throw new Error(`Component catalog ${where}: a hole token names no hole`);
    }
  }
  return template;
}

/** Whether every hole token in `text` names one of `count` holes. */
function namesOnlyHoles(text: string, count: number): boolean {
  for (const match of text.matchAll(HOLE)) {
    if (Number(match[1]) >= count) {
      return false;
    }
  }
  return true;
}

/** Whether every hole token in a difference's rendering names a hole. Each piece of the
 * rendering is checked on its own; a token can only span the seam after a piece that
 * ends inside one (a hole opening, then digits), and a rendering with such a seam, or
 * whose base itself fails, is rebuilt and checked whole, so the answer is always the
 * rebuilt rendering's. */
function renderingNamesOnlyHoles(template: ComponentTemplate, difference: TemplateDifference, baseValid: boolean, count: number): boolean {
  const joined = renderingPieces(template, difference);
  // An empty piece adds nothing to the rendering, so it is no seam of its own.
  const pieces = (joined ?? []).filter((piece) => piece.start < piece.end);
  let piecewise = joined !== undefined && (baseValid || pieces.every((piece) => !piece.fromBase));
  for (const [index, piece] of pieces.entries()) {
    if (!piecewise) {
      break;
    }
    // A token wholly inside one piece is a token of the rendering. A slice of a base
    // already checked whole holds only the base's tokens, cut ones aside.
    if (!piece.fromBase && !namesOnlyHoles(piece.text.slice(piece.start, piece.end), count)) {
      return false;
    }
    // The last piece has no seam after it.
    if (index < pieces.length - 1 && mayOpenToken(piece.text, piece.start, piece.end)) {
      piecewise = false;
    }
  }
  if (piecewise) {
    return true;
  }
  return namesOnlyHoles(stateHTML(template, difference) ?? '', count);
}

interface RenderingPiece {
  /** A slice of the template's base, whose tokens were checked with the base. */
  readonly fromBase: boolean;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The runs a rendering is joined from, in order, as stateHTML joins them; undefined
 * when it needs a base the template does not have. */
function renderingPieces(template: ComponentTemplate, difference: TemplateDifference): readonly RenderingPiece[] | undefined {
  const base = template.base;
  if (difference.hunks !== undefined) {
    if (base === undefined) {
      return undefined;
    }
    const pieces: RenderingPiece[] = [];
    let position = 0;
    for (const [start, end, text] of difference.hunks) {
      pieces.push({ fromBase: true, text: base, start: position, end: start }, { fromBase: false, text, start: 0, end: text.length });
      position = end;
    }
    pieces.push({ fromBase: true, text: base, start: position, end: base.length });
    return pieces;
  }
  if (difference.prefix === 0 && difference.suffix === 0) {
    return [{ fromBase: false, text: difference.middle, start: 0, end: difference.middle.length }];
  }
  if (base === undefined || difference.prefix + difference.suffix > base.length) {
    return undefined;
  }
  return [
    { fromBase: true, text: base, start: 0, end: difference.prefix },
    { fromBase: false, text: difference.middle, start: 0, end: difference.middle.length },
    { fromBase: true, text: base, start: base.length - difference.suffix, end: base.length },
  ];
}

/** Whether text[start, end) could end partway through a hole token: it ends in a hole
 * opening and digits, or holds only digits, so what came before it decides. */
function mayOpenToken(text: string, start: number, end: number): boolean {
  let position = end;
  while (position > start && isDigit(text.charCodeAt(position - 1))) {
    position--;
  }
  return position === start || text[position - 1] === HOLE_OPEN;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function parseComponentCatalog(input: unknown): ComponentCatalog {
  if (input === undefined) {
    return EMPTY_CATALOG;
  }
  const data = object(input, 'root');
  const templates = array(data['templates'], 'templates', TEMPLATE_LIMITS.templatesMax).map((template, index) =>
    parseTemplate(template, `templates[${index}]`),
  );
  const instances: Record<string, Record<string, number>> = {};
  let total = 0;
  for (const [page, paths] of Object.entries(object(data['instances'], 'instances'))) {
    const parsed: Record<string, number> = {};
    for (const [path, index] of Object.entries(object(paths, `instances.${page}`))) {
      total++;
      if (total > TEMPLATE_LIMITS.instancesMax) {
        throw new Error('Component catalog: too many instances');
      }
      parsed[text(path, `instances.${page} path`, 500)] = count(index, `instances.${page}.${path}`, templates.length - 1);
    }
    instances[text(page, 'instances page', 500)] = parsed;
  }
  return { templates, instances };
}
