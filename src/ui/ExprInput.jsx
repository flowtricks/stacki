import React, { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { appTheme, appHighlight } from './CodeEditor.jsx';

// A field that holds JavaScript — highlighted, but shaped like an input:
// it grows with its content and Enter commits instead of adding a line.
//
// Uncontrolled after mount (like StyleEditor): the parent may reformat what
// it stores, and feeding that back would fight every keystroke. External
// changes are applied through `syncValue`, which only replaces the document
// when the text genuinely differs from what's on screen.
export default function ExprInput({
  value,
  onChange,
  onCommit,
  placeholder = '',
  autoFocus,
  syncValue,
  invalid,
  // A field holds one expression, so Enter commits it. `multiline` is for the
  // places that hold a whole statement instead (a data declaration's source),
  // where Enter has to mean a new line.
  multiline = false,
  className = '',
}) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;
  const [initial] = useState(() => value ?? '');

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          drawSelection(),
          // Enter commits; the field is one expression, not a document.
          keymap.of(
            multiline
              ? [...defaultKeymap, ...historyKeymap]
              : [
                  {
                    key: 'Enter',
                    run: () => {
                      onCommitRef.current?.(viewRef.current?.state.doc.toString() ?? '');
                      return true;
                    },
                  },
                  ...defaultKeymap.filter((b) => b.key !== 'Enter'),
                  ...historyKeymap,
                ]
          ),
          javascript(),
          appTheme,
          appHighlight,
          EditorView.lineWrapping,
          cmPlaceholder(placeholder),
          EditorView.domEventHandlers({
            blur: () => {
              onCommitRef.current?.(viewRef.current?.state.doc.toString() ?? '');
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply outside edits (undo, file reload, the Code field below).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || syncValue == null) return;
    const cur = view.state.doc.toString();
    if (syncValue !== cur) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: syncValue } });
    }
  }, [syncValue]);

  return (
    <div ref={hostRef} className={`expr-input ${invalid ? 'invalid' : ''} ${className}`} />
  );
}
