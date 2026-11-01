import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { useRef, useState } from 'react';
import { ChatIcon } from './ChatIcon';
import { useChatAttachments } from './useChatAttachments';
import { updateChat, type ChatThread } from './chatState';
import { useDictation } from './useDictation';
import { sendChat, stopChat } from './chatActions';
import type { ModelConfiguration } from './chatContracts';

interface ComposerProps {
  readonly chat: ChatThread;
  readonly file: string;
  readonly config: ModelConfiguration;
}
export function ChatComposer({ chat, file, config }: ComposerProps) {
  const { loading, attach } = useChatAttachments(chat.id);
  const [dragging, setDragging] = useState(false);
  const voice = useDictation((text) =>
    updateChat(chat.id, (thread) => ({
      ...thread,
      draft: `${thread.draft}${thread.draft ? ' ' : ''}${text}`.slice(0, 12_000),
    })),
  );
  return (
    <div className="chat-compose-area">
      <div className="chat-context" title={file}>
        <ChatIcon name="file" />
        <span>{file.replace(/^src\//, '')}</span>
        <span className="chat-draft-label">Draft</span>
      </div>
      <form
        className={`chat-composer ${dragging ? 'is-dragging' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading && !voice.listening && config.models.includes(chat.model)) {
            void sendChat(chat.id, file);
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
          if (files.length) {
            event.preventDefault();
            void attach(files);
          }
        }}
      >
        <AttachmentStrip chat={chat} />
        <PromptInput chat={chat} dragging={dragging} />
        <ComposerTools chat={chat} config={config} voice={voice} loading={loading} attach={attach} />
      </form>
      <ErrorToast message={voice.error} />
      <div className="chat-composer-hint" role="status">
        {voice.listening
          ? voice.interim || 'Listening… click the microphone to finish'
          : loading
            ? 'Preparing images…'
            : 'Enter to send · Shift + Enter for a new line'}
      </div>
    </div>
  );
}
function AttachmentStrip({ chat }: { readonly chat: ChatThread }) {
  return (
    <div className="chat-attachments">
      {chat.images.map((image) => (
        <div className="chat-attachment" key={image.id}>
          <img src={image.url} alt={image.name} />
          <button
            type="button"
            aria-label={`Remove ${image.name}`}
            onClick={() =>
              updateChat(chat.id, (thread) => ({
                ...thread,
                images: thread.images.filter((item) => item.id !== image.id),
              }))
            }
          >
            <ChatIcon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}

function PromptInput({ chat, dragging }: { readonly chat: ChatThread; readonly dragging: boolean }) {
  const patch = (draft: string) => updateChat(chat.id, (thread) => ({ ...thread, draft }));
  return (
    <textarea
      autoFocus
      aria-label="AI prompt"
      placeholder={dragging ? 'Drop images here' : 'Ask anything, or describe a change…'}
      rows={3}
      maxLength={12_000}
      value={chat.draft}
      onChange={(event) => patch(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
  );
}

interface ToolsProps {
  readonly chat: ChatThread;
  readonly config: ModelConfiguration;
  readonly voice: ReturnType<typeof useDictation>;
  readonly loading: boolean;
  readonly attach: (files: readonly File[]) => Promise<void>;
}
function ComposerTools({ chat, config, voice, loading, attach }: ToolsProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="chat-composer-tools">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        aria-label="Attach image files"
        onChange={(event) => {
          void attach([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        className="chat-icon-button"
        aria-label="Attach images"
        title="Attach images, or paste / drop them here"
        disabled={loading || chat.images.length >= 4}
        onClick={() => input.current?.click()}
      >
        <ChatIcon name="plus" />
      </button>
      <ModelPicker chat={chat} config={config} />
      <button
        type="button"
        className={`chat-icon-button ${voice.listening ? 'is-listening' : ''}`}
        aria-label={voice.listening ? 'Stop dictation' : 'Voice input'}
        aria-pressed={voice.listening}
        title={voice.supported ? 'Dictate a message' : 'Voice input is unavailable in this browser'}
        onClick={voice.toggle}
      >
        <ChatIcon name="mic" />
      </button>
      <SendButton chat={chat} disabled={loading || voice.listening || !config.models.includes(chat.model)} />
    </div>
  );
}

function ModelPicker({ chat, config }: Pick<ToolsProps, 'chat' | 'config'>) {
  return (
    <label className="chat-model">
      <select
        aria-label="Choose model"
        value={chat.model}
        disabled={chat.status !== 'idle' || !config.models.length}
        onChange={(event) => updateChat(chat.id, (thread) => ({ ...thread, model: event.target.value }))}
      >
        {!config.models.includes(chat.model) && <option value={chat.model}>{chat.model || 'No model connected'}</option>}
        {config.models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      <ChatIcon name="chevron" />
    </label>
  );
}

function SendButton({ chat, disabled }: { readonly chat: ChatThread; readonly disabled: boolean }) {
  return chat.status === 'working' ? (
    <button type="button" className="chat-send" aria-label="Stop response" onClick={() => stopChat(chat.id)}>
      <ChatIcon name="stop" />
    </button>
  ) : (
    <button
      type="submit"
      className="chat-send"
      aria-label="Send message"
      disabled={disabled || chat.status !== 'idle' || (!chat.draft.trim() && !chat.images.length)}
    >
      <ChatIcon name="send" />
    </button>
  );
}
