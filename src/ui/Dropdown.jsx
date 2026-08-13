import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
export default function Dropdown({
  value,
  options,
  onChange,
  className,
  placeholder,
  livePreview = true,
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [pos, setPos] = useState(null); // {left, top, bottom, width}
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const committedRef = useRef(value); // value when the popup opened
  const previewedRef = useRef(null); // last live-previewed value, or null

  const selected = options.find((o) => o.value === value);
  const selectedIndex = options.findIndex((o) => o.value === value);

  const openPopup = () => {
    committedRef.current = value;
    previewedRef.current = null;
    setHighlight(selectedIndex);
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
    const o = options[i];
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
      : options.length * 30 + 12;
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
  }, [open, options.length, pos]);

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

  // Keep the highlighted option in view while navigating with arrows.
  useEffect(() => {
    if (!open || highlight < 0 || !popupRef.current) return;
    const el = popupRef.current.children[highlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [open, highlight]);

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
      previewOption(Math.min(highlight + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      previewOption(Math.max(highlight - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (highlight >= 0 && options[highlight]) pick(options[highlight]);
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
          className="dd-popup"
          style={{
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            width: pos.width,
            maxHeight: pos.maxHeight,
          }}
        >
          {options.map((o, i) => (
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
              <span className="dd-option-label">{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
