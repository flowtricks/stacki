// Visibility and a per-option Tooltip, in a prop's settings: each works as
// Default value does. Plain, it is one control (Visibility: Allowed or
// Required; Tooltip: its words) with a branch beside its title; set by
// conditions, it is the purple Conditional pill with a one-line summary,
// opening the Value conditions editor every conditional value uses, its
// groups testing other props (Variant, Element, Pressed) and giving a state
// (or, for the Tooltip, words).
//
// Visibility replaces "Controlled by": the conditions are written as the
// discriminated unions TypeScript checks (src/features/props/visibility.ts),
// one `setVisibility` edit, one undo step. Conditions TypeScript cannot say
// are refused with one line; a union the writer cannot keep in step is the
// pill, disabled, with its one word. docs/props-conditional-values.md.

import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { VARIANT_LIMITS } from '../../../shared/properties/variantRules';
import type { VariantGroup, VariantGroupReason, VariantRuleEdit, VariantRuleState, VisibilityRule } from '../../../shared/properties/variantRules';
import type { ConditionalValue } from '../../editor/conditionalValue';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import type { DropdownOption } from '../../ui/Dropdown';
import { BranchIcon } from '../../ui/Icons';
import {
  ConditionalDefaultField,
  ConditionalDefaultStart,
  conditionProps,
  conditionWords,
  optionDefaultStart,
  stateOf,
  tooltipConditional,
  tooltipEntries,
  visibilityConditional,
  visibilityRules,
  conditionSchema,
  type VisibilityController,
  type VisibilityProblem,
} from '../props/propBindings';
import { PropertyTooltip } from './PropertySettings';

type Translate = ReturnType<typeof useTranslate>;

const STATE_KEYS = {
  optional: 'componentProps.variants.state.optional',
  required: 'componentProps.variants.state.required',
  forbidden: 'componentProps.variants.state.forbidden',
} as const satisfies Record<VariantRuleState, string>;

const REASON_KEYS = {
  shape: 'componentProps.variants.reason.shape',
  nested: 'componentProps.variants.reason.nested',
  shared: 'componentProps.variants.reason.shared',
  runtime: 'componentProps.variants.reason.runtime',
} as const satisfies Record<VariantGroupReason, string>;

/** The props that can decide `name`'s Visibility: every prop of options or a switch but itself, with its options. */
export function visibilityControllers(groups: readonly VariantGroup[] | undefined, name: string): readonly VisibilityController[] {
  const all = groups ?? [];
  assert(all.length <= VARIANT_LIMITS.groupsMax, 'visibilityControllers: the groups are bounded');
  const seen = new Set<string>();
  const out: VisibilityController[] = [];
  // Real groups first, so a controller that is both a group and a candidate is read as the group.
  for (const group of [...all.filter((item) => item.editing.kind !== 'candidate'), ...all.filter((item) => item.editing.kind === 'candidate')]) {
    if (group.controller !== name && !seen.has(group.controller)) {
      seen.add(group.controller);
      out.push({ name: group.controller, options: group.options.map((option) => option.value), kind: group.optionKind });
    }
  }
  return out;
}

/** The rules the groups that rule `name` give it, one per controller. */
export function visibilityRulesOf(groups: readonly VariantGroup[] | undefined, name: string): readonly VisibilityRule[] {
  return (groups ?? [])
    .filter((group) => group.editing.kind !== 'candidate' && group.props.includes(name))
    .map((group) => {
      const index = group.props.indexOf(name);
      return {
        controller: group.controller,
        states: group.options.map((option) => ({ option: option.value, state: option.rules[index]?.state ?? 'optional' })),
      };
    });
}

/** A Visibility in one line: `Not allowed when Variant = Main; Allowed otherwise`. */
export function visibilitySummary(model: ConditionalValue, properties: readonly ComponentProperty[], translate: Translate): string {
  const catalog = conditionProps('', conditionSchema(properties));
  const lines = model.groups.flatMap((group) => {
    const state = stateOf(group.value);
    if (state === undefined) {
      return [];
    }
    const conditions = group.conditions.map((condition) => conditionWords(condition, catalog, translate)).join(', ');
    return [translate('componentProps.visibility.when', { state: translate(STATE_KEYS[state]), conditions })];
  });
  const otherwise = stateOf(model.otherwise) ?? 'optional';
  return [...lines, translate('componentProps.visibility.otherwise', { state: translate(STATE_KEYS[otherwise]) })].join('; ');
}

/**
 * Visibility: Allowed or Required, or set by conditions. The prop's own
 * Required flag is the plain state; conditions are written as unions.
 */
export function PropertyVisibilityField(props: {
  readonly name: string;
  readonly property: ComponentProperty;
  readonly properties: readonly ComponentProperty[];
  readonly groups: readonly VariantGroup[] | undefined;
  readonly pending: boolean;
  readonly onRequired: (required: boolean) => void;
  readonly run: (edit: VariantRuleEdit) => Promise<boolean>;
  readonly onProblem: (message: string) => void;
}) {
  const translate = useTranslate();
  const [starting, setStarting] = useState(false);
  const { name } = props;
  const controllers = visibilityControllers(props.groups, name);
  const rules = visibilityRulesOf(props.groups, name);
  const readonlyGroup = (props.groups ?? []).find((group) => group.editing.kind === 'readonly' && group.props.includes(name));
  const context = {
    frontmatter: '',
    propsSchema: conditionSchema(props.properties.filter((property) => controllers.some((controller) => controller.name === property.name))),
  };
  const choices: readonly DropdownOption[] = (['optional', 'required', 'forbidden'] as const).map((state) => ({
    value: state,
    label: translate(STATE_KEYS[state]),
  }));
  const title = translate('componentProps.visibility.title');
  const write = (model: ConditionalValue): void => {
    const written = visibilityRules(model, controllers);
    if (!written.ok) {
      props.onProblem(problemText(written.error, translate));
      return;
    }
    void props.run({ kind: 'setVisibility', prop: name, rules: written.value }).then((done) => {
      // With no condition left, the Else is the plain state: Required is the prop's own flag.
      const plain = stateOf(model.otherwise);
      if (done && written.value.length === 0 && plain === 'required' && !props.property.required) {
        props.onRequired(true);
      }
    });
  };
  if (rules.length > 0) {
    const model = visibilityConditional(rules, controllers);
    const reason = readonlyGroup?.editing.kind === 'readonly' ? translate(REASON_KEYS[readonlyGroup.editing.reason]) : undefined;
    return (
      <div className="property-default property-visibility" role="group" aria-label={title}>
        <div className="property-default-title">
          <span>{title}</span>
        </div>
        <ConditionalDefaultField
          model={model}
          context={context}
          quote='"'
          valueChoices={choices}
          title={title}
          summary={visibilitySummary(model, props.properties, translate)}
          readonlyWord={reason}
          onApply={write}
        />
      </div>
    );
  }
  const branch = translate('componentProps.defaults.conditional');
  return (
    <div className="property-default property-visibility" role="group" aria-label={title}>
      <div className="property-default-title">
        <span>{title}</span>
        {controllers.length > 0 && (
          <button
            type="button"
            className={`prop-expr-toggle${starting ? ' on' : ''}`}
            title={branch}
            aria-label={branch}
            aria-pressed={starting}
            onClick={() => setStarting(true)}
          >
            <BranchIcon size={12} />
          </button>
        )}
      </div>
      {starting && (
        <ConditionalDefaultStart
          defaultResult={{ type: 'string', value: props.property.required ? 'required' : 'optional' }}
          context={context}
          valueChoices={choices}
          title={title}
          firstValue={{ kind: 'text', text: 'forbidden' }}
          onApply={write}
          onClose={() => setStarting(false)}
        />
      )}
      <Dropdown
        ariaLabel={title}
        value={props.property.required ? 'required' : 'optional'}
        options={choices.filter((choice) => choice.value !== 'forbidden')}
        disabled={props.pending}
        onChange={(value) => props.onRequired(value === 'required')}
      />
    </div>
  );
}

/**
 * Tooltip for a prop a controller rules: its words, or one per option, set by
 * conditions on that controller as the pill. A tooltip is a doc comment on each
 * option's declaration, so it can depend on that controller alone.
 */
export function PropertyTooltipField(props: {
  readonly name: string;
  readonly property: ComponentProperty;
  readonly properties: readonly ComponentProperty[];
  readonly groups: readonly VariantGroup[] | undefined;
  readonly onChange: (description: string) => void;
  readonly run: (edit: VariantRuleEdit) => Promise<boolean>;
  readonly onProblem: (message: string) => void;
}) {
  const translate = useTranslate();
  const [starting, setStarting] = useState(false);
  const group = (props.groups ?? []).find((candidate) => candidate.editing.kind === 'editable' && candidate.props.includes(props.name));
  if (group === undefined) {
    return <PropertyTooltip property={props.property} onChange={props.onChange} />;
  }
  const index = group.props.indexOf(props.name);
  const tooltips = group.options.flatMap((option) => {
    const rule = option.rules[index];
    return rule === undefined || rule.state === 'forbidden' ? [] : [{ option: option.value, description: rule.description }];
  });
  const options = tooltips.map((tooltip) => tooltip.option);
  const context = { frontmatter: '', propsSchema: conditionSchema(props.properties.filter((property) => property.name === group.controller)) };
  const title = translate('componentProps.settings.tooltip');
  const write = (model: ConditionalValue): void => {
    const entries = tooltipEntries(model, group.controller, options);
    if (!entries.ok) {
      props.onProblem(translate('componentProps.tooltips.perOption', { controller: group.controller }));
      return;
    }
    void props.run({ kind: 'setRuleDescriptions', controller: group.controller, prop: props.name, entries: entries.value });
  };
  if (new Set(tooltips.map((tooltip) => tooltip.description)).size > 1) {
    return (
      <div className="property-default property-tooltip" role="group" aria-label={title}>
        <div className="property-default-title">
          <span>{title}</span>
        </div>
        <ConditionalDefaultField model={tooltipConditional(group.controller, tooltips)} context={context} quote='"' title={title} onApply={write} />
      </div>
    );
  }
  const [first] = options;
  const branch = translate('componentProps.defaults.conditional');
  return (
    <>
      <PropertyTooltip
        property={props.property}
        onChange={props.onChange}
        branch={
          first !== undefined && (
            <button
              type="button"
              className={`prop-expr-toggle${starting ? ' on' : ''}`}
              title={branch}
              aria-label={branch}
              aria-pressed={starting}
              onClick={() => setStarting(true)}
            >
              <BranchIcon size={12} />
            </button>
          )
        }
      />
      {starting && first !== undefined && (
        <ConditionalDefaultStart
          defaultResult={tooltips[0]?.description === '' ? undefined : { type: 'string', value: tooltips[0]?.description ?? '' }}
          context={context}
          title={title}
          start={optionDefaultStart({ groups: [], otherwise: { kind: 'none', word: 'undefined' } }, group.controller, first)}
          onApply={write}
          onClose={() => setStarting(false)}
        />
      )}
    </>
  );
}

function problemText(problem: VisibilityProblem, translate: Translate): string {
  switch (problem.kind) {
    case 'shape':
      return translate('componentProps.visibility.shape');
    case 'subject':
      return translate('componentProps.visibility.subject', { name: problem.name });
    case 'combination':
      return translate('componentProps.visibility.combination');
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}
