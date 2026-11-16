// Variant rules in a prop's own settings: which props each option of a
// controller (`variant`, `element`) allows, requires or forbids, edited with
// controls, never TypeScript. Main reads the rules from the component's Props
// union and writes each change back as the smallest TypeScript edit
// (docs/props-variant-rules.md); each control sends one edit, one undo step.
//
// - The controller keeps the panel's own Options list and Default value
//   dropdown (PropertyOptions, PropertyDefault). For it they write the union:
//   adding, renaming, removing or moving an option is an option edit, and
//   picking the default moves the fallback, instead of a save of the type text.
// - A prop the controller rules shows, in place of Required, "Controlled by"
//   with one Allowed / Required / Not allowed switch per option.
// - A prop every option shares shows "Only for", which gives it rules: the
//   options picked allow it, the rest do not.
// - A group main cannot edit faithfully is drawn the same, disabled, with one
//   word for why.

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import { VARIANT_LIMITS, variantGroupsOf } from '../../../shared/properties/variantRules';
import type { VariantGroup, VariantGroupReason, VariantRuleEdit, VariantRuleState } from '../../../shared/properties/variantRules';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import type { ListFieldChange } from '../props/ListField';
import type { PropertySaveHost, PropertySaveOutcome } from './propertyAutosave';
import './propertyVariants.css';

/** Where the controls read their groups and send their edits: the form's save host. */
export interface VariantHost {
  readonly groups: readonly VariantGroup[];
  readonly edit: (edit: VariantRuleEdit) => Promise<PropertySaveOutcome>;
}

/** What a prop is to the variant rules: the prop that picks the option, one an option rules, one that could be ruled, or none. */
export type VariantRole =
  | { readonly kind: 'controller'; readonly group: VariantGroup }
  | { readonly kind: 'ruled'; readonly groups: readonly VariantGroup[] }
  | { readonly kind: 'attachable'; readonly groups: readonly VariantGroup[] }
  | { readonly kind: 'none' };

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

const STATE_ORDER: readonly VariantRuleState[] = ['optional', 'required', 'forbidden'];

export function variantRoleOf(groups: readonly VariantGroup[] | undefined, name: string): VariantRole {
  if (name === '') {
    return { kind: 'none' };
  }
  const controller = groups?.find((group) => group.controller === name);
  if (controller !== undefined) {
    return { kind: 'controller', group: controller };
  }
  const ruled = variantGroupsOf(groups, name);
  if (ruled.length > 0) {
    return { kind: 'ruled', groups: ruled };
  }
  const attachable = (groups ?? []).filter((group) => group.attachable.includes(name));
  return attachable.length > 0 ? { kind: 'attachable', groups: attachable } : { kind: 'none' };
}

/**
 * The host a prop's settings form gives the controls: each edit goes through
 * the form's own save host (one undoable batch), then the form is rebased on
 * the prop as the file now holds it, so its next autosave never writes back
 * what the edit replaced. `refreshGroups` reads the groups again for a form
 * whose host does not hand them down fresh (the data picker's dialog).
 */
export function useVariantHost(
  groups: readonly VariantGroup[] | undefined,
  form: { readonly saveHost: PropertySaveHost; readonly name: string; readonly rebase: (fresh: ComponentProperty) => void },
  refreshGroups?: () => Promise<readonly VariantGroup[] | undefined>,
): VariantHost | undefined {
  const [fresh, setFresh] = useState<readonly VariantGroup[] | undefined>(undefined);
  const shown = fresh ?? groups;
  if (shown === undefined) {
    return undefined;
  }
  return {
    groups: shown,
    edit: async (edit) => {
      const outcome = await form.saveHost.save({ kind: 'variantRules', edit });
      if (outcome.kind === 'saved') {
        const property = await form.saveHost.reload(form.name);
        if (property.ok) {
          form.rebase(property.value);
        }
        if (refreshGroups !== undefined) {
          setFresh(await refreshGroups());
        }
      }
      return outcome;
    },
  };
}

/**
 * Sends one edit at a time and reports a refusal where the form reports its
 * own (`onProblem`, the line under the fields). True when it was written.
 */
export function useVariantRun(host: VariantHost | undefined, onProblem: (message: string) => void) {
  const [pending, setPending] = useState(false);
  const run = async (edit: VariantRuleEdit): Promise<boolean> => {
    if (host === undefined || pending) {
      return false;
    }
    setPending(true);
    onProblem('');
    try {
      const outcome = await host.edit(edit);
      if (outcome.kind === 'saved') {
        return true;
      }
      onProblem(outcome.message);
      return false;
    } catch (caught: unknown) {
      onProblem(String(caught));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
}

/** An option's value as the Options list shows it: the literal without its quotes. */
export function optionValueOf(literal: string): string {
  const quoted = /^(["'`])(.*)\1$/s.exec(literal.trim());
  return quoted?.[2] ?? literal.trim();
}

/**
 * The option edit one change of the controller's Options list stands for, or
 * undefined when it stands for none yet (a name still being typed, a move to
 * where it was). `options` are the literals the file holds; `next`, the list after.
 */
export function optionListEdit(
  controller: string,
  options: readonly string[],
  next: readonly string[],
  change: ListFieldChange,
  commit: 'immediate' | 'draft',
): VariantRuleEdit | undefined {
  assert(options.length <= VARIANT_LIMITS.optionsMax, 'optionListEdit: options are bounded');
  switch (change.kind) {
    case 'add': {
      const added = next.at(-1);
      return added === undefined ? undefined : { kind: 'addOption', controller, value: optionValueOf(added) };
    }
    case 'remove': {
      const removed = options[change.index];
      return removed === undefined ? undefined : { kind: 'removeOption', controller, value: optionValueOf(removed) };
    }
    case 'move': {
      const moved = options[change.index];
      const index = moved === undefined ? -1 : next.indexOf(moved);
      return moved === undefined || index < 0 || index === change.index ? undefined : { kind: 'moveOption', controller, value: optionValueOf(moved), index };
    }
    case 'edit': {
      const from = options[change.index];
      const to = next[change.index];
      if (commit === 'draft' || from === undefined || to === undefined) {
        return undefined;
      }
      const value = optionValueOf(to).trim();
      return optionValueOf(from) === value ? undefined : { kind: 'renameOption', controller, from: optionValueOf(from), to: value };
    }
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/** The fallback edit a Default value pick stands for: the literal of another option. */
export function fallbackEdit(group: VariantGroup, defaultValue: string): VariantRuleEdit | undefined {
  const options = literalOptions(defaultValue.trim());
  if (options?.length !== 1) {
    return undefined;
  }
  const value = optionValueOf(defaultValue);
  const option = group.options.find((candidate) => candidate.value === value);
  if (option === undefined || option.fallback) {
    return undefined;
  }
  return { kind: 'setFallback', controller: group.controller, value };
}

/** "Controlled by" and one switch per option: a ruled prop's place for Required. */
export function VariantPropRules(props: {
  readonly name: string;
  readonly groups: readonly VariantGroup[];
  readonly host: VariantHost;
  readonly onProblem: (message: string) => void;
}) {
  const translate = useTranslate();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const { run, pending } = useVariantRun(props.host, props.onProblem);
  const group = props.groups.find((candidate) => candidate.controller === chosen) ?? props.groups[0];
  assert(group !== undefined, 'VariantPropRules: a ruled prop has a group');
  const index = group.props.indexOf(props.name);
  assert(index >= 0, 'VariantPropRules: the prop is one the group rules');
  const disabled = pending || group.editing.kind !== 'editable';
  return (
    <div className="variant-rules" role="group" aria-label={translate('componentProps.variants.rules')} aria-busy={pending}>
      <ControllerRow label={translate('componentProps.variants.controlledBy')} groups={props.groups} group={group} onChoose={setChosen} translate={translate} />
      {group.options.map((option) => {
        const rule = option.rules[index];
        assert(rule !== undefined, 'VariantPropRules: every option has a rule for every prop');
        return (
          <div key={option.value} className="variant-rule-row">
            <span className="variant-rule-option" title={option.value}>
              {option.value}
            </span>
            <VariantStateSwitch
              label={translate('componentProps.variants.cell', { prop: props.name, controller: group.controller, value: option.value })}
              state={rule.state}
              disabled={disabled}
              translate={translate}
              onPick={(state) => void run({ kind: 'setRule', controller: group.controller, option: option.value, prop: props.name, state })}
            />
          </div>
        );
      })}
    </div>
  );
}

/** "Only for": a shared prop's options to allow it for; the first pick gives it rules. */
export function VariantOnlyFor(props: {
  readonly name: string;
  readonly groups: readonly VariantGroup[];
  readonly host: VariantHost;
  readonly onProblem: (message: string) => void;
}) {
  const translate = useTranslate();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const { run, pending } = useVariantRun(props.host, props.onProblem);
  const group = props.groups.find((candidate) => candidate.controller === chosen) ?? props.groups[0];
  assert(group !== undefined, 'VariantOnlyFor: an attachable prop has a group');
  return (
    <div className="variant-rules" role="group" aria-label={translate('componentProps.variants.onlyFor')} aria-busy={pending}>
      <ControllerRow label={translate('componentProps.variants.onlyFor')} groups={props.groups} group={group} onChoose={setChosen} translate={translate} />
      <div className="variant-only-for">
        {group.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="variant-only-option"
            aria-label={translate('componentProps.variants.cell', { prop: props.name, controller: group.controller, value: option.value })}
            disabled={pending}
            onClick={() => void run({ kind: 'attachProp', controller: group.controller, prop: props.name, options: [option.value] })}
          >
            {option.value}
          </button>
        ))}
      </div>
    </div>
  );
}

// The controller's name, or a choice when two groups rule the prop; and a
// read-only group's one word.
function ControllerRow(props: {
  readonly label: string;
  readonly groups: readonly VariantGroup[];
  readonly group: VariantGroup;
  readonly translate: Translate;
  readonly onChoose: (controller: string) => void;
}) {
  const { groups, group, translate } = props;
  return (
    <div className="variant-controlled">
      <span>{props.label}</span>
      <span className="variant-controller">
        {group.editing.kind === 'readonly' && <span className="variant-reason">{translate(REASON_KEYS[group.editing.reason])}</span>}
        {groups.length > 1 ? (
          <Dropdown
            ariaLabel={props.label}
            value={group.controller}
            options={groups.map((candidate) => ({ value: candidate.controller, label: candidate.controller }))}
            onChange={props.onChoose}
          />
        ) : (
          <span className="variant-chip">{group.controller}</span>
        )}
      </span>
    </div>
  );
}

// Allowed, Required, Not allowed: three choices side by side, one of them on.
// Left and right arrows pick the one beside.
function VariantStateSwitch(props: {
  readonly label: string;
  readonly state: VariantRuleState;
  readonly disabled: boolean;
  readonly translate: Translate;
  readonly onPick: (state: VariantRuleState) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step !== 0 && !props.disabled) {
      event.preventDefault();
      const next = STATE_ORDER[(STATE_ORDER.indexOf(props.state) + step + STATE_ORDER.length) % STATE_ORDER.length];
      assert(next !== undefined, 'VariantStateSwitch: the next state exists');
      props.onPick(next);
    }
  };
  return (
    <div className="variant-seg" role="radiogroup" aria-label={props.label} onKeyDown={move}>
      {STATE_ORDER.map((state) => (
        <button
          key={state}
          type="button"
          role="radio"
          aria-checked={state === props.state}
          tabIndex={state === props.state ? 0 : -1}
          className={state === props.state ? 'on' : ''}
          data-state={state}
          disabled={props.disabled}
          onClick={() => {
            if (state !== props.state) {
              props.onPick(state);
            }
          }}
        >
          {props.translate(STATE_KEYS[state])}
        </button>
      ))}
    </div>
  );
}
