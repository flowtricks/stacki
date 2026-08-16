import React, { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, LanguageDescription } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// CodeMirror 6 wrapper themed to match the app. Controlled-ish: `value` in,
// `onChange(text)` out; external value changes replace the doc only when
// they differ from the editor's current text (so typing doesn't loop).
// Key the component by node id at the call site so switching nodes resets
// history and selection.

export const appTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--text)',
      fontSize: '11.5px',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      lineHeight: '1.55',
    },
    '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    // The same selection as the rest of the app. CodeMirror paints its own
    // layer rather than using ::selection, so it has to be told separately or
    // code is the one place a selection looks different.
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
      { backgroundColor: 'var(--selection)' },
    '.cm-content ::selection': { backgroundColor: 'var(--selection)', color: 'var(--selection-text)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-faint)',
      border: 'none',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(0, 153, 255, 0.2)',
      outline: 'none',
    },
    '.cm-tooltip': {
      backgroundColor: '#232323',
      border: '1px solid var(--border-strong)',
      borderRadius: '6px',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)' },
  },
  { dark: true }
);

export const appHighlight = syntaxHighlighting(
  HighlightStyle.define(
    [
      { tag: [t.keyword, t.modifier], color: '#c792ea' },
      { tag: [t.propertyName], color: '#80cbc4' },
      { tag: [t.className, t.tagName], color: '#ffcb6b' },
      { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
      { tag: [t.number, t.unit, t.bool, t.null, t.atom], color: '#f78c6c' },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
      { tag: [t.variableName, t.definition(t.variableName)], color: '#e0e0e0' },
      { tag: [t.comment, t.blockComment, t.lineComment], color: '#616161', fontStyle: 'italic' },
      { tag: [t.operator, t.punctuation, t.separator], color: '#89ddff' },
      { tag: [t.labelName, t.attributeName], color: '#80cbc4' },
      { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#f78c6c' },
      // Markdown: the structure of a document rather than of code. Headings
      // lead, code and links pick up the colours their kind already has
      // elsewhere in this theme, and the marks (#, *, `) stay quiet.
      { tag: [t.heading], color: '#f5f5f5', fontWeight: '600' },
      { tag: [t.emphasis], fontStyle: 'italic' },
      { tag: [t.strong], fontWeight: '600', color: '#f5f5f5' },
      { tag: [t.link, t.url], color: '#82aaff', textDecoration: 'underline' },
      { tag: [t.monospace], color: '#c3e88d' },
      { tag: [t.quote], color: '#999999', fontStyle: 'italic' },
      { tag: [t.list], color: '#89ddff' },
      { tag: [t.processingInstruction], color: '#616161' },
    ],
    { themeType: 'dark' }
  )
);

export default function CodeEditor({ value, language, onChange, revealLine }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const lang =
      language === 'css'
        ? css()
        : language === 'markdown'
          ? // GFM as the base, and the languages a fenced block is likely to
            // hold. An .mdx body's imports and JSX read as prose to the
            // markdown parser — the headings, fences, links and emphasis
            // around them are what there is to colour, and the alternative
            // (a JS parser over a document that is mostly prose) colours the
            // prose wrongly instead.
            markdown({
              base: markdownLanguage,
              codeLanguages: [
                LanguageDescription.of({ name: 'css', extensions: ['css'], load: async () => css() }),
                LanguageDescription.of({
                  name: 'javascript',
                  alias: ['js', 'jsx', 'ts', 'tsx', 'typescript'],
                  extensions: ['js', 'ts'],
                  load: async () => javascript({ typescript: true, jsx: true }),
                }),
              ],
            })
          : javascript({ typescript: true });
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value ?? '',
        extensions: [
          basicSetup,
          lang,
          appTheme,
          appHighlight,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Apply external value changes (file reloads, undo from app level).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if ((value ?? '') !== cur) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value ?? '' } });
    }
  }, [value]);

  // Open on a particular line — the declaration you asked to edit, rather than
  // the top of a file you then have to search.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLine) return;
    const line = view.state.doc.line(Math.max(1, Math.min(revealLine, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [revealLine, value]);

  return <div ref={hostRef} className="cm-host" />;
}
