import Popup from '../../../ui/Popup';
// What a Select draws: the trigger, the list and its rows, each row's action
// (Select.tsx).

import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { type SelectOption, type Props } from './selectTypes';

// A ReactNode given as null by a caller means "none", the same as leaving it out.
export const present = (node: ReactNode): boolean => (node ?? undefined) !== undefined;

export const CHEVRON = (
  <svg className="u-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.2 6.2 8 10l3.8-3.8" />
  </svg>
);

export function SelectTrigger<T extends string>({
  props,
  selectedOption,
  open,
  buttonRef,
  onToggle,
  onKeyDown,
}: {
  props: Props<T>;
  selectedOption: SelectOption<T> | undefined;
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement>;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const triggerLabel = selectedOption ? (selectedOption.triggerLabel ?? selectedOption.label) : '';
  const triggerIcon = selectedOption?.triggerIcon ?? selectedOption?.icon;
  const shared = {
    ref: buttonRef,
    id: props.id,
    type: 'button' as const,
    'aria-haspopup': 'listbox' as const,
    'aria-expanded': open,
    'aria-label': props.ariaLabel,
    'aria-labelledby': props.labelId,
    disabled: props.disabled,
    onClick: onToggle,
    onKeyDown,
  };
  const icon = !props.hideTriggerIcon && present(triggerIcon) ? <span className="u-select-icon">{triggerIcon}</span> : undefined;
  if (present(props.customInput)) {
    return (
      <div className="u-select-button is-custom">
        {props.customInput}
        <button {...shared} className="u-select-chevron-btn">
          {CHEVRON}
        </button>
      </div>
    );
  }
  if (props.variant === 'link') {
    return (
      <button {...shared} className="u-select-link" data-tone={selectedOption?.tone}>
        {icon}
        <span className="u-select-label">{triggerLabel}</span>
        {CHEVRON}
      </button>
    );
  }
  return (
    <button {...shared} className="u-select-button" data-tone={selectedOption?.tone}>
      <span className="u-select-value">
        {icon}
        <span className="u-select-label">{triggerLabel}</span>
      </span>
      {CHEVRON}
    </button>
  );
}

export type SelectListProps<T extends string> = {
  props: Props<T>;
  listRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  dropUp: boolean;
  baseId: string;
  displayed: SelectOption<T>[];
  activeIndex: number;
  query: string;
  onQuery: (query: string) => void;
  onListKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onActivate: (index: number) => void;
  onLeave: () => void;
  onChoose: (index: number) => void;
  onCancel: () => void;
};

export const optionId = (baseId: string, index: number) => `${baseId}-opt-${index}`;

export function SelectList<T extends string>(list: SelectListProps<T>) {
  const { props, displayed } = list;
  const { ariaLabel, labelId, searchable = false } = props;
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={list.onCancel}
      ref={list.listRef}
      className={['u-select-list', list.dropUp ? 'is-up' : ''].filter(Boolean).join(' ')}
      role="listbox"
      tabIndex={-1}
      label={ariaLabel}
      labelledBy={labelId}
      aria-activedescendant={optionId(list.baseId, list.activeIndex)}
      onKeyDown={searchable ? undefined : list.onListKeyDown}
      onMouseLeave={list.onLeave}
    >
      {searchable ? (
        <div className="u-select-search">
          <input
            ref={list.searchRef}
            type="text"
            className="u-select-search-input"
            placeholder={props.searchPlaceholder ?? 'Search…'}
            value={list.query}
            onChange={(event) => list.onQuery(event.target.value)}
            onKeyDown={list.onSearchKeyDown}
            aria-label={ariaLabel ? `Search ${ariaLabel}` : 'Search'}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ) : undefined}
      {displayed.length === 0 ? (
        <div className="u-select-empty" role="presentation">
          No matches
        </div>
      ) : (
        displayed.map((option, index) => (
          <SelectRow
            key={option.value}
            option={option}
            id={optionId(list.baseId, index)}
            selected={option.value === props.value}
            active={index === list.activeIndex}
            onActivate={() => list.onActivate(index)}
            onChoose={() => list.onChoose(index)}
            onCancel={list.onCancel}
          />
        ))
      )}
    </Popup>
  );
}

export function SelectRow<T extends string>({
  option,
  id,
  selected,
  active,
  onActivate,
  onChoose,
  onCancel,
}: {
  option: SelectOption<T>;
  id: string;
  selected: boolean;
  active: boolean;
  onActivate: () => void;
  onChoose: () => void;
  onCancel: () => void;
}) {
  const icon = present(option.icon) ? <span className="u-select-icon">{option.icon}</span> : undefined;
  if (option.heading) {
    return (
      <div className="u-select-heading" role="presentation">
        {icon}
        <span className="u-select-heading-label">{option.label}</span>
      </div>
    );
  }
  return (
    <div
      id={id}
      className={['u-select-option', active ? 'is-active' : '', selected ? 'is-selected' : '', option.indent ? 'is-indented' : ''].filter(Boolean).join(' ')}
      role="option"
      aria-selected={selected}
      data-active={active || undefined}
      onMouseEnter={onActivate}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button === 0) {
          event.preventDefault();
          onChoose();
        }
      }}
      onClick={onChoose}
    >
      <span className="u-select-check" aria-hidden="true">
        {selected ? CHECK : undefined}
      </span>
      {icon}
      <span className="u-select-label">{option.label}</span>
      {option.marked ? <span className="u-select-dot" aria-hidden="true" /> : undefined}
      {option.action ? <RowAction action={option.action} onCancel={onCancel} /> : undefined}
    </div>
  );
}

export const CHECK = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
    <path d="M13.5 4.5 6.5 11.5 3 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function RowAction({ action, onCancel }: { action: NonNullable<SelectOption<string>['action']>; onCancel: () => void }) {
  return (
    <button
      type="button"
      className="u-select-action"
      title={action.label}
      aria-label={action.label}
      // The listbox owns arrow-key focus; this is reached with the
      // pointer (and by name from a screen reader), not by tabbing
      // out of the list mid-navigation.
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      // The menu closes on an outside pointerdown and picks on click;
      // this row is inside it, so only the click needs stopping — and
      // it has to stop before `choose` runs, or acting on an option
      // would also select it.
      onClick={(event) => {
        event.stopPropagation();
        const run = action.onSelect;
        onCancel();
        run();
      }}
    >
      {action.icon}
    </button>
  );
}
