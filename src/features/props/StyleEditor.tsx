import { useCodeAccess, ManagedValue } from '../../ui/CodeAccess';
import React, { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, highlightSpecialChars, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { StreamLanguage, StringStream } from '@codemirror/language';
import type { Tag } from '@lezer/highlight';
import { CODE_TOKEN_RULES, type CodeLine, type CodeToken } from '../../ui/codeHighlight';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { appTheme, appHighlight } from '../../ui/CodeEditor';
import { codeIndentExtensions } from '../../ui/codeEditorIndent';
import { useCssFieldChips } from '../../ui/cssFieldChips';

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

// What each token of the mode is, in the tags the app's highlight style colours.
const DECLARATION_TAGS: Readonly<Record<string, Tag>> = {
  prop: t.propertyName,
  val: t.variableName,
  num: t.number,
  str: t.string,
  fn: t.function(t.variableName),
  punct: t.punctuation,
  important: t.modifier,
  comment: t.comment,
};

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
  tokenTable: DECLARATION_TAGS,
});

/** The style attribute's declaration language, for another field that edits declarations (a conditional's branch value). */
export const styleDeclarations = styleMode;

/**
 * A line of declarations as highlighted tokens, coloured exactly as this
 * editor colours them, for text shown rather than edited (a summary line).
 */
export function declarationTokens(text: string): CodeLine {
  assert(text.length <= LIMITS.attrCharsMax, 'declarationTokens: style value limit exceeded');
  const tokens: CodeToken[] = [];
  const stream = new StringStream(text, 2, 2);
  let state: StyleState = { inValue: false, depth: 0 };
  for (let round = 0; round <= text.length && stream.pos < text.length; round += 1) {
    stream.start = stream.pos;
    const step = styleStep(stream, state);
    assert(stream.pos > stream.start, 'declarationTokens: every token moves forward');
    state = step;
    const tag = step.style === undefined ? undefined : DECLARATION_TAGS[step.style];
    const style = tag === undefined ? undefined : CODE_TOKEN_RULES.find((rule) => tagsOf(rule.tag).includes(tag))?.style;
    tokens.push(style === undefined ? { text: stream.current() } : { text: stream.current(), style });
  }
  assert(tokens.map((token) => token.text).join('') === text, 'declarationTokens: the tokens are the text');
  return tokens;
}

function tagsOf(tag: Tag | readonly Tag[]): readonly Tag[] {
  return isTagList(tag) ? tag : [tag];
}

function isTagList(tag: Tag | readonly Tag[]): tag is readonly Tag[] {
  return Array.isArray(tag);
}

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
  // A number with its unit (12px, 100svh, 50cqmin, -.3em, 1e3ms): whatever
  // name is glued to the digits is the unit. A list of known units lagged CSS and
  // split `100svh` into `100s` and `vh`.
  if (stream.match(/^[-+]?(\d*\.\d+|\d+)([eE][-+]?\d+)?(%|[a-zA-Z]+)?/)) {
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
  return declarationPieces(text)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

// The text cut at each declaration's `;`, untouched: joined with `;` it is the text again.
function declarationPieces(text: string): string[] {
  assert(text.length <= LIMITS.attrCharsMax, 'StyleEditor: style value limit exceeded');
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (quote) {
      if (character === quote && text[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === ';' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  assert(out.join(';') === text, 'StyleEditor: the pieces are the text');
  return out;
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

/**
 * The attribute for the editor's `text`, spelled as `previous` spelled it. The
 * editor shows one declaration per line, but the source keeps its own spacing,
 * line breaks and last `;`: only a declaration that changed is rewritten, so
 * connecting a variable changes that reference and nothing else. A new
 * declaration is written ` name: value`, and an attribute that was empty is
 * written on one line (collapseDeclarations).
 */
export function rewriteDeclarations(previous: string, text: string): string {
  const next = splitDeclarations(text);
  const pieces = declarationPieces(previous);
  const written = pieces.filter((piece) => piece.trim() !== '');
  if (next.length === 0 || written.length === 0) {
    return collapseDeclarations(text);
  }
  const same = (at: number, from: number): boolean => written[from]?.trim() === next[at];
  const shared = Math.min(next.length, written.length);
  let head = 0;
  while (head < shared && same(head, head)) {
    head += 1;
  }
  let tail = 0;
  while (tail < shared - head && same(next.length - 1 - tail, written.length - 1 - tail)) {
    tail += 1;
  }
  // Which of the old declarations lends its spacing to the new one at `at`.
  const lender = (at: number): number | undefined => {
    if (at >= next.length - tail) {
      return written.length - (next.length - at);
    }
    return at < head || at < written.length - tail ? at : undefined;
  };
  const body = next.map((declaration, at) => {
    const from = lender(at);
    const old = from === undefined ? undefined : written[from];
    if (old === undefined) {
      return at === 0 ? declaration : ` ${declaration}`;
    }
    const lead = old.slice(0, old.length - old.trimStart().length);
    const trail = old.slice(old.trimEnd().length);
    // The first declaration's lead is not a separator, so moved down it takes one.
    return `${at > 0 && from === 0 && lead === '' ? ' ' : lead}${declaration}${trail}`;
  });
  const end = pieces.at(-1) ?? '';
  const closed = pieces.length > 1 && end.trim() === '';
  const result = `${body.join(';')}${closed ? `;${end}` : ''}`;
  assert(splitDeclarations(result).join(';') === next.join(';'), 'StyleEditor: the attribute holds the edited declarations');
  return result;
}

interface StyleEditorProps {
  readonly value?: string | undefined;
  /** The attribute to write after an edit (rewriteDeclarations); empty when nothing is left. */
  readonly onChange?: (value: string) => void;
  readonly autoFocus?: boolean;
  readonly placeholder?: string;
}

// A document replaced by the `value` effect below is the element's value
// arriving from outside (Reset, undo, another element selected), not an edit
// made here, so it never reaches `onChange`: hearing it as typing wrote the
// value straight back to the file, a write made by merely looking.
const outsideValue = Annotation.define<true>();

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
  // The attribute as it is spelled now, which the next edit is written over.
  const sourceRef = useRef(value || '');
  // The same CSS chips every code editor draws: the text is a bare declaration list.
  const codeChips = useCssFieldChips();
  const chipExtension = codeChips.extension;
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
          codeIndentExtensions(),
          highlightSpecialChars(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          styleMode,
          chipExtension,
          cmPlaceholder(initial.placeholder),
          appTheme,
          appHighlight,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              if (!update.transactions.some((transaction) => transaction.docChanged && transaction.annotation(outsideValue) !== true)) {
                return; // Only the outside value changed the document.
              }
              sourceRef.current = rewriteDeclarations(sourceRef.current, update.state.doc.toString());
              onChangeRef.current?.(sourceRef.current);
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
  }, [initial, chipExtension]);

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
    if (collapseDeclarations(view.state.doc.toString()) === collapseDeclarations(next)) {
      sourceRef.current = next;
      return;
    }
    sourceRef.current = next;
    // A value arriving from outside is not an edit made here: kept off the
    // editor's undo stack, so ⌘Z never undoes it back to a stale value.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: expandDeclarations(next) },
      annotations: [outsideValue.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  return (
    <>
      <div ref={hostRef} className="style-editor" />
      {codeChips.overlay}
    </>
  );
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
