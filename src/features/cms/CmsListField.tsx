// A list of plain values — `SERMON_SERVICES = ["Sunday Service", …]` — edited as
// options: drag to reorder, rename in place, delete with the trash, and the
// whole list collapses to its count. Values keep their kind: a number stays a
// number when renamed.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DragIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';

interface Props {
  readonly value: readonly unknown[];
  /**
   * `collapsible` (the default) starts folded to a summary, so a settings file
   * reads as its settings, not its lists. `open` always shows the items and the
   * add button: a CMS document's list is content to work on, not to unfold.
   */
  readonly layout?: 'collapsible' | 'open';
  readonly onChange: (value: unknown[]) => void;
}

export function CmsListField({ value, layout = 'collapsible', onChange }: Props) {
  assert(value.length <= BOUNDARY_LIMITS.itemsMax, 'CMS list: item limit exceeded');
  const [folded, setFolded] = useState(true);
  const open = layout === 'open' || !folded;
  const [renaming, setRenaming] = useState<number | undefined>(undefined);
  const list = useListEdits(value, onChange, setRenaming);
  const reorder = useListReorder({ count: value.length, onMove: list.move });
  return (
    <div className={`cms-option-list is-${layout}`}>
      {layout === 'collapsible' && (
        <button type="button" className="cms-option-head" onClick={() => setFolded(!folded)}>
          {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
          <span className="cms-option-summary">{listSummary(value, { open })}</span>
        </button>
      )}
      {open && (
        <>
          {value.map((entry, index) => (
            <div
              key={index}
              className={`cms-option-row ${reorder.rowClass(index)}`}
              {...reorder.rowProps(index)}
            >
              <span className="cms-option-grip" title="Drag to reorder">
                <DragIcon size={12} />
              </span>
              {renaming === index ? (
                <RenameInput
                  initial={optionText(entry)}
                  onDone={(text) => list.rename(index, text)}
                  onCancel={() => setRenaming(undefined)}
                />
              ) : (
                <OptionLabel text={optionText(entry)} onRename={() => setRenaming(index)} />
              )}
              <button
                type="button"
                className="ghost cms-option-trash"
                title="Delete"
                onClick={() => list.remove(index)}
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
          <button type="button" className="cms-option-add" onClick={list.add}>
            <PlusIcon size={12} /> Add item
          </button>
        </>
      )}
    </div>
  );
}

function OptionLabel(props: { readonly text: string; readonly onRename: () => void }) {
  return (
    <>
      <span className="cms-option-text" onDoubleClick={props.onRename}>
        {props.text || <em>Empty</em>}
      </span>
      <button
        type="button"
        className="ghost cms-option-rename"
        title="Rename"
        onClick={props.onRename}
      >
        <PencilIcon size={12} />
      </button>
    </>
  );
}

// Enter or leaving the field keeps the new text; Escape keeps the old.
function RenameInput(props: {
  readonly initial: string;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState(props.initial);
  return (
    <input
      autoFocus
      className="cms-option-input"
      value={text}
      maxLength={BOUNDARY_LIMITS.textLengthMax}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => props.onDone(text)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          props.onDone(text);
        }
        if (event.key === 'Escape') {
          props.onCancel();
        }
      }}
    />
  );
}

// The list's edits, each a new array: rename (keeping a number a number),
// remove, add (opening the new item for its text) and move.
function useListEdits(
  value: readonly unknown[],
  onChange: (value: unknown[]) => void,
  setRenaming: (index: number | undefined) => void,
) {
  const rename = (index: number, text: string) => {
    assert(index >= 0, 'CMS list: rename index is nonnegative');
    assert(index < value.length, 'CMS list: rename index in range');
    setRenaming(undefined);
    const entry = value[index];
    const next = typeof entry === 'number' ? Number(text) : text;
    if (typeof next === 'number' && !Number.isFinite(next)) {
      return;
    }
    if (next !== entry) {
      onChange(value.map((item, position) => (position === index ? next : item)));
    }
  };
  const remove = (index: number) => {
    assert(index < value.length, 'CMS list: removed index in range');
    setRenaming(undefined);
    onChange(value.filter((_, position) => position !== index));
  };
  const add = () => {
    assert(value.length < BOUNDARY_LIMITS.itemsMax, 'CMS list: item limit exceeded');
    const blank = value.length > 0 && value.every((item) => typeof item === 'number') ? 0 : '';
    onChange([...value, blank]);
    setRenaming(value.length);
  };
  // `to` is measured before removal, as useListReorder reports it.
  const move = (from: number, to: number) => {
    assert(from >= 0, 'CMS list: source index is nonnegative');
    assert(from < value.length, 'CMS list: source index in range');
    assert(to >= 0, 'CMS list: target index is nonnegative');
    assert(to <= value.length, 'CMS list: target index in range');
    if (from === to) {
      return;
    }
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    onChange(next);
  };
  return { rename, remove, add, move };
}

// Open, the rows say what is there and the head counts them; collapsed, the
// head reads the items, one line cut short where it runs out of room (CSS).
function listSummary(value: readonly unknown[], state: { readonly open: boolean }): string {
  if (value.length === 0) {
    return 'No items';
  }
  if (state.open) {
    return value.length === 1 ? '1 item' : `${value.length} items`;
  }
  return value.map((entry) => optionText(entry) || '(empty)').join(', ');
}

function optionText(entry: unknown): string {
  if (entry === null || entry === undefined) {
    return '';
  }
  return typeof entry === 'string' ? entry : String(entry);
}
