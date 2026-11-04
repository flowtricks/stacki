import { useCodeAccess, ManagedValue } from '../../ui/CodeAccess';
import React, { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, highlightSpecialChars, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Transaction } from '@codemirror/state';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { StreamLanguage } from '@codemirror/language';
import type { StringStream } from '@codemirror/language';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { appTheme, appHighlight } from '../../ui/CodeEditor';

// A `style` attribute holds a declaration list, not a stylesheet — no
// selector, no braces. @codemirror/lang-css can't read that: it parses
// `opacity: 1; pointer-events: auto` as selectors, tagging `opacity` a
// TagName and `pointer-events` a PseudoClassName, with the values as error
// nodes. So this is a small mode for declarations only. Token names map
// through tokenTable to the same tags the app's highlight style already
// colors, so it looks like the rest of the editors.
interface StyleState {
  readonly inValue: boolean;
  readonly depth: number;
}
interface StyleStep extends StyleState {
  readonly style: string | undefined;
}

const styleMode = StreamLanguage.define<{ inValue: boolean; depth: number }>({
  name: 'css-declarations',
  startState: () => ({ inValue: false, depth: 0 }),
  // CodeMirror's stream parser advances the state object it hands in, and reads
  // "no style" as null; the step itself is computed without touching either.
  token(stream, state) {
    const step = styleStep(stream, state);
    // eslint-disable-next-line no-param-reassign -- StreamParser advances its state in place.
    state.inValue = step.inValue;
    // eslint-disable-next-line no-param-reassign -- StreamParser advances its state in place.
    state.depth = step.depth;
    // eslint-disable-next-line stacki/no-null -- StreamParser spells "no style" as null.
    return step.style ?? null;
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

// One token of a declaration list, and the state after it.
function styleStep(stream: StringStream, state: StyleState): StyleStep {
  // One declaration per line, so a new line starts a new property — even
  // when the previous one was left without its semicolon. Values that wrap
  // inside parens (a long gradient) are the exception, hence the depth.
  const inValue = stream.sol() && state.depth === 0 ? false : state.inValue;
  const depth = state.depth;
  if (stream.eatSpace()) {
    return { style: undefined, inValue, depth };
  }

  const literal = styleLiteral(stream);
  if (literal !== undefined) {
    return { style: literal, inValue, depth };
  }
  const ch = stream.peek();
  if (ch === ':') {
    stream.next();
    return { style: 'punct', inValue: true, depth };
  }
  if (ch === ';') {
    stream.next();
    return { style: 'punct', inValue: false, depth };
  }
  if (/[(),/]/.test(ch ?? '')) {
    stream.next();
    if (ch === '(') {
      return { style: 'punct', inValue, depth: depth + 1 };
    }
    if (ch === ')') {
      return { style: 'punct', inValue, depth: Math.max(0, depth - 1) };
    }
    return { style: 'punct', inValue, depth };
  }
  if (ch === '#') {
    stream.next();
    stream.eatWhile(/[\da-fA-F]/);
    return { style: 'num', inValue, depth }; // hex color
  }
  // Number with an optional unit (12px, 1.5rem, 50%, -.3em)
  if (stream.match(/^[-+]?(\d*\.\d+|\d+)(px|r?em|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in)?/)) {
    return { style: 'num', inValue, depth };
  }
  // Bare word: a property before the colon, a function if a ( follows,
  // otherwise a keyword value (auto, none, …) or a var()/custom property.
  if (stream.match(/^[-\w\\]+/)) {
    if (stream.peek() === '(') {
      return { style: 'fn', inValue, depth };
    }
    return { style: inValue ? 'val' : 'prop', inValue, depth };
  }
  stream.next();
  return { style: undefined, inValue, depth };
}

// Splitting on ";" has to skip the ones inside strings and parens — a
// `background: url("a;b.png")` or a data: URI would otherwise be cut in half.
export function splitDeclarations(text: string): string[] {
  assert(text.length <= LIMITS.attrCharsMax, 'StyleEditor: style value limit exceeded');
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (quote) {
      buf += character;
      if (character === quote && text[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      buf += character;
    } else if (character === '(') {
      depth++;
      buf += character;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
      buf += character;
    } else if (character === ';' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += character;
    }
  }
  out.push(buf);
  return out.map((declaration) => declaration.trim()).filter(Boolean);
}

// One declaration per line for editing.
export const expandDeclarations = (value: string | undefined) =>
  splitDeclarations(value || '')
    .map((declaration) => declaration + ';')
    .join('\n');

// …and back onto one line for the attribute itself. Newlines are legal in an
// HTML attribute, but writing them into the .astro source would spread one
// attribute across several lines of markup.
export const collapseDeclarations = (text: string): string => {
  const declarations = splitDeclarations(text);
  return declarations.join('; ') + (declarations.length ? ';' : '');
};

interface StyleEditorProps {
  readonly value?: string | undefined;
  readonly onChange?: (value: string) => void;
  readonly autoFocus?: boolean;
  readonly placeholder?: string;
}

// Compact declaration editor: no gutters, no line numbers, no folding — it
// sits inside a popover a couple of hundred pixels wide.
export default function StyleEditor(props: StyleEditorProps) {
  return useCodeAccess() ? <EditableStyleEditor {...props} /> : <ManagedValue />;
}
function EditableStyleEditor({ value, onChange, autoFocus, placeholder = '' }: StyleEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Mounted once with the expanded text; from then on the effect below decides
  // when the incoming value is news and when it's this editor's own echo.
  const [initial] = useState(() => ({ text: expandDeclarations(value), placeholder, autoFocus }));

  useEffect(() => {
    const parent = hostRef.current;
    assert(parent !== null, 'StyleEditor: mounted host exists');
    assert(viewRef.current === undefined, 'StyleEditor: only one editor owns the host');
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.text,
        extensions: [
          history(),
          highlightSpecialChars(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          styleMode,
          cmPlaceholder(initial.placeholder),
          appTheme,
          appHighlight,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (initial.autoFocus) {
      view.focus();
    }
    return () => {
      viewRef.current = undefined;
      view.destroy();
    };
  }, [initial]);

  // A change that didn't come from here — Reset, undo, a value written by
  // something else — has to reach the document, or the editor goes on showing
  // (and re-committing) text the element no longer has. Compared in collapsed
  // form, which is exactly what this editor emits, so the parent echoing an
  // edit straight back is a no-op and typing is never interrupted.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const next = value || '';
    if (collapseDeclarations(view.state.doc.toString()) === next) {
      return;
    }
    // A value arriving from outside is not an edit made here: kept off the
    // editor's undo stack, so ⌘Z never undoes it back to a stale value.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: expandDeclarations(next) },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  return <div ref={hostRef} className="style-editor" />;
}

// Each scan advances the stream and stops at its finite line boundary.
function styleLiteral(stream: StringStream): string | undefined {
  if (stream.match('/*')) {
    while (!stream.eol()) {
      if (stream.match('*/')) {
        break;
      }
      stream.next();
    }
    return 'comment';
  }
  if (stream.match(/^!\s*important\b/i)) {
    return 'important';
  }

  const ch = stream.peek();
  if (ch === '"' || ch === "'") {
    stream.next();
    let escaped = false;
    while (!stream.eol()) {
      const character = stream.next();
      if (!escaped && character === ch) {
        break;
      }
      escaped = !escaped && character === '\\';
    }
    return 'str';
  }
  return undefined;
}
