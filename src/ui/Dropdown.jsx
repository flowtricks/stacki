import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { endDragNotes, hoverNote } from './sound.js';
import { useSoundHere } from './soundScope.jsx';
import { ChevronDownIcon, CheckIcon } from './Icons.jsx';

// Where a popup of `wanted` pixels goes, given the trigger's box and the
// window height. Below unless it doesn't fit and above has more room; capped
// only when the chosen side is genuinely smaller than the list, so a list that
// fits is never given a scrollbar it doesn't need.
export const POPUP_GAP = 4;
const POPUP_EDGE = 8; // never sit flush against the window edge
const POPUP_MIN = 120; // a cramped window still shows a few rows
export function popupBox(rect, wanted, winH) {
  const roomBelow = winH - rect.bottom - POPUP_GAP - POPUP_EDGE;
  const roomAbove = rect.top - POPUP_GAP - POPUP_EDGE;
  const up = wanted > roomBelow && roomAbove > roomBelow;
  const room = Math.max(POPUP_MIN, up ? roomAbove : roomBelow);
  return {
    top: up ? undefined : rect.bottom + POPUP_GAP,
    bottom: up ? winH - rect.top + POPUP_GAP : undefined,
    maxHeight: wanted > room ? room : undefined,
  };
}

// Custom dropdown that replaces native <select>. Options: [{value, label}].
//
// Live preview: hovering (or arrow-keying) an option applies it immediately
// via onChange so the page preview updates in real time. Closing the menu
// without picking reverts to the value that was committed when it opened.
//
// The popup renders position:fixed so it can escape scrolling panels, flips
// upward when there's no room below, and closes on outside click, Escape,
// or any scroll outside the popup.
// `livePreview={false}` turns the hover/arrow preview off, for values where
// applying one costs more than a repaint — a loop's data source rewrites the
// page's code, so skimming the list would churn through every option.
//
// `searchable` puts a filter box at the top of the popup. It is off by default:
// most of these lists are five options long, where a search box is furniture.
// It earns its place on lists that grow with the project's content — every
// entry of a collection, say — which is also where an option carries an `icon`.
export default function Dropdown({
  value,
  options,
  onChange,
  className,
  // The popup is a sibling of the trigger, not a child, so a caller that wants
  // to style both has to name both.
  menuClassName,
  placeholder,
  livePreview = true,
  searchable = false,
  searchPlaceholder = 'Search…',
}) {
  const sounds = useSoundHere();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState(null); // {left, top, bottom, width}
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const committedRef = useRef(value); // value when the popup opened
  const previewedRef = useRef(null); // last live-previewed value, or null

  const selected = options.find((o) => o.value === value);

  // What the popup is showing. Everything below indexes into this, not into
  // `options` — with a filter typed in, the two are different lists.
  const q = query.trim().toLowerCase();
  const visible =
    searchable && q
      ? options.filter((o) => `${o.label} ${o.hint || ''}`.toLowerCase().includes(q))
      : options;
  const selectedIndex = visible.findIndex((o) => o.value === value);

  const openPopup = () => {
    committedRef.current = value;
    previewedRef.current = null;
    setQuery('');
    setHighlight(options.findIndex((o) => o.value === value));
    setOpen(true);
  };

  // Close, reverting any live preview back to the committed value.
  const closeAndRevert = () => {
    setOpen(false);
    if (previewedRef.current !== null && previewedRef.current !== committedRef.current) {
      onChange(committedRef.current);
    }
    previewedRef.current = null;
  };

  const previewOption = (i) => {
    setHighlight(i);
    const o = visible[i];
    if (!o || !livePreview) return;
    const applied = previewedRef.current ?? committedRef.current;
    if (o.value !== applied) {
      previewedRef.current = o.value;
      onChange(o.value);
    }
  };

  const pick = (option) => {
    committedRef.current = option.value;
    previewedRef.current = null;
    setOpen(false);
    onChange(option.value);
    triggerRef.current?.focus();
  };

  // Open at whatever height the list actually needs, and only scroll when the
  // window can't give it that. The first pass positions from an estimate so
  // the popup has somewhere to render; the second measures what rendered and
  // corrects both the side and the cap.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // Measured once it exists; before that, a row's worth per option.
    const wanted = popupRef.current
      ? popupRef.current.scrollHeight
      : visible.length * 30 + 12 + (searchable ? 34 : 0);
    const next = { left: rect.left, width: rect.width, ...popupBox(rect, wanted, window.innerHeight) };
    setPos((prev) =>
      prev &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.top === next.top &&
      prev.bottom === next.bottom &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next
    );
  }, [open, visible.length, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (
        popupRef.current && !popupRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        closeAndRevert();
      }
    };
    const onScroll = (e) => {
      if (popupRef.current && popupRef.current.contains(e.target)) return;
      closeAndRevert();
    };
    const onResize = () => closeAndRevert();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The highlight moving is a sound, pitched by how far down the list it is —
  // the same note the style panel's menus play, and from the same place: the
  // highlight, not the pointer, so arrowing through a menu sounds like running
  // down it with the mouse.
  //
  // Not on the way in. Opening a menu parks the highlight on the selected row,
  // and a note for a highlight nobody moved would be the menu answering a
  // question that was not asked. And the last note is forgotten only on the way
  // CLOSED: every render of every closed dropdown would otherwise wipe what the
  // open one just played, and the open one would sound the same row twice.
  const placedRef = useRef(false);
  useEffect(() => {
    if (!sounds) return;
    if (!open) {
      if (placedRef.current) {
        placedRef.current = false;
        endDragNotes(); // the next menu sounds its first row, wherever it opens
      }
      return;
    }
    if (!placedRef.current) {
      placedRef.current = true;
      return;
    }
    if (visible[highlight]) hoverNote(highlight, visible.length);
  }, [sounds, open, highlight, visible]);

  // Keep the highlighted option in view while navigating with arrows.
  useEffect(() => {
    if (!open || highlight < 0) return;
    const el = (listRef.current || popupRef.current)?.children[highlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [open, highlight]);

  // A filter box is only useful with the caret in it.
  useEffect(() => {
    if (!open || !searchable) return undefined;
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, searchable]);

  const onKeyDown = (e) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openPopup();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRevert();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      previewOption(Math.min(highlight + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      previewOption(Math.max(highlight - 1, 0));
    } else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) {
      // Space is a character while there is a box to type it into.
      e.preventDefault();
      if (highlight >= 0 && visible[highlight]) pick(visible[highlight]);
    } else if (e.key === 'Tab') {
      closeAndRevert();
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`dd-trigger ${className || ''}`}
        onClick={() => (open ? closeAndRevert() : openPopup())}
        onKeyDown={onKeyDown}
      >
        {selected?.icon && <span className="dd-icon">{selected.icon}</span>}
        <span className={`dd-label ${selected && !selected.dim ? '' : 'dim'}`}>
          {selected ? selected.label : placeholder || ''}
        </span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>

      {open && pos && (
        <div
          ref={popupRef}
          className={`dd-popup ${searchable ? 'dd-searchable' : ''} ${menuClassName || ''}`}
          style={{
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            width: pos.width,
            maxHeight: pos.maxHeight,
          }}
        >
          {searchable && (
            <input
              ref={searchRef}
              className="dd-search"
              value={query}
              placeholder={searchPlaceholder}
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
            />
          )}
          <div className="dd-list" ref={listRef}>
            {visible.map((o, i) => (
              <div
                key={`${o.value}-${i}`}
                className={`dd-option ${i === highlight ? 'highlight' : ''} ${o.value === committedRef.current && open ? 'selected' : ''} ${o.dim ? 'dim' : ''}`}
                onMouseEnter={() => previewOption(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                <span className="dd-check">
                  {o.value === committedRef.current ? <CheckIcon size={11} /> : null}
                </span>
                {o.icon && <span className="dd-icon">{o.icon}</span>}
                <span className="dd-option-label">{o.label}</span>
              </div>
            ))}
            {!visible.length && <div className="dd-empty">Nothing matches</div>}
          </div>
        </div>
      )}
    </>
  );
}
