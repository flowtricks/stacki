import React, { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import type { MutableRefObject } from 'react';
import type { LanguageSupport } from '@codemirror/language';
import { assert } from '../../shared/assert';
import { Annotation, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { syntaxHighlighting, HighlightStyle, LanguageDescription } from '@codemirror/language';
import { search } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { astroHighlight } from './astroHighlight';

// CodeMirror 6 wrapper themed to match the app. Controlled-ish: `value` in,
// `onChange(text)` out; external value changes replace the doc only when
// they differ from the editor's current text (so typing doesn't loop).
// Key the component by node id at the call site so switching nodes resets
// history and selection.

const externalValue = Annotation.define<boolean>();

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
    ['&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ' +
    '.cm-selectionBackground']: { backgroundColor: 'var(--selection)' },
    '.cm-content ::selection': {
      backgroundColor: 'var(--selection)',
      color: 'var(--selection-text)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    // Find results. Every hit gets a quiet blue wash; the one you're ON gets
    // amber with an edge, so running through matches is a colour changing
    // places rather than a list of identical highlights to count through.
    // In the theme (not the app stylesheet) because CodeMirror's own default
    // for these ships in a base theme, which only a theme reliably outranks.
    '.cm-searchMatch': {
      backgroundColor: 'rgba(0, 153, 255, 0.22)',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(255, 214, 10, 0.16)',
      // A ring rather than a heavier fill: CodeMirror also SELECTS the current
      // match, and two washes over each other came out a muddy third colour.
      outline: '1px solid rgba(255, 214, 10, 0.9)',
      outlineOffset: '-1px',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-faint)',
      border: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--text-dim)',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(0, 153, 255, 0.2)',
      outline: 'none',
    },
    '.cm-tooltip': {
      backgroundColor: '#232323',
      border: '1px solid var(--border-strong)',
      borderRadius: '6px',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--accent)',
    },
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
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: '#82aaff',
      },
      { tag: [t.variableName, t.definition(t.variableName)], color: '#e0e0e0' },
      {
        tag: [t.comment, t.blockComment, t.lineComment],
        color: '#616161',
        fontStyle: 'italic',
      },
      { tag: [t.operator, t.punctuation, t.separator], color: '#89ddff' },
      { tag: [t.labelName, t.attributeName], color: '#80cbc4' },
      {
        tag: [t.color, t.constant(t.name), t.standard(t.name)],
        color: '#f78c6c',
      },
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

export interface CodeEditorProps {
  readonly value?: string | null | undefined;
  readonly language?: string | undefined;
  readonly onChange?: ((text: string, position: number) => void) | undefined;
  readonly revealLine?: number | null | undefined;
  readonly activeRange?: CodeEditorRange | null | undefined;
  readonly componentRanges?: readonly CodeEditorComponentRange[] | undefined;
  readonly onPositionChange?: ((position: number) => void) | undefined;
  readonly onOpenComponent?: ((name: string, id: string) => void) | undefined;
}

export interface CodeEditorRange {
  readonly from: number;
  readonly to: number;
}

export interface CodeEditorComponentRange extends CodeEditorRange {
  readonly id: string;
  readonly name: string;
}

interface CodeDecorations {
  readonly active: CodeEditorRange | null;
  readonly components: readonly CodeEditorComponentRange[];
}

const codeDecorations = StateEffect.define<CodeDecorations>();
const codeDecorationField = StateField.define({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    const changed = transaction.effects.find((effect) => effect.is(codeDecorations));
    return changed
      ? codeEditorDecorations(transaction.state.doc.length, changed.value)
      : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export default function CodeEditor(props: CodeEditorProps) {
  const { value, language, revealLine, activeRange, componentRanges } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // These values change without replacing the editor, preserving history and selection.
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const parent = hostRef.current;
    assert(parent !== null, 'CodeEditor: mounted host exists');
    assert(viewRef.current === null, 'CodeEditor: only one editor owns the host');
    const view = codeEditorCreate(parent, language, latest);
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language]);

  // External reloads and app undo must not echo as user edits or enter local history.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const current = view.state.doc.toString();
    if ((value ?? '') !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value ?? '' },
        annotations: [externalValue.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [value]);
  useCodeDecorations(viewRef, activeRange, componentRanges);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLine) {
      return;
    }
    assert(Number.isSafeInteger(revealLine), 'CodeEditor: reveal line is a safe integer');
    const line = view.state.doc.line(Math.max(1, Math.min(revealLine, view.state.doc.lines)));
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [revealLine, language]);
  return <div ref={hostRef} className="cm-host" />;
}

function useCodeDecorations(
  viewRef: MutableRefObject<EditorView | null>,
  activeRange: CodeEditorRange | null | undefined,
  componentRanges: readonly CodeEditorComponentRange[] | undefined
): void {
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: codeDecorations.of({
        active: activeRange ?? null,
        components: componentRanges ?? [],
      }),
    });
    if (activeRange) {
      view.dispatch({
        effects: EditorView.scrollIntoView(activeRange.from, { y: 'nearest' }),
      });
    }
  }, [activeRange, componentRanges, viewRef]);
}

function codeEditorCreate(
  parent: HTMLDivElement,
  language: string | undefined,
  latest: MutableRefObject<CodeEditorProps>
): EditorView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: latest.current.value ?? '',
      extensions: [
        basicSetup,
        // Search stays above the document so it cannot cover the final match.
        search({ top: true }),
        codeEditorLanguage(language),
        appTheme,
        language === 'astro' ? astroHighlight : appHighlight,
        codeDecorationField,
        codeEditorInteractions(latest),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (!update.transactions.some((transaction) => transaction.annotation(externalValue))) {
              latest.current.onChange?.(
                update.state.doc.toString(),
                update.state.selection.main.head
              );
            }
          }
        }),
      ],
    }),
  });
  view.dispatch({
    effects: codeDecorations.of({
      active: latest.current.activeRange ?? null,
      components: latest.current.componentRanges ?? [],
    }),
  });
  return view;
}

function codeEditorInteractions(latest: MutableRefObject<CodeEditorProps>) {
  return EditorView.domEventHandlers({
    click: (event, view) => codeEditorClick(event, view, latest),
    keydown: (event, view) => codeEditorModifier(event.metaKey, view),
    keyup: (event, view) => codeEditorModifier(event.metaKey, view),
    mousemove: (event, view) => codeEditorModifier(event.metaKey, view),
    blur: (_event, view) => codeEditorModifier(false, view),
  });
}

function codeEditorClick(
  event: MouseEvent,
  view: EditorView,
  latest: MutableRefObject<CodeEditorProps>
): boolean {
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) {
    return false;
  }
  const component = latest.current.componentRanges?.find(
    (range) => range.from <= position && position <= range.to
  );
  if (event.metaKey && component) {
    event.preventDefault();
    latest.current.onOpenComponent?.(component.name, component.id);
    return true;
  }
  latest.current.onPositionChange?.(position);
  return false;
}

function codeEditorModifier(active: boolean, view: EditorView): false {
  view.dom.classList.toggle('cm-meta-held', active);
  return false;
}

function codeEditorDecorations(length: number, state: CodeDecorations) {
  const ranges = [];
  const active = codeEditorRangeWithin(state.active, length);
  if (active) {
    if (active.from > 0) {
      ranges.push(Decoration.mark({ class: 'cm-code-muted' }).range(0, active.from));
    }
    if (active.to < length) {
      ranges.push(Decoration.mark({ class: 'cm-code-muted' }).range(active.to, length));
    }
  }
  for (const component of state.components) {
    const range = codeEditorRangeWithin(component, length);
    if (range && range.from < range.to) {
      ranges.push(Decoration.mark({ class: 'cm-component-link' }).range(range.from, range.to));
    }
  }
  return Decoration.set(ranges, true);
}

function codeEditorRangeWithin(
  range: CodeEditorRange | null,
  length: number
): CodeEditorRange | null {
  if (!range || range.from < 0 || range.to < range.from || range.to > length) {
    return null;
  }
  return range;
}

function codeEditorLanguage(language: string | undefined): LanguageSupport {
  if (language === 'astro') {
    // HTML supplies structural editing while the official Astro TextMate
    // grammar supplies the colors, including embedded expressions and scripts.
    return html();
  }
  if (language === 'css') {
    return css();
  }
  if (language === 'markdown') {
    // MDX is mostly prose: highlight headings and fences instead of parsing it all as JS.
    return markdown({
      base: markdownLanguage,
      codeLanguages: [
        LanguageDescription.of({
          name: 'css',
          extensions: ['css'],
          load: async () => css(),
        }),
        LanguageDescription.of({
          name: 'javascript',
          alias: ['js', 'jsx', 'ts', 'tsx', 'typescript'],
          extensions: ['js', 'ts'],
          load: async () => javascript({ typescript: true, jsx: true }),
        }),
      ],
    });
  }
  return javascript({ typescript: true });
}
