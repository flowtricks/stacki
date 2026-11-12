// The composer, drawn with Desktop's own classes (composer.css, shared through the vendor tree) so the two panels
// read the same: one slim box with the "+" menu, the chip input, dictation and send/stop, and under it the status
// line with the model chip. What Desktop adds on top (effort and mode menus, the context ring, queue and steer) needs
// a long-lived agent session; Studio sends one request per message, so those controls are absent, not disabled.
import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { FileIcon, PaperclipIcon, PlusIcon } from '../../../vendor/stacki/src/ui/Icons';
import Menu, { useMenuTrigger } from '../../../vendor/stacki/src/ui/Menu';
import { StatusChip } from '../../../vendor/stacki/src/features/ai/composer/StatusChip';
import '../../../vendor/stacki/src/features/ai/composer/composer.css';
import { useEffect, useRef, useState } from 'react';
import { ChatIcon } from './ChatIcon';
import { useChatAttachments } from './useChatAttachments';
import { setDraftSegments, setDraftText, updateChat, type ChatThread } from './chatState';
import { useDictation } from './useDictation';
import { sendChat, stopChat } from './chatActions';
import type { ModelConfiguration } from './chatContracts';
import { baseName } from './mentionFiles';
import { PromptInput, type PromptHandle } from './PromptInput';

interface ComposerProps {
  readonly chat: ChatThread;
  readonly file: string;
  readonly files: readonly string[];
  readonly config: ModelConfiguration;
}
export function ChatComposer({ chat, file, files, config }: ComposerProps) {
  const { loading, attach } = useChatAttachments(chat.id);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<PromptHandle>(null);
  const voice = useDictation((text) => setDraftText(chat.id, `${chat.draft}${chat.draft ? ' ' : ''}${text}`.slice(0, 12_000)));
  const connected = config.models.includes(chat.model);
  const working = chat.status === 'working';
  const hasContent = chat.draft.trim() !== '' || chat.images.length > 0;
  // The composer takes the keyboard when a chat opens, so the person can just type.
  useEffect(() => {
    input.current?.focus();
  }, [chat.id]);
  const send = (): void => {
    if (!loading && !voice.listening && connected && !working) {
      void sendChat(chat.id, file);
    }
  };
  const placeholder = !connected ? 'Connect a model to start' : dragging ? 'Drop images here' : '⏎ to send, @ to mention a file';
  return (
    <div className="ai-compose chat-compose-area">
      <form
        className={`ai-composer${dragging ? ' is-dragging' : ''}${connected ? '' : ' is-blocked'}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
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
          const pasted = [...event.clipboardData.files];
          if (pasted.length) {
            event.preventDefault();
            void attach(pasted);
          }
        }}
      >
        {chat.images.length > 0 && (
          <div className="ai-attachments">
            {chat.images.map((image) => (
              <span className="ai-attachment" key={image.id}>
                <img src={image.url} alt={image.name} />
                <span>{image.name}</span>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => updateChat(chat.id, (thread) => ({ ...thread, images: thread.images.filter((item) => item.id !== image.id) }))}
                >
                  <ChatIcon name="close" />
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
            aria-label="Attach image files"
            onChange={(event) => {
              void attach([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
          <PlusMenu
            disabled={loading || chat.images.length >= 4}
            onPickImages={() => picker.current?.click()}
            onInsertMention={() => input.current?.insertText('@')}
          />
          <PromptInput
            segments={chat.segments}
            files={files}
            placeholder={placeholder}
            inputRef={input}
            onSegmentsChange={(segments) => setDraftSegments(chat.id, segments)}
            onSend={send}
          />
          <div className="ai-composer-end">
            <button
              type="button"
              className={`ghost ai-tool-button${voice.listening ? ' is-listening' : ''}`}
              aria-label={voice.listening ? 'Stop dictation' : 'Voice input'}
              aria-pressed={voice.listening}
              title={voice.supported ? 'Dictate a message' : 'Voice input is unavailable in this browser'}
              onClick={voice.toggle}
            >
              <ChatIcon name="mic" />
            </button>
            {working && (
              <button type="button" className="ai-send ai-stop" aria-label="Stop response" title="Stop the response" onClick={() => stopChat(chat.id)}>
                <span className="ai-stop-square" />
              </button>
            )}
            {!working && hasContent && (
              <button
                type="submit"
                className="ai-send"
                aria-label="Send message"
                title="Send (Enter)"
                disabled={loading || voice.listening || !connected || chat.status !== 'idle'}
              >
                <ChatIcon name="send" />
              </button>
            )}
          </div>
        </div>
      </form>
      <div className="ai-status-line">
        <ModelChip chat={chat} config={config} />
        <span className="ai-status-spacer" />
        <span className="ai-chip-quiet" title={`Changes are proposed against ${file}`}>
          {baseName(file)}
        </span>
      </div>
      <ErrorToast message={voice.error} />
      {(voice.listening || loading) && (
        <div className="ai-compose-hint">{voice.listening ? voice.interim || 'Listening… click the microphone to finish' : 'Preparing images…'}</div>
      )}
    </div>
  );
}

function PlusMenu({
  disabled,
  onPickImages,
  onInsertMention,
}: {
  readonly disabled: boolean;
  readonly onPickImages: () => void;
  readonly onInsertMention: () => void;
}) {
  const trigger = useMenuTrigger();
  return (
    <>
      <button
        ref={trigger.ref}
        type="button"
        className={`ghost ai-plus${trigger.open ? ' is-open' : ''}`}
        aria-label="Add to message"
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        title="Add images, or type @ to mention a file"
        onClick={trigger.toggle}
      >
        <PlusIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label="Add to message"
        placement="above-start"
        onClose={trigger.close}
        entries={[
          { kind: 'item', id: 'images', label: 'Add image', icon: <PaperclipIcon size={14} />, disabled, onSelect: onPickImages },
          { kind: 'item', id: 'mention', label: 'Mention a file', icon: <FileIcon size={14} />, shortcut: '@', onSelect: onInsertMention },
          { kind: 'note', id: 'note', text: 'You can also drop or paste images on the box.' },
        ]}
      />
    </>
  );
}

/** The model chip and its menu. The model is fixed for a request, so it cannot change while one runs. */
function ModelChip({ chat, config }: { readonly chat: ChatThread; readonly config: ModelConfiguration }) {
  const trigger = useMenuTrigger();
  const running = chat.status !== 'idle';
  const label = chat.model || 'No model connected';
  return (
    <>
      <StatusChip
        buttonRef={trigger.ref}
        open={trigger.open}
        disabled={running || config.models.length === 0}
        tone="plain"
        ariaLabel="Choose model"
        title={running ? 'The model changes when the response is done' : label}
        onClick={trigger.toggle}
      >
        <span className="ai-chip-text">{label}</span>
      </StatusChip>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label="Model"
        placement="above-start"
        onClose={trigger.close}
        entries={config.models.map((model, index) => ({
          kind: 'item' as const,
          id: `model:${model}`,
          label: model,
          ...(index < 9 ? { numberKey: index + 1 } : {}),
          checked: model === chat.model,
          onSelect: () => updateChat(chat.id, (thread) => ({ ...thread, model })),
        }))}
      />
    </>
  );
}
