import React, { useEffect, useRef, useState } from 'react';
import type { Item } from '../arrayValue';
import { assert } from '../../shared/assert';
import { LIMITS } from '../../shared/limits';
import { PlusIcon, CloseIcon } from '../ui/Icons.jsx';
import ListFieldRow from '../ui/ListFieldRow';
import { arrayItems, arrayText, blankLike, itemLabel, moveItem } from '../arrayValue.js';

// A prop that takes a list, edited as a list.
//
// The value is an array literal in the file — `options={["Designer",
// "Developer"]}` — and every row here is one item of it. Drag a row to reorder,
// press the bin to drop it, press the last row to add one, and click a row to
// open it.
//
// Opening is a popup rather than an input in the row, because an item is not
// always one thing: `{ value: "us", label: "United States" }` is a row with two
// fields, and there is no room beside the row's own name for either of them.
// One place to edit an item, whatever the item turns out to be.
//
// Every action writes the whole array back, because that is what the file
// holds: one value, not a list of values. The code editor is still one press of
// `{}` away, and it is the only field that can hold an array this cannot show —
// a spread, a call, a name standing for a list elsewhere (see arrayValue.js).

// The fields of one item, in a box anchored to its row.
interface Position {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}
interface ItemEditorProps {
  readonly item: Item;
  readonly pos: Position;
  readonly trigger: HTMLElement;
  readonly onChange: (item: Item) => void;
  readonly onClose: () => void;
}
function ItemEditor({ item, pos, trigger, onChange, onClose }: ItemEditorProps) {
  const ref = useListEditorDismiss(trigger, onClose);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  // A word is one field called Value; an object is its own fields, named as the
  // file names them. Either way the popup is a list of labelled boxes, so there
  // is one thing to learn rather than two.
  const fields = item.fields || [{ key: 'value', text: item.text, quote: item.quote }];
  const set = (i: number, text: string) => {
    if (item.fields) {
      onChange({
        ...item,
        fields: item.fields.map((f, at) => (at === i ? { ...f, text } : f)),
      });
      return;
    }
    onChange({ ...item, text });
  };

  return (
    <div
      ref={ref}
      className="attr-editor list-item-editor"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      <div className="var-src-head">
        <span className="var-src-name">{item.fields ? 'Item' : 'Value'}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      {fields.map((field, i) => (
        <label className="list-item-field" key={field.key}>
          <span>{field.key}</span>
          <input
            ref={i === 0 ? firstRef : null}
            value={field.text}
            spellCheck={false}
            maxLength={LIMITS.attrCharsMax}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </label>
      ))}
    </div>
  );
}

function useListEditorDismiss(trigger: HTMLElement, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // The active row handles its own toggle; dismissing here would reopen it on click.
      if (e.composedPath().includes(trigger)) {
        return;
      }
      const NodeType = ref.current?.ownerDocument.defaultView?.Node;
      if (NodeType && e.target instanceof NodeType && !ref.current?.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, trigger]);
  return ref;
}

// What an empty list has to say for itself, if anything. The Add item button
// under it already says that the list is empty and what to do about it, so a
// note is drawn only when it adds something the button doesn't. A declared
// default of `[]` adds nothing: it is the same sentence a second time, written
// in code, over the button that says it in words.
export function emptyNote(placeholder: unknown) {
  const text = String(placeholder ?? '').trim();
  return !text || /^\[\s*\]$/.test(text) ? '' : text;
}

export type ListFieldChange =
  | { readonly kind: 'edit'; readonly index: number }
  | { readonly kind: 'add' }
  | { readonly kind: 'remove'; readonly index: number }
  | { readonly kind: 'move'; readonly index: number; readonly gap: number };

interface ListFieldProps {
  readonly value?: string | null;
  readonly placeholder?: string | null;
  readonly onChange: (value: string, immediate: boolean, change: ListFieldChange) => void;
  readonly disabled?: boolean;
  readonly itemsMin?: number;
  readonly itemsMax?: number;
  readonly valueCharsMax?: number;
}
type Editor =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'existing';
      readonly index: number;
      readonly pos: Position;
      readonly trigger: HTMLElement;
    }
  | {
      readonly kind: 'pending';
      readonly item: Item;
      readonly pos: Position;
      readonly trigger: HTMLElement;
    };
type Drag =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'dragging';
      readonly index: number;
      readonly gap: number | null;
    };

export default function ListField(props: ListFieldProps) {
  const state = useListField(props);
  const note = emptyNote(props.placeholder);
  return (
    <div className="list-field" onDragOver={(event) => event.preventDefault()} onDrop={state.drop}>
      {state.items.length === 0 && note ? <div className="list-field-empty">{note}</div> : null}
      {state.items.length > 0 && (
        <div className="list-field-items" onScroll={() => closeListRowEditor(state)}>
          {state.items.map((item, index) => (
            <ListRow key={index} item={item} index={index} state={state} />
          ))}
        </div>
      )}
      <button
        type="button"
        className="list-field-add"
        disabled={state.disabled || state.items.length >= state.itemsMax}
        onClick={(event) => {
          if (state.editor.kind === 'pending') {
            state.closePending();
          } else {
            state.openAt(event, null, blankLike(state.items));
          }
        }}
      >
        <PlusIcon size={12} />
        Add item
      </button>
      <ListEditor state={state} />
    </div>
  );
}

function useListField(props: ListFieldProps) {
  const {
    value,
    onChange,
    disabled = false,
    itemsMin = 0,
    itemsMax = LIMITS.scanEntriesMax,
    valueCharsMax = LIMITS.attrCharsMax,
  } = props;
  assert((value?.length ?? 0) <= valueCharsMax, 'ListField: value limit exceeded');
  const items = arrayItems(value) || [];
  assert(items.length <= itemsMax, 'ListField: item count limit exceeded');
  const [editor, setEditor] = useState<Editor>({ kind: 'closed' });
  const write = (
    next: readonly Item[],
    options: { readonly immediate: boolean; readonly change: ListFieldChange }
  ) => {
    if (disabled) {
      return;
    }
    const text = arrayText(next);
    assert(text.length <= valueCharsMax, 'ListField: output limit exceeded');
    assert(next.length <= itemsMax, 'ListField: output item count limit exceeded');
    onChange(text, options.immediate, options.change);
  };
  const { drag, setDrag, drop } = useListDrag(items, write);
  const openAt = (event: React.MouseEvent<HTMLElement>, index: number | null, item: Item): void => {
    setEditor(listEditorAt(event.currentTarget, index, item));
  };
  const closePending = (): void => {
    setEditor({ kind: 'closed' });
    const item = pendingListItem(editor);
    if (item) {
      write([...items, item], { immediate: true, change: { kind: 'add' } });
    }
  };
  const remove = (index: number): void => {
    if (disabled || items.length <= itemsMin) {
      return;
    }
    setEditor({ kind: 'closed' });
    write(
      items.filter((_, current) => current !== index),
      {
        immediate: true,
        change: { kind: 'remove', index },
      }
    );
  };
  return {
    items,
    editor,
    setEditor,
    drag,
    setDrag,
    write,
    openAt,
    closePending,
    remove,
    drop,
    disabled,
    itemsMin,
    itemsMax,
  };
}
function listEditorAt(trigger: HTMLElement, index: number | null, item: Item): Editor {
  const pos = listPopupPosition(trigger);
  return index === null
    ? { kind: 'pending', item, pos, trigger }
    : { kind: 'existing', index, pos, trigger };
}

function pendingListItem(editor: Editor): Item | undefined {
  if (editor.kind !== 'pending') {
    return undefined;
  }
  const said = editor.item.fields
    ? editor.item.fields.some((field) => String(field.text).trim())
    : String(editor.item.text).trim();
  return said ? editor.item : undefined;
}

function useListDrag(
  items: readonly Item[],
  write: (
    items: readonly Item[],
    options: {
      readonly immediate: boolean;
      readonly change: ListFieldChange;
    }
  ) => void
) {
  const [drag, setDrag] = useState<Drag>({ kind: 'idle' });
  const drop = (): void => {
    if (drag.kind === 'dragging' && drag.gap !== null) {
      const next = moveItem(items, drag.index, drag.gap);
      // A drop into the original gap must not create an undo/save operation.
      if (next.some((item, index) => item !== items[index])) {
        write(next, {
          immediate: true,
          change: { kind: 'move', index: drag.index, gap: drag.gap },
        });
      }
    }
    setDrag({ kind: 'idle' });
  };
  return { drag, setDrag, drop };
}

function listPopupPosition(element: HTMLElement): Position {
  const row = element.closest('.list-field-row') || element;
  const rectangle = row.getBoundingClientRect();
  const width = Math.max(rectangle.width, 220);
  return {
    left: Math.max(8, Math.min(rectangle.left, window.innerWidth - width - 8)),
    top: Math.min(rectangle.bottom + 4, Math.max(60, window.innerHeight - 220)),
    width,
  };
}

type ListState = ReturnType<typeof useListField>;

function ListRow({
  item,
  index,
  state,
}: {
  readonly item: Item;
  readonly index: number;
  readonly state: ListState;
}) {
  const { drag, editor, setDrag, remove, drop } = state;
  const dragging = drag.kind === 'dragging' ? drag.index : null;
  const gap = drag.kind === 'dragging' ? drag.gap : null;
  const open = editor.kind === 'existing' && editor.index === index;
  return (
    <ListFieldRow
      className={`${dragging === index ? 'is-dragging' : ''} ${gap === index ? 'is-before' : ''} ${
        gap === index + 1 ? 'is-after' : ''
      } ${open ? 'is-open' : ''}`}
      rowProps={{
        draggable: !state.disabled,
        onDragStart: (event) => startListDrag(event, state, index),
        onDragEnd: () => setDrag({ kind: 'idle' }),
        onDragOver: (event) => {
          if (drag.kind === 'idle') {
            return;
          }
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          const gap = event.clientY - box.top < box.height / 2 ? index : index + 1;
          setDrag({ ...drag, gap });
        },
        onDrop: (event) => {
          event.preventDefault();
          event.stopPropagation();
          drop();
        },
      }}
      expanded={open}
      disabled={state.disabled}
      removeDisabled={state.disabled || state.items.length <= state.itemsMin}
      removeLabel={`Remove ${itemLabel(item) || 'item'}`}
      onOpen={(event) => toggleListRow(event, state, index, item)}
      onRemove={() => remove(index)}
    >
      {itemLabel(item) || <span className="list-field-blank">Empty</span>}
    </ListFieldRow>
  );
}

function toggleListRow(
  event: React.MouseEvent<HTMLElement>,
  state: ListState,
  index: number,
  item: Item
): void {
  if (state.editor.kind === 'existing' && state.editor.index === index) {
    state.write(state.items, {
      immediate: true,
      change: { kind: 'edit', index },
    });
    state.setEditor({ kind: 'closed' });
    return;
  }
  state.openAt(event, index, item);
}

function startListDrag(event: React.DragEvent<HTMLElement>, state: ListState, index: number): void {
  if (state.disabled) {
    return;
  }
  state.setDrag({ kind: 'dragging', index, gap: null });
  state.setEditor({ kind: 'closed' });
  event.dataTransfer.effectAllowed = 'move';
  try {
    event.dataTransfer.setData('text/plain', String(index));
  } catch {
    // Drag data is optional because this list keeps its gesture in local state.
  }
}

function ListEditor({ state }: { readonly state: ListState }) {
  const { editor, items, write, setEditor, closePending } = state;
  switch (editor.kind) {
    case 'closed':
      return null;
    case 'existing': {
      const item = items[editor.index];
      if (!item) {
        return null;
      }
      return (
        <ItemEditor
          item={item}
          pos={editor.pos}
          trigger={editor.trigger}
          onChange={(next) =>
            write(
              items.map((item, index) => (index === editor.index ? next : item)),
              {
                immediate: false,
                change: { kind: 'edit', index: editor.index },
              }
            )
          }
          onClose={() => closeListRowEditor(state)}
        />
      );
    }
    case 'pending':
      return (
        <ItemEditor
          item={editor.item}
          pos={editor.pos}
          trigger={editor.trigger}
          onChange={(item) =>
            setEditor((current) => (current.kind === 'pending' ? { ...current, item } : current))
          }
          onClose={closePending}
        />
      );
    default: {
      const exhaustive: never = editor;
      return exhaustive;
    }
  }
}

function closeListRowEditor(state: ListState): void {
  if (state.editor.kind === 'existing') {
    // Commit before dismissing so scrolling cannot leave a popup detached from its row.
    state.write(state.items, {
      immediate: true,
      change: { kind: 'edit', index: state.editor.index },
    });
    state.setEditor({ kind: 'closed' });
  }
}
