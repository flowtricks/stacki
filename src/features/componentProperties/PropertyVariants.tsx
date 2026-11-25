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
// - Every other existing prop's Visibility, Tooltip and Default value are set
//   by conditions on other props (PropertyVisibility.tsx, PropertyDefault.tsx):
//   the purple Conditional pill and Value conditions editor every conditional
//   value wears. This file holds what they share: the role a prop plays, the
//   save host the edits go through, and the prop list's conditional mark.

import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import { VARIANT_LIMITS } from '../../../shared/properties/variantRules';
import type { VariantGroup, VariantRuleEdit } from '../../../shared/properties/variantRules';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { createPortal } from 'react-dom';
import { BranchIcon } from '../../ui/Icons';
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
