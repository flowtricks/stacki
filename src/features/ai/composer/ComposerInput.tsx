// The text the person writes to the agent: a CodeMirror editor in which `@` opens a
// picker of the project's files, its skills and Stacki's built-in instructions, and a
// choice becomes a purple chip, one atomic character in the text (Backspace removes
// it whole, undo brings it back). The `/` menu (SlashMenu.tsx) completes Stacki's
// commands, the active agent's skills read from disk, and the agent's advertised
// commands. Keys: Enter sends, Shift+Enter is a new line, and
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
import { defaultKeymap, history, historyKeymap, insertNewline, isolateHistory } from '@codemirror/commands';
import { Annotation, Compartment, Prec, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view';
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert } from '../../../../shared/core/assert';
import { AGENTS, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { ChatCommand } from '../../../../shared/properties/ai/chatModel';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import {
  isReferenceChip,
  plainTextOf,
  REFERENCE_CHIPS_MAX,
  type ComponentMemberChip,
  type ComposerSegments,
  type MentionChip,
} from '../../../../shared/properties/ai/mentions';
import { ChipPicker, chipPickerOptionId } from '../../../ui/chipEditor/ChipPicker';
import { createChipEditor } from '../../../ui/chipEditor/chipEditor';
import { dictationDraftExtension, NO_DRAFT, showDictationDraft, type DictationDraft } from './dictationDraft';
import { CHIP_CHARACTER } from '../../../ui/chipEditor/chipModel';
import { chipTrigger, pickerKeymap, type ActiveTrigger, type PickerKey } from '../../../ui/chipEditor/chipTrigger';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { mentionCandidates, useAiState } from '../aiStore';
import { COPIED_LABEL_MS, copyBuiltinChip } from '../mentions/builtinChips';
import { ComponentMembersPopover, MemberValuePopover } from '../mentions/ComponentMembersPopover';
import {
  chipProblemText,
  memberRun,
  mentionScope,
  orphanMembers,
  placedChips,
  planMemberEdit,
  segmentsBefore,
  useMentionComponents,
  type MemberWish,
} from '../mentions/componentMentions';
import { MENTION_TABS, mentionRows, readMentionIndex, refreshMentionIndex, relatedItems, type MentionTab } from '../mentions/projectMentions';
import { RelatedCssPopover } from '../mentions/RelatedCssPopover';
import { MentionRowIcon } from '../mentions/MentionRowIcon';
import { useChipCard, type ChipCard } from '../mentions/useChipCard';
import type { ChipSubject } from '../mentions/ChipValue';
import { chipReadableText } from '../../../../shared/properties/ai/sentMessage';
import {
  chipCountOf,
  chipFits,
  chipFromDrag,
  chipsEqual,
  chipLook,
  chipStyleOf,
  CHIP_STYLE_ICONS,
  type ChipStyle,
  hostChipCountOf,
  isFileDrag,
  segmentsEqual,
  textSegments,
  type PickerRow,
} from '../mentions/mentionChips';
import { useMentionRows, type MentionSearch } from '../mentions/useMentionRows';
import '../mentions/mentions.css';
import { SlashMenu } from './SlashMenu';
import { joinAtCaret, splitAtCaret } from './caretSegments';
import { skillsForAgent, slashQueryOf, slashRowName, slashRows, type SlashRow } from './slashRows';
import { useSlashSkills } from './useSlashSkills';

/** Which send key was pressed: plain Enter, or Enter with Cmd or Ctrl (queue). */
export type SendKey = 'send' | 'queue';

export interface CaretMemory {
  readonly read: () => number | undefined;
  readonly write: (caret: number) => void;
}

/** What a caller can ask of the input from outside. A textarea's `focus` fits, so older callers' refs still work. */
export interface ComposerFocus {
  readonly focus: () => void;
}

/** The focus handle plus the edits the composer's menus make: `insertText('@')` opens the file picker, `insertText('/')` the command menu. */
export interface ComposerHandle extends ComposerFocus {
  readonly insertText: (text: string) => void;
  /** The caret's place in the draft, a chip counting as one character. */
  readonly caret: () => number | undefined;
  /** The draft up to the caret. */
  readonly beforeCaret: () => ComposerSegments;
  /** Rewrites the draft up to the caret, as one edit the draft's owner hears; the caret ends after what was written. */
  readonly editBeforeCaret: (change: (before: ComposerSegments) => ComposerSegments) => void;
}

export interface ComposerInputProps {
  readonly agent: AgentId;
  /** The commands and skills the agent advertised; the menu offers those that match a draft beginning with `/`. */
  readonly commands: readonly ChatCommand[];
  readonly placeholder: string;
  /** Filled with a `ComposerHandle` while mounted (typed as its `focus` part so a ref made for a textarea is accepted). */
  readonly inputRef: Ref<ComposerFocus>;
  readonly onSend: (key: SendKey) => void;
  /** Where the caret was when this draft's box last closed, put back as it opens; and where it is as it closes. */
  readonly caretMemory?: CaretMemory | undefined;
  /** The words being dictated, drawn after the text as a draft that is not part of it (dictationDraft.ts). */
  readonly dictationDraft?: DictationDraft | undefined;
  /** The draft with its chips. Pair with `onSegmentsChange`. */
  readonly segments?: ComposerSegments;
  readonly onSegmentsChange?: (segments: ComposerSegments) => void;
  /** The draft as plain text, for a caller with no chips. Pair with `onChange`. */
  readonly value?: string;
  readonly onChange?: (text: string) => void;
  /** Where `@` looks for files and skills; the store's `mentionCandidates` unless a test says otherwise. */
  readonly searchMentions?: MentionSearch;
  /**
   * Runs a chosen command the caller answers itself (Stacki's `/clear`, builtinCommands.ts); true when it
   * did, and the command's text is then not put in the box. Without it every command is completed as text.
   */
  readonly onCommand?: (command: ChatCommand) => boolean;
}

/** The filter tab the picker opens on: the last one used, for the session. */
let lastMentionTab: MentionTab = 'all';

/** Each filter tab's label: the group headings, reused. */
const MENTION_TAB_LABELS = {
  all: 'ai.mention.tabs.all',
  components: 'ai.mention.group.component',
  layouts: 'ai.mention.group.layout',
  pages: 'ai.mention.group.page',
  variables: 'ai.mention.tabs.variables',
  classes: 'ai.mention.group.class',
  assets: 'ai.mention.tabs.assets',
  files: 'ai.mention.group.file',
  other: 'ai.mention.tabs.other',
} as const satisfies Record<MentionTab, MessageKey>;

// Marks a transaction that applies a draft the caller already holds: it is not reported back, and not undoable.
const externalDraft = Annotation.define<boolean>();

const iconMarkup = new Map<ChipStyle, string>();

/** The icon of a chip's look (mentionChips.ts, CHIP_STYLE_ICONS), at the size the pill (12) or the picker (16) draws it. */
function chipStyleIcon(style: ChipStyle, size: number) {
  const Icon = CHIP_STYLE_ICONS[style];
  return <Icon size={size} />;
}

/** The 12px icon of a chip's look as static markup, drawn once per look. */
function chipIconMarkup(style: ChipStyle): string {
  const cached = iconMarkup.get(style);
  if (cached !== undefined) {
    return cached;
  }
  const markup = renderToStaticMarkup(chipStyleIcon(style, 12));
  iconMarkup.set(style, markup);
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
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' }, // physical: CodeMirror draws its caret as a left border
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
  const projectPath = useAiState().projectPath;
  const [slashDismissed, setSlashDismissed] = useState<string | undefined>(undefined);
  const translate = useTranslate();
  // The editor is built once; its chip callbacks read the language that is current when they run.
  const translateLatest = useRef(translate);
  translateLatest.current = translate;
  // The card of the chip under the pointer or the keyboard; the pills are the editor's own elements, so they reach it through a ref.
  const card = useChipCard();
  const cardLatest = useRef(card);
  cardLatest.current = card;
  // The project's components, read the same way: a chip whose component is gone is drawn invalid.
  const components = useMentionComponents();
  const componentsLatest = useRef(components);
  componentsLatest.current = components;
  const listId = useId();
  const [trigger, setTrigger] = useState<ActiveTrigger | undefined>(undefined);
  // The component chip whose popover is open: where its placeholder is, its path, and where the pill was drawn.
  const [membersOpen, setMembersOpen] = useState<
    | {
        readonly from: number;
        readonly path: string;
        readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
      }
    | undefined
  >(undefined);
  // The member chip whose own popover is open: where its placeholder is, the chip, and where the pill was drawn.
  const [memberOpen, setMemberOpen] = useState<
    | {
        readonly from: number;
        readonly chip: ComponentMemberChip;
        readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
      }
    | undefined
  >(undefined);
  // The CSS chip whose swap list is open: where its placeholder is, the chip, and where the pill was drawn.
  const [cssOpen, setCssOpen] = useState<
    | {
        readonly from: number;
        readonly chip: Extract<MentionChip, { readonly kind: 'css' }>;
        readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
      }
    | undefined
  >(undefined);
  const [dismissedFrom, setDismissedFrom] = useState<number | undefined>(undefined);
  // Undefined: the default row, the first (the best match in the mention picker, which lists the best first).
  const [highlight, setHighlight] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<MentionTab>(() => lastMentionTab);
  const host = useRef<HTMLDivElement>(null);
  const caretLatest = useRef(props.caretMemory);
  caretLatest.current = props.caretMemory;
  const viewRef = useRef<EditorView | undefined>(undefined);
  const live = useRef<Live | undefined>(undefined);
  const attributes = useMemo(() => new Compartment(), []);
  const editor = useMemo(
    () =>
      createChipEditor<MentionChip>({
        describe: (chip) => ({
          ...chipLook(chip, translateLatest.current, chipProblemText(chip, componentsLatest.current, translateLatest.current)),
          hover: 'card',
        }),
        // A cut or copied chip leaves the box as the words it stands for; selected code as its place and the code.
        copyText: chipReadableText,
        // A prop, value or slot chip means nothing without its component: deleting the component chip deletes them too.
        orphans: orphanMembers,
        decorate: (chip, element) => {
          element.insertAdjacentHTML('beforeend', chipIconMarkup(chipStyleOf(chip)));
          chipCardEvents(
            element,
            chip,
            () => cardLatest.current,
            () => ({
              chip,
              problem: chipProblemText(chip, componentsLatest.current, translateLatest.current),
            }),
          );
          if (chip.kind === 'builtin') {
            element.setAttribute('aria-live', 'polite');
          }
        },
        onChipClick: (chip, element) => {
          // What a click opens takes the card's place.
          cardLatest.current.close();
          if (chip.kind === 'builtin') {
            void copyBuiltinChip(chip.id).then((done) => {
              if (done) {
                flashCopied(element, translateLatest.current('ai.common.copied'));
              }
            });
            return;
          }
          const view = viewRef.current;
          // A component chip that still matches the project opens its props and slots; an invalid one has nothing to offer.
          if (view !== undefined && chip.kind === 'component' && chipProblemText(chip, componentsLatest.current, translateLatest.current) === undefined) {
            const rectangle = element.getBoundingClientRect();
            setMembersOpen({
              from: view.posAtDOM(element),
              path: chip.path,
              box: { left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height },
            });
            return;
          }
          // A CSS chip opens its related classes or variables, to swap it for one of them.
          if (view !== undefined && chip.kind === 'css') {
            const rectangle = element.getBoundingClientRect();
            setCssOpen({
              from: view.posAtDOM(element),
              chip,
              box: { left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height },
            });
            return;
          }
          // A member chip that still matches opens its own field: change its value there, or remove it.
          if (view !== undefined && chip.kind === 'member' && chipProblemText(chip, componentsLatest.current, translateLatest.current) === undefined) {
            const rectangle = element.getBoundingClientRect();
            setMemberOpen({
              from: view.posAtDOM(element),
              chip,
              box: { left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height },
            });
            return;
          }
          // A file or skill chip has nothing to copy; a click puts the caret after it, as a click on text would.
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
  const mentionOpen = trigger !== undefined && trigger.from !== dismissedFrom;
  // The `/` menu: open while the draft is a command name being typed, until Esc dismisses it for this text.
  const slashQuery = chipCountOf(segments) === 0 ? slashQueryOf(plain) : undefined;
  const commandsOpen = !mentionOpen && slashQuery !== undefined && slashDismissed !== plain;
  const skillState = useSlashSkills({ scope: projectPath ?? '', open: commandsOpen, search });
  const matches: readonly SlashRow[] =
    commandsOpen && slashQuery !== undefined
      ? slashRows({ commands: props.commands, skills: skillState.kind === 'ready' ? skillsForAgent(skillState.skills, props.agent) : [], query: slashQuery })
      : [];
  const atMentionLimit = hostChipCountOf(segments) >= AI_LIMITS.mentionsMax;
  const found = useMentionRows(mentionOpen && !atMentionLimit ? trigger.query : undefined, search);
  // `@` right after a component chip (or one of its members) lists that component's props, values and slots first.
  const scope = mentionOpen ? mentionScope(segmentsBefore(segments, trigger.from)) : undefined;
  // The project's pages, variables, classes and assets, as the panels' caches hold them now: read per keystroke, never awaited.
  const answer =
    mentionOpen && !atMentionLimit
      ? mentionRows(found.rows, { components, index: readMentionIndex(), scope, query: trigger.query, tab, translate })
      : undefined;
  const rows = answer?.rows ?? found.rows;
  const rowCount = mentionOpen ? rows.length : matches.length;
  const defaultRow = 0;
  const active = rowCount === 0 ? 0 : Math.min(highlight ?? defaultRow, rowCount - 1);
  const pickTab = (next: MentionTab): void => {
    lastMentionTab = next;
    setTab(next);
    setHighlight(undefined);
  };
  const activeRow = mentionOpen ? rows[active] : undefined;

  const chooseRow = (row: PickerRow): boolean => {
    const view = viewRef.current;
    if (view === undefined || trigger === undefined) {
      return false;
    }
    const spec = editor.insertChip(view.state, row.chip, { from: trigger.from, to: trigger.to });
    if (spec === undefined || !chipFits(segments, row.chip)) {
      return false;
    }
    view.dispatch(spec);
    return true;
  };
  const chooseCommand = (command: ChatCommand): void => {
    const view = viewRef.current;
    if (props.onCommand?.(command) === true) {
      setHighlight(undefined);
      return;
    }
    if (view !== undefined) {
      view.dispatch(editor.replaceSegments(view.state, textSegments(`/${command.name} `)));
    }
    setHighlight(undefined);
  };
  // A skill completes as its name, like a command; the agent reads `/name` as the skill.
  const chooseSlashRow = (row: SlashRow): void => {
    switch (row.kind) {
      case 'builtin':
      case 'command':
        chooseCommand(row.command);
        return;
      case 'skill':
        chooseCommand({ name: slashRowName(row), description: row.skill.description, hint: undefined });
        return;
      default: {
        const exhaustive: never = row;
        return exhaustive;
      }
    }
  };
  const onMenuKey = (key: PickerKey): boolean => {
    switch (key) {
      case 'down':
      case 'up': {
        if (rowCount === 0) {
          return false;
        }
        const step = key === 'down' ? 1 : rowCount - 1;
        setHighlight((index) => (Math.min(index ?? defaultRow, rowCount - 1) + step) % rowCount);
        return true;
      }
      case 'previousTab':
      case 'nextTab': {
        if (!mentionOpen) {
          return false;
        }
        const at = MENTION_TABS.indexOf(tab);
        const next = MENTION_TABS[(at + (key === 'nextTab' ? 1 : MENTION_TABS.length - 1)) % MENTION_TABS.length];
        assert(next !== undefined, 'ComposerInput: the next tab is one of the tabs');
        pickTab(next);
        return true;
      }
      case 'choose': {
        if (mentionOpen) {
          return activeRow !== undefined && chooseRow(activeRow);
        }
        const row = matches[active];
        if (row === undefined) {
          return false;
        }
        chooseSlashRow(row);
        return true;
      }
      case 'close': {
        if (mentionOpen && trigger !== undefined) {
          setDismissedFrom(trigger.from);
          return true;
        }
        if (commandsOpen) {
          setSlashDismissed(plain);
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
      dictationDraftExtension,
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
    const remembered = caretLatest.current?.read();
    if (remembered !== undefined) {
      view.dispatch({ selection: { anchor: Math.min(remembered, view.state.doc.length) } });
    }
    return () => {
      caretLatest.current?.write(view.state.selection.main.head);
      view.destroy();
      viewRef.current = undefined;
    };
    // The editor is built once per mount; props and state reach it through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [editor, attributes]);

  // The dictation draft follows the prop; it is a decoration, so the document and its history are untouched.
  const draftText = props.dictationDraft?.text ?? NO_DRAFT.text;
  const draftDecoding = props.dictationDraft?.decoding ?? NO_DRAFT.decoding;
  const draftPlace = props.dictationDraft?.place ?? 'end';
  useEffect(() => {
    const view = viewRef.current;
    if (view !== undefined) {
      showDictationDraft(view, { text: draftText, decoding: draftDecoding, place: draftPlace });
    }
  }, [draftText, draftDecoding, draftPlace]);

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
      caret: () => viewRef.current?.state.selection.main.head,
      beforeCaret: () => {
        const view = viewRef.current;
        return view === undefined ? [] : splitAtCaret(editor.readSegments(view.state), view.state.selection.main.head).before;
      },
      editBeforeCaret: (change) => {
        const view = viewRef.current;
        if (view === undefined) {
          return;
        }
        const split = splitAtCaret(editor.readSegments(view.state), view.state.selection.main.head);
        const joined = joinAtCaret(change(split.before), split.after);
        view.dispatch({ ...editor.replaceSegments(view.state, joined.segments), selection: { anchor: joined.caret }, scrollIntoView: true });
      },
    }),
    [editor],
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

  useEffect(() => setHighlight(undefined), [trigger?.query, plain]);
  // Each time the picker opens, the panels' sources are asked again, so a file changed since shows on the next keystroke.
  useEffect(() => {
    if (mentionOpen) {
      refreshMentionIndex();
    }
  }, [mentionOpen]);

  // Each wish from the popover is one transaction: undo takes back one toggle, and the caret stays where it was.
  const applyWish = (wish: MemberWish): void => {
    const view = viewRef.current;
    if (view === undefined || membersOpen === undefined) {
      return;
    }
    const text = view.state.doc.toString();
    const ranges = editor.chipRanges(view.state);
    const chipThere = ranges.find((entry) => entry.from === membersOpen.from)?.chip;
    if (chipThere?.kind !== 'component' || chipThere.path !== membersOpen.path) {
      setMembersOpen(undefined); // The chip moved or went: the popover no longer stands for anything.
      return;
    }
    const edit = planMemberEdit(text, memberRun(text, ranges, membersOpen.from), { componentFrom: membersOpen.from, path: membersOpen.path }, wish);
    if (edit === undefined) {
      return;
    }
    // Its own history event, never merged with a neighbouring toggle, so one undo takes back exactly one.
    const ownStep = { annotations: isolateHistory.of('full') };
    switch (edit.kind) {
      case 'insert': {
        const spec =
          ranges.filter((entry) => isReferenceChip(entry.chip)).length < REFERENCE_CHIPS_MAX
            ? editor.insertChip(view.state, edit.chip, { from: edit.at, to: edit.at, leading: ' ', trailing: '', caret: 'keep' })
            : undefined;
        if (spec !== undefined) {
          view.dispatch(spec, ownStep);
        }
        return;
      }
      case 'replace': {
        const spec = editor.insertChip(view.state, edit.chip, { from: edit.at, to: edit.at + 1, trailing: '', caret: 'keep' });
        if (spec !== undefined) {
          view.dispatch(spec, ownStep);
        }
        return;
      }
      case 'remove':
        view.dispatch({ changes: { from: edit.from, to: edit.to }, userEvent: 'delete' }, ownStep);
        return;
      default: {
        const exhaustive: never = edit;
        return exhaustive;
      }
    }
  };
  // One member chip's popover: a new value replaces the chip in place, Remove deletes it with the space before it.
  const editMember = (change: { readonly value: string | undefined } | 'remove'): void => {
    const view = viewRef.current;
    if (view === undefined || memberOpen === undefined) {
      return;
    }
    const text = view.state.doc.toString();
    const there = editor.chipRanges(view.state).find((entry) => entry.from === memberOpen.from)?.chip;
    if (there === undefined || !chipsEqual(there, memberOpen.chip)) {
      setMemberOpen(undefined); // The chip moved or went: the popover no longer stands for anything.
      return;
    }
    const ownStep = { annotations: isolateHistory.of('full') };
    if (change === 'remove') {
      const from = text.charAt(memberOpen.from - 1) === ' ' ? memberOpen.from - 1 : memberOpen.from;
      view.dispatch({ changes: { from, to: memberOpen.from + 1 }, userEvent: 'delete' }, ownStep);
      setMemberOpen(undefined);
      view.focus();
      return;
    }
    const next = memberWithValue(memberOpen.chip, change.value);
    if (next === undefined || chipsEqual(next, memberOpen.chip)) {
      return;
    }
    const spec = editor.insertChip(view.state, next, { from: memberOpen.from, to: memberOpen.from + 1, trailing: '', caret: 'keep' });
    if (spec !== undefined) {
      view.dispatch(spec, ownStep);
      setMemberOpen({ ...memberOpen, chip: next });
    }
  };
  // A press back in the text closes the swap list; the press itself still places the caret.
  const closeCss = useCallback(() => setCssOpen(undefined), []);
  // The draft changed under the list (typed, sent, restored): what it was opened for may be gone.
  useEffect(() => setCssOpen(undefined), [segments]);
  // A swap replaces the CSS chip in place as one undoable change; the caret stays where it was and the editor has it back.
  const swapCss = (next: Extract<MentionChip, { readonly kind: 'css' }>): void => {
    const view = viewRef.current;
    setCssOpen(undefined);
    if (view === undefined || cssOpen === undefined) {
      return;
    }
    const there = editor.chipRanges(view.state).find((entry) => entry.from === cssOpen.from)?.chip;
    if (there !== undefined && chipsEqual(there, cssOpen.chip) && !chipsEqual(next, cssOpen.chip)) {
      const spec = editor.insertChip(view.state, next, { from: cssOpen.from, to: cssOpen.from + 1, trailing: '', caret: 'keep' });
      if (spec !== undefined) {
        view.dispatch(spec, { annotations: isolateHistory.of('full') });
      }
    }
    view.focus();
  };

  const memberProp =
    memberOpen?.chip.role === 'prop'
      ? components?.find((component) => component.path === memberOpen.chip.component)?.props.find((prop) => prop.name === memberOpen.chip.name)
      : undefined;

  const membersComponent = membersOpen === undefined ? undefined : components?.find((component) => component.path === membersOpen.path);
  const placed = membersOpen === undefined ? [] : placedChips(segments);
  const membersChip = placed.find((entry) => entry.from === membersOpen?.from)?.chip;
  const membersView =
    membersOpen !== undefined && membersComponent !== undefined && membersChip?.kind === 'component' && membersChip.path === membersComponent.path
      ? { open: membersOpen, component: membersComponent }
      : undefined;

  // The components changed (a rescan after a rename or a delete): the chips are drawn again, so one that no longer matches turns invalid.
  useEffect(() => {
    const view = viewRef.current;
    if (view !== undefined) {
      view.dispatch(editor.redraw(view.state));
    }
  }, [editor, components]);

  return (
    <>
      {commandsOpen && (
        <SlashMenu agent={props.agent} rows={matches} activeIndex={active} skills={skillState} onActiveChange={setHighlight} onChoose={chooseSlashRow} />
      )}
      <div ref={host} className="ai-editor" />
      {card.card}
      {membersView !== undefined && (
        <ComponentMembersPopover
          component={membersView.component}
          selection={memberRun(plainDocumentText(segments), placed, membersView.open.from)}
          anchorBox={membersView.open.box}
          anchor={host.current ?? undefined}
          onWish={applyWish}
          onClose={() => {
            setMembersOpen(undefined);
            // Back to the editor at the caret it had: the popover never moved it.
            viewRef.current?.focus();
          }}
        />
      )}
      {cssOpen !== undefined && (
        <RelatedCssPopover
          items={relatedItems(readMentionIndex(), cssOpen.chip)}
          anchorBox={cssOpen.box}
          anchor={host.current ?? undefined}
          onPick={(item) => swapCss(item.chip)}
          onClose={() => {
            // Escape: the editor gets its caret back right after the chip.
            const view = viewRef.current;
            const after = cssOpen.from + 1;
            setCssOpen(undefined);
            if (view !== undefined && after <= view.state.doc.length) {
              view.dispatch({ selection: { anchor: after } });
              view.focus();
              // The popup hands focus back to what it was stacked above as it leaves; the editor takes it after that.
              requestAnimationFrame(() => view.focus());
            }
          }}
          onPressComposer={closeCss}
        />
      )}
      {memberOpen !== undefined && (
        <MemberValuePopover
          chip={memberOpen.chip}
          prop={memberProp}
          anchorBox={memberOpen.box}
          anchor={host.current ?? undefined}
          onValue={(value) => editMember({ value })}
          onRemove={() => editMember('remove')}
          onClose={() => {
            setMemberOpen(undefined);
            viewRef.current?.focus();
          }}
        />
      )}
      {mentionOpen && (
        <ChipPicker
          open
          anchor={trigger.anchor}
          candidates={rows.map((row) => pickerCandidate(row))}
          activeIndex={active}
          label={translate('ai.composer.mention.label')}
          listId={listId}
          emptyText={emptyTextFor({ atLimit: atMentionLimit, state: found.state, translate })}
          tabs={
            answer === undefined
              ? undefined
              : {
                  tabs: MENTION_TABS.map((value) => ({
                    value,
                    label: translate(MENTION_TAB_LABELS[value]),
                    badge: String(answer.counts[value]),
                    dim: answer.counts[value] === 0,
                  })),
                  value: tab,
                  label: translate('ai.mention.tabs.label'),
                  onPick: pickTab,
                }
          }
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

/** A pill the editor drew shows its card on hover and keyboard focus, as a sent chip does (MentionChipView.tsx). */
function chipCardEvents(element: HTMLElement, chip: MentionChip, card: () => ChipCard, subject: () => ChipSubject): void {
  // A tab stop, so the keyboard reaches the code of a chip without a pointer.
  element.tabIndex = 0;
  element.dataset['chip'] = chip.kind;
  element.addEventListener('mouseenter', () => card().rest(element, subject()));
  element.addEventListener('mouseleave', () => card().leave());
  element.addEventListener('focus', () => card().focus(element, subject()));
  element.addEventListener('blur', () => card().leave());
  element.addEventListener('keydown', (event) => {
    if (card().key(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

/** The member chip with a new value: a slot has none, text keeps its own when cleared. */
function memberWithValue(chip: ComponentMemberChip, value: string | undefined): ComponentMemberChip | undefined {
  switch (chip.role) {
    case 'slot':
      return undefined;
    case 'text':
      return value === undefined ? undefined : { ...chip, value };
    case 'prop':
    case 'attr':
      return { ...chip, value };
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}

/** The editor's document text for a draft: each chip one placeholder character. */
function plainDocumentText(segments: ComposerSegments): string {
  return segments.map((segment) => (segment.kind === 'text' ? segment.text : CHIP_CHARACTER)).join('');
}

function pickerCandidate(row: PickerRow) {
  return {
    id: row.id,
    label: row.label,
    group: row.group,
    icon: row.look === undefined ? chipStyleIcon(chipStyleOf(row.chip), 16) : <MentionRowIcon look={row.look} />,
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

// Repeated here so a segment-equality helper import is not needed in tests of the model alone.
export { segmentsEqual };
