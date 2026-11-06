// A sample's structure: search, the arrows that step through its items, and a
// row per field with nested ones under a chevron. It looks and moves as the data
// picker does, and is its own component because the picker's rows are bindings
// into a page's scope, which a template being created does not have yet. The
// field list and the page address both draw it, so they cannot drift apart.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SampleList, TemplateField } from '../../../shared/properties/pageTemplate';
import { popupBox } from '../../ui/Dropdown';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { addressOptions, allFieldsChosen, isFieldChosen, sampleTreeRows, steppedItem, type SampleTreeRow } from './pageTemplateForm';

const POPOVER_WIDTH = 380;
const POPOVER_HEIGHT = 340;
const INDENT_PX = 14;

export type SampleTreeMode =
  | {
      readonly kind: 'fields';
      readonly chosen: readonly TemplateField[];
      readonly toggle: (path: string) => void;
      readonly selectAll: () => void;
      readonly deselectAll: () => void;
    }
  | {
      readonly kind: 'address';
      readonly value: string;
      readonly route: string;
      readonly pick: (path: string) => void;
      /** A choice that is not a field of the sample: a content entry's own id. */
      readonly extra?: { readonly value: string; readonly label: string };
    };

export function SampleTree({ list, mode }: { readonly list: SampleList; readonly mode: SampleTreeMode }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [item, setItem] = useState(0);
  const rows = sampleTreeRows(list, expanded, query);
  const items = Math.max(0, ...list.fields.map((field) => field.examples?.length ?? 0));
  const toggleOpen = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };
  return (
    <>
      <input value={query} placeholder="Search" spellCheck={false} aria-label="Search the data" onChange={(event) => setQuery(event.currentTarget.value)} />
      <div className="page-template-tree-head">
        {items > 1 && (
          <span className="page-template-tree-items">
            <button className="ghost" title="Previous item" onClick={() => setItem((index) => steppedItem(index, items, -1))}>
              <ChevronLeftIcon size={11} />
            </button>
            <span>
              Item {item + 1} of {items}
            </span>
            <button className="ghost" title="Next item" onClick={() => setItem((index) => steppedItem(index, items, 1))}>
              <ChevronRightIcon size={11} />
            </button>
          </span>
        )}
        {mode.kind === 'fields' && (
          <button className="ghost page-template-add" onClick={allFieldsChosen(mode.chosen, list) ? mode.deselectAll : mode.selectAll}>
            {allFieldsChosen(mode.chosen, list) ? 'Deselect all' : 'Select all'}
          </button>
        )}
      </div>
      <div className="page-template-tree">
        {mode.kind === 'address' && mode.extra !== undefined && query.trim().length === 0 && (
          <button className="page-template-tree-row" onClick={() => mode.extra !== undefined && mode.pick(mode.extra.value)}>
            <span className="page-template-tree-key">{mode.extra.label}</span>
            <span className="page-template-tree-check">{mode.value === mode.extra.value && <CheckIcon size={11} />}</span>
          </button>
        )}
        {rows.map((row) => (
          <SampleRow key={row.path} row={row} list={list} mode={mode} item={item} toggleOpen={toggleOpen} />
        ))}
        {rows.length === 0 && <p className="hint-text">Nothing matches.</p>}
      </div>
    </>
  );
}

function SampleRow({
  row,
  list,
  mode,
  item,
  toggleOpen,
}: {
  readonly row: SampleTreeRow;
  readonly list: SampleList;
  readonly mode: SampleTreeMode;
  readonly item: number;
  readonly toggleOpen: (path: string) => void;
}) {
  const field = list.fields.find((candidate) => candidate.path === row.path);
  const value = field?.examples?.[item] ?? field?.example ?? '';
  const style = { paddingLeft: row.depth * INDENT_PX };
  const chevron = row.expandable ? (
    <button
      className={`ghost page-template-tree-chevron ${row.expanded ? 'is-open' : ''}`}
      title={row.expanded ? 'Close' : 'Open'}
      onClick={() => toggleOpen(row.path)}
    >
      <ChevronRightIcon size={10} />
    </button>
  ) : (
    <span className="page-template-tree-chevron" />
  );
  if (mode.kind === 'fields') {
    return (
      <div className="page-template-tree-row page-template-tree-field" style={style}>
        <input type="checkbox" aria-label={row.path} checked={isFieldChosen(mode.chosen, row.path)} onChange={() => mode.toggle(row.path)} />
        {chevron}
        <span className="page-template-tree-key">{row.label}</span>
        <span className="page-template-example">{value}</span>
      </div>
    );
  }
  const option = addressOptions(list.fields, mode.route).find((candidate) => candidate.value === row.path);
  if (option === undefined) {
    // An object or list has no address of its own, but may hold fields that do.
    return (
      <div className="page-template-tree-row is-group" style={style}>
        {chevron}
        <span className="page-template-tree-key">{row.label}</span>
      </div>
    );
  }
  return (
    <button className="page-template-tree-row" style={style} disabled={option.disabled === true} onClick={() => mode.pick(row.path)}>
      <span className="page-template-tree-copy">
        <span className="page-template-tree-key">{row.label}</span>
        {option.description !== undefined && <span className="page-template-tree-note">{option.description}</span>}
      </span>
      <span className="page-template-example">{value}</span>
      <span className="page-template-tree-check">{mode.value === row.path && <CheckIcon size={11} />}</span>
    </button>
  );
}

// Detail most templates never need, kept off the form until it is asked for, so
// the dialog stays one short column.
export function DetailPopover({
  label,
  title,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const show = (): void => {
    const rect = button.current?.getBoundingClientRect();
    if (rect !== undefined) {
      setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)), ...popupBox(rect, POPOVER_HEIGHT, window.innerHeight) });
      setOpen(true);
    }
  };
  return (
    <>
      <button ref={button} className="page-template-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? setOpen(false) : show())}>
        {label}
        <ChevronDownIcon size={11} />
      </button>
      {box !== undefined && (
        <Popup
          mode="popover"
          open={open}
          anchor={button.current ?? undefined}
          onClose={() => setOpen(false)}
          className="page-template-popover"
          role="dialog"
          label={title}
          style={{ position: 'fixed', ...box, width: POPOVER_WIDTH }}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </Popup>
      )}
    </>
  );
}
