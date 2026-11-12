// Where the person writes to the agent, drawn like Claude's desktop composer: one slim box (a "+" menu,
// the input, Stop while the agent works, the microphone) with messages queued for later above it and one
// quiet line of settings under it (ComposerStatusLine.tsx). The box holds the prompt, its attachments
// (images pasted, dropped or picked; project files dropped from Finder or the Assets panel), dictation and
// the `/` command menu from the agent's advertised commands and skills (ComposerInput.tsx).
//
// Keys, reported by the input as `onSend`: Enter sends; while the agent works Enter steers (the message
// joins the running turn) and Cmd/Ctrl+Enter queues it until the turn ends; Escape in an empty box stops
// the turn. The queue and the steering are the store's (aiStore.ts); this file only picks which to call.
import { useEffect, useRef, useState } from 'react';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { microphone as centralMicrophone } from '../../../ui/central/centralGeometry';
import { ArrowDownIcon, CloseIcon, FileIcon } from '../../../ui/Icons';
import {
  draftText,
  draftWithAppendedText,
  isDraftEmpty,
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
import { useDictation } from '../useDictation';
import { DictationNoticeRow } from './DictationNoticeRow';
import { ComposerInput, type ComposerHandle, type SendKey } from './ComposerInput';
import { ComposerStatusLine } from './ComposerStatusLine';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { PlusMenu } from './PlusMenu';
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
  const [problem, setProblem] = useState<string | undefined>(undefined);
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
  const voice = useDictation((spoken) => setDraft(chat, (current) => draftWithAppendedText(current, spoken)));
  const running = view.running !== undefined;
  const text = draftText(draft);
  const attach = async (files: readonly File[]): Promise<void> => {
    setProblem(undefined);
    const added: DraftAttachment[] = [];
    for (const file of files) {
      if (draft.attachments.length + added.length >= AI_LIMITS.attachmentsMax) {
        setProblem(`Attach up to ${AI_LIMITS.attachmentsMax} files per message.`);
        break;
      }
      try {
        added.push(await attachmentFor(file, projectPath));
      } catch (error: unknown) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }
    if (added.length > 0) {
      setDraft(chat, (current) => ({ ...current, attachments: [...current.attachments, ...added].slice(0, AI_LIMITS.attachmentsMax) }));
    }
  };
  const queued = state.queue.get(chat) ?? [];
  // An empty box has nothing to send, so no Send button takes room from the placeholder; Enter still sends.
  const hasContent = !isDraftEmpty(draft);
  // Enter sends (steers, while the agent works); the queue key sets the message aside until the turn ends.
  const send = (key: SendKey): void => {
    if (disabled !== undefined || voice.listening) {
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
        onSubmit={(event) => {
          event.preventDefault();
          send('send');
        }}
        onKeyDown={(event) => {
          // Escape in an empty box stops the turn, unless something inside (a menu, the command list) already used it.
          if (event.key === 'Escape' && running && !hasContent && !event.defaultPrevented) {
            event.preventDefault();
            void stopChat(chat);
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
        {draft.attachments.length > 0 && (
          <div className="ai-attachments">
            {draft.attachments.map((entry) => (
              <span className="ai-attachment" key={entry.id}>
                {entry.preview === undefined ? <FileIcon size={12} /> : <img src={entry.preview} alt="" />}
                <span>{entry.attachment.kind === 'image' ? entry.attachment.name : entry.attachment.path}</span>
                <button
                  type="button"
                  className="ghost"
                  aria-label="Remove attachment"
                  onClick={() => setDraft(chat, (current) => ({ ...current, attachments: current.attachments.filter((other) => other.id !== entry.id) }))}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="ai-composer-row">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            aria-label="Attach images"
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
          />
          <ComposerInput
            agent={agent}
            commands={view.commands}
            segments={draft.segments}
            placeholder={placeholder}
            inputRef={input}
            onSegmentsChange={(segments) => setDraft(chat, (current) => ({ ...current, segments }))}
            onSend={send}
          />
          <div className="ai-composer-end">
            {running && (
              <button type="button" className="ai-send ai-stop" aria-label="Stop" title="Stop the agent (Esc)" onClick={() => void stopChat(chat)}>
                <span className="ai-stop-square" />
              </button>
            )}
            <button
              type="button"
              className={`ghost ai-tool-button${voice.listening ? ' is-listening' : ''}`}
              aria-label={voice.listening ? 'Stop dictation' : 'Dictate'}
              aria-pressed={voice.listening}
              title={voice.supported ? 'Dictate a message' : 'Voice input is not available'}
              onClick={voice.toggle}
            >
              <MicGlyph />
            </button>
            {!running && hasContent && (
              <button type="submit" className="ai-send" aria-label="Send" title="Send (Enter)" disabled={disabled !== undefined}>
                <ArrowDownIcon size={14} className="ai-send-arrow" />
              </button>
            )}
          </div>
        </div>
      </form>
      <ComposerStatusLine state={state} chatId={chat} agent={agent} view={view} />
      {problem !== undefined && <div className="ai-compose-problem">{problem}</div>}
      {problem === undefined && voice.notice !== undefined && (
        <DictationNoticeRow notice={voice.notice} onDismiss={voice.dismiss} onOpenSettings={voice.openSettings} />
      )}
      {voice.listening && <div className="ai-compose-hint">{voice.interim || 'Listening… click the microphone to finish'}</div>}
    </div>
  );
}

async function attachmentFor(file: File, projectPath: string): Promise<DraftAttachment> {
  const filePath = window.avb.getFilePath(file);
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  if (filePath !== undefined && filePath.startsWith(root) && !file.type.startsWith('image/')) {
    return { id: crypto.randomUUID(), preview: undefined, attachment: { kind: 'file', path: filePath.slice(root.length) } };
  }
  if (file.type.startsWith('image/')) {
    return prepareImage(file);
  }
  throw new Error('Attach images, or files from this project.');
}

const MicGlyph = centralIcon(centralMicrophone);
