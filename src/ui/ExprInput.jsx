import React, { useEffect, useRef, useState } from 'react';
import {
  EditorView,
  keymap,
  drawSelection,
  placeholder as cmPlaceholder,
  Decoration,
  ViewPlugin,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { appTheme, appHighlight } from './CodeEditor.jsx';

// The part of the expression that names where the data comes from, drawn as a
// chip. It is a mark, not a widget: the text underneath stays text, so the
// value is always exactly what is typed and everything after it — `.filter(…)`,
// `[1]`, `.slice(0, 3)` — is ordinary code in an ordinary field. Clicking it
// opens whatever picker the caller gave it.
const setChip = StateEffect.define();

const chipMark = Decoration.mark({ class: 'cm-chip' });

const chipField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setChip)) continue;
      const text = effect.value;
      const doc = tr.state.doc.toString();
      const at = text ? doc.indexOf(text) : -1;
      return at < 0 ? Decoration.none : Decoration.set([chipMark.range(at, at + text.length)]);
    }
    if (!tr.docChanged) return value;
    // The text moved: find it again rather than mapping, so a chip whose text
    // was edited away stops being a chip.
    const text = tr.state.field(chipTextField);
    const doc = tr.state.doc.toString();
    const at = text ? doc.indexOf(text) : -1;
    return at < 0 ? Decoration.none : Decoration.set([chipMark.range(at, at + text.length)]);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const chipTextField = StateField.define({
  create: () => '',
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setChip)) return effect.value || '';
    return value;
  },
});

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
  // The leading part of the value that names its source, drawn as a chip, and
  // what to do when it is clicked.
  chip = '',
  onChipClick,
  // Set to {insert} while the field is mounted, so a bind handle beside it can
  // drop a path in at the caret.
  apiRef,
}) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // Whether the caret in the state is one the user put there. CodeMirror keeps
  // a selection whether or not the field has ever been touched, and its idea
  // of "nowhere" is offset 0 — which would insert in front of the expression
  // rather than after it.
  const touchedRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  const onChipClickRef = useRef(onChipClick);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;
  onChipClickRef.current = onChipClick;
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
          chipTextField,
          chipField,
          appTheme,
          appHighlight,
          EditorView.lineWrapping,
          cmPlaceholder(placeholder),
          EditorView.domEventHandlers({
            mousedown: (event) => {
              if (!(event.target instanceof Element) || !event.target.closest('.cm-chip')) return false;
              // The chip is a control, not text: pressing it opens the picker
              // rather than putting the caret in the middle of a name.
              event.preventDefault();
              onChipClickRef.current?.();
              return true;
            },
            focus: () => {
              touchedRef.current = true;
              return false;
            },
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

  // Dropping data in from outside: at the caret, or at the end for a field
  // nobody has clicked into yet — the same place BindInput puts it. Returns
  // the whole value, since the caller is usually about to commit it.
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = {
      insert(text) {
        const view = viewRef.current;
        if (!view) return null;
        const end = view.state.doc.length;
        const { from, to } = touchedRef.current ? view.state.selection.main : { from: end, to: end };
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        view.focus();
        return view.state.doc.toString();
      },
    };
    return () => {
      apiRef.current = null;
    };
  });

  // The chip follows whatever the caller says the source is.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setChip.of(chip || '') });
  }, [chip, syncValue]);

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
