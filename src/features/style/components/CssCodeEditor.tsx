import ReactCodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search } from '@codemirror/search';
import { Decoration, EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { cssEditorIndentExtensions } from './cssEditorIndent';
import { lockedEdgeExtensions, type CodeEditorLockedEdges } from '../../../ui/codeEditorLockedEdges';
import { type CodeVariableScope } from '../model/codeVariableScope';
import { useCodeVariables } from './CodeVariables';
import './CssCodeEditor.css';

type CodeEditorLanguage = 'css';
type CodeEditorLineOverflow = 'scroll' | 'wrap';
export type CodeEditorTokenHighlight = {
  from: number;
  to: number;
  className: string;
};

type CodeEditorProps = {
  id?: string;
  value: string;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  ariaLabel: string;
  /**
   * What the text is, for the variables typed into it: one property's value
   * (the whole of it can be bound, from the purple dot) or a declaration list
   * (`--` offers variables in each declaration's value). Required, so no CSS
   * editor is added without them (CodeVariables.tsx).
   */
  variables: CodeVariableScope;
  className?: string;
  minHeight?: string;
  tokenHighlights?: CodeEditorTokenHighlight[];
  /**
   * What a line too long for the box does. A rule reads as one declaration per
   * line, so the CSS Code box scrolls; a clip-path is one long value, so its
   * short field wraps to show all of it.
   */
  lineOverflow?: CodeEditorLineOverflow;
  /** Context at the ends of the text: shown, never editable. */
  lockedEdges?: CodeEditorLockedEdges;
  onChange?: (value: string) => void;
  onSelectionChange?: (position: number) => void;
};

const codeEditorHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--color-info)' },
  {
    tag: [tags.propertyName, tags.definition(tags.propertyName)],
    color: 'var(--color-text-primary)',
  },
  { tag: [tags.number, tags.unit, tags.color], color: 'var(--color-success)' },
  { tag: [tags.string, tags.url], color: 'var(--color-warning)' },
  { tag: [tags.className, tags.tagName, tags.attributeName], color: 'var(--color-info)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--color-text-secondary)' },
  { tag: tags.comment, color: 'var(--color-text-tertiary)', fontStyle: 'italic' },
]);

// CodeMirror paints its selection as its own layer; this selector covers both the unfocused
// and the focused selection backgrounds.
const SELECTION_BACKGROUND_SELECTOR = '.cm-selectionBackground, ' + '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground';

const codeEditorTheme = EditorView.theme(
  {
    '&': {
      width: '100%',
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-bg-surface)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-content': {
      caretColor: 'var(--color-text-primary)',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--color-text-primary)',
    },
    // Matches the selection used everywhere else; CodeMirror paints its own
    // layer instead of using ::selection.
    [SELECTION_BACKGROUND_SELECTOR]: {
      backgroundColor: 'var(--selection)',
    },
    // Find results: a quiet wash on every hit, amber on the current one. Set here
    // rather than in CSS because CodeMirror's defaults for these live in a base
    // theme, which only a theme reliably outranks.
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
    '.cm-content ::selection': {
      color: 'var(--selection-text)',
      backgroundColor: 'var(--selection)',
    },
  },
  { dark: true },
);

const codeEditorExtensions = {
  // ⌘F opens at the top: this editor is short, and a panel at the bottom covers
  // the end of the file — which is where a search that has run leaves you.
  css: [...cssEditorIndentExtensions(), search({ top: true }), syntaxHighlighting(codeEditorHighlightStyle), codeEditorTheme],
};

const codeEditorBasicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  syntaxHighlighting: false,
  // cssEditorIndentExtensions adds it with the indent unit it works to.
  indentOnInput: false,
  searchKeymap: true,
  foldKeymap: false,
  completionKeymap: false,
  lintKeymap: false,
};

// Report the caret whenever the selection moves, and after a click, a key or focus
// (the frame's wait lets CodeMirror settle the selection first).
function selectionListeners(onSelectionChange: (head: number) => void) {
  return [
    EditorView.updateListener.of((update) => {
      if (update.selectionSet) {
        onSelectionChange(update.state.selection.main.head);
      }
    }),
    EditorView.domEventHandlers({
      pointerup: (_event, view) => {
        window.requestAnimationFrame(() => onSelectionChange(view.state.selection.main.head));
        return false;
      },
      keyup: (_event, view) => {
        onSelectionChange(view.state.selection.main.head);
        return false;
      },
      focus: (_event, view) => {
        window.requestAnimationFrame(() => onSelectionChange(view.state.selection.main.head));
        return false;
      },
    }),
  ];
}

// Mark each token highlight, dropping any that no longer fit the document.
function highlightDecorations(highlights: ReadonlyArray<CodeEditorTokenHighlight>) {
  return EditorView.decorations.of((view) => {
    const documentLength = view.state.doc.length;
    const ranges = highlights
      .filter((highlight) => highlight.to <= documentLength)
      .map((highlight) => Decoration.mark({ class: highlight.className }).range(highlight.from, highlight.to));
    return Decoration.set(ranges, true);
  });
}

export function CodeEditor({
  id,
  value,
  language = 'css',
  readOnly = false,
  ariaLabel,
  variables,
  className,
  minHeight: heightMin = '124px',
  tokenHighlights = [],
  lineOverflow = 'wrap',
  lockedEdges,
  onChange,
  onSelectionChange,
}: CodeEditorProps) {
  const codeVariables = useCodeVariables(variables, { readOnly });
  const variableExtension = codeVariables.extension;
  const prefixLength = lockedEdges?.prefixLength ?? 0;
  const suffixLength = lockedEdges?.suffixLength ?? 0;
  const extensions = useMemo(() => {
    const highlights = tokenHighlights
      .filter((highlight) => highlight.from >= 0 && highlight.to > highlight.from && highlight.to <= value.length)
      .sort((left, right) => left.from - right.from || left.to - right.to);
    const selectionExtensions = onSelectionChange ? selectionListeners(onSelectionChange) : [];
    const locked = lockedEdgeExtensions({ prefixLength, suffixLength });
    const wrapping = lineOverflow === 'wrap' ? [EditorView.lineWrapping] : [];
    if (!highlights.length) {
      return [...codeEditorExtensions[language], ...wrapping, variableExtension, ...locked, ...selectionExtensions];
    }
    return [...codeEditorExtensions[language], ...wrapping, variableExtension, ...locked, highlightDecorations(highlights), ...selectionExtensions];
  }, [language, lineOverflow, onSelectionChange, prefixLength, suffixLength, tokenHighlights, value.length, variableExtension]);

  // The frame holds the bind dot in the editor's top-left corner, shown on
  // hover as it is over every value field (embed-editor_varconnect's rules).
  return (
    <div ref={codeVariables.frameRef} className="embed-editor_varconnect code-editor_frame">
      <ReactCodeMirror
        {...(id === undefined ? {} : { id })}
        className={['code-editor', readOnly ? 'is-readonly' : '', className || ''].filter(Boolean).join(' ')}
        value={value}
        extensions={extensions}
        basicSetup={codeEditorBasicSetup}
        theme="none"
        minHeight={heightMin}
        readOnly={readOnly}
        editable={!readOnly}
        // cssEditorIndentExtensions binds the key: Tab inserts a tab at the caret.
        indentWithTab={false}
        {...(onChange === undefined ? {} : { onChange })}
        aria-label={ariaLabel}
      />
      {codeVariables.overlay}
    </div>
  );
}
