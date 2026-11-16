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

import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import { VARIANT_LIMITS } from '../../../shared/properties/variantRules';
import type { VariantGroup, VariantGroupReason, VariantRuleEdit, VariantRuleState } from '../../../shared/properties/variantRules';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { createPortal } from 'react-dom';
import { centralIcon } from '../../ui/central/CentralIcon';
import { block as centralBlock, checkCircle as centralCheckCircle, star as centralStar } from '../../ui/central/centralGeometry';
import Dropdown from '../../ui/Dropdown';
import type { DropdownOption } from '../../ui/Dropdown';
import { kindIcon } from './PropertyType';
import { BranchIcon, CloseIcon } from '../../ui/Icons';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
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
  /** `groups` rule it (every one must allow it: AND); `available` could rule it too. */
  | { readonly kind: 'ruled'; readonly groups: readonly VariantGroup[]; readonly available: readonly VariantGroup[] }
  | { readonly kind: 'attachable'; readonly available: readonly VariantGroup[] }
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
  const all = groups ?? [];
  assert(all.length <= VARIANT_LIMITS.groupsMax, 'variantRoleOf: groups are bounded');
  const ruled = all.filter((group) => group.props.includes(name));
  const available = all.filter((group) => group.attachable.includes(name) && group.controller !== name);
  if (ruled.length > 0) {
    return { kind: 'ruled', groups: ruled, available };
  }
  return available.length > 0 ? { kind: 'attachable', available } : { kind: 'none' };
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
 * ruled prop. One block per controller that rules it, joined by "and" (every
 * one must allow it): the controller, which can be switched to any other that
 * could rule it, a remove, and one row per option with its state. "Add
 * condition" joins another. A prop with no rules picks its first controller
 * from None. Joining a controller allows the prop for every option there;
 * the rows then say where it is not.
 */
export function VariantControlledBy(props: {
  readonly name: string;
  readonly role: Extract<VariantRole, { readonly kind: 'ruled' | 'attachable' }>;
  readonly host: VariantHost;
  readonly onProblem: (message: string) => void;
}) {
  const translate = useTranslate();
  const { run, pending } = useVariantRun(props.host, props.onProblem);
  const { role, name } = props;
  const label = translate('componentProps.variants.controlledBy');
  const ruling = role.kind === 'ruled' ? role.groups : [];
  const attach = (controller: string): void => {
    const group = role.available.find((candidate) => candidate.controller === controller);
    if (group !== undefined) {
      void run({ kind: 'attachProp', controller, prop: name, options: group.options.map((option) => option.value) });
    }
  };
  const choices = (current: VariantGroup | undefined) => [
    ...(current === undefined ? [{ value: NO_CONTROLLER, label: translate('componentProps.variants.none') }] : [controllerChoice(current)]),
    ...role.available.map(controllerChoice),
  ];
  return (
    <div className="variant-rules" role="group" aria-label={label} aria-busy={pending}>
      <span className="variant-label">{label}</span>
      {ruling.length === 0 && (
        <div className="variant-block-head">
          <Dropdown
            className="variant-controller-choice"
            ariaLabel={label}
            value={NO_CONTROLLER}
            options={choices(undefined)}
            disabled={pending}
            onChange={attach}
          />
        </div>
      )}
      {ruling.map((group, index) => {
        const readonly = group.editing.kind === 'readonly';
        const remove = translate('componentProps.variants.removeCondition', { controller: group.controller });
        return (
          <div key={group.controller} className="variant-block">
            {index > 0 && <span className="variant-and">{translate('componentProps.variants.and')}</span>}
            <div className="variant-block-head">
              <Dropdown
                className="variant-controller-choice"
                ariaLabel={index === 0 ? label : `${label} ${index + 1}`}
                value={group.controller}
                options={choices(group)}
                disabled={pending || readonly}
                onChange={(to) => {
                  if (to !== group.controller) {
                    void run({ kind: 'switchController', controller: group.controller, to, prop: name });
                  }
                }}
              />
              {group.editing.kind === 'readonly' && <span className="variant-reason">{translate(REASON_KEYS[group.editing.reason])}</span>}
              <button
                type="button"
                className="variant-remove"
                aria-label={remove}
                title={remove}
                disabled={pending || readonly}
                onClick={() => void run({ kind: 'detachProp', controller: group.controller, prop: name })}
              >
                <CloseIcon size={12} />
              </button>
            </div>
            <VariantRuleRows name={name} group={group} disabled={pending || readonly} translate={translate} run={run} />
          </div>
        );
      })}
      {ruling.length > 0 && role.available.length > 0 && (
        <div className="variant-block-head">
          <Dropdown
            className="variant-add-condition"
            ariaLabel={translate('componentProps.variants.addCondition')}
            value={NO_CONTROLLER}
            options={[{ value: NO_CONTROLLER, label: translate('componentProps.variants.addCondition') }, ...role.available.map(controllerChoice)]}
            disabled={pending}
            onChange={attach}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A controller as a Dropdown row: its name, with the icon the prop list gives
 * a prop of its kind (kindIcon): a Choice for string options, a Switch for
 * true / false. Every controller is one or the other.
 */
export function controllerChoice(group: VariantGroup): DropdownOption {
  const type = group.optionKind === 'boolean' ? 'boolean' : group.options.map((option) => JSON.stringify(option.value)).join(' | ');
  return { value: group.controller, label: group.controller, icon: kindIcon({ type, description: '' }) };
}

/** Where a conditional prop is allowed, one line per controller (`variant: play, close, arrow`), for its row's tip. */
export function conditionLines(groups: readonly VariantGroup[] | undefined, name: string, translate: Translate): readonly string[] {
  return (groups ?? [])
    .filter((group) => group.props.includes(name))
    .map((group) => {
      const index = group.props.indexOf(name);
      const options = group.options.filter((option) => option.rules[index]?.state !== 'forbidden').map((option) => option.value);
      return translate('componentProps.variants.condition', { controller: group.controller, options: options.join(', ') });
    });
}

/** The prop list's mark on a conditional prop: a dimmed branch, its tip naming where the prop is allowed. */
export function VariantConditionMark({ lines }: { readonly lines: readonly string[] }) {
  const translate = useTranslate();
  const tip = useDelayedTooltip();
  const text = lines.join('\n');
  const label = `${translate('componentProps.variants.conditional')}: ${lines.join('; ')}`;
  return (
    <>
      <span className="variant-condition-mark" role="img" aria-label={label} onMouseEnter={tip.show} onMouseLeave={tip.hide}>
        <BranchIcon size={14} />
      </span>
      {tip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below variant-condition-tip" style={tip.value} role="tooltip" aria-hidden="true">
            {text}
          </div>,
          tooltipHost(undefined),
        )}
    </>
  );
}

// The states' marks, from the Central set: Allowed a checked circle
// (Figma 5441:1558), Required a star (5440:1500), Not allowed a blocked
// circle (7511:66225).
const STATE_ICONS = {
  optional: centralIcon(centralCheckCircle, 12),
  required: centralIcon(centralStar, 12),
  forbidden: centralIcon(centralBlock, 12),
} as const satisfies Record<VariantRuleState, ReturnType<typeof centralIcon>>;

// One full-width row per option: its name, and its state as three icon buttons.
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
            <VariantStateButtons
              label={translate('componentProps.variants.cell', { prop: name, controller: group.controller, value: option.value })}
              state={rule.state}
              disabled={props.disabled}
              translate={translate}
              onPick={(state) => void props.run({ kind: 'setRule', controller: group.controller, option: option.value, prop: name, state })}
            />
          </div>
        );
      })}
    </div>
  );
}

// Allowed, Required, Not allowed as a radio group of icon buttons, each named
// and tipped with its state. Left and right arrows pick and focus the one beside.
function VariantStateButtons(props: {
  readonly label: string;
  readonly state: VariantRuleState;
  readonly disabled: boolean;
  readonly translate: Translate;
  readonly onPick: (state: VariantRuleState) => void;
}) {
  const buttons = useRef(new Map<VariantRuleState, HTMLButtonElement>());
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0 && !props.disabled) {
      event.preventDefault();
      const next = STATE_ORDER[(STATE_ORDER.indexOf(props.state) + step + STATE_ORDER.length) % STATE_ORDER.length];
      assert(next !== undefined, 'VariantStateButtons: the next state exists');
      buttons.current.get(next)?.focus();
      props.onPick(next);
    }
  };
  return (
    <div className="variant-states" role="radiogroup" aria-label={props.label} onKeyDown={keys}>
      {STATE_ORDER.map((state) => (
        <VariantStateButton
          key={state}
          state={state}
          label={props.translate(STATE_KEYS[state])}
          checked={state === props.state}
          disabled={props.disabled}
          register={(element) => {
            if (element === null) {
              buttons.current.delete(state);
            } else {
              buttons.current.set(state, element);
            }
          }}
          onPick={() => {
            if (state !== props.state) {
              props.onPick(state);
            }
          }}
        />
      ))}
    </div>
  );
}

function VariantStateButton(props: {
  readonly state: VariantRuleState;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  // eslint-disable-next-line stacki/no-null -- React hands a ref callback null when the element goes
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onPick: () => void;
}) {
  const tip = useDelayedTooltip();
  const Icon = STATE_ICONS[props.state];
  return (
    <>
      <button
        ref={props.register}
        type="button"
        role="radio"
        className={`variant-state-button${props.checked ? ' on' : ''}`}
        data-state={props.state}
        aria-label={props.label}
        aria-checked={props.checked}
        tabIndex={props.checked ? 0 : -1}
        disabled={props.disabled}
        onMouseEnter={tip.show}
        onMouseLeave={tip.hide}
        onFocus={tip.hide}
        onClick={props.onPick}
      >
        <Icon size={12} />
      </button>
      {tip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" style={tip.value} role="tooltip" aria-hidden="true">
            {props.label}
          </div>,
          tooltipHost(undefined),
        )}
    </>
  );
}
