import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { useEffect, useState } from 'react';
import { request } from '../project/projectClient';
import { parseModels, type ModelConfiguration } from './chatContracts';
import { useChats, initializeChats, updateChat, createChat, type ChatThread } from './chatState';
import { ChatComposer } from './ChatComposer';
import { ChatMessages } from './ChatMessages';
import { ChatSwitcher } from './ChatSwitcher';
import { ChatIcon } from './ChatIcon';
import './chat.css';

export function ChatPanel({ file, refresh }: { readonly file: string; readonly refresh: () => void; readonly error: (error: unknown) => void }) {
  const state = useChats();
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
      <header className="chat-header">
        <ChatSwitcher chats={state.threads} active={chat} />
        <button
          className="chat-icon-button"
          aria-label="New chat"
          title={state.threads.length >= 20 ? 'Delete a chat to make room' : 'New chat'}
          disabled={state.threads.length >= 20}
          onClick={() => createChat(chat.model || config.defaultModel)}
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
      {chat.messages.length || chat.error ? <ChatMessages key={chat.id} chat={chat} refresh={refresh} /> : <ChatWelcome chat={chat} />}
      <ChatComposer key={chat.id} chat={chat} file={file} config={config} />
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
              updateChat(chat.id, (thread) => ({ ...thread, draft: prompt }));
              document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus();
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
