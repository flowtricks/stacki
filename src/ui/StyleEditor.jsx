import React, { useEffect, useRef, useState } from 'react';
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { appTheme, appHighlight } from './CodeEditor.jsx';

// A `style` attribute holds a declaration list, not a stylesheet — no
// selector, no braces. @codemirror/lang-css can't read that: it parses
// `opacity: 1; pointer-events: auto` as selectors, tagging `opacity` a
// TagName and `pointer-events` a PseudoClassName, with the values as error
// nodes. So this is a small mode for declarations only. Token names map
// through tokenTable to the same tags the app's highlight style already
// colors, so it looks like the rest of the editors.
const styleMode = StreamLanguage.define({
  name: 'css-declarations',
  startState: () => ({ inValue: false, depth: 0 }),
  token(stream, state) {
    // One declaration per line, so a new line starts a new property — even
    // when the previous one was left without its semicolon. Values that wrap
    // inside parens (a long gradient) are the exception, hence the depth.
    if (stream.sol() && state.depth === 0) state.inValue = false;
    if (stream.eatSpace()) return null;

    if (stream.match('/*')) {
      while (!stream.eol()) {
        if (stream.match('*/')) break;
        stream.next();
      }
      return 'comment';
    }
    if (stream.match(/^!\s*important\b/i)) return 'important';

    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const c = stream.next();
        if (!escaped && c === ch) break;
        escaped = !escaped && c === '\\';
      }
      return 'str';
    }
    if (ch === ':') {
      stream.next();
      state.inValue = true;
      return 'punct';
    }
    if (ch === ';') {
      stream.next();
      state.inValue = false;
      return 'punct';
    }
    if (/[(),/]/.test(ch)) {
      stream.next();
      if (ch === '(') state.depth++;
      else if (ch === ')') state.depth = Math.max(0, state.depth - 1);
      return 'punct';
    }
    if (ch === '#') {
      stream.next();
      stream.eatWhile(/[\da-fA-F]/);
      return 'num'; // hex color
    }
    // Number with an optional unit (12px, 1.5rem, 50%, -.3em)
    if (stream.match(/^[-+]?(\d*\.\d+|\d+)(px|r?em|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in)?/)) {
      return 'num';
    }
    // Bare word: a property before the colon, a function if a ( follows,
    // otherwise a keyword value (auto, none, …) or a var()/custom property.
    if (stream.match(/^[-\w\\]+/)) {
      if (stream.peek() === '(') return 'fn';
      return state.inValue ? 'val' : 'prop';
    }
    stream.next();
    return null;
  },
  tokenTable: {
    prop: t.propertyName,
    val: t.variableName,
    num: t.number,
    str: t.string,
    fn: t.function(t.variableName),
    punct: t.punctuation,
    important: t.modifier,
    comment: t.comment,
  },
});

// Splitting on ";" has to skip the ones inside strings and parens — a
// `background: url("a;b.png")` or a data: URI would otherwise be cut in half.
export function splitDeclarations(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
    } else if (c === '(') {
      depth++;
      buf += c;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      buf += c;
    } else if (c === ';' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  out.push(buf);
  return out.map((d) => d.trim()).filter(Boolean);
}

// One declaration per line for editing…
export const expandDeclarations = (value) =>
  splitDeclarations(value || '')
    .map((d) => d + ';')
    .join('\n');

// …and back onto one line for the attribute itself. Newlines are legal in an
// HTML attribute, but writing them into the .astro source would spread one
// attribute across several lines of markup.
export const collapseDeclarations = (text) => splitDeclarations(text).join('; ') + (splitDeclarations(text).length ? ';' : '');

// Compact declaration editor: no gutters, no line numbers, no folding — it
// sits inside a popover a couple of hundred pixels wide.
export default function StyleEditor({ value, onChange, autoFocus, placeholder = '' }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Mounted once with the expanded text; from then on the effect below decides
  // when the incoming value is news and when it's this editor's own echo.
  const [initial] = useState(() => expandDeclarations(value));

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          highlightSpecialChars(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          styleMode,
          cmPlaceholder(placeholder),
          appTheme,
          appHighlight,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A change that didn't come from here — Reset, undo, a value written by
  // something else — has to reach the document, or the editor goes on showing
  // (and re-committing) text the element no longer has. Compared in collapsed
  // form, which is exactly what this editor emits, so the parent echoing an
  // edit straight back is a no-op and typing is never interrupted.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = value || '';
    if (collapseDeclarations(view.state.doc.toString()) === next) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: expandDeclarations(next) },
    });
  }, [value]);

  return <div ref={hostRef} className="style-editor" />;
}
