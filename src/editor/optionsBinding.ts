// Binding a list setting to a component prop, and unlinking it again:
//
//   "filter": {"filterFor": "ALL", "fields": […]}
//     → "filter": propFilters,  with  filters: propFilters = {"filterFor": "ALL", "fields": […]}
//
// Binding moves the setting's current value into a new prop's default, so the
// component renders exactly as before, and each page using it may now pass its
// own. Unlinking puts the default back in the options. The prop itself is kept
// on unlinking: pages may pass it, and removing a prop is the Properties
// panel's to do, where its uses are shown.

import { assert } from '../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { parseExpression, type Js } from './loopSyntax';
import { freeLocal, readPropsDestructure, withProp } from './loopProps';
import { settingEntry, type LoopSetting, type OptionsHome } from './optionsQuery';

export type BindingChange =
  /** Link to a new prop, made with the setting's current value as its default. */
  | {
      readonly kind: 'bind';
      readonly setting: LoopSetting;
      readonly key: string;
      /** Its tooltip, written as its doc comment; the setting's name when absent. */
      readonly description?: string | undefined;
      /** Its default, as code; the setting's current value when absent. */
      readonly defaultCode?: string | undefined;
    }
  /** Link to a prop the component already has, whose default becomes the value. */
  | { readonly kind: 'connect'; readonly setting: LoopSetting; readonly key: string }
  | { readonly kind: 'unbind'; readonly setting: LoopSetting };

export type BindingResult = { readonly ok: true; readonly frontmatter: string } | { readonly ok: false; readonly message: string };

/** What each setting is called, in the panel and in the prop's description. */
export const SETTING_TITLES: Readonly<Record<LoopSetting, string>> = {
  filter: 'Filters',
  sort: 'Sort',
  limit: 'Show',
  offset: 'Skip',
  curated: 'Select items',
};

/** The name a new prop for a setting is offered: what a builder calls it. */
export const SETTING_PROP_NAMES: Readonly<Record<LoopSetting, string>> = { filter: 'filters', sort: 'sort', limit: 'limit', offset: 'skip', curated: 'items' };

// What an unset setting means, written out: the helper's own defaults.
const EMPTY_VALUES: Readonly<Record<LoopSetting, string>> = {
  filter: '{"filterFor": "ALL", "fields": []}',
  sort: '[]',
  limit: '0',
  offset: '0',
  curated: '{"itemIds": []}',
};
// Each setting's prop typed as the data the helper reads, so a page passing
// something else is a type error in the editor rather than an empty list.
export const SETTING_PROP_TYPES: Readonly<Record<LoopSetting, string>> = {
  filter: '{ filterFor: "ALL" | "ANY"; fields: { fieldPath: string; operatorName: string; value?: unknown }[] }',
  sort: '{ field: string; direction: "asc" | "desc" }[]',
  limit: 'number',
  offset: 'number',
  curated: '{ itemIds: string[] }',
};
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Why a name cannot be a new prop, or undefined when it can. */
export function propNameProblem(frontmatter: string, key: string): string | undefined {
  if (!IDENTIFIER.test(key)) {
    return 'Use letters and numbers, starting with a letter.';
  }
  if (key.length > PROPERTY_LIMITS.nameCharsMax) {
    return 'That name is too long.';
  }
  const taken = readPropsDestructure(frontmatter)?.entries.some((entry) => entry.key === key) ?? false;
  return taken ? `This component already has a ${key} property.` : undefined;
}

/**
 * The frontmatter with one setting bound to a new prop or unlinked from its
 * prop. `statementFrom` is where the options' declaration starts: a component
 * with no props yet gets its destructure there.
 */
export function reboundOptions(
  frontmatter: string,
  read: {
    readonly home: OptionsHome;
    readonly options: Extract<Js, { readonly kind: 'object' }>;
    readonly statementFrom: number;
    readonly taken: ReadonlySet<string>;
  },
  change: BindingChange,
): BindingResult {
  assert(read.options.from === read.home.options.from, 'The options rebound are the ones read');
  assert(read.statementFrom <= read.options.from, 'The options sit inside their declaration');
  const settingHome = read.home.settings[change.setting];
  const entry = settingEntry(read.options.entries, change.setting);
  if (change.kind === 'unbind') {
    if (settingHome.kind !== 'prop' || entry === undefined) {
      return { ok: false, message: 'This setting is not linked to a property.' };
    }
    const value = frontmatter.slice(settingHome.literal.from, settingHome.literal.to);
    return { ok: true, frontmatter: spliced(frontmatter, entry.value, value) };
  }
  if (change.kind === 'connect') {
    const prop = readPropsDestructure(frontmatter)?.entries.find((candidate) => candidate.key === change.key);
    if (prop === undefined || !connectableProps(frontmatter, change.setting).includes(change.key)) {
      return { ok: false, message: `The ${change.key} property can’t hold this list’s ${SETTING_TITLES[change.setting].toLowerCase()}.` };
    }
    return { ok: true, frontmatter: named(frontmatter, read.options, change.setting, prop.local) };
  }
  const problem = propNameProblem(frontmatter, change.key);
  if (problem !== undefined) {
    return { ok: false, message: problem };
  }
  const local = freeLocal(change.key, read.taken);
  // The new prop starts from what the list shows now: the old prop's default
  // when the setting is moving from one prop to another.
  const current = settingHome.kind === 'prop' ? settingHome.literal : entry?.value;
  const defaultCode = change.defaultCode ?? (current === undefined ? EMPTY_VALUES[change.setting] : frontmatter.slice(current.from, current.to));
  if (parseExpression(defaultCode) === undefined) {
    return { ok: false, message: 'That default is not a value the list can read.' };
  }
  const options = named(frontmatter, read.options, change.setting, local);
  const out = withProp(
    options,
    {
      key: change.key,
      local,
      defaultCode,
      type: SETTING_PROP_TYPES[change.setting],
      description: tooltipText(change.description) ?? SETTING_TITLES[change.setting],
    },
    read.statementFrom,
  );
  assert(out.includes(local), 'A bound setting names its prop');
  return { ok: true, frontmatter: out };
}

/**
 * The props whose default this setting could read: a filter object, a list
 * of sorts, or a whole number, by what the default says. A prop already
 * named by the setting is included (the menu marks it as connected).
 */
export function connectableProps(frontmatter: string, setting: LoopSetting): readonly string[] {
  const entries = readPropsDestructure(frontmatter)?.entries ?? [];
  const out: string[] = [];
  for (const entry of entries) {
    const value = entry.defaultValue === undefined ? undefined : parseExpression(frontmatter.slice(entry.defaultValue.from, entry.defaultValue.to))?.expression;
    if (value !== undefined && holds(setting, value)) {
      out.push(entry.key);
    }
  }
  assert(out.length <= entries.length, 'Connectable props are some of the props');
  return out;
}

function holds(setting: LoopSetting, value: Js): boolean {
  switch (setting) {
    case 'filter':
      return value.kind === 'object' && value.entries.some((entry) => entry.key === 'fields' || entry.key === 'filterFor');
    case 'sort':
      return value.kind === 'array' && value.items.every((item) => item.kind === 'object' && item.entries.some((entry) => entry.key === 'field'));
    case 'limit':
    case 'offset':
      return value.kind === 'number' && Number.isSafeInteger(value.value) && value.value >= 0;
    case 'curated':
      return value.kind === 'object' && value.entries.some((entry) => entry.key === 'itemIds');
    default: {
      const exhaustive: never = setting;
      return exhaustive;
    }
  }
}

// The options naming `local` for a setting: in place of its value, or as a new entry.
function named(frontmatter: string, options: Extract<Js, { readonly kind: 'object' }>, setting: LoopSetting, local: string): string {
  const entry = settingEntry(options.entries, setting);
  if (entry !== undefined) {
    return spliced(frontmatter, entry.value, local);
  }
  const separator = options.entries.length === 0 ? '' : ', ';
  return spliced(frontmatter, { from: options.to - 1, to: options.to - 1 }, `${separator}${JSON.stringify(setting)}: ${local}`);
}

// A tooltip as a one-line doc comment: `*/` would end the comment early.
const TOOLTIP_CHARS_MAX = 500;
function tooltipText(description: string | undefined): string | undefined {
  const text = description?.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim().slice(0, TOOLTIP_CHARS_MAX);
  return text === undefined || text === '' ? undefined : text;
}

function spliced(text: string, span: { readonly from: number; readonly to: number }, replacement: string): string {
  assert(span.from <= span.to, 'A span is ordered');
  assert(span.to <= text.length, 'A span is inside its text');
  return `${text.slice(0, span.from)}${replacement}${text.slice(span.to)}`;
}
