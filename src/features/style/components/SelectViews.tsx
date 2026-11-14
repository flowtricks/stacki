import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { check as centralCheck, chevronDown as centralChevronDown } from '../../../ui/central/centralGeometry';
import Popup from '../../../ui/Popup';
// What a Select draws: the trigger, the list and its rows, each row's action
// (Select.tsx).

const ChevronDownGlyph = centralIcon(centralChevronDown, 12);

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { assert } from '../../../../shared/core/assert';
import { type SelectOption, type SelectTag, type Props } from './selectTypes';

// A ReactNode given as null by a caller means "none", the same as leaving it out.
export const present = (node: ReactNode): boolean => (node ?? undefined) !== undefined;

const SUBLINE_SEPARATOR = ', ';
const SUBLINE_MORE = '…';
// Held back from the row's width: clientWidth is rounded and text is not, and the
// last item should not lose a glyph to that rounding.
const SUBLINE_SLACK_PX = 1;

// The option's label, on one line, or with its overline (and its source chip, when
// it has one) above it and its subline below. Every line truncates with an ellipsis
// rather than wraps, so a long selector never grows the row or the trigger; the chip
// keeps its size and the overline text gives way.
export function OptionLabel({
  label,
  overline,
  tag,
  subline,
}: {
  readonly label: string;
  readonly overline: string | undefined;
  readonly tag?: SelectTag | undefined;
  readonly subline?: readonly string[] | undefined;
}) {
  const hasOverline = overline !== undefined && overline.length > 0;
  const hasFirstLine = hasOverline || tag !== undefined;
  const hasSubline = subline !== undefined && subline.length > 0;
  if (!hasFirstLine && !hasSubline) {
    return (
      <span className="u-select-label" onMouseEnter={titleWhenCut(label)}>
        {label}
      </span>
    );
  }
  return (
    <span className="u-select-label has-overline">
      {hasFirstLine ? (
        <span className="u-select-overline">
          {tag === undefined ? undefined : <OptionTag tag={tag} />}
          {hasOverline ? <span className="u-select-overline-text">{overline}</span> : undefined}
        </span>
      ) : undefined}
      <span className="u-select-label-line" onMouseEnter={titleWhenCut(label)}>
        {label}
      </span>
      {hasSubline ? <OptionSubline items={subline} /> : undefined}
    </span>
  );
}

// A label the row cuts with an ellipsis shows its whole text on hover; one shown whole
// carries no title, so the pointer does not raise a tooltip that repeats the row.
function titleWhenCut(label: string) {
  return (event: { readonly currentTarget: HTMLElement }): void => {
    const element = event.currentTarget;
    element.title = element.scrollWidth > element.clientWidth ? label : '';
  };
}

// Fitted after layout, before paint, and again whenever the row's width changes,
// so the count follows the real row and not a fixed number of items.
function OptionSubline({ items }: { readonly items: readonly string[] }) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const full = items.join(SUBLINE_SEPARATOR);
  const [text, setText] = useState(full);
  useLayoutEffect(() => {
    const line = lineRef.current;
    assert(line !== null, 'OptionSubline: the line is mounted before it is fitted');
    const fit = () => setText(fitSublineToElement(line, items));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(line);
    return () => observer.disconnect();
  }, [items]);
  return (
    <span ref={lineRef} className="u-select-subline" title={full}>
      {text}
    </span>
  );
}

/**
 * The most leading items that fit `widthPx` whole, then an ellipsis, so a name is
 * never cut into what reads as another name. The first item always shows: when even
 * it does not fit, the line's own ellipsis cuts it, in plain sight.
 */
export function fitSubline(items: readonly string[], widthPx: number, measure: (text: string) => number): string {
  assert(items.length > 0, 'fitSubline: a subline has items');
  assert(widthPx >= 0, 'fitSubline: a width is not negative');
  const full = items.join(SUBLINE_SEPARATOR);
  if (measure(full) <= widthPx) {
    return full;
  }
  let fitted = sublineWithMore(items, 1);
  // Widths only grow with the count, so the first miss ends the search.
  for (let count = 2; count < items.length; count += 1) {
    const candidate = sublineWithMore(items, count);
    if (measure(candidate) > widthPx) {
      break;
    }
    fitted = candidate;
  }
  assert(fitted.length > 0, 'fitSubline: the first item always shows');
  return fitted;
}

// One item alone in a list of one has nothing after it to stand for.
function sublineWithMore(items: readonly string[], count: number): string {
  const shown = items.slice(0, count).join(SUBLINE_SEPARATOR);
  return count < items.length ? `${shown}${SUBLINE_SEPARATOR}${SUBLINE_MORE}` : shown;
}

// A line with no width is not laid out, and a page with no canvas cannot measure:
// either way the whole list goes in and the line's own ellipsis ends it.
function fitSublineToElement(line: HTMLElement, items: readonly string[]): string {
  const full = items.join(SUBLINE_SEPARATOR);
  if (line.clientWidth === 0) {
    return full;
  }
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) {
    return full;
  }
  const style = getComputedStyle(line);
  context.font = style.font;
  context.letterSpacing = style.letterSpacing;
  return fitSubline(items, Math.max(0, line.clientWidth - SUBLINE_SLACK_PX), (text) => context.measureText(text).width);
}

function OptionTag({ tag }: { readonly tag: SelectTag }) {
  return (
    <span className="u-select-tag" data-tone={tag.tone}>
      {present(tag.icon) ? <span className="u-select-tag-icon">{tag.icon}</span> : undefined}
      <span className="u-select-tag-label">{tag.label}</span>
    </span>
  );
}

export const CHEVRON = <ChevronDownGlyph className="u-select-chevron" />;

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
  const triggerOverline = selectedOption?.triggerOverline ?? selectedOption?.overline;
  const triggerTag = selectedOption?.triggerTag ?? selectedOption?.tag;
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
        <OptionLabel label={triggerLabel} overline={triggerOverline} tag={triggerOverline === undefined ? undefined : triggerTag} />
      </span>
      {CHEVRON}
    </button>
  );
}

export type SelectListProps<T extends string> = {
  props: Props<T>;
  listRef: RefObject<HTMLDivElement>;
  searchRef: RefObject<HTMLInputElement>;
  /** The button that opened the list. A press on it is not an outside press: its own
   *  click closes the list, so the press must not close it first and the click reopen it. */
  trigger: HTMLElement | undefined;
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
  const translate = useTranslate();
  const { props, displayed } = list;
  const { ariaLabel, labelId, searchable = false } = props;
  // Read from the whole option list, not the filtered rows, so typing a search
  // never opens or closes the dot column under the pointer.
  const dotColumn = dotColumnFor(props.options);
  return (
    <Popup
      mode="popover"
      portal={false}
      anchor={list.trigger}
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
            placeholder={props.searchPlaceholder ?? translate('ui.search')}
            value={list.query}
            onChange={(event) => list.onQuery(event.target.value)}
            onKeyDown={list.onSearchKeyDown}
            aria-label={
              ariaLabel ? translate('styleModel.components.select.searchNamed', { label: ariaLabel }) : translate('styleModel.components.select.search')
            }
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ) : undefined}
      {displayed.length === 0 ? (
        <div className="u-select-empty" role="presentation">
          {translate('styleModel.components.select.noMatches')}
        </div>
      ) : (
        listSections(displayed).map((section) => {
          const rows = section.indexes.map((index) => {
            const option = displayed[index];
            assert(option !== undefined, 'SelectList: a section names displayed rows');
            return (
              <SelectRow
                key={option.value}
                option={option}
                id={optionId(list.baseId, index)}
                selected={option.value === props.value}
                active={index === list.activeIndex}
                dotColumn={dotColumn}
                onActivate={() => list.onActivate(index)}
                onChoose={() => list.onChoose(index)}
                onCancel={list.onCancel}
              />
            );
          });
          if (section.kind === 'rows') {
            return rows;
          }
          // A group heading opens one filled card with its rows; the heading names it.
          return (
            <div
              key={`group-${section.indexes[0] ?? 0}`}
              className="u-select-group"
              role="group"
              aria-labelledby={optionId(list.baseId, section.indexes[0] ?? 0)}
            >
              {rows}
            </div>
          );
        })
      )}
    </Popup>
  );
}

// Whether a list's rows hold a column for the status dot. A list where any row
// can carry one holds it on every row, so the dots stand in one column; a list
// with no dots at all holds none, so its rows carry no blank gutter.
export type DotColumn = 'held' | 'none';

/** A run of rows drawn loose, or a group: a `group` heading and the indented rows after it. */
export type ListSection = { readonly kind: 'rows' | 'group'; readonly indexes: readonly number[] };

/** The displayed rows cut into loose runs and groups, keeping their order and indexes. */
export function listSections<T extends string>(options: readonly SelectOption<T>[]): ListSection[] {
  const sections: { kind: 'rows' | 'group'; indexes: number[] }[] = [];
  for (const [index, option] of options.entries()) {
    const last = sections[sections.length - 1];
    if (option.heading === true && option.group === true) {
      sections.push({ kind: 'group', indexes: [index] });
    } else if (last !== undefined && last.kind === 'group' && option.indent === true && option.heading !== true) {
      last.indexes.push(index);
    } else if (last !== undefined && last.kind === 'rows') {
      last.indexes.push(index);
    } else {
      sections.push({ kind: 'rows', indexes: [index] });
    }
  }
  assert(sections.reduce((total, section) => total + section.indexes.length, 0) === options.length, 'listSections: every row is drawn once');
  return sections;
}

export function dotColumnFor<T extends string>(options: readonly SelectOption<T>[]): DotColumn {
  return options.some((option) => option.marked === true) ? 'held' : 'none';
}

export function SelectRow<T extends string>({
  option,
  id,
  selected,
  active,
  dotColumn,
  onActivate,
  onChoose,
  onCancel,
}: {
  option: SelectOption<T>;
  id: string;
  selected: boolean;
  active: boolean;
  dotColumn: DotColumn;
  onActivate: () => void;
  onChoose: () => void;
  onCancel: () => void;
}) {
  const icon = present(option.icon) ? <span className="u-select-icon">{option.icon}</span> : undefined;
  if (option.heading) {
    return (
      <div id={id} className={['u-select-heading', option.group ? 'is-group' : ''].filter(Boolean).join(' ')} role="presentation">
        {icon}
        {option.tag === undefined ? undefined : <OptionTag tag={option.tag} />}
        <span className="u-select-heading-label" title={option.label}>
          {option.label}
        </span>
      </div>
    );
  }
  return (
    <div
      id={id}
      className={[
        'u-select-option',
        active ? 'is-active' : '',
        selected ? 'is-selected' : '',
        option.indent ? 'is-indented' : '',
        option.action ? 'has-action' : '',
        option.footer ? 'is-footer' : '',
        (option.subline?.length ?? 0) > 0 ? 'has-subline' : '',
      ]
        .filter(Boolean)
        .join(' ')}
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
      {icon}
      <OptionLabel label={option.label} overline={option.overline} tag={option.tag} subline={option.subline} />
      {/* Fixed trailing slots, held open whether or not they are filled, so every
          row's dot stands in one column and every row's check or pencil in the
          one after it. The end slot ends the row, so icons align down the left
          edge (a rule across the app). */}
      {dotColumn === 'held' ? (
        <span className="u-select-dot-slot" aria-hidden="true">
          {option.marked ? <span className="u-select-dot" /> : undefined}
        </span>
      ) : undefined}
      <span className="u-select-check">
        {selected ? CHECK : undefined}
        {option.action ? <RowAction action={option.action} onCancel={onCancel} /> : undefined}
      </span>
    </div>
  );
}

const CheckIcon = centralIcon(centralCheck);
export const CHECK = <CheckIcon />;

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
