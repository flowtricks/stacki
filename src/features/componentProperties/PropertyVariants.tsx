// The Variants section of a prop's settings: which props each option of a
// controller (`variant`, `element`) allows, requires or forbids, edited with
// controls, never TypeScript. Main reads the rules from the component's Props
// union and writes each change back as the smallest TypeScript edit
// (docs/props-variant-rules.md); every control here sends one edit and draws
// what the file holds after it.
//
// The controller's own settings hold its options (rename, reorder, the
// Default, add, delete) and the grid of every prop against every option. A
// prop the controller rules shows its row of that grid as one switch per
// option. A group main cannot edit faithfully is drawn the same, disabled,
// with one word for why.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { VARIANT_LIMITS, variantGroupsOf, variantOptionValue } from '../../../shared/properties/variantRules';
import type { VariantGroup, VariantGroupReason, VariantOption, VariantRuleEdit, VariantRuleState } from '../../../shared/properties/variantRules';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import { CheckIcon, DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import type { PropertySaveHost, PropertySaveOutcome } from './propertyAutosave';
import './propertyVariants.css';

/** Where the section reads its groups and sends its edits: the panel's transaction. */
export interface VariantHost {
  readonly groups: readonly VariantGroup[];
  readonly edit: (edit: VariantRuleEdit) => Promise<PropertySaveOutcome>;
}

type Translate = ReturnType<typeof useTranslate>;
type Run = (edit: VariantRuleEdit) => Promise<boolean>;

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

/** A cell's next state on a click: Not allowed, Allowed, Required, round again. */
export const NEXT_STATE = { forbidden: 'optional', optional: 'required', required: 'forbidden' } as const satisfies Record<VariantRuleState, VariantRuleState>;

const PROP_NAME = /^[A-Za-z_$][\w$]*$/;
// The type a prop added here starts with; its own settings change it.
const NEW_PROP_TYPE = 'string';

/**
 * The host a prop's settings form gives the section: each edit goes through
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

/** The variant settings of `name`, or `fallback` when no group controls or rules it. */
export function PropertyVariants({ name, host, fallback }: { readonly name: string; readonly host: VariantHost | undefined; readonly fallback: ReactNode }) {
  const translate = useTranslate();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const groups = variantGroupsOf(host?.groups, name);
  const group = groups.find((candidate) => candidate.controller === chosen) ?? groups[0];
  if (host === undefined || group === undefined) {
    return <>{fallback}</>;
  }
  const editable = group.editing.kind === 'editable';
  const run: Run = async (edit) => {
    assert(edit.controller === group.controller, 'PropertyVariants: an edit names the group drawn');
    if (pending) {
      return false;
    }
    setPending(true);
    setError('');
    try {
      const outcome = await host.edit(edit);
      if (outcome.kind === 'saved') {
        return true;
      }
      setError(outcome.message);
      return false;
    } catch (caught: unknown) {
      setError(String(caught));
      return false;
    } finally {
      setPending(false);
    }
  };
  const controls = { group, run, disabled: !editable || pending, translate, onProblem: setError };
  return (
    <section className="property-variants" aria-label={translate('componentProps.variants.title')} aria-busy={pending}>
      <div className="variant-head">
        <span>{translate('componentProps.variants.title')}</span>
        {group.editing.kind === 'readonly' && <span className="variant-reason">{translate(REASON_KEYS[group.editing.reason])}</span>}
      </div>
      {group.controller === name ? (
        <>
          <VariantOptions {...controls} />
          <VariantMatrix {...controls} />
        </>
      ) : (
        <>
          <ControlledBy groups={groups} group={group} onChoose={setChosen} translate={translate} />
          <VariantPropRules {...controls} prop={name} />
        </>
      )}
      {error !== '' && (
        <p className="property-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

interface ControlsProps {
  readonly group: VariantGroup;
  readonly run: Run;
  readonly disabled: boolean;
  readonly translate: Translate;
  readonly onProblem: (message: string) => void;
}

// Which prop switches this prop's rules: a name, or a choice when two groups rule it.
function ControlledBy(props: {
  readonly groups: readonly VariantGroup[];
  readonly group: VariantGroup;
  readonly translate: Translate;
  readonly onChoose: (controller: string) => void;
}) {
  const { groups, group, translate } = props;
  const label = translate('componentProps.variants.controlledBy');
  return (
    <div className="variant-controlled">
      <span>{label}</span>
      {groups.length > 1 ? (
        <Dropdown
          ariaLabel={label}
          value={group.controller}
          options={groups.map((candidate) => ({ value: candidate.controller, label: candidate.controller }))}
          onChange={props.onChoose}
        />
      ) : (
        <span className="variant-chip">{group.controller}</span>
      )}
    </div>
  );
}

// One prop's row: a switch per option.
function VariantPropRules({ group, run, disabled, translate, prop }: ControlsProps & { readonly prop: string }) {
  const index = group.props.indexOf(prop);
  assert(index >= 0, 'VariantPropRules: the prop is one the group rules');
  return (
    <div className="variant-rules" role="group" aria-label={translate('componentProps.variants.rules')}>
      {group.options.map((option) => {
        const rule = option.rules[index];
        assert(rule !== undefined, 'VariantPropRules: every option has a rule for every prop');
        return (
          <div key={option.value} className="variant-rule-row">
            <span className="variant-rule-option" title={option.value}>
              {option.value}
            </span>
            <VariantStateSwitch
              label={translate('componentProps.variants.cell', { prop, controller: group.controller, value: option.value })}
              state={rule.state}
              disabled={disabled}
              translate={translate}
              onPick={(state) => void run({ kind: 'setRule', controller: group.controller, option: option.value, prop, state })}
            />
          </div>
        );
      })}
    </div>
  );
}

// Allowed, Required, Not allowed: three choices side by side, one of them on.
function VariantStateSwitch(props: {
  readonly label: string;
  readonly state: VariantRuleState;
  readonly disabled: boolean;
  readonly translate: Translate;
  readonly onPick: (state: VariantRuleState) => void;
}) {
  const order: readonly VariantRuleState[] = ['optional', 'required', 'forbidden'];
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step !== 0 && !props.disabled) {
      event.preventDefault();
      const next = order[(order.indexOf(props.state) + step + order.length) % order.length];
      assert(next !== undefined, 'VariantStateSwitch: the next state exists');
      props.onPick(next);
    }
  };
  return (
    <div className="variant-seg" role="radiogroup" aria-label={props.label} onKeyDown={move}>
      {order.map((state) => (
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

// The controller's options: rename in place, drag or Alt+arrow to reorder,
// Default, delete, add.
function VariantOptions({ group, run, disabled, translate, onProblem }: ControlsProps) {
  const [focusValue, setFocusValue] = useState<string | undefined>(undefined);
  const dragged = useRef<string | undefined>(undefined);
  const controller = group.controller;
  const add = async (): Promise<void> => {
    const value = newOptionValue(group, translate('componentProps.variants.newOption'));
    if (value !== undefined && (await run({ kind: 'addOption', controller, value }))) {
      setFocusValue(value);
    }
  };
  const move = (value: string, index: number): void => {
    if (index >= 0 && index < group.options.length) {
      void run({ kind: 'moveOption', controller, value, index });
    }
  };
  return (
    <div className="variant-options" role="list" aria-label={translate('componentProps.variants.options')}>
      {group.options.map((option, index) => (
        <VariantOptionRow
          key={option.value}
          option={option}
          index={index}
          count={group.options.length}
          focus={option.value === focusValue}
          disabled={disabled}
          translate={translate}
          onRename={(to) => run({ kind: 'renameOption', controller, from: option.value, to })}
          onProblem={onProblem}
          onMove={(target) => move(option.value, target)}
          onDragStart={() => {
            dragged.current = option.value;
          }}
          onDrop={() => {
            const value = dragged.current;
            dragged.current = undefined;
            if (value !== undefined && value !== option.value) {
              move(value, index);
            }
          }}
          onFallback={() => void run({ kind: 'setFallback', controller, value: option.value })}
          onRemove={() => void run({ kind: 'removeOption', controller, value: option.value })}
        />
      ))}
      <button type="button" className="variant-add" disabled={disabled || group.options.length >= VARIANT_LIMITS.optionsMax} onClick={() => void add()}>
        <PlusIcon size={12} />
        {translate('componentProps.variants.addOption')}
      </button>
    </div>
  );
}

function VariantOptionRow(props: {
  readonly option: VariantOption;
  readonly index: number;
  readonly count: number;
  readonly focus: boolean;
  readonly disabled: boolean;
  readonly translate: Translate;
  readonly onRename: (to: string) => Promise<boolean>;
  readonly onProblem: (message: string) => void;
  readonly onMove: (index: number) => void;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
  readonly onFallback: () => void;
  readonly onRemove: () => void;
}) {
  const { option, index, translate } = props;
  const [text, setText] = useState(option.value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.focus) {
      input.current?.select();
    }
  }, [props.focus]);
  const commit = async (): Promise<void> => {
    const value = variantOptionValue(text);
    if (value === undefined) {
      props.onProblem(translate('componentProps.variants.badValue'));
      setText(option.value);
      return;
    }
    if (value === option.value) {
      setText(value);
      return;
    }
    if (!(await props.onRename(value))) {
      setText(option.value);
    }
  };
  const grip = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      props.onMove(index + (event.key === 'ArrowUp' ? -1 : 1));
    }
  };
  return (
    <div
      className="variant-option"
      role="listitem"
      onDragOver={(event) => {
        if (!props.disabled) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop();
      }}
    >
      <button
        type="button"
        className="variant-grip"
        aria-label={translate('componentProps.variants.moveOption', { value: option.value })}
        title={translate('componentProps.variants.moveOption', { value: option.value })}
        draggable={!props.disabled}
        disabled={props.disabled}
        onDragStart={props.onDragStart}
        onKeyDown={grip}
      >
        <DragIcon size={12} />
      </button>
      <input
        ref={input}
        value={text}
        aria-label={translate('componentProps.variants.optionName', { number: index + 1 })}
        maxLength={VARIANT_LIMITS.valueCharsMax}
        disabled={props.disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            setText(option.value);
          }
        }}
      />
      <button
        type="button"
        className={`variant-default${option.fallback ? ' on' : ''}`}
        aria-pressed={option.fallback}
        aria-label={
          option.fallback ? translate('componentProps.variants.fallback') : translate('componentProps.variants.makeFallback', { value: option.value })
        }
        title={option.fallback ? translate('componentProps.variants.fallback') : translate('componentProps.variants.makeFallback', { value: option.value })}
        disabled={props.disabled}
        onClick={() => {
          if (!option.fallback) {
            props.onFallback();
          }
        }}
      >
        {translate('componentProps.variants.fallback')}
      </button>
      <button
        type="button"
        className="variant-remove"
        aria-label={translate('componentProps.variants.removeOption', { value: option.value })}
        title={translate('componentProps.variants.removeOption', { value: option.value })}
        disabled={props.disabled || option.fallback || props.count <= 2}
        onClick={props.onRemove}
      >
        <TrashIcon size={12} />
      </button>
    </div>
  );
}

// Every prop against every option. Arrow keys move between cells; Enter or
// Space, or a click, turns a cell to its next state.
function VariantMatrix({ group, run, disabled, translate, onProblem }: ControlsProps) {
  const [focus, setFocus] = useState({ row: 0, column: 0 });
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const rows = group.props.length;
  const columns = group.options.length;
  const at = (row: number, column: number): string => `${row}:${column}`;
  const moveFocus = (row: number, column: number): void => {
    const next = { row: Math.min(Math.max(row, 0), rows - 1), column: Math.min(Math.max(column, 0), columns - 1) };
    setFocus(next);
    cells.current.get(at(next.row, next.column))?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const steps: Readonly<Record<string, readonly [number, number]>> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      moveFocus(focus.row + step[0], focus.column + step[1]);
    }
  };
  return (
    <div className="variant-matrix-wrap">
      {rows > 0 && (
        <div
          className="variant-matrix"
          role="grid"
          aria-label={translate('componentProps.variants.matrix', { controller: group.controller })}
          style={{ gridTemplateColumns: `minmax(56px, 1fr) repeat(${columns}, 32px) 22px` }}
          onKeyDown={keys}
        >
          <div className="variant-matrix-line" role="row">
            <span role="columnheader" />
            {group.options.map((option) => (
              <span key={option.value} role="columnheader" className="variant-matrix-head" title={option.value}>
                {option.value}
              </span>
            ))}
            <span role="columnheader" />
          </div>
          {group.props.map((prop, row) => (
            <div key={prop} className="variant-matrix-line" role="row">
              <span role="rowheader" className="variant-matrix-prop" title={prop}>
                {prop}
              </span>
              {group.options.map((option, column) => {
                const rule = option.rules[row];
                assert(rule !== undefined, 'VariantMatrix: every option has a rule for every prop');
                const state = translate(STATE_KEYS[rule.state]);
                const label = `${translate('componentProps.variants.cell', { prop, controller: group.controller, value: option.value })}: ${state}`;
                return (
                  <span key={option.value} role="gridcell">
                    <button
                      ref={(element) => {
                        if (element === null) {
                          cells.current.delete(at(row, column));
                        } else {
                          cells.current.set(at(row, column), element);
                        }
                      }}
                      type="button"
                      className="variant-cell"
                      data-state={rule.state}
                      aria-label={label}
                      title={label}
                      tabIndex={focus.row === row && focus.column === column ? 0 : -1}
                      disabled={disabled}
                      onFocus={() => setFocus({ row, column })}
                      onClick={() => void run({ kind: 'setRule', controller: group.controller, option: option.value, prop, state: NEXT_STATE[rule.state] })}
                    >
                      {rule.state === 'forbidden' ? undefined : <CheckIcon size={12} />}
                    </button>
                  </span>
                );
              })}
              <span role="gridcell">
                <button
                  type="button"
                  className="variant-remove"
                  aria-label={translate('componentProps.variants.removeProp', { name: prop })}
                  title={translate('componentProps.variants.removeProp', { name: prop })}
                  tabIndex={-1}
                  disabled={disabled}
                  onClick={() => void run({ kind: 'removeProp', controller: group.controller, prop })}
                >
                  <TrashIcon size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="variant-legend" aria-hidden="true">
        {(['optional', 'required', 'forbidden'] as const).map((state) => (
          <span key={state}>
            <i className="variant-cell" data-state={state}>
              {state === 'forbidden' ? undefined : <CheckIcon size={10} />}
            </i>
            {translate(STATE_KEYS[state])}
          </span>
        ))}
      </div>
      <VariantNewProp group={group} run={run} disabled={disabled} translate={translate} onProblem={onProblem} />
    </div>
  );
}

function VariantNewProp({ group, run, disabled, translate, onProblem }: ControlsProps) {
  const [name, setName] = useState('');
  const add = async (): Promise<void> => {
    const prop = name.trim();
    if (prop === '') {
      return;
    }
    if (!PROP_NAME.test(prop)) {
      onProblem(translate('componentProps.problem.nameShape'));
      return;
    }
    if (await run({ kind: 'addProp', controller: group.controller, prop, type: NEW_PROP_TYPE })) {
      setName('');
    }
  };
  return (
    <div className="variant-new-prop">
      <input
        value={name}
        aria-label={translate('componentProps.variants.propName')}
        placeholder={translate('componentProps.variants.addProp')}
        maxLength={PROPERTY_LIMITS.nameCharsMax}
        disabled={disabled}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void add();
          }
        }}
      />
      <button
        type="button"
        aria-label={translate('componentProps.variants.addProp')}
        title={translate('componentProps.variants.addProp')}
        disabled={disabled || name.trim() === ''}
        onClick={() => void add()}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}

/** A name for a new option no other option has: the word, then the word and a number. */
export function newOptionValue(group: Pick<VariantGroup, 'options'>, word: string): string | undefined {
  const taken = new Set(group.options.map((option) => option.value));
  const base = variantOptionValue(word) ?? 'option';
  for (let number = 1; number <= VARIANT_LIMITS.optionsMax + 1; number++) {
    const candidate = number === 1 ? base : `${base} ${number}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
