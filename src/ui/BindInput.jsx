import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { deleteChipAtCaret } from './chipKeys.js';

// A prop's value as a field you can type in, with the data in it shown as
// chips: `Posted ` · [post.data.pubDate] · ` in London`. The chip is atomic —
// the caret steps over it, backspace takes the whole thing — so a binding
// can't be half-edited into something that doesn't resolve, while the text
// either side stays ordinary text.
//
// Uncontrolled after mount, like the other editors here: it is a
// contenteditable, and rewriting its HTML under a live caret would fight every
// keystroke. Outside changes (undo, a different node) are applied only while
// it isn't focused.

const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const chipHtml = (path) =>
  `<span class="expr-chip" contenteditable="false" data-expr="${esc(path)}">${esc(path)}</span>`;

const partsToHtml = (parts) =>
  (parts || [])
    .map((p) => (p.expr !== undefined ? chipHtml(p.expr) : esc(p.text)))
    .join('');

// What is in the field now. Chips report the path they hold rather than the
// text they show, and everything else is text.
function readParts(host) {
  const out = [];
  for (const node of host.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) out.push({ text: node.nodeValue });
    } else if (node.classList?.contains('expr-chip')) {
      out.push({ expr: node.getAttribute('data-expr') || node.textContent });
    } else if (node.tagName === 'BR') {
      // A browser's own line break in a one-line field — nothing to keep.
    } else if (node.textContent) {
      // Pasted markup: keep what it said, drop what it was.
      out.push({ text: node.textContent });
    }
  }
  return out;
}

const BindInput = forwardRef(function BindInput(
  { parts, placeholder, onChange, onChipClick, onFocus, onBlur },
  ref
) {
  const hostRef = useRef(null);
  const lastHtmlRef = useRef('');
  // Where the caret was when focus left — the picker's search box takes it, so
  // inserting has to put the chip back where the caret actually was.
  const rangeRef = useRef(null);

  const emit = () => {
    const host = hostRef.current;
    if (!host) return;
    lastHtmlRef.current = host.innerHTML;
    onChange?.(readParts(host));
  };

  const saveRange = () => {
    const host = hostRef.current;
    const sel = window.getSelection();
    if (!host || !sel?.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (host.contains(r.commonAncestorContainer)) rangeRef.current = r.cloneRange();
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const html = partsToHtml(parts);
    lastHtmlRef.current = html;
    host.innerHTML = html;
    // Mount only: everything after comes through the sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside edits — undo, a reset, the same field now editing another node.
  // Never while focused: what's on screen is then the newer of the two.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || document.activeElement === host) return;
    const html = partsToHtml(parts);
    if (html !== lastHtmlRef.current) {
      lastHtmlRef.current = html;
      host.innerHTML = html;
    }
  });

  useImperativeHandle(ref, () => ({
    // Drop a chip in at the caret — or at the end, which is where a field
    // nobody has clicked into yet leaves it.
    insert(path) {
      const host = hostRef.current;
      if (!host) return;
      host.focus();
      const sel = window.getSelection();
      const saved = rangeRef.current;
      const range = document.createRange();
      if (saved && host.contains(saved.commonAncestorContainer)) {
        range.setStart(saved.startContainer, saved.startOffset);
        range.setEnd(saved.endContainer, saved.endOffset);
      } else {
        range.selectNodeContents(host);
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertHTML', false, chipHtml(path));
      saveRange();
      emit();
    },
    // Same chip, different data: the one already in the field is repointed
    // rather than replaced, so the text around it never moves.
    replace(chip, path) {
      if (!chip) return;
      chip.setAttribute('data-expr', path);
      chip.textContent = path;
      emit();
    },
    focus() {
      hostRef.current?.focus();
    },
  }));

  return (
    <div
      ref={hostRef}
      className="bind-input"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      data-placeholder={placeholder || ''}
      onInput={emit}
      onKeyUp={saveRange}
      onMouseUp={saveRange}
      onFocus={onFocus}
      onBlur={(e) => {
        saveRange();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        // One line: Enter commits rather than splitting the value in two.
        if (e.key === 'Enter') {
          e.preventDefault();
          hostRef.current?.blur();
          return;
        }
        // Backspace against a chip takes that chip, and only that chip.
        if (deleteChipAtCaret(hostRef.current, e)) {
          e.preventDefault();
          emit();
        }
      }}
      // Plain text only — a paste from a page would otherwise bring its markup
      // (and its own chips' styling) into a prop value.
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ');
        document.execCommand('insertText', false, text);
      }}
      onMouseDown={(e) => {
        const chip = e.target.closest?.('.expr-chip');
        if (!chip) return;
        // The caret must not land inside a chip: it is one thing, and half of
        // a path is not a value.
        e.preventDefault();
        onChipClick?.(chip);
      }}
    />
  );
});

export default BindInput;
