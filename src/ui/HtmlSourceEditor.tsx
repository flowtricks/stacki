// The rich text field's HTML view: CodeMirror with HTML highlighting in the
// app's own colours, opened on the field's HTML laid out to read
// (richTextModel.formatHTML). The text is written back when the editor loses
// focus, or on Format, never mid-typing: a half-written tag must not reach the
// page. Opening the view writes nothing, so a field only viewed keeps its HTML.
import { useLayoutEffect, useRef } from 'react';
import { minimalSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { html } from '@codemirror/lang-html';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { appHighlight, appTheme } from './CodeEditor';
import { codeIndentExtensions } from './codeEditorIndent';
import { formatHTML } from './richTextModel';

/** The HTML the view opens on: laid out to read when it is short enough to lay out. */
export function sourceText(value: string): string {
  return value.length <= BOUNDARY_LIMITS.textLengthMax ? formatHTML(value, document) : value;
}

export function HtmlSourceEditor(props: {
  readonly value: string;
  readonly label: string;
  /** Bumped by the toolbar's Format button: lay the current text out again. */
  readonly formatCount: number;
  readonly onChange: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const opened = useRef(sourceText(props.value));
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    const parent = hostRef.current;
    assert(parent !== null, 'HTML view: mounted host exists');
    const commit = (view: EditorView): void => {
      const text = view.state.doc.toString();
      // Unchanged text, even reformatted, is not an edit.
      if (text !== opened.current && text !== latest.current.value) {
        latest.current.onChange(text);
      }
    };
    const view = new EditorView({
      parent,
      doc: opened.current,
      extensions: [
        minimalSetup,
        codeIndentExtensions(),
        html(),
        appTheme,
        appHighlight,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': `${latest.current.label} HTML` }),
        EditorView.domEventHandlers({ blur: (_event, current) => commit(current) }),
      ],
    });
    viewRef.current = view;
    return () => {
      commit(view);
      view.destroy();
      viewRef.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === undefined || props.formatCount === 0) {
      return;
    }
    const text = view.state.doc.toString();
    const formatted = sourceText(text);
    if (formatted !== text) {
      view.dispatch({ changes: { from: 0, to: text.length, insert: formatted } });
      latest.current.onChange(formatted);
    }
  }, [props.formatCount]);
  return <div ref={hostRef} className="html-source" />;
}
