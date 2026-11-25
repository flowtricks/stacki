// A prop's Visibility (Show, Required or Hide) set by conditions on
// other props, in the Value conditions editor every conditional value uses,
// each group's value a state. Pure, so the mapping is pinned by tests.
//
// TypeScript says a prop's Visibility with discriminated unions: each union
// a controller rules it by (`variant`, `element`, a switch) gives every option
// a state, and the prop's state is the strictest any union gives (Hide
// over Required over Show). So:
//
// - Reading: one controller that only shows or hides the prop reads Show
//   first, Hide the Else ("Show when Variant = Play"), naming the shorter
//   list. Otherwise one group per controller and state, Hide first, then
//   Required, each testing the options that give it; Show is the Else.
// - Writing: each group must be one condition on one controller (any of some
//   options, or a switch on or off), its value a state. The rule each
//   controller gives an option is the first group on it that holds there,
//   else the Else; and the whole must equal the strictest of those rules for
//   every combination of options, which is what TypeScript will hold. A model
//   that is not (`Required when Variant = Play and Pressed is true`, an
//   Else that is not Show beside two controllers) is refused, never
//   written another way. Docs: docs/props-conditional-values.md.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { VARIANT_LIMITS, VARIANT_RULE_STATES, type VariantGroup, type VariantRuleState, type VisibilityRule } from '../../../shared/properties/variantRules';
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

/**
 * The Visibility the rules say, as conditions. One controller that only shows
 * or hides the prop reads Show first: "Show when Variant = Play; else Hide",
 * the Show group naming the shorter list (`is any of` the shown options, or
 * `is not any of` the hidden ones). It means exactly what the rule means for
 * every option of that closed set, and writes back as the same rule, so
 * nothing is rewritten for having been read this way. Anything else (several
 * controllers, Required) reads as written: Hide groups first, then Required,
 * Show the Else.
 */
export function visibilityConditional(rules: readonly VisibilityRule[], controllers: readonly VisibilityController[]): ConditionalValue {
  assert(rules.length <= VARIANT_LIMITS.groupsMax, 'visibilityConditional: the rules are bounded');
  const shown = showFirst(rules, controllers);
  if (shown !== undefined) {
    return shown;
  }
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

// One controller's Show-or-Hide rule as Show first, Hide the Else; undefined when the rule is anything else.
function showFirst(rules: readonly VisibilityRule[], controllers: readonly VisibilityController[]): ConditionalValue | undefined {
  const [rule] = rules;
  if (rule === undefined || rules.length !== 1) {
    return undefined;
  }
  const controller = controllers.find((candidate) => candidate.name === rule.controller);
  if (controller === undefined) {
    return undefined;
  }
  // Closed: the rule names every option the controller has, and no other, so the complement is the same set of options.
  const named = rule.states.map((entry) => entry.option);
  if (named.length !== controller.options.length || !controller.options.every((option) => named.includes(option))) {
    return undefined;
  }
  if (rule.states.some((entry) => entry.state === 'required')) {
    return undefined;
  }
  const visible = rule.states.filter((entry) => entry.state === 'optional').map((entry) => entry.option);
  const hidden = rule.states.filter((entry) => entry.state === 'forbidden').map((entry) => entry.option);
  if (visible.length === 0) {
    return undefined;
  }
  if (hidden.length === 0) {
    return undefined;
  }
  assert(visible.length + hidden.length === controller.options.length, 'showFirst: every option is shown or hidden');
  // The shorter list of chips: the shown options, or "is not any of" the hidden ones (a switch is always one option).
  const condition: Condition =
    hidden.length < visible.length && controller.kind === 'string'
      ? { kind: 'compare', subject: controller.name, operator: 'notIn', values: hidden.map((value) => ({ kind: 'string', value })) }
      : conditionOf(controller, visible);
  const parsed = parseConditionalValue({
    groups: [{ match: 'all', conditions: [condition], value: { kind: 'text', text: 'optional' } }],
    otherwise: { kind: 'text', text: 'forbidden' },
  });
  assert(parsed.ok, 'showFirst: the rule makes a valid model');
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
    // A test kept as code (`index >= PAGE_SIZE`) names no prop, so no union can say it: refused, never rewritten.
    if (!('subject' in condition)) {
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

/** The prop a Visibility's code declares: its name, its type and whether it may be left out where no union rules it. */
export interface VisibilityDeclaration {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/**
 * A Visibility as the TypeScript that says it, for its `{}` view: with no
 * union ruling the prop, its own declaration (`label?: string`); else, for
 * each controller that rules it, that union's members, each naming its option
 * and the prop as that option declares it (`label?: never` where it is
 * hidden). Read-only: the members are written by the controls.
 */
export function visibilityCode(declaration: VisibilityDeclaration, groups: readonly VariantGroup[]): string {
  assert(declaration.name !== '', 'visibilityCode: the prop has a name');
  assert(groups.length <= VARIANT_LIMITS.groupsMax, 'visibilityCode: the groups are bounded');
  const ruling = groups.filter((group) => group.editing.kind !== 'candidate' && group.props.includes(declaration.name));
  if (ruling.length === 0) {
    return `${memberDeclaration(declaration.name, declaration.required ? 'required' : 'optional', declaration.type)};`;
  }
  const unions = ruling.map((group) => {
    const index = group.props.indexOf(declaration.name);
    assert(index >= 0, 'visibilityCode: a ruling group names the prop');
    const members = group.options.map((option) => {
      const rule = option.rules[index];
      const key = `${group.controller}${option.fallback ? '?' : ''}: ${optionLiteral(option.value, group.optionKind)}`;
      const type = rule === undefined || rule.type === '' ? declaration.type : rule.type;
      return `  | { ${key}; ${memberDeclaration(declaration.name, rule?.state ?? 'optional', type)} }`;
    });
    return [`// By ${group.controller}`, ...members].join('\n');
  });
  return unions.join('\n\n');
}

/** The prop a Tooltip's code declares: its declaration and its doc comment's text as written. */
export interface TooltipDeclaration extends VisibilityDeclaration {
  readonly description: string;
}

// The most lines a doc comment is shown with; past it, the code view is a summary of the source, not the source.
const COMMENT_LINES_MAX = 64;

/**
 * A Tooltip as the doc comment that says it, for its `{}` view: above the
 * prop's own declaration (`/** Accessible label. *\/ label?: string;`), or,
 * when `group` (the controller the prop's options document it by) is given,
 * on the prop in each of that union's members. A hidden member has no
 * tooltip. Read-only: the comments are written by the Tooltip field.
 */
export function tooltipCode(declaration: TooltipDeclaration, group: VariantGroup | undefined): string {
  assert(declaration.name !== '', 'tooltipCode: the prop has a name');
  if (group === undefined) {
    const own = memberDeclaration(declaration.name, declaration.required ? 'required' : 'optional', declaration.type);
    return `${documentComment(declaration.description, 'block')}${own};`;
  }
  const index = group.props.indexOf(declaration.name);
  assert(index >= 0, 'tooltipCode: the group names the prop');
  assert(group.options.length <= VARIANT_LIMITS.optionsMax, 'tooltipCode: the options are bounded');
  const members = group.options.map((option) => {
    const rule = option.rules[index];
    const state = rule?.state ?? 'optional';
    const key = `${group.controller}${option.fallback ? '?' : ''}: ${optionLiteral(option.value, group.optionKind)}`;
    const type = rule === undefined || rule.type === '' ? declaration.type : rule.type;
    const comment = state === 'forbidden' ? '' : documentComment(rule?.description ?? '', 'inline');
    return `  | { ${key}; ${comment}${memberDeclaration(declaration.name, state, type)} }`;
  });
  return [`// By ${group.controller}`, ...members].join('\n');
}

// Words as a doc comment: `/** … */` on its own line(s) above a declaration, or inline before it; nothing for none.
function documentComment(text: string, layout: 'block' | 'inline'): string {
  const lines = text.trim() === '' ? [] : text.trim().split('\n').slice(0, COMMENT_LINES_MAX);
  if (lines.length === 0) {
    return '';
  }
  if (layout === 'inline') {
    return `/** ${lines.map((line) => line.trim()).join(' ')} */ `;
  }
  if (lines.length === 1) {
    return `/** ${lines[0]?.trim() ?? ''} */\n`;
  }
  return ['/**', ...lines.map((line) => ` * ${line.trim()}`.trimEnd()), ' */', ''].join('\n');
}

// The prop as one member declares it: left out (`?`), needed, or refused (`?: never`).
function memberDeclaration(name: string, state: VariantRuleState, type: string): string {
  const written = type.trim() === '' ? 'unknown' : type.trim();
  switch (state) {
    case 'optional':
      return `${name}?: ${written}`;
    case 'required':
      return `${name}: ${written}`;
    case 'forbidden':
      return `${name}?: never`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// An option as its member's discriminant is written: a string literal, or `true` / `false`.
function optionLiteral(value: string, kind: VariantGroup['optionKind']): string {
  return kind === 'boolean' ? value : JSON.stringify(value);
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

// A condition that names the prop it tests: a comparison or a test, never code kept as written.
type SubjectCondition = Extract<Condition, { readonly subject: string }>;

// Which options a condition holds for, when it is one TypeScript can say on this controller.
function holdsFor(condition: SubjectCondition, controller: VisibilityController): ((option: string) => boolean) | undefined {
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
