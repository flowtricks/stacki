// The text the person writes to the agent: a CodeMirror editor in which `@` opens a
// picker of the project's files, its skills and Stacki's built-in instructions, and a
// choice becomes a purple chip, one atomic character in the text (Backspace removes
// it whole, undo brings it back). The `/` menu completes the agent's advertised
// commands and skills as before. Keys: Enter sends, Shift+Enter is a new line, and
// Cmd/Ctrl+Enter asks to queue; what each means (a send while idle, a steer or a queue
// while the agent works) is the composer's to decide, so the input only reports the key
// through `onSend`.
//
// The draft is `segments` (text runs and chips, shared/properties/ai/mentions.ts). The
// editor owns the text while the person types and reports every edit through
// `onSegmentsChange`; when the draft changes from outside (sent and cleared, restored,
// dictation, "Build an app" adding its chip) the editor takes it over, without touching
// its undo history. Older callers that hold the draft as a string pass `value` and
// `onChange` instead and see the plain text.
//
// Why CodeMirror and not a textarea: chips inside the text need atomic ranges, undo,
// IME and selection that work on one document; the chip mechanics are src/ui/chipEditor.
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { Annotation, Compartment, Prec, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view';
import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert } from '../../../../shared/core/assert';
import { AGENTS, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { ChatCommand } from '../../../../shared/properties/ai/chatModel';
import { plainTextOf, type ComposerSegments, type MentionChip } from '../../../../shared/properties/ai/mentions';
import { ChipPicker, chipPickerOptionId } from '../../../ui/chipEditor/ChipPicker';
import { createChipEditor } from '../../../ui/chipEditor/chipEditor';
import { CHIP_CHARACTER } from '../../../ui/chipEditor/chipModel';
import { chipTrigger, pickerKeymap, type ActiveTrigger, type PickerKey } from '../../../ui/chipEditor/chipTrigger';
import { FileIcon, InstructionsIcon, SkillIcon } from '../../../ui/Icons';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { mentionCandidates } from '../aiStore';
import { COPIED_LABEL_MS, copyBuiltinChip } from '../mentions/builtinChips';
import { chipCountOf, chipFromDrag, chipLook, isFileDrag, segmentsEqual, textSegments, type PickerRow } from '../mentions/mentionChips';
import { useMentionRows, type MentionSearch } from '../mentions/useMentionRows';
import '../mentions/mentions.css';

const COMMANDS_SHOWN_MAX = 8;

/** Which send key was pressed: plain Enter, or Enter with Cmd or Ctrl (queue). */
export type SendKey = 'send' | 'queue';

/** What a caller can ask of the input from outside. A textarea's `focus` fits, so older callers' refs still work. */
export interface ComposerFocus {
  readonly focus: () => void;
}

/** The focus handle plus the edits the composer's menus make: `insertText('@')` opens the file picker, `insertText('/')` the command menu. */
export interface ComposerHandle extends ComposerFocus {
  readonly insertText: (text: string) => void;
}

export interface ComposerInputProps {
  readonly agent: AgentId;
  /** The commands and skills the agent advertised; the menu offers those that match a draft beginning with `/`. */
  readonly commands: readonly ChatCommand[];
  readonly placeholder: string;
  /** Filled with a `ComposerHandle` while mounted (typed as its `focus` part so a ref made for a textarea is accepted). */
  readonly inputRef: Ref<ComposerFocus>;
  readonly onSend: (key: SendKey) => void;
  /** The draft with its chips. Pair with `onSegmentsChange`. */
  readonly segments?: ComposerSegments;
  readonly onSegmentsChange?: (segments: ComposerSegments) => void;
  /** The draft as plain text, for a caller with no chips. Pair with `onChange`. */
  readonly value?: string;
  readonly onChange?: (text: string) => void;
  /** Where `@` looks for files and skills; the store's `mentionCandidates` unless a test says otherwise. */
  readonly searchMentions?: MentionSearch;
}

// Marks a transaction that applies a draft the caller already holds: it is not reported back, and not undoable.
const externalDraft = Annotation.define<boolean>();

type ChipKind = MentionChip['kind'];
const iconMarkup = new Map<ChipKind, string>();

/** The 12px icon of a chip kind as static markup, drawn once per kind. */
function chipIconMarkup(kind: ChipKind): string {
  const cached = iconMarkup.get(kind);
  if (cached !== undefined) {
    return cached;
  }
  const icon = kind === 'file' ? <FileIcon size={12} /> : kind === 'skill' ? <SkillIcon size={12} /> : <InstructionsIcon size={12} />;
  const markup = renderToStaticMarkup(icon);
  iconMarkup.set(kind, markup);
  return markup;
}

const copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Shows "Copied" on a drawn pill for a moment; the pill belongs to the editor, so this changes its DOM directly. */
function flashCopied(element: HTMLElement, copiedText: string): void {
  const label = element.querySelector('.chip-editor-chip-label');
  if (label === null) {
    return;
  }
  const earlier = copiedTimers.get(element);
  if (earlier !== undefined) {
    clearTimeout(earlier);
  } else {
    element.dataset['label'] = label.textContent ?? '';
  }
  label.textContent = copiedText;
  element.classList.add('is-copied');
  copiedTimers.set(
    element,
    setTimeout(() => {
      label.textContent = element.dataset['label'] ?? '';
      element.classList.remove('is-copied');
      copiedTimers.delete(element);
    }, COPIED_LABEL_MS),
  );
}

const composerTheme = EditorView.theme({
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
  onSend: (key: SendKey) => void;
  onTrigger: (trigger: ActiveTrigger | undefined) => void;
  menuOpen: boolean;
  onMenuKey: (key: PickerKey) => boolean;
}

export function ComposerInput(props: ComposerInputProps) {
  assert(props.segments !== undefined || props.value !== undefined, 'ComposerInput: the draft comes as segments or as a string');
  const segments = props.segments ?? textSegments(props.value ?? '');
  const search = props.searchMentions ?? mentionCandidates;
  const translate = useTranslate();
  // The editor is built once; its chip callbacks read the language that is current when they run.
  const translateLatest = useRef(translate);
  translateLatest.current = translate;
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
        describe: (chip) => chipLook(chip, translateLatest.current),
        decorate: (chip, element) => {
          element.insertAdjacentHTML('beforeend', chipIconMarkup(chip.kind));
          if (chip.kind === 'builtin') {
            element.setAttribute('aria-live', 'polite');
          }
        },
        onChipClick: (chip, element) => {
          if (chip.kind === 'builtin') {
            void copyBuiltinChip(chip.id).then((done) => {
              if (done) {
                flashCopied(element, translateLatest.current('ai.common.copied'));
              }
            });
            return;
          }
          // A file or skill chip has nothing to copy; a click puts the caret after it, as a click on text would.
          const view = viewRef.current;
          if (view !== undefined) {
            view.dispatch({ selection: { anchor: view.posAtDOM(element) + 1 } });
            view.focus();
          }
        },
      }),
    [],
  );

  // What the menus below show, derived from the draft and the picker state on every render.
  const plain = plainTextOf(segments);
  const matches = chipCountOf(segments) === 0 ? matchingCommands(props.commands, plain) : [];
  const mentionOpen = trigger !== undefined && trigger.from !== dismissedFrom;
  const commandsOpen = !mentionOpen && matches.length > 0;
  const atMentionLimit = chipCountOf(segments) >= AI_LIMITS.mentionsMax;
  const found = useMentionRows(mentionOpen && !atMentionLimit ? trigger.query : undefined, search);
  const rows = found.rows;
  const rowCount = mentionOpen ? rows.length : matches.length;
  const active = rowCount === 0 ? 0 : Math.min(highlight, rowCount - 1);
  const activeRow = mentionOpen ? rows[active] : undefined;

  const chooseRow = (row: PickerRow): boolean => {
    const view = viewRef.current;
    if (view === undefined || trigger === undefined) {
      return false;
    }
    const spec = editor.insertChip(view.state, row.chip, { from: trigger.from, to: trigger.to });
    if (spec === undefined || chipCountOf(segments) >= AI_LIMITS.mentionsMax) {
      return false;
    }
    view.dispatch(spec);
    return true;
  };
  const chooseCommand = (command: ChatCommand): void => {
    const view = viewRef.current;
    if (view !== undefined) {
      view.dispatch(editor.replaceSegments(view.state, textSegments(`/${command.name} `)));
    }
    setHighlight(0);
  };
  const onMenuKey = (key: PickerKey): boolean => {
    switch (key) {
      case 'down':
      case 'up': {
        if (rowCount === 0) {
          return false;
        }
        const step = key === 'down' ? 1 : rowCount - 1;
        setHighlight((index) => (Math.min(index, rowCount - 1) + step) % rowCount);
        return true;
      }
      case 'choose': {
        if (mentionOpen) {
          return activeRow !== undefined && chooseRow(activeRow);
        }
        const command = matches[active];
        if (command === undefined) {
          return false;
        }
        chooseCommand(command);
        return true;
      }
      case 'close': {
        if (mentionOpen && trigger !== undefined) {
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
    segments,
    emit: (next) => {
      if (props.onSegmentsChange !== undefined) {
        props.onSegmentsChange(next);
      } else {
        props.onChange?.(plainTextOf(next));
      }
    },
    onSend: props.onSend,
    onTrigger: (next) => {
      setTrigger(next);
      if (next === undefined) {
        setDismissedFrom(undefined);
      }
    },
    menuOpen: mentionOpen || commandsOpen,
    onMenuKey,
  };

  const label = translate('ai.composer.messageLabel', { agent: AGENTS[props.agent].label });
  const activeDescendant = mentionOpen && activeRow !== undefined ? chipPickerOptionId(listId, active) : undefined;
  const attributeExtensions = (): Extension => [
    placeholderExtension(props.placeholder),
    EditorView.contentAttributes.of({
      'aria-label': label,
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
      assert(live.current !== undefined, 'ComposerInput: the editor runs only after a render');
      return live.current;
    };
    const sendKey =
      (key: SendKey) =>
      (view: EditorView): boolean => {
        // An input method that is composing owns Enter (from the first key of the composition, not only after its first edit).
        if (view.compositionStarted) {
          return false;
        }
        current().onSend(key);
        return true;
      };
    const state = editor.createState(current().segments, [
      pickerKeymap({ isOpen: () => current().menuOpen, onKey: (key) => current().onMenuKey(key) }),
      Prec.highest(
        keymap.of([
          { key: 'Enter', run: sendKey('send') },
          { key: 'Mod-Enter', run: sendKey('queue') }, // i18n-ignore: a CodeMirror key binding, not text.
          { key: 'Ctrl-Enter', run: sendKey('queue') }, // i18n-ignore: a CodeMirror key binding, not text.
          { key: 'Meta-Enter', run: sendKey('queue') }, // i18n-ignore: a CodeMirror key binding, not text.
          { key: 'Shift-Enter', run: insertNewline }, // i18n-ignore: a CodeMirror key binding, not text.
        ]),
      ),
      history(),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      composerTheme,
      attributes.of(attributeExtensions()),
      chipTrigger({ trigger: '@', onChange: (next) => current().onTrigger(next) }),
      // A pasted placeholder character would be a chip with no payload; the plain text around it is kept.
      EditorView.clipboardInputFilter.of((text) => text.replaceAll(CHIP_CHARACTER, '')),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalDraft) === true)) {
          current().emit(editor.readSegments(update.state));
        }
      }),
      EditorView.domEventHandlers({
        dragover: (event) => event.dataTransfer !== null && isFileDrag(event.dataTransfer.types),
        drop: (event, view) => {
          const chip = event.dataTransfer === null ? undefined : chipFromDrag(event.dataTransfer);
          if (chip === undefined) {
            return false;
          }
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.doc.length;
          const spec = editor.chipCount(view.state) < AI_LIMITS.mentionsMax ? editor.insertChip(view.state, chip, { from: position, to: position }) : undefined;
          if (spec !== undefined) {
            view.dispatch(spec);
          }
          return true;
        },
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
    (): ComposerHandle => ({
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
    if (view === undefined || segmentsEqual(editor.readSegments(view.state), segments)) {
      return;
    }
    view.dispatch(editor.replaceSegments(view.state, segments), { annotations: [externalDraft.of(true), Transaction.addToHistory.of(false)] });
  }, [editor, segments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: attributes.reconfigure(attributeExtensions()) });
    // The extension is rebuilt from these values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [attributes, props.placeholder, label, activeDescendant]);

  useEffect(() => setHighlight(0), [trigger?.query, plain]);

  return (
    <>
      {commandsOpen && (
        <div className="ai-commands" role="listbox" aria-label={translate('ai.composer.commands')}>
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? 'on' : ''}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                chooseCommand(command);
              }}
            >
              <span className="ai-command-name">/{command.name}</span>
              <span className="ai-command-description">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <div ref={host} className="ai-editor" />
      {mentionOpen && (
        <ChipPicker
          open
          anchor={trigger.anchor}
          candidates={rows.map((row) => pickerCandidate(row))}
          activeIndex={active}
          label={translate('ai.composer.mention.label')}
          listId={listId}
          emptyText={emptyTextFor({ atLimit: atMentionLimit, state: found.state, translate })}
          onActiveChange={setHighlight}
          onChoose={(candidate) => {
            const row = rows.find((entry) => entry.id === candidate.id);
            if (row !== undefined) {
              chooseRow(row);
            }
          }}
          onClose={() => setDismissedFrom(trigger.from)}
        />
      )}
    </>
  );
}

function pickerCandidate(row: PickerRow) {
  return {
    id: row.id,
    label: row.label,
    group: row.group,
    icon: row.chip.kind === 'file' ? <FileIcon size={14} /> : row.chip.kind === 'skill' ? <SkillIcon size={14} /> : <InstructionsIcon size={14} />,
    ...(row.description === undefined ? {} : { description: row.description }),
  };
}

function emptyTextFor({
  atLimit,
  state,
  translate,
}: {
  readonly atLimit: boolean;
  readonly state: 'searching' | 'ready' | 'failed';
  readonly translate: Translator;
}): string {
  if (atLimit) {
    return translate('ai.composer.mention.limit', { count: AI_LIMITS.mentionsMax });
  }
  switch (state) {
    case 'searching':
      return translate('ai.composer.mention.searching');
    case 'failed':
      return translate('ai.composer.mention.failed');
    case 'ready':
      return translate('ai.composer.mention.none');
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The commands a draft that starts with `/` and has no space yet matches, by name. */
export function matchingCommands(commands: readonly ChatCommand[], text: string): readonly ChatCommand[] {
  if (!text.startsWith('/') || /\s/.test(text)) {
    return [];
  }
  const query = text.slice(1).toLowerCase();
  const matches = commands.filter((command) => command.name.toLowerCase().includes(query));
  matches.sort((left, right) => Number(!left.name.toLowerCase().startsWith(query)) - Number(!right.name.toLowerCase().startsWith(query)));
  assert(matches.length <= commands.length, 'matchingCommands: a subset');
  return matches.slice(0, COMMANDS_SHOWN_MAX);
}

// Repeated here so a segment-equality helper import is not needed in tests of the model alone.
export { segmentsEqual };
