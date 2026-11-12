// The text the person writes to the model: a CodeMirror editor in which `@` opens a picker of the project's files and
// a choice becomes a chip, one atomic character in the text (Backspace removes it whole, undo brings it back). Enter
// sends and Shift+Enter is a new line. The chip mechanics are Desktop's (src/ui/chipEditor); what Studio adds is the
// source of the files (the project it already holds) and, since its model is one HTTP request, no commands or skills.
//
// The draft is `segments`. The editor owns the text while the person types and reports each edit through
// `onSegmentsChange`; when the draft changes from outside (sent and cleared, a starter, dictation) the editor takes
// it over without touching its undo history.
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { Annotation, Compartment, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view';
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { AI_LIMITS } from '../../../vendor/stacki/shared/properties/ai/aiLimits';
import { plainTextOf, type ComposerSegments, type MentionChip } from '../../../vendor/stacki/shared/properties/ai/mentions';
import { CHIP_PICKER_ROWS_MAX, ChipPicker, chipPickerOptionId } from '../../../vendor/stacki/src/ui/chipEditor/ChipPicker';
import { createChipEditor } from '../../../vendor/stacki/src/ui/chipEditor/chipEditor';
import { CHIP_CHARACTER } from '../../../vendor/stacki/src/ui/chipEditor/chipModel';
import { chipTrigger, pickerKeymap, type ActiveTrigger, type PickerKey } from '../../../vendor/stacki/src/ui/chipEditor/chipTrigger';
import { FileIcon } from '../../../vendor/stacki/src/ui/Icons';
import { baseName, chipCountOf, fileChip, matchFiles, MENTION_LIMIT_TEXT, sameDraft } from './mentionFiles';
import '../../../vendor/stacki/src/features/ai/mentions/mentions.css';

export interface PromptHandle {
  readonly focus: () => void;
  /** Types at the caret: `@` opens the file picker. */
  readonly insertText: (text: string) => void;
}

export interface PromptInputProps {
  readonly segments: ComposerSegments;
  readonly files: readonly string[];
  readonly placeholder: string;
  readonly inputRef: Ref<PromptHandle>;
  readonly onSegmentsChange: (segments: ComposerSegments) => void;
  readonly onSend: () => void;
}

// Marks a transaction that applies a draft the caller already holds: it is not reported back, and not undoable.
const externalDraft = Annotation.define<boolean>();
const FILE_ICON_MARKUP = renderToStaticMarkup(<FileIcon size={12} />);

const promptTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: '12.5px', maxHeight: '200px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '20px', overflowX: 'hidden' },
  '.cm-content': { minHeight: '52px', padding: '2px', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
});

interface Live {
  segments: ComposerSegments;
  emit: (segments: ComposerSegments) => void;
  onSend: () => void;
  onTrigger: (trigger: ActiveTrigger | undefined) => void;
  menuOpen: boolean;
  onMenuKey: (key: PickerKey) => boolean;
}

export function PromptInput(props: PromptInputProps) {
  const listId = useId();
  const [trigger, setTrigger] = useState<ActiveTrigger | undefined>(undefined);
  const [dismissedFrom, setDismissedFrom] = useState<number | undefined>(undefined);
  const [highlight, setHighlight] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const live = useRef<Live | undefined>(undefined);
  const attributes = useMemo(() => new Compartment(), []);
  const editor = useMemo(
    () =>
      createChipEditor<MentionChip>({
        describe: (chip) => (chip.kind === 'file' ? { label: chip.name, title: chip.path, kind: 'file' } : { label: chip.kind, kind: chip.kind }),
        decorate: (_chip, element) => element.insertAdjacentHTML('beforeend', FILE_ICON_MARKUP),
        onChipClick: (_chip, element) => {
          // A file chip has nothing to open here; a click puts the caret after it, as a click on text would.
          const view = viewRef.current;
          if (view !== undefined) {
            view.dispatch({ selection: { anchor: view.posAtDOM(element) + 1 } });
            view.focus();
          }
        },
      }),
    [],
  );

  const atLimit = chipCountOf(props.segments) >= AI_LIMITS.mentionsMax;
  const mentionOpen = trigger !== undefined && trigger.from !== dismissedFrom;
  const rows = mentionOpen && !atLimit ? matchFiles(props.files, trigger.query, CHIP_PICKER_ROWS_MAX) : [];
  const active = rows.length === 0 ? 0 : Math.min(highlight, rows.length - 1);

  const chooseFile = (path: string | undefined): boolean => {
    const view = viewRef.current;
    if (view === undefined || trigger === undefined || path === undefined || atLimit) {
      return false;
    }
    const spec = editor.insertChip(view.state, fileChip(path), { from: trigger.from, to: trigger.to });
    if (spec === undefined) {
      return false;
    }
    view.dispatch(spec);
    return true;
  };
  const onMenuKey = (key: PickerKey): boolean => {
    switch (key) {
      case 'down':
      case 'up': {
        if (rows.length === 0) {
          return false;
        }
        const step = key === 'down' ? 1 : rows.length - 1;
        setHighlight((index) => (Math.min(index, rows.length - 1) + step) % rows.length);
        return true;
      }
      case 'choose':
        return chooseFile(rows[active]);
      case 'close': {
        if (trigger !== undefined) {
          setDismissedFrom(trigger.from);
          return true;
        }
        return false;
      }
      default: {
        const exhaustive: never = key;
        return exhaustive;
      }
    }
  };
  live.current = {
    segments: props.segments,
    emit: props.onSegmentsChange,
    onSend: props.onSend,
    onTrigger: (next) => {
      setTrigger(next);
      if (next === undefined) {
        setDismissedFrom(undefined);
      }
    },
    menuOpen: mentionOpen,
    onMenuKey,
  };

  const activeDescendant = mentionOpen && rows.length > 0 ? chipPickerOptionId(listId, active) : undefined;
  const attributeExtensions = () => [
    placeholderExtension(props.placeholder),
    EditorView.contentAttributes.of({
      'aria-label': 'AI prompt',
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      ...(activeDescendant === undefined ? {} : { 'aria-activedescendant': activeDescendant }),
    }),
  ];

  // The editor is made once; everything it needs later it reads from `live`, which each render refreshes.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) {
      return undefined;
    }
    const current = (): Live => {
      assert(live.current !== undefined, 'PromptInput: the editor runs only after a render');
      return live.current;
    };
    const state = editor.createState(current().segments, [
      pickerKeymap({ isOpen: () => current().menuOpen, onKey: (key) => current().onMenuKey(key) }),
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            // An input method that is composing owns Enter.
            run: (view) => {
              if (view.compositionStarted) {
                return false;
              }
              current().onSend();
              return true;
            },
          },
          { key: 'Shift-Enter', run: insertNewline },
        ]),
      ),
      history(),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      promptTheme,
      attributes.of(attributeExtensions()),
      chipTrigger({ trigger: '@', onChange: (next) => current().onTrigger(next) }),
      // A pasted placeholder character would be a chip with no payload; the plain text around it is kept.
      EditorView.clipboardInputFilter.of((text) => text.replaceAll(CHIP_CHARACTER, '')),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalDraft) === true)) {
          current().emit(editor.readSegments(update.state));
        }
      }),
    ]);
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = undefined;
    };
    // The editor is built once per mount; props and state reach it through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [editor, attributes]);

  useImperativeHandle(
    props.inputRef,
    (): PromptHandle => ({
      focus: () => viewRef.current?.focus(),
      insertText: (text) => {
        const view = viewRef.current;
        if (view !== undefined) {
          view.focus();
          view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' });
        }
      },
    }),
    [],
  );

  // A draft that changed from outside replaces the document; one the editor itself reported is already there.
  useEffect(() => {
    const view = viewRef.current;
    if (view === undefined || sameDraft(editor.readSegments(view.state), props.segments)) {
      return;
    }
    view.dispatch(editor.replaceSegments(view.state, props.segments), { annotations: [externalDraft.of(true), Transaction.addToHistory.of(false)] });
  }, [editor, props.segments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: attributes.reconfigure(attributeExtensions()) });
    // The extension is rebuilt from these values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [attributes, props.placeholder, activeDescendant]);

  // A new query or an edited draft starts the list again from its first row.
  const query = trigger?.query;
  const plain = plainTextOf(props.segments);
  useEffect(() => setHighlight(0), [query, plain]);

  return (
    <>
      <div ref={host} className="ai-editor" />
      {mentionOpen && (
        <ChipPicker
          open
          anchor={trigger.anchor}
          candidates={rows.map((path) => ({ id: path, label: baseName(path), description: path, icon: <FileIcon size={14} /> }))}
          activeIndex={active}
          label="Mention a project file"
          listId={listId}
          emptyText={atLimit ? MENTION_LIMIT_TEXT : 'No matching files.'}
          onActiveChange={setHighlight}
          onChoose={(candidate) => {
            chooseFile(candidate.id);
          }}
          onClose={() => setDismissedFrom(trigger.from)}
        />
      )}
    </>
  );
}
