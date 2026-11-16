// Variant rules: which props a component allows, requires or forbids for each
// option of the prop that switches them (its controller, `variant` in
// `type Kind = { variant?: "main"; label?: never } | { variant: "play"; label?: string }`).
//
// Main reads them from the component's `Props` union (electron/properties/variantRuleModel.ts)
// and writes each edit as a minimal text change to that union
// (electron/properties/variantRuleEdits.ts); the Properties panel draws and edits them
// without the designer writing TypeScript. This file is the contract between the
// two: the read-only model the panel draws, the edits it may ask for, and the
// boundary parsers for both. docs/props-variant-rules.md describes the model.
import { assert } from '../core/assert';
import { boolean, count, list, object, text } from '../core/boundary';
import { LIMITS } from '../core/limits';
import { toRecord } from '../core/record';

export const VARIANT_LIMITS = {
  /** Options one controller may have: a union of more is a generated type, not a designer's list. */
  optionsMax: 64,
  /** Discriminated unions one component's props may combine. */
  groupsMax: 16,
  /** An option's characters: a word or two, written as a string literal. */
  valueCharsMax: 128,
  /** Props one group may rule: the props a component may have (VARIANT_LIMITS.propsMax). */
  propsMax: LIMITS.propSchemaFieldsMax,
  /** A prop's name, and a type or default as code (PROPERTY_LIMITS.nameCharsMax, textCharsMax). */
  nameCharsMax: 128,
  codeCharsMax: 32768,
} as const;

/** What an option says about a prop: it may be passed, must be passed, or may not be passed. */
export const VARIANT_RULE_STATES = ['optional', 'required', 'forbidden'] as const;
export type VariantRuleState = (typeof VARIANT_RULE_STATES)[number];

/**
 * Why a group is drawn but not edited, one word each in the panel. `shape`: a
 * member is not one object type beside attribute types; `nested`: a member holds
 * another union; `shared`: the type is exported, so other files read it;
 * `runtime`: the runtime type or destructure cannot be kept in step.
 */
export const VARIANT_GROUP_REASONS = ['shape', 'nested', 'shared', 'runtime'] as const;
export type VariantGroupReason = (typeof VARIANT_GROUP_REASONS)[number];

/** One prop under one option. `listed` is false when the option's type does not name the prop (TypeScript then refuses it, as `never` does). */
export interface VariantRule {
  readonly prop: string;
  readonly state: VariantRuleState;
  readonly listed: boolean;
  /** The prop's type as written in this option, or '' when the option forbids it. */
  readonly type: string;
}

/** One option of the controller. `fallback`: the option that applies when the controller is not passed (`variant?: "main"`). */
export interface VariantOption {
  readonly value: string;
  readonly fallback: boolean;
  /** One rule per prop of the group, in the group's prop order. */
  readonly rules: readonly VariantRule[];
}

export type VariantGroupEditing = { readonly kind: 'editable' } | { readonly kind: 'readonly'; readonly reason: VariantGroupReason };

export interface VariantGroup {
  /** The prop whose value picks the option. */
  readonly controller: string;
  /** Every prop an option names, the controller excluded, in first-written order. */
  readonly props: readonly string[];
  /** Props every option shares that this group could rule (`attachProp`): the panel offers them "Only for". */
  readonly attachable: readonly string[];
  readonly options: readonly VariantOption[];
  readonly editing: VariantGroupEditing;
}

/**
 * The edits the panel can ask for. Each names its group by controller, and is
 * applied by main against the current source as one undoable batch.
 */
export type VariantRuleEdit =
  | { readonly kind: 'setRule'; readonly controller: string; readonly option: string; readonly prop: string; readonly state: VariantRuleState }
  | { readonly kind: 'addOption'; readonly controller: string; readonly value: string }
  | { readonly kind: 'renameOption'; readonly controller: string; readonly from: string; readonly to: string }
  | { readonly kind: 'removeOption'; readonly controller: string; readonly value: string }
  | { readonly kind: 'moveOption'; readonly controller: string; readonly value: string; readonly index: number }
  | { readonly kind: 'setFallback'; readonly controller: string; readonly value: string }
  | { readonly kind: 'addProp'; readonly controller: string; readonly prop: string; readonly type: string }
  | { readonly kind: 'removeProp'; readonly controller: string; readonly prop: string }
  | { readonly kind: 'attachProp'; readonly controller: string; readonly prop: string; readonly options: readonly string[] };

/** The group that controls or rules `name`, if any: the panel draws variant settings for both. */
export function variantGroupOf(groups: readonly VariantGroup[] | undefined, name: string): VariantGroup | undefined {
  if (groups === undefined) {
    return undefined;
  }
  assert(groups.length <= VARIANT_LIMITS.groupsMax, 'variantGroupOf: groups are bounded');
  return groups.find((group) => group.controller === name) ?? groups.find((group) => group.props.includes(name));
}

/** Every group that controls or rules `name`. */
export function variantGroupsOf(groups: readonly VariantGroup[] | undefined, name: string): readonly VariantGroup[] {
  if (groups === undefined) {
    return [];
  }
  assert(groups.length <= VARIANT_LIMITS.groupsMax, 'variantGroupsOf: groups are bounded');
  return groups.filter((group) => group.controller === name || group.props.includes(name));
}

/**
 * An option as a designer may type it: written into a string literal as is, so
 * no quote, backslash or control character; trimmed, and within the limit.
 * Undefined when it cannot be one.
 */
export function variantOptionValue(input: string): string | undefined {
  const value = input.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > VARIANT_LIMITS.valueCharsMax) {
    return undefined;
  }
  if (/["'`\\\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

/** Parses the groups main sends with a component's properties. */
export function parseVariantGroups(input: unknown): readonly VariantGroup[] {
  const groups = list(parseVariantGroup)(input);
  if (groups.length > VARIANT_LIMITS.groupsMax) {
    throw new Error('Too many variant groups');
  }
  return groups;
}

function parseVariantGroup(input: unknown): VariantGroup {
  const value = object({
    controller: propertyName,
    props: (item) => boundedList(item, VARIANT_LIMITS.propsMax, propertyName),
    attachable: (item) => boundedList(item, VARIANT_LIMITS.propsMax, propertyName),
    options: (item) => boundedList(item, VARIANT_LIMITS.optionsMax, parseVariantOption),
    editing: parseVariantGroupEditing,
  })(input);
  if (new Set(value.props).size !== value.props.length) {
    throw new Error('Variant group props repeat');
  }
  if (value.props.includes(value.controller)) {
    throw new Error('A controller does not rule itself');
  }
  if (value.attachable.some((name) => name === value.controller || value.props.includes(name)) || new Set(value.attachable).size !== value.attachable.length) {
    throw new Error('An attachable prop is one the group does not rule yet');
  }
  if (new Set(value.options.map((option) => option.value)).size !== value.options.length) {
    throw new Error('Variant options repeat');
  }
  for (const option of value.options) {
    if (option.rules.length !== value.props.length) {
      throw new Error('Every variant option has one rule per prop');
    }
    option.rules.forEach((rule, index) => {
      if (rule.prop !== value.props[index]) {
        throw new Error('Variant rules follow the group prop order');
      }
    });
  }
  return value;
}

function parseVariantOption(input: unknown): VariantOption {
  return object({
    value: parseOptionValue,
    fallback: boolean,
    rules: (item) => boundedList(item, VARIANT_LIMITS.propsMax, parseVariantRule),
  })(input);
}

function parseVariantRule(input: unknown): VariantRule {
  const rule = object({ prop: propertyName, state: parseVariantRuleState, listed: boolean, type: propertyText })(input);
  if (rule.state === 'forbidden') {
    if (rule.type !== '') {
      throw new Error('A forbidden prop has no type');
    }
  } else if (rule.type.trim() === '') {
    throw new Error('An allowed prop has a type');
  }
  if (!rule.listed) {
    if (rule.state !== 'forbidden') {
      throw new Error('A prop an option does not name is forbidden there');
    }
  }
  return rule;
}

function parseVariantGroupEditing(input: unknown): VariantGroupEditing {
  const value = toRecord(input);
  if (value?.['kind'] === 'editable') {
    return { kind: 'editable' };
  }
  if (value?.['kind'] === 'readonly') {
    return { kind: 'readonly', reason: parseVariantGroupReason(value['reason']) };
  }
  throw new Error('Invalid variant group editing');
}

/** Parses an edit the renderer asks main to apply. */
export function parseVariantRuleEdit(input: unknown): VariantRuleEdit {
  const value = toRecord(input);
  const kind = value?.['kind'];
  switch (kind) {
    case 'setRule':
      return {
        kind,
        ...object({ controller: propertyName, option: parseOptionValue, prop: propertyName, state: parseVariantRuleState })(input),
      };
    case 'addOption':
    case 'removeOption':
    case 'setFallback':
      return { kind, ...object({ controller: propertyName, value: parseOptionValue })(input) };
    case 'renameOption': {
      const rename = object({ controller: propertyName, from: parseOptionValue, to: parseOptionValue })(input);
      if (rename.from === rename.to) {
        throw new Error('An option rename changes the value');
      }
      return { kind, ...rename };
    }
    case 'moveOption': {
      const move = object({ controller: propertyName, value: parseOptionValue, index: count })(input);
      if (move.index >= VARIANT_LIMITS.optionsMax) {
        throw new Error('Option index is out of bounds');
      }
      return { kind, ...move };
    }
    case 'addProp':
      return { kind, ...object({ controller: propertyName, prop: propertyName, type: parseTypeText })(input) };
    case 'removeProp':
      return { kind, ...object({ controller: propertyName, prop: propertyName })(input) };
    case 'attachProp': {
      const attach = object({
        controller: propertyName,
        prop: propertyName,
        options: (item) => boundedList(item, VARIANT_LIMITS.optionsMax, parseOptionValue),
      })(input);
      if (attach.options.length === 0 || new Set(attach.options).size !== attach.options.length) {
        throw new Error('A prop is attached for one or more distinct options');
      }
      return { kind, ...attach };
    }
    default:
      throw new Error('Unknown variant rule edit');
  }
}

function parseOptionValue(input: unknown): string {
  const raw = text(input);
  const value = variantOptionValue(raw);
  if (value === undefined) {
    throw new Error('Variant option must be a short value without quotes');
  }
  if (value !== raw) {
    throw new Error('Variant option must be trimmed');
  }
  return value;
}

// The same bounds as propertyEditing.ts's parsers, which import this file.
function propertyName(input: unknown): string {
  const value = text(input);
  if (value.length > VARIANT_LIMITS.nameCharsMax) {
    throw new Error('Property name exceeds limit');
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) {
    throw new Error('Use a TypeScript identifier for the property name');
  }
  return value;
}

function propertyText(input: unknown): string {
  const value = text(input);
  if (value.length > VARIANT_LIMITS.codeCharsMax) {
    throw new Error('Property text exceeds limit');
  }
  return value;
}

function parseTypeText(input: unknown): string {
  const value = propertyText(input);
  if (value.trim() === '') {
    throw new Error('A prop type is written');
  }
  return value;
}

function parseVariantRuleState(input: unknown): VariantRuleState {
  const state = VARIANT_RULE_STATES.find((candidate) => candidate === input);
  if (state === undefined) {
    throw new Error('Unknown variant rule state');
  }
  return state;
}

function parseVariantGroupReason(input: unknown): VariantGroupReason {
  const reason = VARIANT_GROUP_REASONS.find((candidate) => candidate === input);
  if (reason === undefined) {
    throw new Error('Unknown variant group reason');
  }
  return reason;
}

function boundedList<T>(input: unknown, max: number, parse: (value: unknown) => T): readonly T[] {
  const values = list(parse)(input);
  if (values.length > max) {
    throw new Error('Variant list exceeds limit');
  }
  return values;
}
