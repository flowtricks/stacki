// A prop's Visibility (Allowed, Required or Not allowed) set by conditions on
// other props, in the Value conditions editor every conditional value uses,
// each group's value a state. Pure, so the mapping is pinned by tests.
//
// TypeScript says a prop's Visibility with discriminated unions: each union
// a controller rules it by (`variant`, `element`, a switch) gives every option
// a state, and the prop's state is the strictest any union gives (Not allowed
// over Required over Allowed). So:
//
// - Reading: one group per controller and state, Not allowed first, then
//   Required, each testing the options that give it; Allowed is the Else.
// - Writing: each group must be one condition on one controller (any of some
//   options, or a switch on or off), its value a state. The rule each
//   controller gives an option is the first group on it that holds there,
//   else the Else; and the whole must equal the strictest of those rules for
//   every combination of options, which is what TypeScript will hold. A model
//   that is not (`Required when Variant = Play and Pressed is true`, an
//   Else that is not Allowed beside two controllers) is refused, never
//   written another way. Docs: docs/props-conditional-values.md.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { VARIANT_LIMITS, VARIANT_RULE_STATES, type VariantRuleState, type VisibilityRule } from '../../../shared/properties/variantRules';
import { CONDITIONAL_LIMITS, parseConditionalValue, type Condition, type ConditionGroup, type ConditionalValue } from '../../editor/conditionalValue';

/** A prop that can decide another's Visibility: its options, and whether it is a switch (`true` / `false`). */
export interface VisibilityController {
  readonly name: string;
  readonly options: readonly string[];
  readonly kind: 'string' | 'boolean';
}

/** Why a Visibility cannot be written: a group TypeScript cannot say, or a state combination it cannot. */
export type VisibilityProblem = { readonly kind: 'shape' } | { readonly kind: 'subject'; readonly name: string } | { readonly kind: 'combination' };

// Combinations checked when writing: past this, the options multiply into more than a designer means.
const COMBINATIONS_MAX = 4096;

const SEVERITY: Readonly<Record<VariantRuleState, number>> = { optional: 0, required: 1, forbidden: 2 };

/** The Visibility the rules say, as conditions: Not allowed groups first, then Required, Allowed the Else. */
export function visibilityConditional(rules: readonly VisibilityRule[], controllers: readonly VisibilityController[]): ConditionalValue {
  assert(rules.length <= VARIANT_LIMITS.groupsMax, 'visibilityConditional: the rules are bounded');
  const groups: ConditionGroup[] = [];
  for (const state of ['forbidden', 'required'] as const) {
    for (const rule of rules) {
      const options = rule.states.filter((entry) => entry.state === state).map((entry) => entry.option);
      const controller = controllers.find((candidate) => candidate.name === rule.controller);
      if (options.length > 0 && controller !== undefined) {
        groups.push({ match: 'all', conditions: [conditionOf(controller, options)], value: { kind: 'text', text: state } });
      }
    }
  }
  const parsed = parseConditionalValue({ groups: groups.slice(0, CONDITIONAL_LIMITS.groupsMax), otherwise: { kind: 'text', text: 'optional' } });
  assert(parsed.ok, 'visibilityConditional: the rules make a valid model');
  return parsed.value;
}

/** The rules an edited Visibility writes, or why TypeScript cannot say it. */
export function visibilityRules(model: ConditionalValue, controllers: readonly VisibilityController[]): Result<readonly VisibilityRule[], VisibilityProblem> {
  assert(controllers.length <= VARIANT_LIMITS.propsMax, 'visibilityRules: the controllers are bounded');
  const otherwise = stateOf(model.otherwise);
  if (otherwise === undefined) {
    return err({ kind: 'shape' });
  }
  const parts: { readonly controller: VisibilityController; readonly holds: (option: string) => boolean; readonly state: VariantRuleState }[] = [];
  for (const group of model.groups) {
    const state = stateOf(group.value);
    const [condition] = group.conditions;
    if (state === undefined || condition === undefined || group.conditions.length !== 1) {
      return err({ kind: 'shape' });
    }
    const controller = controllers.find((candidate) => candidate.name === condition.subject);
    if (controller === undefined) {
      return err({ kind: 'subject', name: condition.subject });
    }
    const holds = holdsFor(condition, controller);
    if (holds === undefined) {
      return err({ kind: 'shape' });
    }
    parts.push({ controller, holds, state });
  }
  const named = [...new Set(parts.map((part) => part.controller))];
  // Each controller's rule: the first of its groups that holds for an option, else the Else.
  const ruleOf = (controller: VisibilityController, option: string): VariantRuleState =>
    parts.find((part) => part.controller === controller && part.holds(option))?.state ?? otherwise;
  const count = named.reduce((product, controller) => product * Math.max(1, controller.options.length), 1);
  if (count > COMBINATIONS_MAX) {
    return err({ kind: 'combination' });
  }
  // Every combination of options: the conditions, tried in order, must give what TypeScript will hold.
  for (let index = 0; index < count; index += 1) {
    let rest = index;
    const chosen = new Map<VisibilityController, string>();
    for (const controller of named) {
      const option = controller.options[rest % controller.options.length];
      assert(option !== undefined, 'visibilityRules: each controller has an option at each step');
      chosen.set(controller, option);
      rest = Math.floor(rest / controller.options.length);
    }
    const conditions = parts.find((part) => part.holds(chosen.get(part.controller) ?? ''))?.state ?? otherwise;
    const strictest = named.reduce<VariantRuleState>(
      (state, controller) => stricter(state, ruleOf(controller, chosen.get(controller) ?? '')),
      named.length === 0 ? otherwise : 'optional',
    );
    if (conditions !== strictest) {
      return err({ kind: 'combination' });
    }
  }
  const rules = named.map((controller) => ({
    controller: controller.name,
    states: controller.options.map((option) => ({ option, state: ruleOf(controller, option) })),
  }));
  // A controller that allows the prop for every option rules nothing: it is left out.
  const kept = rules.filter((rule) => rule.states.some((entry) => entry.state !== 'optional'));
  assert(kept.length <= named.length, 'visibilityRules: one rule per controller at most');
  return ok(kept);
}

/** A state as a group's value: the text the editor's state picker writes. */
export function stateOf(result: ConditionalValue['otherwise']): VariantRuleState | undefined {
  return result.kind === 'text' ? VARIANT_RULE_STATES.find((state) => state === result.text) : undefined;
}

function stricter(left: VariantRuleState, right: VariantRuleState): VariantRuleState {
  return SEVERITY[left] >= SEVERITY[right] ? left : right;
}

function conditionOf(controller: VisibilityController, options: readonly string[]): Condition {
  if (controller.kind === 'boolean' && options.length === 1) {
    return { kind: 'test', subject: controller.name, operator: options[0] === 'true' ? 'truthy' : 'falsy' };
  }
  return { kind: 'compare', subject: controller.name, operator: 'in', values: options.map((value) => ({ kind: 'string', value })) };
}

// Which options a condition holds for, when it is one TypeScript can say on this controller.
function holdsFor(condition: Condition, controller: VisibilityController): ((option: string) => boolean) | undefined {
  if (condition.kind === 'test') {
    if (controller.kind !== 'boolean') {
      return undefined;
    }
    return condition.operator === 'truthy' ? (option) => option === 'true' : (option) => option === 'false';
  }
  const values = condition.values.map((value) => String(value.value));
  if (!values.every((value) => controller.options.includes(value))) {
    return undefined;
  }
  return condition.operator === 'in' ? (option) => values.includes(option) : (option) => !values.includes(option);
}
