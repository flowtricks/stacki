import React, { useEffect, useRef, useState } from 'react';
import {
  EditorView,
  keymap,
  drawSelection,
  placeholder as cmPlaceholder,
  Decoration,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap, closeCompletion } from '@codemirror/autocomplete';
import { appTheme, appHighlight } from './CodeEditor.jsx';

// The data inside an expression, drawn as chips. They are marks, not widgets:
// the text underneath stays text, so the value is always exactly what is typed
// and everything around a chip — `.filter(…)`, `[1]`, a whole ternary — is
// ordinary code in an ordinary field. Clicking one opens whatever picker the
// caller gave it.
//
// Which text is a chip is the caller's to say: a loop's Data field marks the
// name at the front (the list being looped over), a prop's code field marks
// every `${…}` hole in it. So what arrives here is a function from the text to
// the ranges, re-run on every edit rather than mapped through it — a chip whose
// name is typed away stops being a chip, which is the honest answer.
const setChips = StateEffect.define();

const chipMark = Decoration.mark({ class: 'cm-chip' });

// A chip drawn INSTEAD of its text, for a range that is more than the name it
// means: `${maxWidth}` is one value, and the `${`/`}` around it is the syntax
// that puts it in a template, not part of what it names. It wears `expr-chip`,
// the class every other chip in the app wears, so it is the same object rather
// than something that resembles one.
//
// The text stays in the document underneath — the value written to the file is
// still `${maxWidth}` — and the range is atomic, so the caret steps over the
// chip as one thing instead of into the middle of a name.
class ChipWidget extends WidgetType {
  constructor(label) {
    super();
    this.label = label;
  }
  eq(other) {
    return other.label === this.label;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'expr-chip';
    span.textContent = this.label;
    return span;
  }
  // The press has to reach the editor's own handler, which is what opens the
  // picker.
  ignoreEvent() {
    return false;
  }
}

// The function itself, kept in state so the decorations can be rebuilt from any
// transaction — including ones that only changed the document.
const chipFnField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setChips)) return effect.value || null;
    return value;
  },
});

// Two kinds, decided by the range itself. A range whose text IS the path stays
// a mark over live text: that is a loop's source, where what follows the name is
// typed right next to it and the name has to stay typeable. A range carrying
// syntax around the path is drawn as the path alone, the way a chip is drawn
// everywhere else.
function chipSets(state) {
  const ranges = state.field(chipFnField);
  if (!ranges) return { deco: Decoration.none, atomic: Decoration.none };
  const doc = state.doc.toString();
  const deco = [];
  const atomic = [];
  for (const range of ranges(doc) || []) {
    const { from, to, path } = range;
    // A range that no longer fits the document is one the text moved out from
    // under; dropping it is better than throwing.
    if (!(from >= 0 && to > from && to <= doc.length)) continue;
    if (doc.slice(from, to) === path) {
      deco.push(chipMark.range(from, to));
      continue;
    }
    const replace = Decoration.replace({ widget: new ChipWidget(path) });
    deco.push(replace.range(from, to));
    atomic.push(replace.range(from, to));
  }
  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

const chipField = StateField.define({
  create: (state) => chipSets(state),
  update(value, tr) {
    if (!tr.docChanged && !tr.effects.some((effect) => effect.is(setChips))) return value;
    return chipSets(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field, (sets) => sets.deco),
});

// The facet wants a function of the view, not a set — so it can't come from
// `provide` above, which hands over the value itself.
const chipsAreAtomic = EditorView.atomicRanges.of((view) => view.state.field(chipField).atomic);

/** Ranges for a single piece of text — what a field with one chip in it wants. */
const findOne = (text) => (doc) => {
  const at = text ? doc.indexOf(text) : -1;
  return at < 0 ? [] : [{ from: at, to: at + text.length, path: text }];
};

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
  // One-line fields wrap, because there is nowhere to scroll to. A box opened to
  // read code is the other way round: wrapping breaks the indentation that says
  // what is nested in what, so it scrolls sideways instead.
  wrap = true,
  className = '',
  // What to draw as chips, either way round: `chip` is one piece of text to
  // find (a loop's source), `chipsOf` a function from the whole value to the
  // ranges (every `${…}` hole in a prop's code). `chipsOf` wins when both are
  // given. onChipClick receives the chip that was pressed — its text and where
  // it sits — so the caller can repoint that one rather than the field.
  chip = '',
  chipsOf,
  onChipClick,
  // Set to {insert} while the field is mounted, so a bind handle beside it can
  // drop a path in at the caret.
  apiRef,
  // What this field can name: the values in scope where it sits — the file's
  // props, its frontmatter consts, the item of any loop around it. Typing
  // offers them, so a name doesn't have to be remembered (or spelled) to be
  // used. Each is {label, detail?, info?}; the caller decides what is in scope,
  // since only it knows where the field is.
  completions,
}) {
  // Read through a ref: CodeMirror's extensions are built once, and the scope
  // arrives (and changes) after that — a captured array would go stale the
  // moment the frontmatter gains a const.
  const completionsRef = useRef(completions);
  completionsRef.current = completions;
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
          // Only what's in scope: a JS field with the language's own completions
          // would offer `Array`, `decodeURIComponent` and every other global,
          // which buries the six names that are actually about this page.
          autocompletion({
            override: [
              (ctx) => {
                const list = completionsRef.current;
                if (!list?.length) return null;
                // After a dot, complete the property rather than the whole path:
                // `post.` offers `data`, not `post.data`.
                const before = ctx.matchBefore(/[\w$.]*/);
                if (!before || (before.from === before.to && !ctx.explicit)) return null;
                const typed = before.text;
                const dot = typed.lastIndexOf('.');
                const prefix = dot >= 0 ? typed.slice(0, dot + 1) : '';
                const options = list
                  .filter((c) => c.label.startsWith(prefix) && c.label !== prefix)
                  .map((c) => ({
                    label: c.label.slice(prefix.length),
                    detail: c.detail || undefined,
                    info: c.info || undefined,
                    type: c.type || 'variable',
                  }));
                if (!options.length) return null;
                return { from: before.from + prefix.length, options, validFor: /^[\w$]*$/ };
              },
            ],
            icons: false,
            defaultKeymap: false,
          }),
          keymap.of(completionKeymap),
          chipFnField,
          chipField,
          chipsAreAtomic,
          appTheme,
          appHighlight,
          ...(wrap ? [EditorView.lineWrapping] : []),
          cmPlaceholder(placeholder),
          EditorView.domEventHandlers({
            mousedown: (event, view) => {
              if (!(event.target instanceof Element) || !event.target.closest('.cm-chip, .expr-chip'))
                return false;
              // The chip is a control, not text: pressing it opens the picker
              // rather than putting the caret in the middle of a name.
              event.preventDefault();
              // Which chip — a field can have several, and the picker has to
              // repoint the one that was pressed.
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              const ranges = view.state.field(chipFnField)?.(view.state.doc.toString()) || [];
              const hit = pos == null ? null : ranges.find((r) => pos >= r.from && pos <= r.to);
              onChipClickRef.current?.(hit || null);
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
      /** Swap one range for other text — repointing a chip. */
      replaceRange(from, to, text) {
        const view = viewRef.current;
        if (!view) return null;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        return view.state.doc.toString();
      },
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

  // The chips follow whatever the caller says they are. `syncValue` is in the
  // deps because an outside edit replaces the document, and the ranges are read
  // from the document.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setChips.of(chipsOf || (chip ? findOne(chip) : null)) });
  }, [chip, chipsOf, syncValue]);

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
