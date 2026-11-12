import { ConfirmHost } from '../../../vendor/stacki/src/ui/ConfirmDialog';
import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { useEffect, useMemo, useState } from 'react';
import { request, type Project } from '../project/projectClient';
import { parseModels, type ModelConfiguration } from './chatContracts';
import { useChats, initializeChats, createChat, setDraftText, updateChat, CHATS_MAX, type ChatThread } from './chatState';
import { ChatComposer } from './ChatComposer';
import { ChatList } from './ChatList';
import { ChatMessages } from './ChatMessages';
import { ChatIcon } from './ChatIcon';
import { mentionFiles } from './mentionFiles';
import './chat.css';

interface PanelProps {
  readonly file: string;
  readonly project: Pick<Project, 'pages' | 'components' | 'assets'>;
  readonly refresh: () => void;
  readonly error: (error: unknown) => void;
}
export function ChatPanel({ file, project, refresh }: PanelProps) {
  const state = useChats();
  const [listing, setListing] = useState(false);
  const files = useMemo(() => mentionFiles(project, file), [project, file]);
  const { config, error, reload } = useModels();
  const chat = state.threads.find((chat) => chat.id === state.active) ?? state.threads[0];
  useEffect(() => {
    initializeChats();
  }, []);
  useEffect(() => {
    if (state.ready && chat && !chat.model && config.defaultModel) {
      updateChat(chat.id, (thread) => ({ ...thread, model: config.defaultModel }));
    }
  }, [chat, config.defaultModel, state.ready]);
  if (!chat || !state.ready) {
    return (
      <div className="chat-loading" role="status">
        Loading chats…
      </div>
    );
  }
  return (
    <section className="chat-panel" aria-label="AI workspace">
      <ConfirmHost />
      <header className="chat-header">
        <button
          className="chat-switcher-button"
          aria-label="Chat history"
          aria-expanded={listing}
          title={listing ? 'Back to the chat' : 'All chats'}
          onClick={() => setListing(!listing)}
        >
          <ChatIcon name="chat" />
          <span>{listing ? 'Chats' : chat.title}</span>
          <ChatIcon name="chevron" />
        </button>
        <button
          className="chat-icon-button"
          aria-label="New chat"
          title={state.threads.length >= CHATS_MAX ? 'Delete a chat to make room' : 'New chat'}
          disabled={state.threads.length >= CHATS_MAX}
          onClick={() => {
            createChat(chat.model || config.defaultModel);
            setListing(false);
          }}
        >
          <ChatIcon name="plus" />
        </button>
      </header>
      {state.notice && (
        <div className="chat-notice" role="status">
          {state.notice}
        </div>
      )}
      {(error || !config.models.length) && (
        <div className="chat-notice">
          {error ? (
            <ErrorToast message={error} recovery={[{ label: 'Retry', run: reload }]} />
          ) : (
            'AI is not connected yet. Ask the site owner to connect a provider.'
          )}
          <button onClick={reload}>Retry connection</button>
        </div>
      )}
      {/* The keys reset each part's local state when the chat changes. They must differ: siblings that share a
          key make React leave an orphaned transcript in the page on every render, in development and production alike. */}
      {listing ? (
        <ChatList
          chats={state.threads}
          active={chat.id}
          onOpen={() => setListing(false)}
          onNew={() => {
            createChat(chat.model || config.defaultModel);
            setListing(false);
          }}
        />
      ) : (
        <>
          {chat.messages.length || chat.error ? <ChatMessages key={`messages-${chat.id}`} chat={chat} refresh={refresh} /> : <ChatWelcome chat={chat} />}
          <ChatComposer key={`composer-${chat.id}`} chat={chat} file={file} files={files} config={config} />
        </>
      )}
    </section>
  );
}
function useModels() {
  const [config, setConfig] = useState<ModelConfiguration>({ models: [], defaultModel: '' });
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request('/studio/api/ai/models', { signal: controller.signal })
      .then((data) => {
        setConfig(parseModels(data));
        setError('');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : 'Could not load models.');
        }
      });
    return () => controller.abort();
  }, [attempt]);
  return { config, error, reload: () => setAttempt((value) => value + 1) };
}
function ChatWelcome({ chat }: { readonly chat: ChatThread }) {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-mark" aria-hidden="true">
        ✦
      </div>
      <h2>What would you like to build?</h2>
      <p>
        Make a change, explore an idea,
        <br />
        or bring a reference image.
      </p>
      <div className="chat-starters">
        {['Help me improve this page', 'Make this page work better on mobile', 'Explain how this page is built'].map((prompt) => (
          <button
            key={prompt}
            onClick={() => {
              setDraftText(chat.id, prompt);
              document.querySelector<HTMLElement>('.ai-composer .cm-content')?.focus();
            }}
          >
            {prompt}
            <span>↗</span>
          </button>
        ))}
      </div>
    </div>
  );
}
