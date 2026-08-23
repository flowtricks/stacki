import React, { useEffect, useRef, useState } from 'react';
import { DragIcon, PlusIcon, TrashIcon } from '../ui/Icons.jsx';
import { arrayItems, arrayText, moveItem } from '../arrayValue.js';

// A prop that takes a list of words, edited as a list of words.
//
// The value is an array literal in the file — `options={["Designer",
// "Developer"]}` — and every row here is one item of it. Drag a row to reorder,
// click it to change it, press the bin to drop it, press the last row to add
// one. Every one of those writes the whole array back, because that is what the
// file holds: one value, not a list of values.
//
// The code editor is still there, one press of `{}` away. It is the only field
// that can hold an array this can't — a spread, an object per item, a name
// standing for a list elsewhere — and that is why this control refuses those
// rather than flattening them into rows (see arrayValue.js).

export default function ListField({ value, placeholder, onChange }) {
  const items = arrayItems(value) || [];
  // Which row is being typed into, and the text so far. Held here rather than
  // written on every keystroke: an array is rewritten whole, and a list that
  // saved per letter would put `["Design"]` in the file on the way to
  // `["Designer"]` — and undo would have to walk back through all of it.
  const [editing, setEditing] = useState(null); // {index, text}
  const [dragging, setDragging] = useState(null); // index being dragged
  const [gap, setGap] = useState(null); // where a drop would land
  const inputRef = useRef(null);
  const addedRef = useRef(false);

  useEffect(() => {
    if (editing == null) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // A row that was just added is empty and waiting; one that was clicked has
    // words in it that are probably being replaced.
    if (addedRef.current) addedRef.current = false;
    else el.select();
  }, [editing?.index]);

  const write = (next) => onChange(arrayText(next));

  const commit = () => {
    if (editing == null) return;
    const text = editing.text;
    const at = editing.index;
    setEditing(null);
    const was = items[at];
    if (!was || was.text === text) return;
    // An item emptied is an item removed: a row with nothing in it is not
    // something the component can render, and leaving `""` in the array would
    // put an empty option on the page.
    if (!text.trim()) {
      write(items.filter((_, i) => i !== at));
      return;
    }
    write(items.map((it, i) => (i === at ? { ...it, text } : it)));
  };

  const add = () => {
    addedRef.current = true;
    const next = [...items, { text: '', quote: items.find((i) => i.quote)?.quote || '"' }];
    setEditing({ index: next.length - 1, text: '' });
    // Not written yet: an empty item is not a value, and the file gets it when
    // it has something in it. Held in `editing` until then, so the row is on
    // screen with the caret in it.
  };

  const remove = (at) => {
    if (editing?.index === at) setEditing(null);
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

  const pending = editing && editing.index === items.length ? editing : null;

  return (
    <div className="list-field" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      {items.length === 0 && !pending ? (
        <div className="list-field-empty">{placeholder || 'No items yet'}</div>
      ) : null}
      {items.map((item, i) => {
        const isEditing = editing?.index === i;
        return (
          <div
            key={i}
            className={`list-field-row ${dragging === i ? 'is-dragging' : ''} ${
              gap === i ? 'is-before' : ''
            } ${gap === i + 1 ? 'is-after' : ''}`}
            draggable={!isEditing}
            onDragStart={(e) => {
              setDragging(i);
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
            {isEditing ? (
              <input
                ref={inputRef}
                className="list-field-input"
                value={editing.text}
                onChange={(e) => setEditing({ index: i, text: e.target.value })}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                }}
              />
            ) : (
              <button
                type="button"
                className="list-field-text"
                onClick={() => setEditing({ index: i, text: item.text })}
              >
                {item.text}
              </button>
            )}
            <button
              type="button"
              className="ghost list-field-remove"
              title="Remove"
              onClick={() => remove(i)}
            >
              <TrashIcon size={12} />
            </button>
          </div>
        );
      })}
      {pending ? (
        <div className="list-field-row">
          <span className="list-field-grip" aria-hidden="true">
            <DragIcon size={12} />
          </span>
          <input
            ref={inputRef}
            className="list-field-input"
            value={pending.text}
            onChange={(e) => setEditing({ index: pending.index, text: e.target.value })}
            onBlur={() => {
              const text = pending.text;
              setEditing(null);
              if (text.trim()) write([...items, { text, quote: items.find((i) => i.quote)?.quote || '"' }]);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
            }}
          />
        </div>
      ) : null}
      <button type="button" className="list-field-add" onClick={add}>
        <PlusIcon size={12} />
        Add item
      </button>
    </div>
  );
}
