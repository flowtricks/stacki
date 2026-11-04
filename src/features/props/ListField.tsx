import React, { useEffect, useRef, useState } from 'react';
import type { Item, ItemField } from './arrayValue';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { PlusIcon, CloseIcon } from '../../ui/Icons';
import ListFieldRow from '../../ui/ListFieldRow';
import AssetField from '../../ui/AssetField';
import { allowDragEffect } from '../../editor/dragState';
import { arrayItems, arrayText, blankLike, itemLabel, moveItem } from './arrayValue';
import { blankItemOf, conformedItem, itemFieldKind, type ItemShapeField } from './listItemShape';
import SegSwitch from './SegSwitch';

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
// A list whose component declares its items (`items?: readonly { title:
// string; featured: boolean }[]`) is given that shape (listItemShape.ts): each
// field in the popup is the control its kind takes (a switch for a boolean, a
// number box, an image card, a link box), every item shows every declared
// field, and Add item starts from the shape even when the list is empty. An
// instance that sets nothing shows the component's default items, dimmed, and
// the first change writes the list from them.
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
  readonly shape: readonly ItemShapeField[] | undefined;
  readonly projectPath: string | undefined;
  readonly position: Position;
  readonly trigger: HTMLElement;
  readonly onChange: (item: Item) => void;
  readonly onClose: () => void;
}
function ItemEditor({ item: given, shape, projectPath, position, trigger, onChange, onClose }: ItemEditorProps) {
  const ref = useListEditorDismiss(trigger, onClose);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  // A word is one field called Value; an object is its own fields, named as the
  // file names them (every declared one, when the component declares them).
  // Either way the popup is a list of labelled fields, so there is one thing
  // to learn rather than two.
  const item = conformedItem(given, shape, '"');
  const fields: readonly ItemField[] = item.fields || [{ key: 'value', keyQuote: undefined, text: item.text, quote: item.quote }];
  const set = (i: number, text: string) => {
    if (item.fields) {
      onChange({
        ...item,
        fields: item.fields.map((field, at) => (at === i ? { ...field, text } : field)),
      });
      return;
    }
    onChange({ ...item, text });
  };
  const firstText = fields.findIndex((field) => field.quote !== undefined);

  return (
    <div ref={ref} className="attr-editor list-item-editor" style={{ top: position.top, left: position.left, width: position.width }}>
      <div className="var-src-head">
        <span className="var-src-name">{item.fields ? 'Item' : 'Value'}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      {fields.map((field, i) => (
        <ItemFieldControl
          key={field.key}
          field={field}
          kind={item.fields ? itemFieldKind(field, shape) : 'text'}
          projectPath={projectPath}
          inputRef={i === firstText ? firstRef : undefined}
          onSet={(text) => set(i, text)}
          onClose={onClose}
        />
      ))}
    </div>
  );
}

// One field of an item, as its kind is edited.
function ItemFieldControl(props: {
  readonly field: ItemField;
  readonly kind: ReturnType<typeof itemFieldKind>;
  readonly projectPath: string | undefined;
  readonly inputRef: React.RefObject<HTMLInputElement> | undefined;
  readonly onSet: (text: string) => void;
  readonly onClose: () => void;
}) {
  const { field, kind, onSet, onClose } = props;
  const closeOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onClose();
    }
  };
  switch (kind) {
    case 'switch':
      return (
        <div className="list-item-field">
          <span>{field.key}</span>
          <SegSwitch
            options={[
              { value: 'true', label: 'On' },
              { value: 'false', label: 'Off' },
            ]}
            current={field.text === 'true' ? 'true' : 'false'}
            onPick={onSet}
          />
        </div>
      );
    case 'number':
      return (
        <label className="list-item-field">
          <span>{field.key}</span>
          <NumberItemInput value={field.text} label={field.key} onSet={onSet} onKeyDown={closeOnEnter} />
        </label>
      );
    case 'image':
      return props.projectPath === undefined ? (
        <TextItemInput {...props} placeholder="https://… or /image.png" onKeyDown={closeOnEnter} />
      ) : (
        <ImageItemField field={field} projectPath={props.projectPath} onSet={onSet} />
      );
    case 'link':
      return <TextItemInput {...props} placeholder="https://… or /page" onKeyDown={closeOnEnter} />;
    case 'text':
      return <TextItemInput {...props} placeholder="" onKeyDown={closeOnEnter} />;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function TextItemInput(props: {
  readonly field: ItemField;
  readonly placeholder: string;
  readonly inputRef: React.RefObject<HTMLInputElement> | undefined;
  readonly onSet: (text: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="list-item-field">
      <span>{props.field.key}</span>
      <input
        ref={props.inputRef}
        value={props.field.text}
        aria-label={props.field.key}
        placeholder={props.placeholder}
        spellCheck={false}
        maxLength={LIMITS.attrCharsMax}
        onChange={(event) => props.onSet(event.target.value)}
        onKeyDown={props.onKeyDown}
      />
    </label>
  );
}

// A number is written as typed only once it is one: `-` or `1e` half-typed
// would write an array the file cannot parse, and the list would drop into the
// code editor mid-keystroke. An emptied box is 0.
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;
function NumberItemInput(props: {
  readonly value: string;
  readonly label: string;
  readonly onSet: (text: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return (
    <input
      value={draft}
      aria-label={props.label}
      inputMode="decimal"
      spellCheck={false}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (text.trim() === '') {
          props.onSet('0');
        } else if (NUMBER_TEXT.test(text.trim())) {
          props.onSet(text.trim());
        }
      }}
      onBlur={() => setDraft(props.value)}
      onKeyDown={props.onKeyDown}
    />
  );
}

// An image in a list is a URL: the array literal can name a file in public/
// or one hosted elsewhere, but not import one from src/, which needs an import
// statement of its own.
function ImageItemField(props: { readonly field: ItemField; readonly projectPath: string; readonly onSet: (text: string) => void }) {
  const [note, setNote] = useState<string | undefined>(undefined);
  return (
    <div className="list-item-field list-item-image">
      <span>{props.field.key}</span>
      <div className="list-item-image-body">
        <AssetField
          value={props.field.text === '' ? undefined : props.field.text}
          mediaKind="image"
          projectPath={props.projectPath}
          onChange={(value) => {
            setNote(undefined);
            props.onSet(value);
          }}
          onPickEntry={(picked) => {
            if (picked.root === 'public') {
              setNote(undefined);
              props.onSet(`/${picked.rel.split('/').slice(1).join('/')}`);
            } else {
              setNote('A list item’s image is a URL: choose one from public/, or enter its address.');
            }
          }}
        />
        {note !== undefined && <div className="list-item-note">{note}</div>}
      </div>
    </div>
  );
}

function useListEditorDismiss(trigger: HTMLElement, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      // The active row handles its own toggle; dismissing here would reopen it on click.
      if (event.composedPath().includes(trigger)) {
        return;
      }
      const NodeType = ref.current?.ownerDocument.defaultView?.Node;
      if (NodeType && event.target instanceof NodeType && !ref.current?.contains(event.target)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
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
  readonly value?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly onChange: (value: string, immediate: boolean, change: ListFieldChange) => void;
  readonly disabled?: boolean;
  readonly itemsMin?: number;
  readonly itemsMax?: number;
  readonly valueCharsMax?: number;
  /** The fields every item has, when the component declares them. */
  readonly itemShape?: readonly ItemShapeField[] | undefined;
  /** The items shown, dimmed, while no value is set: the component's default list. */
  readonly fallback?: string | undefined;
  /** The project, for an image field's asset card. */
  readonly projectPath?: string | undefined;
}
type Editor =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'existing';
      readonly index: number;
      readonly position: Position;
      readonly trigger: HTMLElement;
    }
  | {
      readonly kind: 'pending';
      readonly item: Item;
      readonly position: Position;
      readonly trigger: HTMLElement;
    };
type Drag =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'dragging';
      readonly index: number;
      /** The gap the row would land in; undefined until the pointer is over a row. */
      readonly gap: number | undefined;
    };

export default function ListField(props: ListFieldProps) {
  const state = useListField(props);
  const note = state.fallback ? '' : emptyNote(props.placeholder);
  return (
    <div className={`list-field ${state.fallback ? 'is-fallback' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={state.drop}>
      {state.items.length === 0 && note ? <div className="list-field-empty">{note}</div> : undefined}
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
            state.openAt(event, undefined, state.blank());
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
  const { value, onChange, disabled = false, itemsMin = 0, itemsMax = LIMITS.scanEntriesMax, valueCharsMax = LIMITS.attrCharsMax, itemShape } = props;
  assert((value?.length ?? 0) <= valueCharsMax, 'ListField: value limit exceeded');
  const own = arrayItems(value);
  // Nothing set: the component's default items stand in, and the first change writes from them.
  const fallbackItems = own === undefined && (value ?? '').trim() === '' ? arrayItems(props.fallback) : undefined;
  const fallback = fallbackItems !== undefined && fallbackItems.length > 0;
  const items = own || fallbackItems || [];
  assert(items.length <= itemsMax, 'ListField: item count limit exceeded');
  const [editor, setEditor] = useState<Editor>({ kind: 'closed' });
  const write = (next: readonly Item[], options: { readonly immediate: boolean; readonly change: ListFieldChange }) => {
    if (disabled) {
      return;
    }
    // Opening and closing a default item changes nothing, and must not turn the defaults into the instance's own list.
    if (fallback && next.length === items.length && next.every((item, index) => item === items[index])) {
      return;
    }
    const text = arrayText(next);
    assert(text.length <= valueCharsMax, 'ListField: output limit exceeded');
    assert(next.length <= itemsMax, 'ListField: output item count limit exceeded');
    onChange(text, options.immediate, options.change);
  };
  const { drag, setDrag, drop } = useListDrag(items, write);
  // No index opens a new item, not yet in the list.
  const openAt = (event: React.MouseEvent<HTMLElement>, index: number | undefined, item: Item): void => {
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
      },
    );
  };
  // The next item: shaped as the component declares its items, else like the ones already there.
  const blank = (): Item => {
    const quote = items.find((item) => item.quote)?.quote ?? items.flatMap((item) => item.fields ?? []).find((field) => field.quote)?.quote ?? '"';
    return itemShape !== undefined && itemShape.length > 0 ? blankItemOf(itemShape, quote) : blankLike(items);
  };
  return {
    items,
    fallback,
    blank,
    itemShape,
    projectPath: props.projectPath,
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
function listEditorAt(trigger: HTMLElement, index: number | undefined, item: Item): Editor {
  const position = listPopupPosition(trigger);
  return index === undefined ? { kind: 'pending', item, position, trigger } : { kind: 'existing', index, position, trigger };
}

// A new item is added once something is said in it: words in a text field,
// or a number or a switch moved off where it started (0, off).
function pendingListItem(editor: Editor): Item | undefined {
  if (editor.kind !== 'pending') {
    return undefined;
  }
  const said = editor.item.fields ? editor.item.fields.some(fieldSaid) : String(editor.item.text).trim();
  return said ? editor.item : undefined;
}

function fieldSaid(field: ItemField): boolean {
  if (field.quote !== undefined) {
    return String(field.text).trim() !== '';
  }
  return field.text !== '0' && field.text !== 'false' && field.text !== '';
}

function useListDrag(
  items: readonly Item[],
  write: (
    items: readonly Item[],
    options: {
      readonly immediate: boolean;
      readonly change: ListFieldChange;
    },
  ) => void,
) {
  const [drag, setDrag] = useState<Drag>({ kind: 'idle' });
  const drop = (): void => {
    if (drag.kind === 'dragging' && drag.gap !== undefined) {
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

function ListRow({ item, index, state }: { readonly item: Item; readonly index: number; readonly state: ListState }) {
  const { drag, editor, setDrag, remove, drop } = state;
  const dragging = drag.kind === 'dragging' ? drag.index : undefined;
  const gap = drag.kind === 'dragging' ? drag.gap : undefined;
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

function toggleListRow(event: React.MouseEvent<HTMLElement>, state: ListState, index: number, item: Item): void {
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
  state.setDrag({ kind: 'dragging', index, gap: undefined });
  state.setEditor({ kind: 'closed' });
  allowDragEffect(event.dataTransfer, 'move');
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
      return undefined;
    case 'existing': {
      const item = items[editor.index];
      if (!item) {
        return undefined;
      }
      return (
        <ItemEditor
          item={item}
          shape={state.itemShape}
          projectPath={state.projectPath}
          position={editor.position}
          trigger={editor.trigger}
          onChange={(next) =>
            write(
              items.map((item, index) => (index === editor.index ? next : item)),
              {
                immediate: false,
                change: { kind: 'edit', index: editor.index },
              },
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
          shape={state.itemShape}
          projectPath={state.projectPath}
          position={editor.position}
          trigger={editor.trigger}
          onChange={(item) => setEditor((current) => (current.kind === 'pending' ? { ...current, item } : current))}
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
