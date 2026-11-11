import { centralIcon } from '../../ui/central/CentralIcon';
import { microphone as centralMicrophone } from '../../ui/central/centralGeometry';
// Where the person writes to the agent: the prompt, its attachments (images
// pasted, dropped or picked; project files dropped from Finder or the Assets
// panel), dictation, the `/` command menu from the agent's advertised commands
// and skills, the agent's settings (model, mode and the rest it offers, each a
// Stacki Dropdown) and Send, which becomes Stop while the agent works.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { assert } from '../../../shared/core/assert';
import { AGENTS, type AgentId } from '../../../shared/properties/ai/agentIds';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { ChatCommand, ChatId } from '../../../shared/properties/ai/chatModel';
import { ArrowDownIcon, CloseIcon, FileIcon, PaperclipIcon } from '../../ui/Icons';
import { setDraft, stopChat, sendPrompt, type ChatDraft, type DraftAttachment } from './aiStore';
import { prepareImage } from './chatImages';
import type { ChatView } from './chatReducer';
import { useDictation } from './useDictation';

const COMMANDS_SHOWN_MAX = 8;

export function ChatComposer({
  chat,
  agent,
  view,
  draft,
  projectPath,
  disabled,
  settings,
}: {
  readonly chat: ChatId;
  readonly agent: AgentId;
  readonly view: ChatView;
  readonly draft: ChatDraft;
  readonly projectPath: string;
  /** Why the composer cannot send now (the agent is not ready), or undefined. */
  readonly disabled: string | undefined;
  /** The provider, model and effort pickers for this chat (AiPanel's ComposerSettings). */
  readonly settings: React.ReactNode;
}) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // The composer takes the keyboard when a chat opens, new or not, so the person can just type.
  useEffect(() => {
    input.current?.focus();
  }, [chat]);
  const voice = useDictation((text) => setDraft(chat, (current) => ({ ...current, text: `${current.text}${current.text === '' ? '' : ' '}${text}` })));
  const running = view.running !== undefined;
  const commands = matchingCommands(view.commands, draft.text);
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
  const submit = (): void => {
    if (running || disabled !== undefined || voice.listening) {
      return;
    }
    void sendPrompt(chat);
  };
  const choose = (command: ChatCommand): void => {
    setDraft(chat, (current) => ({ ...current, text: `/${command.name} ` }));
    setHighlight(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (commands.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((index) => (index + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        const command = commands[Math.min(highlight, commands.length - 1)];
        if (command !== undefined) {
          event.preventDefault();
          choose(command);
          return;
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="ai-compose">
      {commands.length > 0 && (
        <div className="ai-commands" role="listbox" aria-label="Commands">
          {commands.map((command, index) => (
            <button
              key={command.name}
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? 'on' : ''}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(command);
              }}
            >
              <span className="ai-command-name">/{command.name}</span>
              <span className="ai-command-description">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <form
        className={`ai-composer${dragging ? ' is-dragging' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
        <textarea
          ref={input}
          aria-label={`Message ${AGENTS[agent].label}`}
          placeholder={disabled ?? (dragging ? 'Drop images or files here' : `Ask ${AGENTS[agent].label} anything, or type / for commands`)}
          rows={3}
          maxLength={AI_LIMITS.promptCharsMax}
          value={draft.text}
          onChange={(event) => {
            setHighlight(0);
            setDraft(chat, (current) => ({ ...current, text: event.target.value }));
          }}
          onKeyDown={onKeyDown}
        />
        <div className="ai-composer-tools">
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
          <button
            type="button"
            className="ghost ai-tool-button"
            aria-label="Attach images"
            title="Attach images, or paste or drop them here"
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon size={14} />
          </button>
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
          {settings}
          <span className="ai-composer-spacer" />
          {running ? (
            <button type="button" className="ai-send ai-stop" aria-label="Stop" title="Stop the agent" onClick={() => void stopChat(chat)}>
              <span className="ai-stop-square" />
            </button>
          ) : (
            <button
              type="submit"
              className="ai-send"
              aria-label="Send"
              title="Send (Enter)"
              disabled={disabled !== undefined || (draft.text.trim() === '' && draft.attachments.length === 0)}
            >
              <ArrowDownIcon size={14} className="ai-send-arrow" />
            </button>
          )}
        </div>
      </form>
      {(problem ?? voice.error) !== undefined && <div className="ai-compose-problem">{problem ?? voice.error}</div>}
      {voice.listening && <div className="ai-compose-hint">{voice.interim || 'Listening… click the microphone to finish'}</div>}
    </div>
  );
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
