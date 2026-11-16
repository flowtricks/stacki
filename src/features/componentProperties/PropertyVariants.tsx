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
// - Every other existing prop shows "Controlled by": for a ruled prop, in
//   place of Required, the controller and one state per option; for one
//   not ruled yet, a controller to pick (one of string options, when the
//   component has no group yet) and the option to allow it for.
// - A group main cannot edit faithfully is drawn the same, disabled, with one
//   word for why.

import { useState } from 'react';
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
  const controller = groups?.find((group) => group.controller === name && group.editing.kind !== 'candidate');
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

// The Dropdown's value for no controller: a controller is a prop name, never empty.
const NO_CONTROLLER = '';

/**
 * "Controlled by" in any existing prop's settings, in place of Required for a
 * ruled prop. Ruled: the controller, then one row per option with its state
 * (Allowed, Required, Not allowed); None gives the prop back to every option.
 * Not ruled yet: pick a controller (an existing one, or with none yet a
 * prop of string options), then an option: the prop is allowed there and not
 * elsewhere, and the rows take over.
 */
export function VariantControlledBy(props: {
  readonly name: string;
  readonly role: Extract<VariantRole, { readonly kind: 'ruled' | 'attachable' }>;
  readonly host: VariantHost;
  readonly onProblem: (message: string) => void;
}) {
  const translate = useTranslate();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const { run, pending } = useVariantRun(props.host, props.onProblem);
  const { role, name } = props;
  const label = translate('componentProps.variants.controlledBy');
  const ruled = role.kind === 'ruled';
  const group = ruled
    ? (role.groups.find((candidate) => candidate.controller === chosen) ?? role.groups[0])
    : role.groups.find((candidate) => candidate.controller === chosen);
  const readonly = group?.editing.kind === 'readonly';
  const choices = [
    { value: NO_CONTROLLER, label: translate('componentProps.variants.none') },
    ...role.groups.map((candidate) => ({ value: candidate.controller, label: candidate.controller })),
  ];
  const choose = (value: string): void => {
    if (ruled && value === NO_CONTROLLER && group !== undefined) {
      void run({ kind: 'detachProp', controller: group.controller, prop: name });
    } else {
      setChosen(value === NO_CONTROLLER ? undefined : value);
    }
  };
  return (
    <div className="variant-rules" role="group" aria-label={label} aria-busy={pending}>
      <span className="variant-label">{label}</span>
      <div className="variant-controller">
        <Dropdown
          className="variant-controller-choice"
          ariaLabel={label}
          value={group?.controller ?? NO_CONTROLLER}
          options={choices}
          disabled={pending || readonly}
          onChange={choose}
        />
        {group?.editing.kind === 'readonly' && <span className="variant-reason">{translate(REASON_KEYS[group.editing.reason])}</span>}
      </div>
      {group !== undefined && ruled && <VariantRuleRows name={name} group={group} disabled={pending || readonly} translate={translate} run={run} />}
      {group !== undefined && !ruled && (
        <div className="variant-only-for">
          {group.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="variant-only-option"
              aria-label={translate('componentProps.variants.cell', { prop: name, controller: group.controller, value: option.value })}
              title={translate('componentProps.variants.cell', { prop: name, controller: group.controller, value: option.value })}
              disabled={pending}
              onClick={() => void run({ kind: 'attachProp', controller: group.controller, prop: name, options: [option.value] })}
            >
              {option.value}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// One full-width row per option: its name, and its state as a compact Dropdown.
function VariantRuleRows(props: {
  readonly name: string;
  readonly group: VariantGroup;
  readonly disabled: boolean;
  readonly translate: Translate;
  readonly run: (edit: VariantRuleEdit) => Promise<boolean>;
}) {
  const { name, group, translate } = props;
  const index = group.props.indexOf(name);
  assert(index >= 0, 'VariantRuleRows: the prop is one the group rules');
  const states = STATE_ORDER.map((state) => ({ value: state, label: translate(STATE_KEYS[state]) }));
  return (
    <div className="variant-rule-rows">
      {group.options.map((option) => {
        const rule = option.rules[index];
        assert(rule !== undefined, 'VariantRuleRows: every option has a rule for every prop');
        return (
          <div key={option.value} className={`variant-rule-row is-${rule.state}`}>
            <span className="variant-rule-option" title={option.value}>
              {option.value}
            </span>
            <Dropdown<VariantRuleState>
              className={`variant-state is-${rule.state}`}
              ariaLabel={translate('componentProps.variants.cell', { prop: name, controller: group.controller, value: option.value })}
              value={rule.state}
              options={states}
              disabled={props.disabled}
              onChange={(state) => {
                if (state !== rule.state) {
                  void props.run({ kind: 'setRule', controller: group.controller, option: option.value, prop: name, state });
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
