import React, { useEffect, useRef, useState } from 'react';
import { DragIcon, PlusIcon, TrashIcon, CloseIcon } from '../ui/Icons.jsx';
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
function ItemEditor({ item, pos, onChange, onClose }) {
  const ref = useRef(null);
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // A word is one field called Value; an object is its own fields, named as the
  // file names them. Either way the popup is a list of labelled boxes, so there
  // is one thing to learn rather than two.
  const fields = item.fields || [{ key: 'value', text: item.text, quote: item.quote }];
  const set = (i, text) => {
    if (item.fields) {
      onChange({ ...item, fields: item.fields.map((f, at) => (at === i ? { ...f, text } : f)) });
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
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onClose() }
            }}
          />
        </label>
      ))}
    </div>
  );
}

export default function ListField({ value, placeholder, onChange }) {
  const items = arrayItems(value) || [];
  const [open, setOpen] = useState(null); // {index, pos}
  const [dragging, setDragging] = useState(null); // the row being dragged
  const [gap, setGap] = useState(null); // where a drop would land
  // An item added is not written until it says something: an empty one is not a
  // value, and `[""]` in the file is an empty option on the page. It lives here
  // until the popup on it is closed.
  const [pending, setPending] = useState(null); // {item, pos}

  // `immediate` is the app's own word for "this is the edit, save it" — the
  // typing in a popup is live so the canvas keeps up, and the edit lands as one
  // when the popup closes. Without that, an item renamed letter by letter would
  // be a dozen edits to undo.
  const write = (next, immediate = true) => onChange(arrayText(next), immediate);

  const openAt = (event, index, item) => {
    const row = event.currentTarget.closest('.list-field-row') || event.currentTarget;
    const r = row.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    const pos = {
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 220)),
      width,
    };
    if (index == null) setPending({ item, pos });
    else setOpen({ index, pos });
  };

  const closePending = () => {
    const held = pending;
    setPending(null);
    if (!held) return;
    const said = held.item.fields
      ? held.item.fields.some((f) => String(f.text).trim())
      : String(held.item.text).trim();
    if (said) write([...items, held.item]);
  };

  const remove = (at) => {
    setOpen(null);
    write(items.filter((_, i) => i !== at));
  };

  const drop = () => {
    if (dragging != null && gap != null) {
      const next = moveItem(items, dragging, gap);
      // A row dropped where it already sits has not moved, and writing the same
      // array back would be an edit — an undo step, a save, a canvas patch —
      // for a drag that did nothing.
      if (next.some((it, i) => it !== items[i])) write(next);
    }
    setDragging(null);
    setGap(null);
  };

  // The gap a pointer is over: the top half of a row means before it, the
  // bottom half means after.
  const gapFor = (event, index) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY - box.top < box.height / 2 ? index : index + 1;
  };

  return (
    <div className="list-field" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      {items.length === 0 ? (
        <div className="list-field-empty">{placeholder || 'No items yet'}</div>
      ) : null}
      {items.map((item, i) => (
        <div
          key={i}
          className={`list-field-row ${dragging === i ? 'is-dragging' : ''} ${
            gap === i ? 'is-before' : ''
          } ${gap === i + 1 ? 'is-after' : ''} ${open?.index === i ? 'is-open' : ''}`}
          draggable
          onDragStart={(e) => {
            setDragging(i);
            setOpen(null);
            e.dataTransfer.effectAllowed = 'move';
            // Firefox refuses to start a drag without one.
            try { e.dataTransfer.setData('text/plain', String(i)) } catch { /* not needed */ }
          }}
          onDragEnd={() => { setDragging(null); setGap(null) }}
          onDragOver={(e) => {
            if (dragging == null) return;
            e.preventDefault();
            setGap(gapFor(e, i));
          }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop() }}
        >
          <span className="list-field-grip" aria-hidden="true">
            <DragIcon size={12} />
          </span>
          <button type="button" className="list-field-text" onClick={(e) => openAt(e, i, item)}>
            {itemLabel(item) || <span className="list-field-blank">Empty</span>}
          </button>
          <button
            type="button"
            className="ghost list-field-remove"
            title="Remove"
            onClick={() => remove(i)}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="list-field-add"
        onClick={(e) => openAt(e, null, blankLike(items))}
      >
        <PlusIcon size={12} />
        Add item
      </button>
      {open && items[open.index] ? (
        <ItemEditor
          item={items[open.index]}
          pos={open.pos}
          onChange={(next) => write(items.map((it, i) => (i === open.index ? next : it)), false)}
          onClose={() => {
            // The same value again, as the edit: what was live becomes what was
            // done, in one step.
            write(items, true);
            setOpen(null);
          }}
        />
      ) : null}
      {pending ? (
        <ItemEditor
          item={pending.item}
          pos={pending.pos}
          onChange={(item) => setPending((p) => ({ ...p, item }))}
          onClose={closePending}
        />
      ) : null}
    </div>
  );
}
