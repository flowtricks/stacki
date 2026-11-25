// i18n-ignore-file: the bake is the `astro-studio build-demo` command line tool; its messages are developer diagnostics in a terminal, not Studio interface text.
// The bake-time half of componentTemplates.ts: which extra renderings each page asks
// the build for, and what the build's answers teach. A probe is a component written
// at the end of a page's template, after everything the page renders, so it runs in
// the same build, with the same frontmatter in scope, the same image pipeline and the
// same markers as the instance it stands for. Each probe's output is fenced by marker
// comments and cut out of the page again before the page is baked.
import { serializeAttrs } from '../../../vendor/stacki/electron/parse/astroAttrs';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { Attr } from '../../../vendor/stacki/shared/page/pageNodeTypes';
import { pathFor } from '../project/previewSelection';
import { parsePage, type ParserNode } from '../source/source';
import {
  attrValue,
  componentFileOf,
  containsHoleCharacters,
  escapeHTML,
  filledSlots,
  holeToken,
  differenceChars,
  entryInstancesKey,
  holeValues,
  isChoiceKind,
  isTemplatedClass,
  listItemName,
  PATH_SENTINEL,
  slotHoles,
  slotMarker,
  stateDifference,
  stateKey,
  TEMPLATE_LIMITS,
  TRANSITION_SCOPE,
  valueClass,
  valueClasses,
  type ComponentCatalog,
  type ComponentTemplate,
  type Hole,
  type Literal,
  type PropKind,
  type TemplateDifference,
  type TemplateProp,
  type TemplateSingle,
  type TemplateState,
} from './componentTemplates';

export const PROBE_LIMITS = {
  /** Renderings one page may ask for; past it the page's remaining instances refuse. */
  rendersPerPageMax: 40_000,
  instancesPerPageMax: 400,
  depthMax: 200,
  /** Combinations tried while enumerating one instance's states, valid or not. */
  enumerationStepsMax: 200_000,
} as const satisfies Record<string, number>;

/** One arm of a discriminated props union, as the project scan reports it: the props
 * that arm forbids, and the values it pins props to. */
export interface ScanUnionBranch {
  readonly forbids: readonly string[];
  readonly pins: Readonly<Record<string, readonly string[]>>;
}

export interface ScanUnion {
  readonly names: readonly string[];
  readonly branches: readonly ScanUnionBranch[];
}

/** A component field as the project scan reports it. */
export interface ScanField {
  readonly name: string;
  readonly type: string;
  readonly options?: readonly string[] | undefined;
  readonly numeric?: boolean | undefined;
  /** The default the component's destructuring gives, when it is a literal. */
  readonly default?: string | number | boolean | undefined;
  readonly defaultExpr?: boolean | undefined;
  /** The component's props unions; every field of a component carries the same list. */
  readonly unions?: readonly ScanUnion[] | undefined;
  /** False for a prop the component's types require. */
  readonly optional?: boolean | undefined;
}

/** The props a component requires and gives no default: a probe without one renders
 * what the component's types forbid, and a component that reads it would throw. */
export function requiredProps(fields: readonly ScanField[]): readonly string[] {
  return fields.filter((field) => field.optional === false && field.default === undefined).map((field) => field.name);
}

/** What the component's types allow, for choosing which combinations to render. */
export interface ProbeSpace {
  /** Each prop's literal default, as text, for reading a pin on an absent prop. */
  readonly defaults: Readonly<Record<string, string>>;
  /** Each choice prop's explicit default class, which renders as its absence when the
   * bake can confirm it. The states use absence, as Studio writes a default. */
  readonly explicit: Readonly<Record<string, string>>;
  readonly unions: readonly ScanUnion[];
  /** Props never left unset (requiredProps). */
  readonly required: readonly string[];
}

/** What a probe stands for: an instance on a page, or a recipe rendered on a page that
 * already uses the component, so nothing about that page's styles changes. */
export interface ProbeSpec {
  readonly file: string;
  /** The component's local name on the page that renders the probe. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, Attr>>;
  readonly order: readonly string[];
  readonly slots: readonly string[];
  readonly props: Readonly<Record<string, TemplateProp>>;
  readonly fixed: Readonly<Record<string, Attr>>;
  /** The page's own stamp, for an instance at the top of the page's template. */
  readonly stamp: string | undefined;
  readonly instance: { readonly page: string; readonly path: string } | undefined;
  readonly space: ProbeSpace;
}

type ProbeValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'literal'; readonly value: Literal }
  /** A list of this many items; its sentinels name each one per run. */
  | { readonly kind: 'list'; readonly length: number };

interface ProbeRender {
  readonly id: number;
  readonly spec: number;
  /** A state index, or a prop name for that prop's single. */
  readonly target:
    | { readonly kind: 'state'; readonly index: number }
    | { readonly kind: 'single'; readonly prop: string }
    /** The base with every prop at its own value: what the page itself rendered. */
    | { readonly kind: 'actual' };
  readonly run: 0 | 1;
  /** The sentinel each templated prop was given in this run. */
  readonly sentinels: ReadonlyMap<string, Literal>;
}

export interface PageProbes {
  /** Appended to the page's marked template. */
  readonly markup: string;
  readonly renders: readonly ProbeRender[];
}

export interface ProbePlan {
  readonly specs: readonly ProbeSpec[];
  readonly states: readonly (readonly StatePlan[])[];
  readonly pages: ReadonlyMap<string, PageProbes>;
}

export interface StatePlan {
  readonly key: string;
  /** Each prop's class in this state. */
  readonly classes: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, ProbeValue>;
  /** The slots this state fills; a slot left out renders as if nothing were written in it. */
  readonly slots: readonly string[];
  readonly templated: readonly string[];
}

const PROBE_OPEN = /<!--stacki-probe:(\d+)-->/g;

/** The kinds of field the demo can model; any other prop is fixed. */
export function propKind(field: ScanField): PropKind | undefined {
  switch (field.type) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'string':
      return { kind: 'string' };
    case 'number':
      return { kind: 'number' };
    case 'enum':
      return field.options !== undefined && field.options.length > 0 && field.options.length <= TEMPLATE_LIMITS.optionsMax
        ? { kind: 'enum', options: field.options, numeric: field.numeric === true }
        : undefined;
    default:
      // A class list is written as a string on every instance a person edits.
      return field.name === 'class' ? { kind: 'string' } : undefined;
  }
}

/** Builds the spec for one component use from its written attributes. */
export function probeSpec(input: {
  readonly file: string;
  readonly name: string;
  readonly node: Pick<ParserNode, 'props' | 'attrOrder'>;
  readonly slots: readonly string[];
  readonly fields: readonly ScanField[];
  readonly stamp: string | undefined;
  readonly instance: ProbeSpec['instance'];
}): ProbeSpec {
  const attrs: Record<string, Attr> = {};
  for (const [name, attr] of Object.entries(input.node.props ?? {})) {
    // `slot` stays: a component that spreads its props renders it, as the page did.
    if (!name.startsWith('data-avb-')) {
      attrs[name] = attr;
    }
  }
  const props: Record<string, TemplateProp> = {};
  for (const field of input.fields.slice(0, TEMPLATE_LIMITS.propsMax)) {
    const attr = attrs[field.name];
    // A list is a list by what the instance writes: the scan types it only as code.
    const kind = propKind(field) ?? (attrValue(attr).kind === 'list' ? { kind: 'list' as const } : undefined);
    if (kind !== undefined && valueClass(kind, attrValue(attr)) !== undefined) {
      props[field.name] = attr === undefined ? { kind } : { kind, attr };
    } else if (kind !== undefined && attr !== undefined && attrValue(attr).kind === 'code') {
      props[field.name] = { kind, attr }; // Code stays as written; a literal may replace it.
    }
  }
  const fixed: Record<string, Attr> = {};
  for (const [name, attr] of Object.entries(attrs)) {
    if (props[name] === undefined) {
      fixed[name] = attr;
    }
  }
  const order = (input.node.attrOrder ?? Object.keys(attrs)).filter((name) => attrs[name] !== undefined || name.startsWith('...'));
  return {
    file: input.file,
    name: input.name,
    attrs,
    order,
    slots: input.slots,
    props,
    fixed,
    stamp: input.stamp,
    instance: input.instance,
    space: probeSpace(input.fields, props),
  };
}

function probeSpace(fields: readonly ScanField[], props: Readonly<Record<string, TemplateProp>>): ProbeSpace {
  const defaults: Record<string, string> = {};
  const explicit: Record<string, string> = {};
  for (const field of fields) {
    const literal = field.defaultExpr === true ? undefined : field.default;
    if (literal !== undefined) {
      defaults[field.name] = String(literal);
    }
    const kind = props[field.name]?.kind;
    if (kind?.kind === 'boolean') {
      explicit[field.name] = literal === true ? 'true' : 'false';
    } else if (kind?.kind === 'enum' && literal !== undefined && kind.options.includes(String(literal))) {
      explicit[field.name] = `option:${String(literal)}`;
    }
  }
  const unions = (fields.find((field) => field.unions !== undefined)?.unions ?? []).slice(0, TEMPLATE_LIMITS.propsMax);
  return { defaults, explicit, unions, required: requiredProps(fields) };
}

/** The states a spec renders, nearest the instance's own values first: the base, the
 * checks that an explicit default renders as its absence, then by distance every
 * combination of choice props the component's types allow, each followed one step
 * later by its moves of a single text prop or slot. Bounded by statesMax. */
export function specStates(spec: ProbeSpec): readonly StatePlan[] {
  const names = Object.keys(spec.props);
  const baseClasses = new Map<string, string>();
  for (const [name, prop] of Object.entries(spec.props)) {
    baseClasses.set(name, valueClass(prop.kind, attrValue(prop.attr)) ?? 'code');
  }
  const choices = names.filter((name) => isChoiceKind(spec.props[name]?.kind ?? { kind: 'string' }));
  const texts = names.filter((name) => !choices.includes(name));
  const states: StatePlan[] = [];
  const keys = new Set<string>();
  const add = (classes: ReadonlyMap<string, string>, slots: readonly string[]): void => {
    if (states.length >= TEMPLATE_LIMITS.statesMax) {
      return;
    }
    const plan = statePlan(spec, baseClasses, classes, slots);
    if (!keys.has(plan.key)) {
      keys.add(plan.key);
      states.push(plan);
    }
  };
  add(baseClasses, spec.slots);
  for (const name of choices) {
    const explicit = collapsibleClass(spec, baseClasses, name);
    if (explicit !== undefined) {
      add(new Map(baseClasses).set(name, explicit), spec.slots);
    }
  }
  const options = choices.map((name) => choiceOptions(spec, baseClasses, name));
  let previous: ReadonlyMap<string, string>[] = [];
  let steps = 0;
  for (let distance = 0; distance <= choices.length + 1 && states.length < TEMPLATE_LIMITS.statesMax; distance++) {
    const level: ReadonlyMap<string, string>[] = [];
    if (distance <= choices.length) {
      steps += choiceLevel(choices, options, baseClasses, distance, PROBE_LIMITS.enumerationStepsMax - steps, (classes) => {
        if (allowed(spec.space, classes)) {
          level.push(classes);
          add(classes, spec.slots);
        }
        return states.length < TEMPLATE_LIMITS.statesMax;
      });
    }
    for (const classes of previous) {
      for (const name of texts) {
        for (const value of stateClassesOf(spec, baseClasses, name)) {
          const moved = new Map(classes).set(name, value);
          if (value !== baseClasses.get(name) && allowed(spec.space, moved)) {
            add(moved, spec.slots);
          }
        }
      }
      for (const slot of spec.slots) {
        add(
          classes,
          spec.slots.filter((other) => other !== slot),
        );
      }
    }
    previous = level;
  }
  assert(states[0]?.key === statePlan(spec, baseClasses, baseClasses, spec.slots).key, 'The base is the first state');
  assert(states.length <= TEMPLATE_LIMITS.statesMax, 'States stay within their limit');
  return states;
}

function statePlan(spec: ProbeSpec, baseClasses: ReadonlyMap<string, string>, classes: ReadonlyMap<string, string>, slots: readonly string[]): StatePlan {
  const overrides = new Map<string, ProbeValue>();
  const templated: string[] = [];
  for (const [name, prop] of Object.entries(spec.props)) {
    const value = classes.get(name) ?? 'code';
    const base = baseClasses.get(name) ?? 'code';
    if (value !== base) {
      assert(value !== 'code', 'Only the base keeps a value written as code');
      overrides.set(name, probeValue(prop.kind, value));
    }
    // A number is a hole only where it moved into a value: numbers are compared and
    // counted far more often than text, so every other state keeps the page's number.
    if (isTemplatedClass(prop.kind, value) && (prop.kind.kind !== 'number' || base !== 'value')) {
      templated.push(name);
    }
  }
  const key = stateKey(
    spec.props,
    spec.slots,
    (name) => classes.get(name) ?? 'code',
    (slot) => slots.includes(slot),
  );
  return { key, classes, overrides, slots, templated };
}

/** The explicit default a state checks against absence, when the instance has neither. */
function collapsibleClass(spec: ProbeSpec, baseClasses: ReadonlyMap<string, string>, name: string): string | undefined {
  const explicit = spec.space.explicit[name];
  return explicit !== undefined && explicit !== baseClasses.get(name) ? explicit : undefined;
}

/** A choice prop's classes other than its base, without the explicit default that
 * absence stands for. */
function choiceOptions(spec: ProbeSpec, baseClasses: ReadonlyMap<string, string>, name: string): readonly string[] {
  const explicit = collapsibleClass(spec, baseClasses, name);
  return stateClassesOf(spec, baseClasses, name).filter((value) => value !== baseClasses.get(name) && value !== explicit);
}

function stateClassesOf(spec: ProbeSpec, baseClasses: ReadonlyMap<string, string>, name: string): readonly string[] {
  const prop = spec.props[name];
  assert(prop !== undefined, 'A state names a modelable prop');
  const base = baseClasses.get(name);
  return base === 'code' ? ['code', ...valueClasses(prop.kind)] : valueClasses(prop.kind);
}

/** Calls `visit` for every combination that moves exactly `distance` choice props off
 * their base, in a fixed order, until it returns false or the steps run out. Returns
 * the steps taken. Iterative: the props are an odometer of subsets, each subset an
 * odometer of its props' other classes. */
function choiceLevel(
  choices: readonly string[],
  options: readonly (readonly string[])[],
  baseClasses: ReadonlyMap<string, string>,
  distance: number,
  stepsMax: number,
  visit: (classes: ReadonlyMap<string, string>) => boolean,
): number {
  assert(distance <= choices.length, 'A level moves no more props than there are');
  const subset = Array.from({ length: distance }, (_, index) => index);
  let steps = 0;
  for (;;) {
    const digits = subset.map(() => 0);
    for (;;) {
      if (steps >= stepsMax) {
        return steps;
      }
      steps++;
      const classes = new Map(baseClasses);
      let empty = false;
      subset.forEach((choice, position) => {
        const value = options[choice]?.[digits[position] ?? 0];
        if (value === undefined) {
          empty = true;
        } else {
          classes.set(choices[choice] ?? '', value);
        }
      });
      if (!empty && !visit(classes)) {
        return steps;
      }
      // The next class combination of this subset, rightmost digit fastest.
      let position = subset.length - 1;
      while (position >= 0 && (digits[position] ?? 0) + 1 >= (options[subset[position] ?? 0]?.length ?? 0)) {
        digits[position] = 0;
        position--;
      }
      if (position < 0 || empty) {
        break;
      }
      digits[position] = (digits[position] ?? 0) + 1;
    }
    // The next subset of `distance` props, in lexicographic order.
    let position = subset.length - 1;
    while (position >= 0 && (subset[position] ?? 0) >= choices.length - subset.length + position) {
      position--;
    }
    if (position < 0) {
      return steps;
    }
    subset[position] = (subset[position] ?? 0) + 1;
    for (let next = position + 1; next < subset.length; next++) {
      subset[next] = (subset[position] ?? 0) + next - position;
    }
  }
}

/** Whether the component's types allow these classes: every union has an arm that
 * forbids none of the props set and pins none to another value. A prop left absent
 * reads as its default, as Studio's own panel reads it. */
function allowed(space: ProbeSpace, classes: ReadonlyMap<string, string>): boolean {
  if (space.required.some((name) => classes.get(name) === 'absent')) {
    return false;
  }
  return space.unions.every((union) => union.branches.some((branch) => branchFits(space, branch, classes)));
}

function branchFits(space: ProbeSpace, branch: ScanUnionBranch, classes: ReadonlyMap<string, string>): boolean {
  for (const name of branch.forbids) {
    const value = classes.get(name);
    if (value !== undefined && value !== 'absent') {
      return false;
    }
  }
  for (const [name, wanted] of Object.entries(branch.pins)) {
    const effective = effectiveValue(space, name, classes.get(name));
    if (effective !== undefined && !wanted.includes(effective)) {
      return false;
    }
  }
  return true;
}

function effectiveValue(space: ProbeSpace, name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === 'absent') {
    return space.defaults[name];
  }
  if (value.startsWith('option:')) {
    return value.slice('option:'.length);
  }
  return value === 'true' || value === 'false' ? value : undefined;
}

/** The props with a value in the base, each of which gets a single of its own. */
export function singleProps(spec: ProbeSpec): readonly string[] {
  return Object.entries(spec.props)
    .filter(([, prop]) => isTemplatedClass(prop.kind, valueClass(prop.kind, attrValue(prop.attr)) ?? 'code'))
    .map(([name]) => name);
}

function probeValue(kind: PropKind, value: string): ProbeValue {
  if (value === 'absent') {
    return { kind: 'absent' };
  }
  if (value === 'true' || value === 'false') {
    return { kind: 'literal', value: value === 'true' };
  }
  if (value === 'empty') {
    return { kind: 'literal', value: '' };
  }
  if (value === 'zero') {
    return { kind: 'literal', value: 0 };
  }
  if (value.startsWith('items:')) {
    return { kind: 'list', length: Number(value.slice('items:'.length)) };
  }
  if (value.startsWith('option:')) {
    const option = value.slice('option:'.length);
    return { kind: 'literal', value: kind.kind === 'enum' && kind.numeric ? Number(option) : option };
  }
  // 'value': the sentinel decides it per run.
  return { kind: 'literal', value: '' };
}

/** Distinct per prop and per run, mixed case and two lengths, with characters Astro
 * escapes, so a transformed, measured or re-encoded value cannot pass for a copy. */
export function sentinel(kind: PropKind, index: number, run: 0 | 1): Literal {
  if (kind.kind === 'number') {
    return run === 0 ? 9_173_310 + index : 48_271.5 + index;
  }
  return run === 0 ? `Sq${index}x&"Zk` : `Wy${index}v&"Lm long probe ${index} text`;
}

function literalAttr(value: Literal | readonly Literal[]): Attr {
  return { type: 'expr', value: JSON.stringify(value) };
}

function probeAttrs(spec: ProbeSpec, overrides: ReadonlyMap<string, ProbeValue>, sentinels: ReadonlyMap<string, Literal>): string {
  const props: Record<string, Attr> = { ...spec.attrs };
  for (const [name, value] of overrides) {
    if (value.kind === 'absent') {
      delete props[name];
    } else if (value.kind === 'list') {
      props[name] = literalAttr(Array.from({ length: value.length }, () => ''));
    } else {
      props[name] = literalAttr(value.value);
    }
  }
  const lists = new Map<string, Literal[]>();
  for (const [name, value] of sentinels) {
    const item = /^(.*)\.(\d+)$/.exec(name);
    if (item !== null && spec.props[item[1] ?? '']?.kind.kind === 'list') {
      const list = lists.get(item[1] ?? '') ?? [];
      list[Number(item[2])] = value;
      lists.set(item[1] ?? '', list);
    } else {
      props[name] = literalAttr(value);
    }
  }
  for (const [name, items] of lists) {
    assert(
      items.every((item) => item !== undefined),
      'A list’s sentinels name every item',
    );
    props[name] = literalAttr(items);
  }
  const order = [
    ...spec.order.filter((name) => props[name] !== undefined || name.startsWith('...')),
    ...Object.keys(props).filter((name) => !spec.order.includes(name)),
  ];
  const markers: Record<string, Attr> = { 'data-avb-p': literalAttr(PATH_SENTINEL) };
  if (spec.stamp !== undefined) {
    markers['data-avb-d'] = literalAttr(spec.stamp);
  }
  return serializeAttrs(props, order) + serializeAttrs(markers);
}

function probeMarkup(spec: ProbeSpec, render: ProbeRender, overrides: ReadonlyMap<string, ProbeValue>, filled: readonly string[]): string {
  const slots = filled.map((slot) => `<Fragment${slot === 'default' ? '' : ` slot="${slot}"`} set:html={${JSON.stringify(slotMarker(slot))}} />`).join('');
  const open = `<Fragment set:html={${JSON.stringify(`<!--stacki-probe:${render.id}-->`)}} />`;
  const close = `<Fragment set:html={${JSON.stringify(`<!--/stacki-probe:${render.id}-->`)}} />`;
  // No children at all, not an empty one: a component asks whether a slot was written.
  const element =
    slots === ''
      ? `<${spec.name}${probeAttrs(spec, overrides, render.sentinels)} />`
      : `<${spec.name}${probeAttrs(spec, overrides, render.sentinels)}>${slots}</${spec.name}>`;
  return `${open}${element}${close}`;
}

/** Each templated prop's sentinel for one run; a list gets one per item, `lengths` long. */
function sentinelsFor(
  spec: ProbeSpec,
  templated: readonly string[],
  run: 0 | 1,
  only: string | undefined,
  lengths: (name: string) => number,
): ReadonlyMap<string, Literal> {
  const names = Object.keys(spec.props);
  const sentinels = new Map<string, Literal>();
  for (const name of templated) {
    const prop = spec.props[name];
    assert(prop !== undefined, 'A templated prop is a modelable prop');
    if (only !== undefined && only !== name) {
      continue;
    }
    if (prop.kind.kind === 'list') {
      const length = lengths(name);
      assert(length <= TEMPLATE_LIMITS.listItemsMax, 'A list stays within its item limit');
      for (let index = 0; index < length; index++) {
        // Past every prop's own index, so no item's sentinel is another prop's.
        sentinels.set(listItemName(name, index), sentinel({ kind: 'string' }, TEMPLATE_LIMITS.propsMax * (names.indexOf(name) + 2) + index, run));
      }
    } else {
      sentinels.set(name, sentinel(prop.kind, names.indexOf(name), run));
    }
  }
  return sentinels;
}

/** A list prop's length in a class, 0 for any other class. */
function listLength(value: string | undefined): number {
  return value?.startsWith('items:') === true ? Number(value.slice('items:'.length)) : 0;
}

/** How many states each instance on a page renders, two renders each within `room`:
 * every instance its whole list when that fits, otherwise an equal share each, with
 * what a smaller instance leaves over shared among the rest. A deep instance (a visual
 * in a card's slot) is never starved by the large ones above it. */
export function stateShares(wanted: readonly number[], room: number): readonly number[] {
  const shares = wanted.map(() => 0);
  let left = Math.max(0, Math.floor(room / 2));
  let open = wanted.map((_, index) => index);
  // Each pass settles at least one instance or ends, so passes never exceed the instances.
  for (let pass = 0; pass <= wanted.length && open.length > 0 && left > 0; pass++) {
    const share = Math.floor(left / open.length);
    const settled = open.filter((index) => (wanted[index] ?? 0) - (shares[index] ?? 0) <= share);
    if (settled.length === 0) {
      for (const index of open) {
        shares[index] = (shares[index] ?? 0) + share;
      }
      left -= share * open.length;
      break;
    }
    for (const index of settled) {
      left -= (wanted[index] ?? 0) - (shares[index] ?? 0);
      shares[index] = wanted[index] ?? 0;
    }
    open = open.filter((index) => !settled.includes(index));
  }
  assert(left >= 0, 'Shares never exceed the room');
  assert(
    shares.every((share, index) => share <= (wanted[index] ?? 0)),
    'No instance gets more than it asks for',
  );
  return shares;
}

/** Every page's probes, for specs grouped by the page that renders them. */
export function planProbes(specsByPage: ReadonlyMap<string, readonly ProbeSpec[]>): ProbePlan {
  const specs: ProbeSpec[] = [];
  const states: (readonly StatePlan[])[] = [];
  const pages = new Map<string, PageProbes>();
  for (const [page, pageSpecs] of specsByPage) {
    const renders: ProbeRender[] = [];
    const markup: string[] = [];
    const instances = pageSpecs.slice(0, PROBE_LIMITS.instancesPerPageMax);
    const wanted = instances.map((spec) => specStates(spec));
    const shares = stateShares(
      wanted.map((plans) => plans.length),
      instances.reduce<number>((room, spec) => room - singleProps(spec).length * 2 - 1, PROBE_LIMITS.rendersPerPageMax),
    );
    for (const [position, spec] of instances.entries()) {
      const singles = singleProps(spec);
      // The states come nearest first, so an instance past its share keeps its closest
      // combinations and refuses only the farthest.
      const plans = (wanted[position] ?? []).slice(0, shares[position] ?? 0);
      if (plans.length === 0) {
        continue; // Past the budget the instance refuses, as it did before templates.
      }
      const index = specs.length;
      // Astro compiles a template's children into one tagged template call, one
      // argument per expression; a page's thousands of probes in one call outgrow the
      // engine's argument limit. Each instance's probes sit in a Fragment of their own.
      const specMarkup: string[] = [];
      specs.push(spec);
      states.push(plans);
      const add = (
        target: ProbeRender['target'],
        run: 0 | 1,
        overrides: ReadonlyMap<string, ProbeValue>,
        sentinels: ReadonlyMap<string, Literal>,
        filled: readonly string[],
      ) => {
        const render: ProbeRender = { id: renders.length, spec: index, target, run, sentinels };
        renders.push(render);
        specMarkup.push(probeMarkup(spec, render, overrides, filled));
      };
      plans.forEach((plan, stateIndex) => {
        for (const run of [0, 1] as const) {
          add(
            { kind: 'state', index: stateIndex },
            run,
            plan.overrides,
            sentinelsFor(spec, plan.templated, run, undefined, (name) => listLength(plan.classes.get(name))),
            plan.slots,
          );
        }
      });
      for (const prop of singles) {
        for (const run of [0, 1] as const) {
          add(
            { kind: 'single', prop },
            run,
            new Map(),
            sentinelsFor(spec, singles, run, prop, (name) =>
              listLength(valueClass(spec.props[name]?.kind ?? { kind: 'list' }, attrValue(spec.props[name]?.attr))),
            ),
            spec.slots,
          );
        }
      }
      add({ kind: 'actual' }, 0, new Map(), new Map(), spec.slots);
      assert(renders.length <= PROBE_LIMITS.rendersPerPageMax, 'A page stays within its render budget');
      // On a template page an instance that reads only literals renders alike on every
      // entry and is probed once; one that reads the page's code is probed per entry.
      const fragment = `<Fragment>${specMarkup.join('\n')}</Fragment>`;
      markup.push(dependsOnPage(spec) ? fragment : onceGuard(page, fragment, `${page}#${index}`));
    }
    if (renders.length > 0) {
      pages.set(page, { markup: `\n${markup.join('\n')}\n`, renders });
    }
  }
  return { specs, states, pages };
}

const PROBED_GLOBAL = '__stackiProbedTemplates';

/** A template page renders once per entry, and its probes would render with every one.
 * An instance's probes render with the first entry the build reaches and no other:
 * Astro builds a route's pages in getStaticPaths order, so that is the first entry the
 * demo lists. Only for an instance that reads nothing of the entry (dependsOnPage). */
export function onceGuard(page: string, markup: string, key: string = page): string {
  if (!page.includes('[')) {
    return markup;
  }
  const seen = `(globalThis[${JSON.stringify(PROBED_GLOBAL)}] ??= new Set())`;
  return `{((seen) => (seen.has(${JSON.stringify(key)}) ? false : (seen.add(${JSON.stringify(key)}), true)))(${seen}) && ${markup}}`;
}

/** Whether an instance's rendering can depend on what its page computes: any attribute
 * written as code, a spread among them. Such an instance on a template page renders
 * differently per entry, so it is probed and kept per entry. */
export function dependsOnPage(spec: ProbeSpec): boolean {
  return Object.values(spec.attrs).some((attr) => attrValue(attr).kind === 'code');
}

/** Cuts the probes out of a built page. The page is what it would have been without
 * them; a probe block that holds anything else means the build moved something, and
 * the bake stops rather than ship a page it cannot vouch for. */
export function extractProbes(html: string): { readonly html: string; readonly outputs: ReadonlyMap<number, string> } {
  const outputs = new Map<number, string>();
  const first = html.search(/<!--stacki-probe:\d+-->/);
  if (first < 0) {
    return { html, outputs };
  }
  let position = first;
  for (const match of html.slice(first).matchAll(PROBE_OPEN)) {
    const start = first + match.index;
    const id = Number(match[1]);
    const close = `<!--/stacki-probe:${id}-->`;
    const end = html.indexOf(close, start);
    if (end < 0) {
      throw new Error(`Probe ${id} never closes`);
    }
    if (html.slice(position, start).trim() !== '') {
      throw new Error('A probe block holds more than probes');
    }
    if (start >= position) {
      outputs.set(id, html.slice(start + match[0].length, end));
      position = end + close.length;
    }
  }
  return { html: html.slice(0, first).replace(/\s+$/, '\n') + html.slice(position).replace(/^\s+/, ''), outputs };
}

interface Tokenized {
  readonly html: string | undefined;
}

class HoleTable {
  readonly holes: Hole[] = [];
  token(hole: Hole): string {
    const key = JSON.stringify(hole);
    let index = this.holes.findIndex((known) => JSON.stringify(known) === key);
    if (index < 0) {
      index = this.holes.length;
      this.holes.push(hole);
    }
    return holeToken(index);
  }
}

function tokenize(output: string, sentinels: ReadonlyMap<string, Literal>, table: HoleTable): Tokenized {
  if (containsHoleCharacters(output) || output.length > TEMPLATE_LIMITS.htmlCharsMax) {
    return { html: undefined };
  }
  let html = output.replaceAll(PATH_SENTINEL, table.token({ kind: 'path' }));
  // Astro numbers transition scopes per render, so no two renderings share them.
  html = html.replace(TRANSITION_SCOPE, (_match, open: string, _scope: string, close: string) => `${open}${table.token({ kind: 'scope' })}${close}`);
  const slots = new Map<string, number>();
  html = slotHoles(html, (name) => {
    slots.set(name, (slots.get(name) ?? 0) + 1);
    return table.token({ kind: 'slot', name });
  });
  if ([...slots.values()].some((count) => count > 1)) {
    return { html: undefined }; // A slot rendered twice cannot hold one copy of its children.
  }
  for (const [name, value] of sentinels) {
    const text = String(value);
    html = html.replaceAll(escapeHTML(text), table.token({ kind: 'prop', name, mode: 'escaped' }));
    if (text !== escapeHTML(text)) {
      html = html.replaceAll(text, table.token({ kind: 'prop', name, mode: 'raw' }));
    }
    const core = typeof value === 'number' ? text : text.slice(0, text.indexOf('&'));
    if (html.includes(core)) {
      return { html: undefined }; // Part of the value survived in some other form.
    }
  }
  return { html };
}

/** The template a spec's renderings teach, or undefined when its base cannot render. */
export function buildTemplate(
  spec: ProbeSpec,
  plans: readonly StatePlan[],
  outputs: ReadonlyMap<string, readonly [string | undefined, string | undefined]>,
  renders: readonly ProbeRender[],
): ComponentTemplate | undefined {
  const table = new HoleTable();
  const byTarget = new Map<string, ProbeRender[]>();
  for (const render of renders) {
    const key = targetKey(render.target);
    byTarget.set(key, [...(byTarget.get(key) ?? []), render]);
  }
  const agreed = (key: string): string | undefined => {
    const [first, second] = outputs.get(key) ?? [undefined, undefined];
    const runs = byTarget.get(key) ?? [];
    const run0 = runs.find((render) => render.run === 0);
    const run1 = runs.find((render) => render.run === 1);
    if (first === undefined || second === undefined || run0 === undefined || run1 === undefined) {
      return undefined;
    }
    const left = tokenize(first, run0.sentinels, table).html;
    const right = tokenize(second, run1.sentinels, table).html;
    return left !== undefined && left === right ? left : undefined;
  };
  // What the page rendered, with only the path and the slots as holes: the base and each
  // single, filled with the props' own values, must give exactly this, or the stand-ins
  // missed logic that reads the value (a number compared with 1, a text matched).
  const [actualOutput] = outputs.get('actual') ?? [undefined, undefined];
  const actual = actualOutput === undefined ? undefined : tokenize(actualOutput, new Map(), table).html;
  const values = new Map<string, Literal>();
  for (const [name, prop] of Object.entries(spec.props)) {
    for (const [hole, literal] of holeValues(name, attrValue(prop.attr))) {
      values.set(hole, literal);
    }
  }
  const reproduces = (html: string | undefined): html is string =>
    html !== undefined && actual !== undefined && fillProps(html, table.holes, values) === actual;
  const shared = agreed(targetKey({ kind: 'state', index: 0 }));
  const base = reproduces(shared) ? shared : undefined;
  const differences: TemplateDifference[] = [];
  const differenceIndex = new Map<string, number>();
  const states: TemplateState[] = [];
  const htmlByKey = new Map<string, string>();
  let characters = (base ?? '').length;
  plans.forEach((plan, index) => {
    const html = index === 0 ? base : agreed(targetKey({ kind: 'state', index }));
    if (html === undefined) {
      return;
    }
    htmlByKey.set(plan.key, `${plan.templated.join(' ')}\n${html}`);
    // The base state is the base itself, kept once as `base` and pointed at here as an
    // empty difference: storing its HTML again doubled every template's largest string.
    const difference = stateDifference(base, html);
    assert(index !== 0 || differenceChars(difference) === 0, 'The base state stores no HTML of its own');
    const identity = JSON.stringify(difference);
    let output = differenceIndex.get(identity);
    if (output === undefined) {
      if (differences.length >= TEMPLATE_LIMITS.outputsMax || characters + differenceChars(difference) > TEMPLATE_LIMITS.templateCharsMax) {
        return; // Past the budget the combination is left to Astro.
      }
      characters += differenceChars(difference);
      output = differences.length;
      differences.push(difference);
      differenceIndex.set(identity, output);
    }
    states.push({ key: plan.key, output, templated: plan.templated });
  });
  // An explicit default looks up as absent only where the build rendered the two alike.
  const collapsed: Record<string, string> = {};
  for (const [name, explicit] of Object.entries(spec.space.explicit)) {
    const withExplicit = plans.find((plan) => plan.slots.length === spec.slots.length && onlyDiffers(plans[0], plan, name, explicit));
    const withAbsence = plans.find((plan) => plan.slots.length === spec.slots.length && onlyDiffers(plans[0], plan, name, 'absent'));
    const left = withExplicit === undefined ? undefined : htmlByKey.get(withExplicit.key);
    const right = withAbsence === undefined ? undefined : htmlByKey.get(withAbsence.key);
    if (left !== undefined && left === right) {
      collapsed[name] = explicit;
    }
  }
  const singles: Record<string, TemplateSingle> = {};
  for (const prop of singleProps(spec)) {
    const html = agreed(targetKey({ kind: 'single', prop }));
    if (reproduces(html)) {
      singles[prop] = { ...stateDifference(base, html), templated: [prop] };
    }
  }
  if (states.length === 0 && Object.keys(singles).length === 0) {
    return undefined;
  }
  if (base !== undefined) {
    assert(states[0]?.key === plans[0]?.key, 'The base is the first state');
  }
  assert(states.length <= TEMPLATE_LIMITS.statesMax, 'A template stays within its states');
  return {
    file: spec.file,
    slots: spec.slots,
    props: spec.props,
    fixed: spec.fixed,
    holes: table.holes,
    base,
    collapsed,
    outputs: differences,
    states,
    singles,
  };
}

/** Whether `plan` is the base with only `name` moved, to `value` (or is the base, when
 * the base already has it). */
function onlyDiffers(base: StatePlan | undefined, plan: StatePlan, name: string, value: string): boolean {
  if (base === undefined || plan.classes.get(name) !== value) {
    return false;
  }
  for (const [other, otherValue] of base.classes) {
    if (other !== name && plan.classes.get(other) !== otherValue) {
      return false;
    }
  }
  return true;
}

/** A tokenized rendering with its prop holes filled; path and slot holes stay tokens. */
function fillProps(html: string, holes: readonly Hole[], values: ReadonlyMap<string, Literal>): string | undefined {
  let missing = false;
  const filled = html.replace(/\uE000(\d+)\uE001/g, (token, index: string) => {
    const hole = holes[Number(index)];
    if (hole?.kind !== 'prop') {
      return token;
    }
    const value = values.get(hole.name);
    if (value === undefined) {
      missing = true;
      return token;
    }
    return hole.mode === 'escaped' ? escapeHTML(String(value)) : String(value);
  });
  return missing ? undefined : filled;
}

function targetKey(target: ProbeRender['target']): string {
  switch (target.kind) {
    case 'state':
      return `state:${target.index}`;
    case 'single':
      return `single:${target.prop}`;
    case 'actual':
      return 'actual';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** Collects every page's probe outputs into templates, deduplicated. */
export class CatalogBuilder {
  private readonly templates: ComponentTemplate[] = [];
  private readonly keys = new Map<string, number>();
  private readonly instances: Record<string, Record<string, number>> = {};
  private characters = 0;

  /** One built document's probe outputs. `entry` names the document of a template
   * page's entry, whose per-entry instances are kept under it (entryInstancesKey). */
  add(plan: ProbePlan, page: string, outputs: ReadonlyMap<number, string>, entry?: string): void {
    const probes = plan.pages.get(page);
    if (probes === undefined) {
      return;
    }
    const bySpec = new Map<number, ProbeRender[]>();
    for (const render of probes.renders) {
      bySpec.set(render.spec, [...(bySpec.get(render.spec) ?? []), render]);
    }
    for (const [specIndex, renders] of bySpec) {
      const spec = plan.specs[specIndex];
      const states = plan.states[specIndex];
      assert(spec !== undefined, 'Every render names a spec');
      assert(states !== undefined, 'Every spec has its states');
      const byTarget = new Map<string, [string | undefined, string | undefined]>();
      for (const render of renders) {
        const pair = byTarget.get(targetKey(render.target)) ?? [undefined, undefined];
        pair[render.run] = outputs.get(render.id);
        byTarget.set(targetKey(render.target), pair);
      }
      const template = buildTemplate(spec, states, byTarget, renders);
      if (template !== undefined) {
        this.record(template, spec.instance, entry !== undefined && dependsOnPage(spec) ? entry : undefined);
      }
    }
  }

  private record(template: ComponentTemplate, instance: ProbeSpec['instance'], entry: string | undefined): void {
    const key = JSON.stringify(template);
    let index = this.keys.get(key);
    if (index === undefined) {
      if (this.templates.length >= TEMPLATE_LIMITS.templatesMax || this.characters + key.length > TEMPLATE_LIMITS.totalCharsMax) {
        return; // Past the budget the component is left to Astro.
      }
      index = this.templates.length;
      this.templates.push(template);
      this.keys.set(key, index);
      this.characters += key.length;
    }
    if (instance !== undefined) {
      const key = entry === undefined ? instance.page : entryInstancesKey(instance.page, entry);
      const paths = (this.instances[key] ??= {});
      paths[instance.path] = index;
    }
  }

  catalog(): ComponentCatalog {
    return { templates: this.templates, instances: this.instances };
  }
}

/** A page's component instances that a probe can stand for: outside loops, with a
 * resolvable import, a plain name and slots that are named in the markup. */
export function pageInstances(page: string, source: string, fields: (file: string) => readonly ScanField[] | undefined, stamp: string): readonly ProbeSpec[] {
  const parsed = parsePage(source);
  if (!parsed.editable) {
    return [];
  }
  const imports = new Map<string, string>();
  for (const declaration of parsed.model.imports) {
    const file = declaration.typeOnly || declaration.imported !== undefined ? undefined : componentFileOf(page, declaration.path);
    if (file !== undefined) {
      imports.set(declaration.name, file);
    }
  }
  const specs: ProbeSpec[] = [];
  const queue: { readonly node: ParserNode; readonly root: boolean; readonly depth: number }[] = parsed.model.nodes.map((node) => ({
    node,
    root: true,
    depth: 0,
  }));
  for (let index = 0; index < queue.length && specs.length < PROBE_LIMITS.instancesPerPageMax; index++) {
    const entry = queue[index];
    assert(entry !== undefined, 'The queue holds what it was given');
    assert(entry.depth <= PROBE_LIMITS.depthMax, 'A page nests within the walk limit');
    const { node } = entry;
    if (node.kind === 'map' || node.kind === 'raw' || node.kind === 'expr' || node.kind === 'cond') {
      // A loop's body has names only the loop defines, and a condition's body may hold
      // values only its condition makes safe (`{group && <Group group={group} />}`); a
      // probe at the end of the page has neither.
      continue;
    }
    const file = node.kind === 'component' ? imports.get(node.name ?? '') : undefined;
    const known = file === undefined ? undefined : fields(file);
    const slots = filledSlots(node.children ?? []);
    if (file !== undefined && known !== undefined && slots !== undefined && node.name !== undefined && /^[A-Z]\w*$/.test(node.name)) {
      specs.push(
        probeSpec({
          file,
          name: node.name,
          node,
          slots,
          fields: known,
          stamp: entry.root ? stamp : undefined,
          instance: { page, path: pathFor(node.id ?? '') },
        }),
      );
    }
    for (const child of node.children ?? []) {
      queue.push({ node: child, root: false, depth: entry.depth + 1 });
    }
  }
  return specs;
}

/** The local name a page gives a component file, when it imports it by default. */
export function localName(page: string, source: string, file: string): string | undefined {
  const parsed = parsePage(source);
  if (!parsed.editable) {
    return undefined;
  }
  return parsed.model.imports.find(
    (declaration) => !declaration.typeOnly && declaration.imported === undefined && componentFileOf(page, declaration.path) === file,
  )?.name;
}
