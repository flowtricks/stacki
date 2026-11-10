// A sample's structure, drawn as the Settings panel's data picker draws data: a
// search, the item's row with the arrows that step through the list, and a row
// per field with nested ones under a chevron. The rows themselves are the
// picker's (ui/DataTree.tsx); this decides only what a row means, because
// the picker's rows are bindings into a page's scope, which a template being
// created does not have yet. The field list and the page address both draw it,
// so they cannot drift apart.

import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { SampleList, TemplateField } from '../../../shared/properties/pageTemplate';
import { DataSearch, DataTreeRow, ItemNavigation, PreviewValue } from '../../ui/DataTree';
import { popupBox } from '../../ui/Dropdown';
import { ChevronDownIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import {
  addressOptions,
  allFieldsChosen,
  isFieldChosen,
  sampleItemCount,
  sampleRowPreview,
  sampleTreeRows,
  steppedItem,
  type SampleTreeRow,
} from './pageTemplateForm';

const POPOVER_WIDTH = 380;
const POPOVER_HEIGHT = 340;
/** The item's own row, which holds every field: not a path any field can have. */
const ITEM_ROW = '';

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
  // The item's row starts open, so the popover opens on fields rather than on one closed row.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([ITEM_ROW]));
  const [item, setItem] = useState(0);
  const searching = query.trim().length > 0;
  const itemOpen = expanded.has(ITEM_ROW);
  const rows = searching || itemOpen ? sampleTreeRows(list, expanded, query) : [];
  const items = sampleItemCount(list);
  // A refetch can bring back fewer items than were stepped through: show the last one there is.
  const shown = Math.min(item, Math.max(0, items - 1));
  assert(shown >= 0, 'SampleTree: the item shown is not negative');
  assert(items === 0 || shown < items, 'SampleTree: the item shown is one of the sample');
  const toggleOpen = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  };
  const action =
    mode.kind === 'fields' ? (
      <button type="button" className="ghost dp-search-action" onClick={allFieldsChosen(mode.chosen, list) ? mode.deselectAll : mode.selectAll}>
        {allFieldsChosen(mode.chosen, list) ? 'Deselect all' : 'Select all'}
      </button>
    ) : undefined;
  return (
    <div className="data-picker page-template-sample">
      <DataSearch value={query} label="Search the data" action={action} onChange={setQuery} />
      <div className="dp-list">
        {mode.kind === 'address' && mode.extra !== undefined && !searching && (
          <AddressExtraRow extra={mode.extra} chosen={mode.value === mode.extra.value} pick={mode.pick} />
        )}
        {/* As the picker shows a loop's item: one row for the item, its arrows
            choosing which one the values beneath are read from. A search lists
            matches by their whole path instead, as the picker's does. */}
        {!searching && (
          <DataTreeRow
            depth={0}
            label="item"
            title={`Each of the ${list.count} items`}
            expandable={list.fields.length > 0}
            open={itemOpen}
            selected={false}
            tone="path-only"
            check={mode.kind === 'fields' ? 'column' : 'selected-only'}
            value={
              items > 1 ? (
                <ItemNavigation
                  path={ITEM_ROW}
                  nav={{ index: shown, count: items }}
                  onStepItem={(_path, step, count) => setItem(steppedItem(shown, count, step))}
                />
              ) : (
                <PreviewValue preview={`${list.fields.length} ${list.fields.length === 1 ? 'field' : 'fields'}`} kind="object" image={undefined} />
              )
            }
            onToggle={() => toggleOpen(ITEM_ROW)}
            onPick={() => toggleOpen(ITEM_ROW)}
          />
        )}
        {rows.map((row) => (
          <SampleRow key={row.path} row={row} depth={searching ? 0 : row.depth + 1} list={list} mode={mode} item={shown} toggleOpen={toggleOpen} />
        ))}
        {searching && rows.length === 0 && <div className="dp-empty">Nothing matches</div>}
      </div>
    </div>
  );
}

function AddressExtraRow({
  extra,
  chosen,
  pick,
}: {
  readonly extra: { readonly value: string; readonly label: string };
  readonly chosen: boolean;
  readonly pick: (path: string) => void;
}) {
  return (
    <DataTreeRow
      depth={0}
      label={extra.label}
      title={extra.label}
      expandable={false}
      open={false}
      selected={chosen}
      tone="plain"
      check="selected-only"
      // An empty value keeps the check at the end of the row, where every other row has it.
      value={<span className="dp-val" />}
      onToggle={() => undefined}
      onPick={() => pick(extra.value)}
    />
  );
}

function SampleRow({
  row,
  depth,
  list,
  mode,
  item,
  toggleOpen,
}: {
  readonly row: SampleTreeRow;
  readonly depth: number;
  readonly list: SampleList;
  readonly mode: SampleTreeMode;
  readonly item: number;
  readonly toggleOpen: (path: string) => void;
}) {
  const value = <PreviewValue preview={sampleRowPreview(list, row.path, item)} kind={row.kind} image={undefined} />;
  const shared = {
    depth,
    label: row.label,
    expandable: row.expandable,
    open: row.expanded,
    value,
    onToggle: () => toggleOpen(row.path),
  };
  if (mode.kind === 'fields') {
    // Every field is a choice: choosing an object keeps it whole, and clearing
    // it clears its fields with it (toggledFields).
    return (
      <DataTreeRow
        {...shared}
        title={row.path}
        selected={isFieldChosen(mode.chosen, row.path)}
        tone="plain"
        check="column"
        onPick={() => mode.toggle(row.path)}
      />
    );
  }
  const option = addressOptions(list.fields, mode.route).find((candidate) => candidate.value === row.path);
  if (option === undefined) {
    // An object or list has no address of its own, but may hold fields that do.
    return <DataTreeRow {...shared} title={row.path} selected={false} tone="path-only" check="selected-only" onPick={() => toggleOpen(row.path)} />;
  }
  return (
    <DataTreeRow
      {...shared}
      title={option.description ?? row.path}
      selected={mode.value === row.path}
      tone={option.disabled === true ? 'disabled' : 'plain'}
      check="selected-only"
      detail={option.description}
      onPick={() => mode.pick(row.path)}
    />
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
