import React, { useEffect, useRef, useState } from 'react';
import DataPicker from './DataPicker.jsx';
import { dataTree } from '../dataSuggest.js';
import { BIND_PATH_RE, resolvePick } from '../bindings.js';
import { deleteChipAtCaret } from './chipKeys.js';
import { ElementLinkIcon } from './Icons.jsx';

// Rich inline-content editor for the props panel: a contentEditable field
// showing a node's inline children (text + <strong>/<em>/<sup>/… tags) with a
// floating bubble toolbar on text selection, Webflow-style. Emits plain node
// lists ({kind:'text'|'element'} without ids — the app assigns ids on write).

export const INLINE_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br',
  'small', 'mark', 'u', 's',
]);

// A simple interpolation like {index + 1}: single braces, no JSX inside —
// editable as literal text (Astro re-parses braces as an expression anyway).
export const isSimpleExpr = (n) =>
  n.kind === 'expr' && /^\{[^{}]*\}$/.test(n.value) && !n.value.includes('<');

// A node list is "inline only" when every node is text, a simple expression,
// or a known inline element (with string-only props) — the shapes this
// editor can round-trip.
export function isInlineOnly(children) {
  if (!Array.isArray(children) || children.length === 0) return false;
  return children.every((c) => {
    if (c.kind === 'text' || isSimpleExpr(c)) return true;
    if (c.kind !== 'element' || !INLINE_TAGS.has(String(c.name).toLowerCase())) return false;
    const propsOk = Object.values(c.props || {}).every(
      (v) => v == null || v.type === 'string' || v.type === 'bare'
    );
    if (!propsOk) return false;
    return c.children === null || c.children.length === 0 || isInlineOnly(c.children);
  });
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

// Which expressions become chips: a PLAIN PATH does — `{post.data.title}` is
// one thing, and the way to change it is to choose another, not to retype it
// character by character. A computed expression stays literal, editable text,
// because a chip is atomic and turning `{index + 1}` into one would take away
// the only way to fix the "+ 1". The same rule the prop fields use, so a
// binding looks the same wherever it appears.
export function isChippable(inner) {
  const t = String(inner || '').trim();
  // `{true}`, `{0}`, `{" "}` — expressions, but nothing is bound in them, and
  // a chip would take away the only way to change what they say.
  if (/^(true|false|null|undefined)$/.test(t) || /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return false;
  return BIND_PATH_RE.test(t);
}

export function nodesToHtml(nodes, chippable = isChippable) {
  let out = '';
  for (const n of nodes || []) {
    if (n.kind === 'text') {
      out += esc(n.value);
    } else if (n.kind === 'expr') {
      // An atomic chip: contentEditable=false makes the caret step over it
      // as one unit, so it can't be part-deleted into broken code, while
      // text either side stays editable. The braces live in data-expr; the
      // label reads better without them.
      const inner = n.value.replace(/^\{|\}$/g, '').trim();
      if (chippable(inner)) {
        out += `<span class="expr-chip" contenteditable="false" data-expr="${esc(n.value).replace(
          /"/g,
          '&quot;'
        )}">${esc(inner)}</span>`;
      } else {
        out += esc(n.value); // shown as literal {expr} text
      }
    } else {
      const attrs = Object.entries(n.props || {})
        .map(([k, v]) =>
          v == null || v.type === 'bare' ? ` ${k}` : ` ${k}="${esc(v.value).replace(/"/g, '&quot;')}"`
        )
        .join('');
      out +=
        n.children === null || n.children.length === 0
          ? n.name === 'br'
            ? '<br>'
            : `<${n.name}${attrs}></${n.name}>`
          : `<${n.name}${attrs}>${nodesToHtml(n.children, chippable)}</${n.name}>`;
    }
  }
  return out;
}

function domToNodes(el) {
  const out = [];
  // Brace runs in typed text become expression nodes again — in an Astro
  // template braces are expressions either way, so this matches semantics.
  const pushText = (raw) => {
    const re = /\{[^{}]*\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) out.push({ kind: 'text', value: raw.slice(last, m.index) });
      out.push({ kind: 'expr', value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < raw.length) out.push({ kind: 'text', value: raw.slice(last) });
  };
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) {
      if (n.textContent) pushText(n.textContent);
      return;
    }
    if (n.nodeType !== 1) return;
    // A chip round-trips from its attribute, not its label — the label has
    // the braces stripped for reading.
    if (n.classList?.contains('expr-chip')) {
      const value = n.getAttribute('data-expr') || `{${n.textContent}}`;
      out.push({ kind: 'expr', value });
      return;
    }
    let name = n.tagName.toLowerCase();
    if (name === 'b') name = 'strong';
    if (name === 'i') name = 'em';
    if (name === 'br') {
      out.push({ kind: 'element', name: 'br', props: {}, children: null });
      return;
    }
    if (!INLINE_TAGS.has(name)) {
      // Unknown wrapper (e.g. a pasted <div>) — keep its content, drop the tag.
      out.push(...domToNodes(n));
      return;
    }
    const props = {};
    for (const attr of ['href', 'class', 'target', 'rel']) {
      const v = n.getAttribute(attr);
      if (v != null && v !== '') props[attr] = { type: 'string', value: v };
    }
    out.push({ kind: 'element', name, props, children: domToNodes(n) });
  });
  return out;
}

const RichContent = function RichContent({ nodes, onChange, bindCtx, insertRef }) {
  const hostRef = useRef(null);
  const bubbleRef = useRef(null);
  const lastEmittedRef = useRef(null);
  const savedRangeRef = useRef(null);
  const [bubble, setBubble] = useState(null); // raw selection anchor {x, top, bottom}
  const [pos, setPos] = useState(null); // measured/clamped {left, top, below, arrowX}
  const [states, setStates] = useState({}); // {bold, italic, …} at the selection
  const [linkMode, setLinkMode] = useState(false);
  const [chipMenu, setChipMenu] = useState(null); // {chip, left, top, current}
  const [linkUrl, setLinkUrl] = useState('');

  const html = nodesToHtml(nodes, isChippable);

  // Load / external updates. lastEmittedRef holds the canonical html of the
  // nodes this editor last emitted, so an incoming value that matches it is
  // just our own edit echoing back through the app — leave the DOM (and the
  // caret) alone. Anything else is a real external change: an undo, a file
  // reload, a chip switched from elsewhere. Keying this off document focus
  // instead used to drop those updates whenever the field happened to hold
  // focus, which is exactly when an undo arrives.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (html !== lastEmittedRef.current) {
      el.innerHTML = html;
      lastEmittedRef.current = html;
    }
  }, [html]);

  const emit = () => {
    const el = hostRef.current;
    if (!el) return;
    let next = domToNodes(el);
    // Deleting the last character leaves a <br> behind: a contentEditable
    // needs one line for the caret to sit on, so the browser puts a
    // placeholder there. It isn't content, and writing it out means the
    // component still receives slot content — a heading emptied in the panel
    // would keep rendering, holding a line break. A lone <br> is that
    // placeholder and nothing else, so it clears to nothing.
    if (next.length === 1 && next[0].kind === 'element' && next[0].name === 'br') next = [];
    // Canonical, not el.innerHTML: the app hands the nodes back with ids
    // added and the browser normalises markup as you type, so only the
    // serialised form is comparable on the way back in.
    lastEmittedRef.current = nodesToHtml(next, isChippable);
    onChange(next);
  };

  // Formatting state at the current selection, for highlighting buttons.
  const readStates = () => {
    const el = hostRef.current;
    const sel = window.getSelection();
    const anchorEl =
      sel && sel.anchorNode
        ? sel.anchorNode.nodeType === 1
          ? sel.anchorNode
          : sel.anchorNode.parentElement
        : null;
    const inTag = (tag) => !!(anchorEl && el && el.contains(anchorEl) && anchorEl.closest(tag));
    let s = {};
    try {
      s = {
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        superscript: document.queryCommandState('superscript'),
        subscript: document.queryCommandState('subscript'),
      };
    } catch {
      s = {};
    }
    s.code = inTag('code');
    s.span = inTag('span');
    s.link = inTag('a');
    return s;
  };

  // Where the caret is, saved whenever it is inside the editor. The bubble
  // below only tracks real selections; inserting data needs the collapsed
  // caret too, and by the time the picker is open focus has left the editor.
  const caretRef = useRef(null);
  useEffect(() => {
    const onSel = () => {
      const el = hostRef.current;
      const sel = window.getSelection();
      if (!el || !sel?.rangeCount) return;
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) caretRef.current = r.cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  // Dropping data in from outside — the Content field's own insert button.
  useEffect(() => {
    if (!insertRef) return undefined;
    insertRef.current = {
      insert(path) {
        const el = hostRef.current;
        if (!el) return;
        el.focus();
        const sel = window.getSelection();
        const saved = caretRef.current;
        const range = document.createRange();
        if (saved && el.contains(saved.commonAncestorContainer)) {
          range.setStart(saved.startContainer, saved.startOffset);
          range.setEnd(saved.endContainer, saved.endOffset);
        } else {
          range.selectNodeContents(el);
          range.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand(
          'insertHTML',
          false,
          `<span class="expr-chip" contenteditable="false" data-expr="{${path}}">${path}</span>`
        );
        emit();
      },
    };
    return () => {
      insertRef.current = null;
    };
  });

  // Selection bubble: track selections anchored inside the editor.
  useEffect(() => {
    const onSelChange = () => {
      if (linkMode) return; // keep the bubble while typing a URL
      const el = hostRef.current;
      const sel = window.getSelection();
      if (
        !el ||
        !sel ||
        sel.rangeCount === 0 ||
        sel.isCollapsed ||
        !el.contains(sel.anchorNode) ||
        !el.contains(sel.focusNode)
      ) {
        setBubble(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setBubble(null);
        return;
      }
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      setBubble({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
      setStates(readStates());
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [linkMode]);

  // Measure the rendered bubble and keep it inside the window: clamp
  // horizontally, flip below the selection when it would hit the titlebar,
  // and keep the arrow pointing at the selection midpoint.
  React.useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!bubble || !el) {
      setPos(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const left = clamp(bubble.x, margin + w / 2, window.innerWidth - margin - w / 2);
    const below = bubble.top - h - 10 < 48;
    const top = below ? bubble.bottom + 10 : bubble.top - 10;
    const arrowX = clamp(bubble.x - (left - w / 2), 12, w - 12);
    setPos({ left, top, below, arrowX });
  }, [bubble, linkMode]);

  const restoreSelection = () => {
    const r = savedRangeRef.current;
    if (!r) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const exec = (command, value = null) => {
    hostRef.current?.focus();
    restoreSelection();
    document.execCommand(command, false, value);
    emit();
    setStates(readStates());
  };

  // Take the selection out of the nearest `tag` around it, leaving its text
  // where it was. The button is a toggle — pressing one that is already lit has
  // to turn it off, and for a <span> that is the only way back: a span with no
  // attributes on it yet is invisible, so one added by mistake could otherwise
  // only be removed by editing the file.
  const unwrapTag = (tag) => {
    const host = hostRef.current;
    const sel = window.getSelection();
    const anchor =
      sel && sel.anchorNode
        ? sel.anchorNode.nodeType === 1
          ? sel.anchorNode
          : sel.anchorNode.parentElement
        : null;
    const el = anchor && host && host.contains(anchor) ? anchor.closest(tag) : null;
    if (!el || !host.contains(el) || el === host) return false;
    const parent = el.parentNode;
    const first = el.firstChild;
    const last = el.lastChild;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    // Keep the text selected, so the bubble stays up and the next press acts on
    // the same words.
    if (first && last) {
      const r = document.createRange();
      r.setStartBefore(first);
      r.setEndAfter(last);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return true;
  };

  // No execCommand for <code> or <span> — wrap the selection manually.
  const wrapTag = (tag) => {
    hostRef.current?.focus();
    restoreSelection();
    // Already inside one: the press means "stop".
    if (unwrapTag(tag)) {
      emit();
      setStates(readStates());
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const el = document.createElement(tag);
    try {
      range.surroundContents(el);
    } catch {
      // Selection crosses element boundaries — extract and rewrap.
      el.appendChild(range.extractContents());
      range.insertNode(el);
    }
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.addRange(r);
    emit();
    setStates(readStates());
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkMode(false);
    setLinkUrl('');
    if (!url) return;
    hostRef.current?.focus();
    restoreSelection();
    document.execCommand('createLink', false, url);
    emit();
    setStates(readStates());
  };

  // Buttons use onMouseDown+preventDefault so the text selection survives.
  const btn = (label, title, onAct, active) => (
    <button
      key={title}
      type="button"
      className={active ? 'on' : ''}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onAct();
      }}
    >
      {label}
    </button>
  );

  // Clicking a chip offers the other values in scope. mousedown rather than
  // click, and preventDefault, so the caret never lands inside the chip.
  const onChipMouseDown = (e) => {
    const chip = e.target.closest?.(".expr-chip");
    if (!chip) return;
    e.preventDefault();
    const r = chip.getBoundingClientRect();
    setChipMenu({
      chip,
      left: r.left,
      top: r.bottom + 4,
      current: (chip.getAttribute("data-expr") || "").replace(/^\{|\}$/g, ""),
    });
  };

  const pickExpr = (insert) => {
    const chip = chipMenu?.chip;
    setChipMenu(null);
    if (!chip) return;
    chip.setAttribute("data-expr", "{" + insert + "}");
    chip.textContent = insert;
    emit();
  };

  useEffect(() => {
    if (!chipMenu) return;
    const close = (e) => {
      // Chips are excluded, not just the menu: React flushes this effect
      // synchronously for a discrete event, so the listener is live while the
      // very mousedown that opened the menu is still propagating to document.
      // Without the exclusion the menu closes on the click that opened it —
      // and clicking straight from one chip to another would too.
      if (e.target.closest?.(".bind-menu, .expr-chip")) return;
      setChipMenu(null);
    };
    const onKey = (e) => e.key === "Escape" && setChipMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [chipMenu]);

  return (
    <>
      <div
        ref={hostRef}
        className="rich-content"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={() => {
          setTimeout(() => setBubble((b) => (linkMode ? b : null)), 150);
        }}
        onInput={emit}
        onMouseDown={onChipMouseDown}
        onKeyDown={(e) => {
          // Keep formatting shortcuts local; Enter inserts <br> (inline field).
          if (e.key === 'Enter') {
            e.preventDefault();
            document.execCommand('insertHTML', false, '<br>');
            emit();
            return;
          }
          // Backspace against a chip takes that chip, and only that chip —
          // not the sentence it sits in.
          if (deleteChipAtCaret(hostRef.current, e)) {
            e.preventDefault();
            emit();
          }
        }}
      />
      {chipMenu && (
        <div
          className="dd-popup bind-menu"
          style={{ left: chipMenu.left, top: chipMenu.top, width: 260 }}
        >
          <DataPicker
            tree={dataTree(bindCtx || {})}
            current={chipMenu.current}
            entries={bindCtx?.entryNav}
            onPick={(path, query) => pickExpr(resolvePick(path, query, bindCtx))}
            onExpand={(node) => node.query && bindCtx?.onNeedSample?.(node.query.collection)}
            footer={false}
          />
        </div>
      )}
      {bubble && (
        <div
          ref={bubbleRef}
          className={`rich-bubble ${pos?.below ? 'below' : ''}`}
          style={{
            left: pos ? pos.left : bubble.x,
            top: pos ? pos.top : bubble.top - 10,
            visibility: pos ? 'visible' : 'hidden',
            '--arrow-x': pos ? `${pos.arrowX}px` : '50%',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {linkMode ? (
            <input
              autoFocus
              className="rich-bubble-url"
              placeholder="https://…  (Enter to apply)"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyLink();
                if (e.key === 'Escape') {
                  setLinkMode(false);
                  setLinkUrl('');
                }
              }}
            />
          ) : (
            <>
              {btn(<b>B</b>, 'Bold', () => exec('bold'), states.bold)}
              {btn(<i>I</i>, 'Italic', () => exec('italic'), states.italic)}
              {btn(
                <span>
                  X<sup>2</sup>
                </span>,
                'Superscript',
                () => exec('superscript'),
                states.superscript
              )}
              {btn(
                <span>
                  X<sub>2</sub>
                </span>,
                'Subscript',
                () => exec('subscript'),
                states.subscript
              )}
              {btn(<span className="mono">{'</>'}</span>, 'Code', () => wrapTag('code'), states.code)}
              {/* A span is the hook for everything else: wrap some words, then
                  give that node a class and style it like any other. Nothing is
                  written on it here — an empty span IS the useful result. */}
              {btn(<span className="mono">span</span>, 'Wrap in a span', () => wrapTag('span'), states.span)}
              {/* The app's own link icon, not the emoji: an emoji is drawn by
                  the system in its own colours and at its own weight, so it sat
                  in this row as the one thing that hadn't been designed. */}
              {btn(<ElementLinkIcon size={14} />, 'Link', () => setLinkMode(true), states.link)}
            </>
          )}
        </div>
      )}
    </>
  );
};

export default RichContent;
