// Where the person writes to the agent, drawn like Claude's desktop composer: one slim box (a "+" menu,
// the input, Stop while the agent works, the microphone) with messages queued for later above it and one
// quiet line of settings under it (ComposerStatusLine.tsx). The box holds the prompt, its attachments
// (images pasted, dropped or picked; project files dropped from Finder or the Assets panel), dictation and
// the `/` command menu from the agent's advertised commands and skills (ComposerInput.tsx).
//
// Keys, reported by the input as `onSend`: Enter sends; while the agent works Enter steers (the message
// joins the running turn) and Cmd/Ctrl+Enter queues it until the turn ends; Escape in an empty box stops
// the turn. The queue and the steering are the store's (aiStore.ts); this file only picks which to call.
// ⌘F / Ctrl+F asks the transcript for its find bar and ⌘⇧O / Ctrl+Shift+O starts a new chat (chatShortcuts.ts).
//
// Stacki's own commands (`/clear`, `/export`, `/find`, builtinCommands.ts) head the `/` menu and run here,
// never reaching the agent; so does a draft that is exactly one of them when Enter sends it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentLabel, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { arrowCornerDownLeft as centralReturn } from '../../../ui/central/centralGeometry';
import { currentDesktopPlatform } from '../../../lib/shortcutLabel';
import { AttachmentChips } from '../screenshot/AttachmentChips';
import { appendAttachments, nextScreenshotNumber } from '../screenshot/draftAttachments';
import { ScreenshotButton } from '../screenshot/ScreenshotButton';
import { useScreenshotCapture } from '../screenshot/useScreenshotCapture';
import {
  draftText,
  EMPTY_DRAFT,
  isDraftEmpty,
  newChat,
  preferredAgent,
  queuePrompt,
  sendPrompt,
  setDraft,
  steerPrompt,
  stopChat,
  type AiState,
  type ChatDraft,
  type DraftAttachment,
} from '../aiStore';
import { prepareImage } from '../chatImages';
import type { ChatView } from '../chatReducer';
import { chatShortcut } from '../chatShortcuts';
import { requestChatFind } from '../transcript/chatFind';
import { hasExportableMessages, transcriptMarkdown } from '../transcript/chatExport';
import { COPY_LIMITS, copyText } from '../transcript/copyText';
import { builtinCommandNamed, builtinCommandOfDraft, builtinCommands, withBuiltinCommands, type BuiltinCommandName } from './builtinCommands';
import { reportErrorToast } from '../../../ui/errorNotices';
import { ComposerInput, type ComposerHandle, type SendKey } from './ComposerInput';
import { ComposerStatusLine } from './ComposerStatusLine';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { PlusMenu } from './PlusMenu';
import { addSelectionToDraft } from '../mentions/selectionMention';
import { VoiceLine } from './VoiceLine';
import { MicButton } from './MicButton';
import { useComposerVoice } from './useComposerVoice';
import { QueuedPrompts } from './QueuedPrompts';
import './composer.css';

/** The key that queues, as the placeholder names it. */
const QUEUE_KEY_LABEL = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘⏎' : 'Ctrl⏎';

export function ChatComposer({
  chat,
  agent,
  view,
  draft,
  projectPath,
  disabled,
  state,
}: {
  readonly chat: ChatId;
  readonly agent: AgentId;
  readonly view: ChatView;
  readonly draft: ChatDraft;
  readonly projectPath: string;
  /** Why the composer cannot send now (the agent is not ready), or undefined. */
  readonly disabled: string | undefined;
  /** The panel's state: the status line reads the chat's settings and the queue from it. */
  readonly state: AiState;
}) {
  const translate = useTranslate();
  // A quiet line under the box after a built-in command ("Copied the chat as Markdown"), gone after a moment.
  const [note, setNote] = useState<string | undefined>(undefined);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const showNote = (text: string): void => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(undefined), COPY_LIMITS.confirmMs * 2);
  };
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<ComposerHandle>(null);
  // The composer takes the keyboard when a chat opens, new or not, so the person can just type.
  useEffect(() => {
    input.current?.focus();
  }, [chat]);
  // A hand-off that placed something in the box (Build an app's chip) asks for the keyboard, including when the chat was already open.
  useEffect(() => {
    if (state.composerFocusRequests > 0) {
      input.current?.focus();
    }
  }, [state.composerFocusRequests]);
  // The newest draft, for the voice callbacks: speech arrives between renders.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const dictation = useComposerVoice({
    read: () => draftNow.current,
    write: (change) => setDraft(chat, change),
    onSend: () => submit('send'),
    draft,
  });
  const { voice } = dictation;
  const dictating = voice.listening || voice.transcribing;
  const running = view.running !== undefined;
  const text = draftText(draft);
  // The one way into the draft for pasted, dropped and picked files and for screenshots, so the bounds hold for all of them.
  const addAttachments = (added: readonly DraftAttachment[]): void => {
    let limited: 'count' | 'size' | undefined;
    setDraft(chat, (current) => {
      const outcome = appendAttachments(current.attachments, added);
      limited = outcome.kind === 'limited' ? outcome.reason : undefined;
      return { ...current, attachments: outcome.attachments };
    });
    if (limited === 'count') {
      reportErrorToast(translate('ai.composer.attach.limit', { count: AI_LIMITS.attachmentsMax }));
    } else if (limited === 'size') {
      reportErrorToast(translate('ai.composer.attach.total'));
    }
  };
  const attach = async (files: readonly File[]): Promise<void> => {
    const added: DraftAttachment[] = [];
    for (const file of files) {
      if (draft.attachments.length + added.length >= AI_LIMITS.attachmentsMax) {
        reportErrorToast(translate('ai.composer.attach.limit', { count: AI_LIMITS.attachmentsMax }));
        break;
      }
      try {
        added.push(await attachmentFor(file, projectPath, translate));
      } catch (error: unknown) {
        reportErrorToast(error instanceof Error ? error.message : String(error));
      }
    }
    if (added.length > 0) {
      addAttachments(added);
    }
  };
  const screenshot = useScreenshotCapture({
    projectPath,
    enabled: disabled === undefined,
    nextNumber: () => nextScreenshotNumber(draft.attachments),
    slotsLeft: () => AI_LIMITS.attachmentsMax - draft.attachments.length,
    onCaptured: (attachments) => addAttachments(attachments),
  });
  const queued = state.queue.get(chat) ?? [];
  const commands = useMemo(() => withBuiltinCommands(builtinCommands(translate), view.commands), [translate, view.commands]);
  const copyChat = (): void => {
    if (!hasExportableMessages(view.items)) {
      showNote(translate('ai.export.empty'));
      return;
    }
    const markdown = transcriptMarkdown(view.items, {
      title: view.title,
      you: translate('ai.export.you'),
      agent: agentLabel(agent),
      attachments: translate('ai.export.attachments'),
      truncated: translate('ai.export.truncated'),
    });
    void copyText(markdown).then((result) => showNote(result === 'copied' ? translate('ai.export.copied') : translate('ai.common.copyFailed')));
  };
  // Stacki's own commands act here and leave the box empty, so the command's name is never sent as a message.
  const runBuiltin = (name: BuiltinCommandName): void => {
    setDraft(chat, () => EMPTY_DRAFT);
    switch (name) {
      case 'clear':
        void newChat(agent);
        return;
      case 'export':
        copyChat();
        return;
      case 'find':
        requestChatFind(chat);
        return;
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  };
  // An empty box has nothing to send, so no Send button takes room from the placeholder; Enter still sends.
  const hasContent = !isDraftEmpty(draft);
  // Enter sends (steers, while the agent works); the queue key sets the message aside until the turn ends.
  const submit = (key: SendKey): void => {
    // A draft that is only a built-in command runs it, even while the agent is not ready: none of them needs the agent.
    const builtin = key === 'send' && draft.attachments.length === 0 ? builtinCommandOfDraft(text) : undefined;
    if (builtin !== undefined) {
      runBuiltin(builtin);
      return;
    }
    if (disabled !== undefined) {
      return;
    }
    if (key === 'queue') {
      void queuePrompt(chat);
    } else if (running) {
      void steerPrompt(chat);
    } else {
      void sendPrompt(chat);
    }
  };
  // Typing Enter while the microphone is open sends nothing: the phrase being spoken has not landed in the box yet.
  const send = (key: SendKey): void => {
    if (!voice.listening) {
      submit(key);
    }
  };
  const placeholder =
    disabled ??
    (dragging
      ? translate('ai.composer.placeholder.drop')
      : running
        ? translate('ai.composer.placeholder.steer', { queueKey: QUEUE_KEY_LABEL })
        : translate('ai.composer.placeholder.send', { queueKey: QUEUE_KEY_LABEL }));
  return (
    <div className="ai-compose">
      <QueuedPrompts chat={chat} queued={queued} paused={state.queuePaused.has(chat)} />
      <form
        className={`ai-composer${dragging ? ' is-dragging' : ''}${disabled === undefined ? '' : ' is-blocked'}`}
        // Why the box takes nothing, whole on hover: a long language can cut the placeholder at the narrowest panel.
        title={disabled}
        onSubmit={(event) => {
          event.preventDefault();
          send('send');
        }}
        onKeyDown={(event) => {
          // Escape in an empty box stops the turn, unless something inside (a menu, the command list) already used it.
          if (event.key === 'Escape' && running && !hasContent && !event.defaultPrevented) {
            event.preventDefault();
            void stopChat(chat);
            return;
          }
          if (event.defaultPrevented) {
            return;
          }
          const shortcut = chatShortcut(event, currentDesktopPlatform());
          if (shortcut === 'find') {
            event.preventDefault();
            requestChatFind(chat);
          } else if (shortcut === 'new-chat') {
            event.preventDefault();
            void newChat(preferredAgent());
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void attach([...event.dataTransfer.files]);
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length > 0) {
            event.preventDefault();
            void attach(files);
          }
        }}
      >
        <AttachmentChips
          attachments={draft.attachments}
          onRemove={(id) => setDraft(chat, (current) => ({ ...current, attachments: current.attachments.filter((other) => other.id !== id) }))}
        />
        <div className="ai-composer-row">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            aria-label={translate('ai.composer.attach.images')}
            onChange={(event) => {
              const element = event.currentTarget;
              void attach([...(element.files ?? [])]);
              element.value = '';
            }}
          />
          <PlusMenu
            disabled={disabled !== undefined}
            canInsertSlash={text === '' && draft.attachments.length === 0}
            onPickImages={() => picker.current?.click()}
            onInsertSlash={() => input.current?.insertText('/')}
            onInsertMention={() => input.current?.insertText('@')}
            onFind={() => requestChatFind(chat)}
            onCopyChat={copyChat}
            canCopyChat={hasExportableMessages(view.items)}
            onAddSelection={() => void addSelectionToDraft(chat)}
          />
          <ComposerInput
            agent={agent}
            commands={commands}
            onCommand={(command) => {
              const name = builtinCommandNamed(command.name);
              if (name === undefined) {
                return false;
              }
              runBuiltin(name);
              return true;
            }}
            segments={draft.segments}
            placeholder={placeholder}
            inputRef={input}
            onSegmentsChange={(segments) => setDraft(chat, (current) => ({ ...current, segments }))}
            onSend={send}
            // The words being spoken, drawn after the text but not part of it until the phrase ends.
            dictationDraft={voice.listening || voice.transcribing ? { text: voice.interim, decoding: voice.decoding } : undefined}
          />
          <div className="ai-composer-end">
            {running && (
              <button
                type="button"
                className="ai-send ai-stop"
                aria-label={translate('ai.composer.stop')}
                title={translate('ai.composer.stop.title')}
                onClick={() => void stopChat(chat)}
              >
                <span className="ai-stop-square" />
              </button>
            )}
            {/* Send exists only when there is something to send (text, a chip or an attachment), as in Claude's composer; it fades in. */}
            {!running && hasContent && (
              <button
                type="submit"
                className="ai-send"
                aria-label={translate('ai.composer.send')}
                title={translate('ai.composer.send.title')}
                disabled={disabled !== undefined}
              >
                <ReturnGlyph size={14} />
              </button>
            )}
            {screenshot.overlay}
            {/* The microphone is the capture bar's bottom segment: hovering or focusing it reveals Screenshot and Record above. */}
            <ScreenshotButton disabled={disabled !== undefined} busy={screenshot.busy} active={screenshot.active} onCapture={screenshot.start}>
              <MicButton dictation={dictation} />
            </ScreenshotButton>
          </div>
        </div>
      </form>
      {/* One row, one height: while dictating, the voice line stands in the footer's place, over it, and the
          footer stays in the layout (hidden and inert), so the box never moves entering or leaving dictation. */}
      <div className={`ai-compose-footer${dictating ? ' is-dictating' : ''}`}>
        {/* `visibility: hidden` (composer.css) keeps its height and takes it out of focus and clicks. */}
        <div className="ai-compose-footer-status" aria-hidden={dictating ? true : undefined}>
          <ComposerStatusLine state={state} chatId={chat} agent={agent} view={view} />
        </div>
        {dictating && (
          <div className="ai-compose-footer-voice">
            <VoiceLine
              feed={voice.feed}
              starting={voice.starting || voice.transcribing}
              latch={voice.state.kind === 'idle' || voice.state.kind === 'stopping' ? 'pending' : voice.state.latch}
              interim="" // The words being spoken are drawn in the box itself (dictationDraft.ts); the line keeps its hint.
              commands={voice.commands}
            />
          </div>
        )}
      </div>
      {note !== undefined && (
        <div className="ai-compose-note" role="status">
          {note}
        </div>
      )}
    </div>
  );
}

async function attachmentFor(file: File, projectPath: string, translate: Translator): Promise<DraftAttachment> {
  const filePath = window.avb.getFilePath(file);
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  if (filePath !== undefined && filePath.startsWith(root) && !file.type.startsWith('image/')) {
    return { id: crypto.randomUUID(), preview: undefined, attachment: { kind: 'file', path: filePath.slice(root.length) } };
  }
  if (file.type.startsWith('image/')) {
    return prepareImage(file, translate);
  }
  throw new Error(translate('ai.composer.attach.unsupported'));
}

// Send is the return arrow (Central's arrow-corner-down-left), as in Claude's composer.
const ReturnGlyph = centralIcon(centralReturn);
