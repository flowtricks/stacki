// The pieces every data tree draws: a search box, a row with its chevron and
// indent, the arrows that step through a list's items, and a value as a person
// reads it. The Settings panel's data picker and the page template's sample
// tree both draw their rows from here, so the two cannot drift apart: one is a
// choice of binding, the other a choice of fields, and they look and move alike.

import type { ReactNode, Ref } from 'react';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from './Icons';

// How far a nested field steps in: the width of a chevron and the gap after
// it. A nested field with nothing beneath it drops its empty chevron slot, so
// its name lines up under its parent's name, just past the parent's chevron.
const DEPTH_INDENT_PX = 18;
const ROW_INSET_PX = 6;

/** The left padding of a row, or of a note under one, `depth` levels down. */
export function dataRowIndentPx(depth: number): number {
  assert(Number.isSafeInteger(depth), 'dataRowIndentPx: depth is a whole number');
  assert(depth >= 0, 'dataRowIndentPx: depth is not negative');
  return ROW_INSET_PX + depth * DEPTH_INDENT_PX;
}

export interface ItemPosition {
  readonly index: number;
  readonly count: number;
}

/**
 * How a row reads besides its name: a row kept only so what is under it can be
 * reached, a binding the data does not hold, or a choice that cannot work here.
 */
export type DataRowTone = 'plain' | 'path-only' | 'missing' | 'disabled';

/**
 * Where a selected row's check goes. A picker of one choice draws it only on
 * that row; a picker of many keeps a column for it on every row, so the values
 * beside the checks stay in one column.
 */
export type DataRowCheck = 'selected-only' | 'column';

export interface DataTreeRowProps {
  readonly depth: number;
  readonly label: string;
  readonly title: string;
  readonly expandable: boolean;
  readonly open: boolean;
  readonly selected: boolean;
  readonly tone: DataRowTone;
  readonly check: DataRowCheck;
  /** What the row holds, down the right: a value, or the arrows of a list. */
  readonly value: ReactNode;
  /** A mark before the name, such as the kind of a prop. */
  readonly lead?: ReactNode;
  /** A short line under the name, for why a choice reads as it does. */
  readonly detail?: string | undefined;
  /** After the check, at the very end: a prop's settings. */
  readonly end?: ReactNode;
  readonly rowRef?: Ref<HTMLDivElement> | undefined;
  readonly onToggle: () => void;
  readonly onPick: () => void;
}

export function DataTreeRow(props: DataTreeRowProps) {
  assert(props.depth <= LIMITS.treeDepthMax, 'DataTreeRow: render depth limit exceeded');
  assert(props.label.length <= LIMITS.attrCharsMax, 'DataTreeRow: label limit exceeded');
  const { expandable, open, depth, tone } = props;
  const toneClass = tone === 'plain' ? '' : tone;
  return (
    <div
      ref={props.rowRef}
      className={`dp-row ${props.selected ? 'selected' : ''} ${toneClass}`}
      style={{ paddingLeft: dataRowIndentPx(depth) }}
      title={props.title}
      aria-selected={props.selected}
      aria-disabled={tone === 'disabled' ? true : undefined}
      // Pressing a row keeps the caret where it was, so a picker opened from a field stays on it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={tone === 'disabled' ? undefined : props.onPick}
    >
      <span
        className={`dp-twist ${expandable ? '' : depth > 0 ? 'absent' : 'hidden'} ${open ? 'open' : ''}`}
        title={expandable ? (open ? 'Close' : 'Open') : undefined}
        onClick={
          expandable
            ? (event) => {
                // The row picks; the chevron only opens.
                event.stopPropagation();
                props.onToggle();
              }
            : undefined
        }
      >
        <ChevronRightIcon size={10} />
      </span>
      {props.lead}
      {props.detail === undefined ? (
        <span className="dp-key">{props.label}</span>
      ) : (
        <span className="dp-key-stack">
          <span className="dp-key">{props.label}</span>
          <span className="dp-note">{props.detail}</span>
        </span>
      )}
      {props.value}
      {props.check === 'column' ? (
        <span className="dp-check-slot">{props.selected && <CheckIcon size={11} className="dp-check" />}</span>
      ) : (
        props.selected && <CheckIcon size={11} className="dp-check" />
      )}
      {props.end}
    </div>
  );
}

// The arrows on a list's row: which of its items the rows beneath are read
// from. The row itself still picks or opens, so the arrows stop the click.
export function ItemNavigation({
  path,
  nav,
  onStepItem,
}: {
  readonly path: string;
  readonly nav: ItemPosition;
  readonly onStepItem: (path: string, step: -1 | 1, count: number) => void;
}) {
  assert(nav.count > 0, 'ItemNavigation: there is an item to show');
  assert(nav.index < nav.count, 'ItemNavigation: the item shown is one of the list');
  return (
    <span className="dp-item-nav" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="dp-step"
        title="Previous item"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStepItem(path, -1, nav.count)}
      >
        <ChevronLeftIcon size={11} />
      </button>
      <span className="dp-item-count">
        {nav.index + 1}/{nav.count}
      </span>
      <button
        type="button"
        className="dp-step"
        title="Next item"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStepItem(path, 1, nav.count)}
      >
        <ChevronRightIcon size={11} />
      </button>
    </span>
  );
}

export function DataSearch({
  value,
  label,
  inputRef,
  action,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly inputRef?: Ref<HTMLInputElement> | undefined;
  /** A control at the end of the search row, such as Select all. */
  readonly action?: ReactNode;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="dp-search">
      <SearchIcon size={12} />
      <input
        ref={inputRef}
        value={value}
        placeholder="Search data…"
        aria-label={label}
        spellCheck={false}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
      />
      {action}
    </div>
  );
}

// What a field holds, as a person reads it: words without the quotes a sample
// writes around them, a link without its scheme, and an image as the image.
export function PreviewValue(props: { readonly preview: string; readonly kind: string; readonly image: string | undefined }) {
  if (props.image) {
    return (
      <span className="dp-val" title={props.image}>
        <img className="dp-thumb" src={props.image} alt="" loading="lazy" />
      </span>
    );
  }
  if (!props.preview) {
    return <span className="dp-val kind">{props.kind}</span>;
  }
  const words = unquoted(props.preview);
  return words === undefined ? (
    <span className="dp-val">{props.preview}</span>
  ) : (
    <span className="dp-val text" title={words}>
      {words.replace(/^https?:\/\//, '')}
    </span>
  );
}

// The words of a quoted string preview, or undefined for any other value. A
// long one is clipped with an ellipsis where its closing quote was.
function unquoted(preview: string): string | undefined {
  if (!preview.startsWith('"')) {
    return undefined;
  }
  if (preview.endsWith('…')) {
    return preview.slice(1);
  }
  if (preview.length < 2 || !preview.endsWith('"')) {
    return undefined;
  }
  return preview.slice(1, -1);
}
