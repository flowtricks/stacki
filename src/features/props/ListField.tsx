import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import type { Item, ItemField } from './arrayValue';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { PlusIcon, CloseIcon } from '../../ui/Icons';
import ListFieldRow from '../../ui/ListFieldRow';
import type { PickedAsset } from '../../ui/AssetField';
import { allowDragEffect } from '../../editor/dragState';
import { arrayItems, arrayText, blankLike, itemLabel, moveItem } from './arrayValue';
import type { SourceContext } from './bindingTypes';
import { blankItemOf, conformedItem, itemFieldDefinition, itemFieldKind, itemFieldOf, itemFieldValue, type ItemShapeField } from './listItemShape';
import PropField from './PropField';
import type { RichContext } from './RichContent';

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
// field, and Add item starts from the shape even when the list is empty. Those
// are PropField's own controls, so a field binds to data as any prop's does and
// the code lands in the literal: `{ title: entry.data.title, number: 0 }`. An
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
  readonly bindContext: RichContext | undefined;
  readonly dataContext: SourceContext | undefined;
  readonly position: Position;
  readonly trigger: HTMLElement;
  readonly onChange: (item: Item) => void;
  readonly onClose: () => void;
}
function ItemEditor({ item: given, shape, projectPath, bindContext, dataContext, position, trigger, onChange, onClose }: ItemEditorProps) {
  const ref = useListEditorDismiss(trigger, onClose);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLInputElement>('input:not([type="color"]), .bind-input, .cm-content');
    first?.focus();
    if (first?.tagName === 'INPUT') {
      first.select();
    }
  }, [ref]);

  // A word is one field called Value; an object is its own fields, named as the
  // file names them (every declared one, when the component declares them).
  // Either way the popup is a list of labelled fields, so there is one thing
  // to learn rather than two.
  const item = conformedItem(given, shape, '"');
  const fields = item.fields;
  return (
    <div
      ref={ref}
      className="attr-editor list-item-editor"
      style={{ top: position.top, left: position.left, width: position.width }}
      onKeyDown={(event) => closeOnEnter(event, onClose)}
    >
      <div className="var-src-head">
        <span className="var-src-name">{item.fields ? 'Item' : 'Value'}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      {fields === undefined ? (
        <WordItemInput text={item.text} onSet={(text) => onChange({ ...item, text })} />
      ) : (
        fields.map((field, at) => (
          <ItemFieldControl
            key={field.key}
            field={field}
            kind={itemFieldKind(field, shape)}
            projectPath={projectPath}
            bindContext={bindContext}
            dataContext={dataContext}
            onSet={(next) => onChange({ fields: fields.map((own, index) => (index === at ? next : own)) })}
          />
        ))
      )}
    </div>
  );
}

// Enter closes the popup from a one-line field. Not from a code editor, where it
// commits, nor from the data picker a field opened, where it belongs to the search.
function closeOnEnter(event: React.KeyboardEvent<HTMLDivElement>, onClose: () => void): void {
  const ElementType = event.currentTarget.ownerDocument.defaultView?.Element;
  if (event.key !== 'Enter' || ElementType === undefined || !(event.target instanceof ElementType)) {
    return;
  }
  if (event.target.closest('.bind-menu, .cm-editor') === null) {
    event.preventDefault();
    onClose();
  }
}

// One field of an object item, drawn by PropField as any prop's field is: its
// label, its `{}`, its bind dot, its chips, and the control its kind takes.
function ItemFieldControl(props: {
  readonly field: ItemField;
  readonly kind: ReturnType<typeof itemFieldKind>;
  readonly projectPath: string | undefined;
  readonly bindContext: RichContext | undefined;
  readonly dataContext: SourceContext | undefined;
  readonly onSet: (field: ItemField) => void;
}) {
  const { field, kind, projectPath, onSet } = props;
  const [note, setNote] = useState<string | undefined>(undefined);
  // Code the list cannot hold yet stays on screen here, because the number box
  // shows only what it is given and `-` has to survive on the way to `-2`.
  const [draft, setDraft] = useState<Attr | undefined>(undefined);
  const write = (value: Attr | undefined): void => {
    const next = itemFieldOf(field, value, kind, '"');
    setDraft(next === undefined ? heldDraft(value, kind) : undefined);
    if (next !== undefined) {
      setNote(undefined);
      onSet(next);
    }
  };
  // An image in a list is a URL: the array literal can name a file in public/
  // or one hosted elsewhere, but not import one from src/, which needs an import
  // statement of its own.
  const pickAsset = (_name: string, picked: PickedAsset): void => {
    if (picked.root === 'public') {
      write({ type: 'string', value: `/${picked.rel.split('/').slice(1).join('/')}` });
    } else {
      setNote('A list item’s image is a URL: choose one from public/, or enter its address.');
    }
  };
  return (
    <>
      <PropField
        nodeKey={`item:${field.key}`}
        field={itemFieldDefinition(field.key, kind)}
        value={draft ?? itemFieldValue(field)}
        bindContext={props.bindContext}
        dataContext={props.dataContext}
        assetContext={projectPath === undefined ? undefined : { projectPath, onPickAsset: pickAsset }}
        onChange={write}
      />
      {note !== undefined && <div className="list-item-note">{note}</div>}
    </>
  );
}

// What a refused value is held as. As code, a number on its way (`-`) reads as
// bound and PropField would swap the box for the code field under the caret;
// as words it stays in the box until the next key makes it a number.
function heldDraft(value: Attr | undefined, kind: ReturnType<typeof itemFieldKind>): Attr | undefined {
  if (value?.type === 'expr' && kind === 'number' && /^[-+]?\.?$/.test(value.value.trim())) {
    return { type: 'string', value: value.value };
  }
  return value;
}

// A list of words holds no fields to bind: an item that is code is a program
// rather than a row (arrayValue.ts), so its one field stays a box for words.
function WordItemInput(props: { readonly text: string; readonly onSet: (text: string) => void }) {
  return (
    <label className="list-item-field">
      <span>value</span>
      <input value={props.text} aria-label="value" spellCheck={false} maxLength={LIMITS.attrCharsMax} onChange={(event) => props.onSet(event.target.value)} />
    </label>
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
      // A field's data picker takes its own Escape, and the item stays open under it.
      if (event.key === 'Escape' && !ref.current?.querySelector('.bind-menu')) {
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
  /** The data an item's fields can bind to. Absent, they take typed values and code. */
  readonly bindContext?: RichContext | undefined;
  readonly dataContext?: SourceContext | undefined;
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
  const { itemsRef, scrolls } = useItemsScroll(state.items.length);
  return (
    <div className={`list-field ${state.fallback ? 'is-fallback' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={state.drop}>
      {state.items.length === 0 && note ? <div className="list-field-empty">{note}</div> : undefined}
      {state.items.length > 0 && (
        <div ref={itemsRef} className={`list-field-items${scrolls ? ' is-scrolling' : ''}`} onScroll={() => closeListRowEditor(state)}>
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

// Whether the rows overflow their box (a host caps its height, as Options does),
// so Add item can sit over the last visible row and show that the list scrolls.
// Measured after each layout and on resize; a list that fits is drawn as before.
function useItemsScroll(count: number) {
  const itemsRef = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = itemsRef.current;
    if (element === null) {
      setScrolls(false);
      return undefined;
    }
    const measure = (): void => setScrolls(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  return { itemsRef, scrolls };
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
    bindContext: props.bindContext,
    dataContext: props.dataContext,
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
          bindContext={state.bindContext}
          dataContext={state.dataContext}
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
          bindContext={state.bindContext}
          dataContext={state.dataContext}
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
