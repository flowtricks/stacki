// A prop's default shown as conditions on other props, in the Value conditions
// editor the Style panel's attribute fields use (src/features/props/ConditionalValue.tsx):
// "If Variant = Play and Pressed is true ↳ Pause". Pure, so the round trip is
// pinned by tests without a renderer.
//
// Two shapes of code say such a default, and each is written back in its own
// shape, so the component keeps the code its author chose:
//
// - A destructure default that is a condition chain
//   (`label = variant === "play" ? "Play" : undefined`): the model is the
//   expression itself (readConditionalExpression), written back whole.
// - A lookup table the component indexes by a prop (`label ?? named[variant]`
//   with `const named = { play: pressed ? "Pause" : "Play", close: "Close" }`):
//   each entry becomes the groups that start with `variant = <its key>`, its
//   own conditions after; writing splits the model back into one entry per
//   option and keeps the code of every entry whose conditions did not change.
//
// Docs: docs/props-conditional-values.md.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import type { VariantDefault, VariantDefaultEntry } from '../../../shared/properties/variantRules';
import { VARIANT_LIMITS } from '../../../shared/properties/variantRules';
import {
  CONDITIONAL_LIMITS,
  emitConditionalExpression,
  parseConditionalValue,
  readConditionalExpression,
  type Condition,
  type ConditionGroup,
  type ConditionalResult,
  type ConditionalValue,
  type WriteOptions,
} from '../../editor/conditionalValue';
import { resultOfAttr, type ConditionSchemaField } from './conditionalModel';

// An option as a union writes it, without its quotes (`"play"` is play).
function optionValueOf(literal: string): string {
  const quoted = /^(["'`])(.*)\1$/s.exec(literal.trim());
  return quoted?.[2] ?? literal.trim();
}

/** A table default: the `table` kind of VariantDefault. */
export type TableDefault = Extract<VariantDefault, { readonly kind: 'table' }>;

const NO_VALUE: ConditionalResult = { kind: 'none', word: 'undefined' };

/** The props a default's conditions can test, as the conditions catalog reads a schema (conditionalModel.ts). */
export function conditionSchema(properties: readonly ComponentProperty[]): readonly ConditionSchemaField[] {
  assert(properties.length <= VARIANT_LIMITS.propsMax, 'conditionSchema: the props are bounded');
  return properties.map((property): ConditionSchemaField => {
    const options = literalOptions(property.type.trim());
    if (options !== undefined && options.length > 0) {
      return { name: property.name, type: 'enum', options: options.map(optionValueOf) };
    }
    const type = property.type.trim();
    if (type === 'boolean' || type === 'number') {
      return { name: property.name, type };
    }
    return { name: property.name, type: 'string' };
  });
}

/** The conditional a destructure default is, or undefined for a plain or other default. */
export function conditionalOfDefault(defaultValue: string): ConditionalValue | undefined {
  const code = defaultValue.trim();
  return code === '' ? undefined : readConditionalExpression(code);
}

/**
 * The default a closed editor writes into the destructure: the expression, the
 * plain value it came down to, or '' (no default) when that value is none.
 */
export function defaultOfConditional(model: ConditionalValue, options: WriteOptions): string {
  if (model.groups.length > 0) {
    return emitConditionalExpression(model, options);
  }
  return entryCode(model.otherwise, options) ?? '';
}

/**
 * The conditions a table says, or undefined when an entry holds code the
 * editor cannot show (a call, an `any` group of several conditions, more
 * groups than the editor holds): that table stays read-only, as its code.
 */
export function tableConditional(table: TableDefault): ConditionalValue | undefined {
  assert(table.entries.length <= VARIANT_LIMITS.optionsMax, 'tableConditional: the entries are bounded');
  const groups: ConditionGroup[] = [];
  for (const entry of table.entries) {
    const read = entryModel(entry.code);
    if (read === undefined) {
      return undefined;
    }
    const key = keyCondition(table.key, entry.option);
    for (const group of read.groups) {
      if (group.match === 'any' && group.conditions.length > 1) {
        return undefined;
      }
      if (group.conditions.length + 1 > CONDITIONAL_LIMITS.conditionsPerGroupMax) {
        return undefined;
      }
      groups.push({ match: 'all', conditions: [key, ...group.conditions], value: group.value });
    }
    // An entry's own Else is the option's last group; no value there is what no entry gives too.
    if (read.otherwise.kind !== 'none') {
      groups.push({ match: 'all', conditions: [key], value: read.otherwise });
    }
  }
  if (groups.length > CONDITIONAL_LIMITS.groupsMax) {
    return undefined;
  }
  const parsed = parseConditionalValue({ groups, otherwise: NO_VALUE });
  return parsed.ok ? parsed.value : undefined;
}

/**
 * The table entries an edited model writes, or why it cannot be one: every
 * group must start with `key = <one option>` (the table is indexed by it) and
 * the Else must give no value (a key the table lacks gives none). An entry
 * whose conditions are what the table holds keeps its code as written.
 */
export function tableEntries(model: ConditionalValue, table: TableDefault, options: WriteOptions): Result<readonly VariantDefaultEntry[], 'perOption'> {
  if (model.otherwise.kind !== 'none') {
    return err('perOption');
  }
  const order: string[] = [];
  const byOption = new Map<string, { groups: ConditionGroup[]; otherwise: ConditionalResult | undefined }>();
  for (const group of model.groups) {
    const option = keyOption(group, table.key);
    if (option === undefined) {
      return err('perOption');
    }
    const slot = byOption.get(option) ?? { groups: [], otherwise: undefined };
    if (!byOption.has(option)) {
      order.push(option);
      byOption.set(option, slot);
    }
    const rest = group.conditions.slice(1);
    // After an option's plain group nothing more for it is ever reached.
    if (slot.otherwise !== undefined) {
      continue;
    }
    if (rest.length === 0) {
      slot.otherwise = group.value;
    } else {
      slot.groups.push({ match: 'all', conditions: rest, value: group.value });
    }
  }
  const entries: VariantDefaultEntry[] = [];
  for (const option of order) {
    const slot = byOption.get(option);
    assert(slot !== undefined, 'tableEntries: every ordered option has its groups');
    const sub: ConditionalValue = { groups: slot.groups, otherwise: slot.otherwise ?? NO_VALUE };
    const before = table.entries.find((entry) => entry.option === option);
    const same = before !== undefined && sameModel(entryModel(before.code), sub);
    const code = same ? before.code : sub.groups.length > 0 ? emitConditionalExpression(sub, options) : entryCode(sub.otherwise, options);
    if (code !== undefined) {
      entries.push({ option, code });
    }
  }
  assert(entries.length <= order.length, 'tableEntries: at most one entry per option');
  return ok(entries);
}

// An entry's code as a model: a chain of conditions, or one plain value as the Else.
function entryModel(code: string): ConditionalValue | undefined {
  const chain = readConditionalExpression(code);
  if (chain !== undefined) {
    return chain;
  }
  const plain = resultOfAttr({ type: 'expr', value: code });
  return plain === undefined ? undefined : { groups: [], otherwise: plain };
}

// A plain value as code: words quoted as the file quotes them; no value is no entry.
function entryCode(result: ConditionalResult, options: WriteOptions): string | undefined {
  return result.kind === 'none' ? undefined : emitConditionalExpression({ groups: [], otherwise: result }, options);
}

function keyCondition(key: string, option: string): Condition {
  return { kind: 'compare', subject: key, operator: 'in', values: [{ kind: 'string', value: option }] };
}

// The option a group is for: its first condition is `key = <one option>`, and the group holds all its conditions.
function keyOption(group: ConditionGroup, key: string): string | undefined {
  const [first] = group.conditions;
  if (first === undefined || first.kind !== 'compare' || first.subject !== key || first.operator !== 'in') {
    return undefined;
  }
  if (group.match === 'any' && group.conditions.length > 1) {
    return undefined;
  }
  const [value] = first.values;
  return first.values.length === 1 && value?.kind === 'string' ? value.value : undefined;
}

function sameModel(left: ConditionalValue | undefined, right: ConditionalValue): boolean {
  return left !== undefined && JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

// `any` and `all` mean the same over one condition, and the empty Else may be spelled `null`.
function normalized(model: ConditionalValue): ConditionalValue {
  return {
    groups: model.groups.map((group) => ({ ...group, match: group.conditions.length === 1 ? 'all' : group.match })),
    otherwise: model.otherwise.kind === 'none' ? NO_VALUE : model.otherwise,
  };
}
