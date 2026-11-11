import { useCodeAccess, ManagedValue } from './CodeAccess';
import React, { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, drawSelection, placeholder as cmPlaceholder, Decoration, WidgetType } from '@codemirror/view';
import type { MutableRefObject } from 'react';
import type { DecorationSet, KeyBinding } from '@codemirror/view';
import type { Extension, Range } from '@codemirror/state';
import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import type { TemplateHole } from '../editor/bindings';
import { assert } from '../../shared/core/assert';
import { codeIndentExtensions, codeIndentSettings } from './codeEditorIndent';
import { editCodeView, openCodeView, sourceCodeView, type CodeView } from './codeIndentView';
import { codeLineClassifier } from './codeLineRoles';
import { LIMITS } from '../../shared/core/limits';
import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { appTheme, appHighlight } from './CodeEditor';

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
export type ChipsOf = (text: string) => readonly TemplateHole[] | undefined;
const setChips = StateEffect.define<ChipsOf | undefined>();

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
  constructor(private readonly label: string) {
    super();
  }
  override eq(other: ChipWidget) {
    return other.label === this.label;
  }
  override toDOM() {
    const span = document.createElement('span');
    span.className = 'expr-chip';
    span.textContent = this.label;
    return span;
  }
  // The press has to reach the editor's own handler, which is what opens the
  // picker.
  override ignoreEvent() {
    return false;
  }
}

// The function itself, kept in state so the decorations can be rebuilt from any
// transaction — including ones that only changed the document.
const chipsOfField = StateField.define<ChipsOf | undefined>({
  create: () => undefined,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setChips)) {
        return effect.value || undefined;
      }
    }
    return value;
  },
});

// Two kinds, decided by the range itself. A range whose text IS the path stays
// a mark over live text: that is a loop's source, where what follows the name is
// typed right next to it and the name has to stay typeable. A range carrying
// syntax around the path is drawn as the path alone, the way a chip is drawn
// everywhere else.
function chipSets(state: EditorState): {
  readonly deco: DecorationSet;
  readonly atomic: DecorationSet;
} {
  const ranges = state.field(chipsOfField);
  if (!ranges) {
    return { deco: Decoration.none, atomic: Decoration.none };
  }
  const document = state.doc.toString();
  const deco: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const chips = ranges(document) || [];
  assert(chips.length <= LIMITS.treeNodesMax, 'ExprInput: chip limit exceeded');
  for (const range of chips) {
    const { from, to, path } = range;
    // A range that no longer fits the document is one the text moved out from
    // under; dropping it is better than throwing.
    if (!(from >= 0 && to > from && to <= document.length)) {
      continue;
    }
    if (document.slice(from, to) === path) {
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
    if (!tr.docChanged && !tr.effects.some((effect) => effect.is(setChips))) {
      return value;
    }
    return chipSets(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field, (sets) => sets.deco),
});

// The facet wants a function of the view, not a set — so it can't come from
// `provide` above, which hands over the value itself.
const chipsAreAtomic = EditorView.atomicRanges.of((view) => view.state.field(chipField).atomic);

/** Ranges for a single piece of text — what a field with one chip in it wants. */
const findOne =
  (text: string): ChipsOf =>
  (document) => {
    const at = text ? document.indexOf(text) : -1;
    return at < 0 ? [] : [{ from: at, to: at + text.length, path: text }];
  };

// A field that holds JavaScript — highlighted, but shaped like an input:
// it grows with its content and Enter commits instead of adding a line.
//
// Uncontrolled after mount (like StyleEditor): the parent may reformat what
// it stores, and feeding that back would fight every keystroke. External
// changes are applied through `syncValue`, which only replaces the document
// when the text genuinely differs from what's on screen.
export interface ExprInputAPI {
  readonly replaceRange: (from: number, to: number, text: string) => string | undefined;
  readonly insert: (text: string) => string | undefined;
}
export interface ExprInputProps {
  readonly value?: string | undefined;
  readonly onChange?: ((text: string) => void) | undefined;
  readonly onCommit?: ((text: string) => void) | undefined;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly syncValue?: string | undefined;
  readonly invalid?: boolean;
  readonly multiline?: boolean;
  readonly wrap?: boolean;
  readonly className?: string;
  readonly chip?: string;
  readonly chipsOf?: ChipsOf | undefined;
  readonly onChipClick?: (range: TemplateHole | undefined) => void;
  readonly apiRef?: MutableRefObject<ExprInputAPI | undefined>;
  readonly completions?: readonly Completion[];
  /** What the text is written in: an expression by default, a TypeScript type, or a line of markup. */
  readonly language?: 'html' | 'javascript' | 'typescript';
  /**
   * A language of the caller's own in place of `language`, for text this
   * module does not know: a style attribute's declarations (StyleEditor.tsx).
   */
  readonly syntax?: Extension | undefined;
  /** The field's accessible name, for a field no <label> wraps. */
  readonly ariaLabel?: string;
}
interface ExprRefs {
  readonly latest: MutableRefObject<ExprInputProps>;
  readonly view: MutableRefObject<EditorView | undefined>;
  readonly touched: MutableRefObject<boolean>;
  readonly codeView: MutableRefObject<CodeView>;
}

export default function ExprInput(props: ExprInputProps) {
  return useCodeAccess() ? <EditableExprInput {...props} /> : <ManagedValue />;
}
function EditableExprInput(props: ExprInputProps) {
  const { syncValue, chip = '', chipsOf, invalid, className = '' } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const touched = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [initial] = useState(() => props);
  const codeView = useRef(exprCodeView(initial, initial.value ?? ''));
  useEffect(() => {
    const parent = hostRef.current;
    assert(parent !== null, 'ExprInput: mounted host exists');
    assert(view.current === undefined, 'ExprInput: only one editor owns the host');
    const editor = exprCreate(parent, initial, { latest, view, touched, codeView });
    view.current = editor;
    if (initial.autoFocus) {
      editor.focus();
    }
    return () => {
      editor.destroy();
      view.current = undefined;
    };
  }, [initial]);
  useExprAPI(props.apiRef, { latest, view, touched, codeView });
  // External edits replace the document, so they also invalidate chip ranges.
  useEffect(() => {
    view.current?.dispatch({ effects: setChips.of(chipsOf || (chip ? findOne(chip) : undefined)) });
  }, [chip, chipsOf, syncValue]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || syncValue === undefined) {
      return;
    }
    if (syncValue !== codeView.current.source) {
      codeView.current = exprCodeView(initial, syncValue);
      // A value arriving from outside is not an edit made here: kept off the
      // field's undo stack, so ⌘Z never undoes it back to a stale value.
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: codeView.current.text }, annotations: Transaction.addToHistory.of(false) });
    }
  }, [initial, syncValue]);
  return <div ref={hostRef} className={`expr-input ${invalid ? 'invalid' : ''} ${className}`} />;
}

// A multi-line field shows its indentation as tabs, as every code editor does.
// A field with chips or an API is the exception: their offsets are offsets into
// the value, so that field's document has to be the value byte for byte.
function exprCodeView(initial: ExprInputProps, value: string): CodeView {
  const plain = !initial.multiline || initial.chip !== undefined || initial.chipsOf !== undefined || initial.apiRef !== undefined;
  return plain ? sourceCodeView(value) : openCodeView(value, { extent: 'document', classify: codeLineClassifier(initial.language) });
}

function exprCreate(parent: HTMLElement, initial: ExprInputProps, refs: ExprRefs): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: refs.codeView.current.text,
      extensions: [
        history(),
        drawSelection(),
        // A one-line field is shaped like an input, so Tab leaves it as Tab leaves one.
        initial.multiline ? codeIndentExtensions() : codeIndentSettings(),
        keymap.of(exprKeys(initial, refs)),
        initial.syntax ?? (initial.language === 'html' ? html() : javascript({ typescript: initial.language === 'typescript' })),
        ...(initial.ariaLabel === undefined ? [] : [EditorView.contentAttributes.of({ 'aria-label': initial.ariaLabel })]),
        // Scope is read at request time: frontmatter can change while this editor stays mounted.
        autocompletion({
          override: [(context) => exprCompletionSource(context, refs.latest.current)],
          icons: false,
          defaultKeymap: false,
        }),
        keymap.of(completionKeymap),
        chipsOfField,
        chipField,
        chipsAreAtomic,
        appTheme,
        appHighlight,
        ...((initial.wrap ?? true) ? [EditorView.lineWrapping] : []),
        cmPlaceholder(initial.placeholder ?? ''),
        exprEvents(refs),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const codeViewRef = refs.codeView;
            codeViewRef.current = editCodeView(codeViewRef.current, update.state.doc.toString());
            refs.latest.current.onChange?.(codeViewRef.current.source);
          }
        }),
      ],
    }),
  });
}

function exprKeys(initial: ExprInputProps, refs: ExprRefs): readonly KeyBinding[] {
  if (initial.multiline) {
    return [...defaultKeymap, ...historyKeymap];
  }
  return [
    {
      key: 'Enter',
      run: () => {
        refs.latest.current.onCommit?.(refs.view.current?.state.doc.toString() ?? '');
        return true;
      },
    },
    ...defaultKeymap.filter((binding) => binding.key !== 'Enter'),
    ...historyKeymap,
  ];
}

// CodeMirror's side of the completions: it reads null, not undefined, as "none".
function exprCompletionSource(context: CompletionContext, props: ExprInputProps) {
  // eslint-disable-next-line stacki/no-null -- CodeMirror reads null as "no completions".
  return exprCompletions(context, props) ?? null;
}

function exprCompletions(context: CompletionContext, props: ExprInputProps) {
  const list = props.completions;
  if (!list?.length) {
    return undefined;
  }
  assert(list.length <= LIMITS.treeNodesMax, 'ExprInput: completion limit exceeded');
  const before = context.matchBefore(/[\w$.]*/);
  if (!before || (before.from === before.to && !context.explicit)) {
    return undefined;
  }
  const dot = before.text.lastIndexOf('.');
  const prefix = dot >= 0 ? before.text.slice(0, dot + 1) : '';
  // After a dot, offer the property rather than repeating the complete path.
  const options = list
    .filter((entry) => entry.label.startsWith(prefix) && entry.label !== prefix)
    .map((entry) => ({
      label: entry.label.slice(prefix.length),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.info ? { info: entry.info } : {}),
      type: entry.type || 'variable',
    }));
  if (!options.length) {
    return undefined;
  }
  return { from: before.from + prefix.length, options, validFor: /^[\w$]*$/ };
}

// The document position of a chip's element, or undefined when it is not in the document.
function chipPosition(view: EditorView, chip: Element): number | undefined {
  try {
    return view.posAtDOM(chip);
  } catch (error: unknown) {
    // posAtDOM throws for a node outside the editor's content: the pointer decides then.
    void error;
    return undefined;
  }
}

function exprEvents(refs: ExprRefs): Extension {
  const touchedRef = refs.touched;
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      const ElementType = view.dom.ownerDocument.defaultView?.Element;
      if (!ElementType || !(event.target instanceof ElementType)) {
        return false;
      }
      const chip = event.target.closest('.cm-chip, .expr-chip');
      if (!chip) {
        return false;
      }
      event.preventDefault();
      // Where the chip sits in the document, read from the chip itself, so the
      // press finds it whatever the layout; the pointer's place is the fallback.
      const position = chipPosition(view, chip) ?? view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined;
      const ranges = view.state.field(chipsOfField)?.(view.state.doc.toString()) || [];
      assert(ranges.length <= LIMITS.treeNodesMax, 'ExprInput: chip limit exceeded');
      const hit = position === undefined ? undefined : ranges.find((range) => position >= range.from && position <= range.to);
      refs.latest.current.onChipClick?.(hit || undefined);
      return true;
    },
    focus: () => {
      touchedRef.current = true;
      return false;
    },
    blur: () => {
      refs.latest.current.onCommit?.(refs.codeView.current.source);
      return false;
    },
  });
}

function useExprAPI(apiRef: ExprInputProps['apiRef'], refs: ExprRefs): void {
  useEffect(() => {
    if (!apiRef) {
      return;
    }
    apiRef.current = {
      replaceRange: (from, to, text) => exprReplace(refs.view.current, from, to, text),
      insert: (text) => {
        const view = refs.view.current;
        if (!view) {
          return undefined;
        }
        const end = view.state.doc.length;
        const { from, to } = refs.touched.current ? view.state.selection.main : { from: end, to: end };
        const value = exprReplace(view, from, to, text);
        view.focus();
        return value;
      },
    };
    return () => {
      apiRef.current = undefined;
    };
  });
}

function exprReplace(view: EditorView | undefined, from: number, to: number, text: string): string | undefined {
  if (!view) {
    return undefined;
  }
  assert(Number.isSafeInteger(from), 'ExprInput: range start is an integer');
  assert(Number.isSafeInteger(to), 'ExprInput: range end is an integer');
  assert(from >= 0, 'ExprInput: range starts inside the document');
  assert(to >= from, 'ExprInput: range is ordered');
  assert(to <= view.state.doc.length, 'ExprInput: range ends inside the document');
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  return view.state.doc.toString();
}
