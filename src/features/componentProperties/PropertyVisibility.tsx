// Visibility and a per-option Tooltip, in a prop's settings: each works as
// Default value does. Plain, it is one control (Visibility: Show or Required,
// three icon choices; Tooltip: its words) under a title whose field shows the
// purple + on hover, opening the data picker's Create conditional; set by
// conditions, it is the purple Conditional pill with a one-line summary,
// opening the Value conditions editor every conditional value uses, its
// groups testing other props (Variant, Element, Pressed) and giving a state
// (or, for the Tooltip, words), and its title is the blue reset label.
//
// Visibility replaces "Controlled by": the conditions are written as the
// discriminated unions TypeScript checks (src/features/props/visibility.ts),
// one `setVisibility` edit, one undo step. Conditions TypeScript cannot say
// are refused with one line; a union the writer cannot keep in step is the
// pill, disabled, with its one word. Its `{}` shows that TypeScript,
// read-only. docs/props-conditional-values.md.

import { useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { VARIANT_LIMITS } from '../../../shared/properties/variantRules';
import type { VariantGroup, VariantGroupReason, VariantRuleEdit, VariantRuleState, VisibilityRule } from '../../../shared/properties/variantRules';
import type { ConditionalValue } from '../../editor/conditionalValue';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { HideIcon, PreviewIcon, RequiredIcon } from '../../ui/Icons';
import {
  ConditionalDefaultField,
  ConditionalDefaultStart,
  conditionProps,
  conditionWords,
  optionDefaultStart,
  stateOf,
  ValueChoiceSwitch,
  visibilityCode,
  type ValueChoice,
  tooltipCode,
  tooltipConditional,
  tooltipEntries,
  visibilityConditional,
  visibilityRules,
  conditionSchema,
  type VisibilityController,
  type VisibilityProblem,
} from '../props/propBindings';
import { PropertyCodeToggle, PropertyCodeView, PropertyFieldHead } from './PropertyFieldHead';
import { PropertyTooltip } from './PropertySettings';

type Translate = ReturnType<typeof useTranslate>;

const STATE_KEYS = {
  optional: 'componentProps.variants.state.optional',
  required: 'componentProps.variants.state.required',
  forbidden: 'componentProps.variants.state.forbidden',
} as const satisfies Record<VariantRuleState, string>;

// Show, Hide, Required: the order the choices sit in, each with its Central icon.
const STATE_ICONS = {
  optional: <PreviewIcon size={14} />,
  forbidden: <HideIcon size={14} />,
  required: <RequiredIcon size={14} />,
} as const satisfies Record<VariantRuleState, ReactNode>;
const STATE_ORDER = ['optional', 'forbidden', 'required'] as const satisfies readonly VariantRuleState[];

/** The states as the icon choices the Visibility field and its Value conditions editor show. */
export function visibilityChoices(translate: Translate): readonly ValueChoice[] {
  return STATE_ORDER.map((state) => ({ value: state, label: translate(STATE_KEYS[state]), icon: STATE_ICONS[state] }));
}

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

/** A Visibility in one line: `Hide when Variant = Main; Show otherwise`. */
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
 * Visibility: Show or Required, or set by conditions. The prop's own
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
  const [code, setCode] = useState(false);
  const { name } = props;
  const controllers = visibilityControllers(props.groups, name);
  const rules = visibilityRulesOf(props.groups, name);
  const readonlyGroup = (props.groups ?? []).find((group) => group.editing.kind === 'readonly' && group.props.includes(name));
  const context = {
    frontmatter: '',
    propsSchema: conditionSchema(props.properties.filter((property) => controllers.some((controller) => controller.name === property.name))),
  };
  const choices = visibilityChoices(translate);
  const title = translate('componentProps.visibility.title');
  const write = (model: ConditionalValue): void => {
    const written = visibilityRules(model, controllers);
    if (!written.ok) {
      props.onProblem(problemText(written.error, translate));
      return;
    }
    // No condition finished on a prop no union rules yet: there is nothing to write.
    if (written.value.length === 0 && rules.length === 0) {
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
  const conditional = rules.length > 0;
  const editable = readonlyGroup === undefined;
  // Reset clears the conditions: no union rules the prop, which is then shown wherever it is passed.
  const reset = conditional && editable ? () => void props.run({ kind: 'setVisibility', prop: name, rules: [] }) : undefined;
  const head = (
    <PropertyFieldHead title={title} onReset={reset} onConditional={!conditional && controllers.length > 0 ? () => setStarting(true) : undefined}>
      <PropertyCodeToggle open={code} onToggle={() => setCode((current) => !current)} />
    </PropertyFieldHead>
  );
  const typescript = code ? <PropertyCodeView code={visibilityCode(props.property, props.groups ?? [])} /> : undefined;
  if (conditional) {
    const model = visibilityConditional(rules, controllers);
    const reason = readonlyGroup?.editing.kind === 'readonly' ? translate(REASON_KEYS[readonlyGroup.editing.reason]) : undefined;
    return (
      <div className="property-default property-field property-visibility" role="group" aria-label={title}>
        {head}
        {typescript ?? (
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
        )}
      </div>
    );
  }
  return (
    <div className="property-default property-field property-visibility" role="group" aria-label={title}>
      {head}
      {starting && (
        <ConditionalDefaultStart
          // Show first: "Show when Variant = Play; else Hide", as a rule is read back (visibility.ts).
          defaultResult={{ type: 'string', value: 'forbidden' }}
          context={context}
          valueChoices={choices}
          title={title}
          firstValue={{ kind: 'text', text: props.property.required ? 'required' : 'optional' }}
          onApply={write}
          onClose={() => setStarting(false)}
        />
      )}
      {typescript ?? (
        <ValueChoiceSwitch
          label={title}
          value={props.property.required ? 'required' : 'optional'}
          choices={choices}
          disabled={props.pending}
          onChange={(value) => {
            // Hiding a prop everywhere says nothing: Hide is chosen in a condition, so it opens the editor on one.
            if (value === 'forbidden') {
              if (controllers.length > 0) {
                setStarting(true);
              } else {
                props.onProblem(translate('componentProps.visibility.hideNeedsCondition'));
              }
              return;
            }
            props.onRequired(value === 'required');
          }}
        />
      )}
    </div>
  );
}

/**
 * Tooltip: its words, or, for a prop a controller rules, one per option, set
 * by conditions on that controller as the pill. A tooltip is a doc comment on
 * each option's declaration, so it can depend on that controller alone. Its
 * `{}` shows those comments as written.
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
  const [code, setCode] = useState(false);
  const title = translate('componentProps.settings.tooltip');
  const group = (props.groups ?? []).find((candidate) => candidate.editing.kind === 'editable' && candidate.props.includes(props.name));
  const toggle = <PropertyCodeToggle open={code} onToggle={() => setCode((current) => !current)} />;
  // The code is the prop's declaration with its comment: a new prop has no name yet, so nothing to show.
  const declaration = props.property.name === '' ? undefined : props.property;
  const typescript = code && declaration !== undefined ? <PropertyCodeView code={tooltipCode(declaration, group)} /> : undefined;
  if (group === undefined) {
    return (
      <PropertyTooltip
        property={props.property}
        onChange={props.onChange}
        head={
          <PropertyFieldHead title={title} onReset={undefined} onConditional={undefined}>
            {declaration !== undefined && toggle}
          </PropertyFieldHead>
        }
        code={typescript}
      />
    );
  }
  const index = group.props.indexOf(props.name);
  const tooltips = group.options.flatMap((option) => {
    const rule = option.rules[index];
    return rule === undefined || rule.state === 'forbidden' ? [] : [{ option: option.value, description: rule.description }];
  });
  const options = tooltips.map((tooltip) => tooltip.option);
  const context = { frontmatter: '', propsSchema: conditionSchema(props.properties.filter((property) => property.name === group.controller)) };
  const write = (model: ConditionalValue): void => {
    const entries = tooltipEntries(model, group.controller, options);
    if (!entries.ok) {
      props.onProblem(translate('componentProps.tooltips.perOption', { controller: group.controller }));
      return;
    }
    void props.run({ kind: 'setRuleDescriptions', controller: group.controller, prop: props.name, entries: entries.value });
  };
  if (new Set(tooltips.map((tooltip) => tooltip.description)).size > 1) {
    // Reset gives every option the same words, none: the plain field again.
    const clear = (): void =>
      void props.run({
        kind: 'setRuleDescriptions',
        controller: group.controller,
        prop: props.name,
        entries: options.map((option) => ({ option, description: '' })),
      });
    return (
      <div className="property-default property-field property-tooltip" role="group" aria-label={title}>
        <PropertyFieldHead title={title} onReset={clear} onConditional={undefined}>
          {toggle}
        </PropertyFieldHead>
        {typescript ?? (
          <ConditionalDefaultField model={tooltipConditional(group.controller, tooltips)} context={context} quote='"' title={title} onApply={write} />
        )}
      </div>
    );
  }
  const [first] = options;
  return (
    <>
      <PropertyTooltip
        property={props.property}
        onChange={props.onChange}
        head={
          <PropertyFieldHead title={title} onReset={undefined} onConditional={first === undefined ? undefined : () => setStarting(true)}>
            {toggle}
          </PropertyFieldHead>
        }
        code={typescript}
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
