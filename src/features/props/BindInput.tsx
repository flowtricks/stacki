import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Part } from '../../editor/bindings';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { deleteChipAtCaret } from './chipKeys';

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

const esc = (text: string | undefined) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// `data-expr` is what the chip WRITES; `data-full` is what it MEANS. They are
// the same for an ordinary chip, and differ for one reached through a `?`:
// `featured?.data.title` is drawn as `featured` · "?" · `.data.title`, and that
// last chip writes `.data.title` while standing for `featured.data.title`. The
// picker needs the second one to know which value is the current one.
const chipHtml = (path: string, full?: string) =>
  `<span class="expr-chip" contenteditable="false" data-expr="${esc(path)}"${full && full !== path ? ` data-full="${esc(full)}"` : ''}>${esc(path)}</span>`;

const partsToHtml = (parts: readonly Part[] | undefined): string => {
  assert((parts?.length ?? 0) <= LIMITS.treeNodesMax, 'BindInput: part limit exceeded');
  // The path the chip before this one stood for, so a `.field` tail can be
  // read as the whole thing it names.
  let last: string | undefined;
  let afterQuestion = false;
  return (parts || [])
    .map((part) => {
      if (part.expr === undefined) {
        afterQuestion = last !== undefined && part.text === '?';
        return esc(part.text);
      }
      const full = afterQuestion && part.expr.startsWith('.') ? last + part.expr : part.expr;
      last = full;
      afterQuestion = false;
      return chipHtml(part.expr, full);
    })
    .join('');
};

// What is in the field now. Chips report the path they hold rather than the
// text they show, and everything else is text.
function readParts(host: HTMLElement): Part[] {
  assert(host.childNodes.length <= LIMITS.treeNodesMax, 'BindInput: child limit exceeded');
  const out: Part[] = [];
  for (const node of host.childNodes) {
    if (node.nodeType === 3) {
      if (node.nodeValue) {
        out.push({ text: node.nodeValue });
      }
    } else if (isChip(node)) {
      out.push({ expr: node.getAttribute('data-expr') || node.textContent || '' });
    } else if (node.nodeName === 'BR') {
      // A browser's own line break in a one-line field — nothing to keep.
    } else if (node.textContent) {
      // Pasted markup: keep what it said, drop what it was.
      out.push({ text: node.textContent });
    }
  }
  return out;
}

export interface BindInputHandle {
  readonly insert: (path: string) => void;
  readonly replace: (chip: Element | undefined, path: string) => void;
  readonly focus: () => void;
}
interface BindInputProps {
  readonly parts?: readonly Part[] | undefined;
  readonly placeholder?: string;
  readonly onChange?: (parts: Part[]) => void;
  readonly onChipClick?: (chip: Element) => void;
  readonly onFocus?: React.FocusEventHandler<HTMLDivElement>;
  readonly onBlur?: React.FocusEventHandler<HTMLDivElement>;
}
const BindInput = forwardRef<BindInputHandle, BindInputProps>(function BindInput(props, ref) {
  const { placeholder, onChipClick, onFocus, onBlur } = props;
  const state = useBindInput(props);
  const { hostRef, saveRange, emit } = state;
  useImperativeHandle(ref, () => bindHandle(state));
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
      onBlur={(event) => {
        saveRange();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        // One line: Enter commits rather than splitting the value in two.
        if (event.key === 'Enter') {
          event.preventDefault();
          hostRef.current?.blur();
          return;
        }
        // Backspace against a chip takes that chip, and only that chip.
        if (deleteChipAtCaret(hostRef.current ?? undefined, event)) {
          event.preventDefault();
          emit();
        }
      }}
      // Plain text only — a paste from a page would otherwise bring its markup
      // (and its own chips' styling) into a prop value.
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ');
        document.execCommand('insertText', false, text);
      }}
      onMouseDown={(event) => {
        const ElementType = event.currentTarget.ownerDocument.defaultView?.Element;
        const chip = ElementType && event.target instanceof ElementType ? event.target.closest('.expr-chip') : undefined;
        if (!chip) {
          return;
        }
        // The caret must not land inside a chip: it is one thing, and half of
        // a path is not a value.
        event.preventDefault();
        onChipClick?.(chip);
      }}
    />
  );
});

export default BindInput;

function useBindInput({ parts, onChange }: BindInputProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const lastHtmlRef = useRef('');
  // Where the caret was when focus left — the picker's search box takes it, so
  // inserting has to put the chip back where the caret actually was.
  const rangeRef = useRef<Range | undefined>(undefined);

  const emit = () => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    lastHtmlRef.current = host.innerHTML;
    onChange?.(readParts(host));
  };

  const saveRange = () => {
    const host = hostRef.current;
    const selection = window.getSelection();
    if (!host || !selection?.rangeCount) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer)) {
      rangeRef.current = range.cloneRange();
    }
  };

  const initialParts = useRef(parts);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const html = partsToHtml(initialParts.current);
    lastHtmlRef.current = html;
    host.innerHTML = html;
    // Mount only: everything after comes through the sync below.
  }, []);

  // Outside edits — undo, a reset, the same field now editing another node.
  // Never while focused: what's on screen is then the newer of the two.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || document.activeElement === host) {
      return;
    }
    const html = partsToHtml(parts);
    if (html !== lastHtmlRef.current) {
      lastHtmlRef.current = html;
      host.innerHTML = html;
    }
  });

  return { hostRef, rangeRef, emit, saveRange };
}

type BindState = ReturnType<typeof useBindInput>;
function bindHandle(state: BindState): BindInputHandle {
  const { hostRef, rangeRef, saveRange, emit } = state;
  return {
    // Drop a chip in at the caret — or at the end, which is where a field
    // nobody has clicked into yet leaves it.
    insert(path: string) {
      const host = hostRef.current;
      if (!host) {
        return;
      }
      host.focus();
      const selection = window.getSelection();
      const saved = rangeRef.current;
      const range = document.createRange();
      if (saved && host.contains(saved.commonAncestorContainer)) {
        range.setStart(saved.startContainer, saved.startOffset);
        range.setEnd(saved.endContainer, saved.endOffset);
      } else {
        range.selectNodeContents(host);
        range.collapse(false);
      }
      if (!selection) {
        return;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertHTML', false, chipHtml(path));
      saveRange();
      emit();
    },
    // Same chip, different data: the one already in the field is repointed
    // rather than replaced, so the text around it never moves.
    replace: (chip, path) => bindReplace(chip, path, emit),
    focus() {
      hostRef.current?.focus();
    },
  };
}

function bindReplace(chipElement: Element | undefined, path: string, emit: () => void): void {
  if (!chipElement) {
    return;
  }
  const full = chipElement.getAttribute('data-full');
  if (full) {
    // A chip reached through a `?` writes only its tail. Repointing it
    // somewhere under the same value keeps the chain — the `?` is how the
    // author chose to reach it and isn't ours to remove.
    const base = full.slice(0, full.length - (chipElement.getAttribute('data-expr') || '').length);
    if (path.startsWith(`${base}.`)) {
      const tail = path.slice(base.length);
      chipElement.setAttribute('data-expr', tail);
      chipElement.setAttribute('data-full', path);
      chipElement.textContent = tail;
      emit();
      return;
    }
    // Somewhere else entirely: the chain it was reached through goes with
    // it, or the field would read `featured?other.thing`.
    const punct = chipElement.previousSibling;
    const baseChip = punct?.previousSibling ?? undefined;
    if (punct?.nodeType === 3 && (punct.nodeValue || '').trim() === '?' && isChip(baseChip)) {
      punct.remove();
      baseChip.remove();
    }
  }
  chipElement.removeAttribute('data-full');
  chipElement.setAttribute('data-expr', path);
  chipElement.textContent = path;
  emit();
}

function isChip(node: Node | undefined): node is Element {
  const ElementType = node?.ownerDocument?.defaultView?.Element;
  return !!ElementType && node instanceof ElementType && node.classList.contains('expr-chip');
}
