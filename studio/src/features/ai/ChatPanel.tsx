import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
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
import { setStudioTranslate } from './studioWords';
import './chat.css';

interface PanelProps {
  readonly file: string;
  readonly project: Pick<Project, 'pages' | 'components' | 'assets'>;
  readonly refresh: () => void;
  readonly error: (error: unknown) => void;
}
export function ChatPanel({ file, project, refresh }: PanelProps) {
  const translate = useTranslate();
  const state = useChats();
  const [listing, setListing] = useState(false);
  const files = useMemo(() => mentionFiles(project, file), [project, file]);
  const { config, error, reload } = useModels();
  const chat = state.threads.find((chat) => chat.id === state.active) ?? state.threads[0];
  // The chat code outside React (state, actions) writes its sentences in the language the panel shows.
  useEffect(() => {
    setStudioTranslate(translate);
  }, [translate]);
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
        {translate('ai.panel.loadingChats')}
      </div>
    );
  }
  return (
    <section className="chat-panel" aria-label={translate('ai.studio.workspace')}>
      <ConfirmHost />
      <header className="chat-header">
        <button
          className="chat-switcher-button"
          aria-label={translate('ai.studio.chatHistory')}
          aria-expanded={listing}
          title={listing ? translate('ai.studio.backToChat') : translate('ai.sessions.allChats')}
          onClick={() => setListing(!listing)}
        >
          <ChatIcon name="chat" />
          <span>{listing ? translate('ai.sessions.chats') : chat.title}</span>
          <ChatIcon name="chevron" />
        </button>
        <button
          className="chat-icon-button"
          aria-label={translate('ai.sessions.newChat')}
          title={state.threads.length >= CHATS_MAX ? translate('ai.studio.makeRoom') : translate('ai.sessions.newChat')}
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
          {error ? <ErrorToast message={error} recovery={[{ label: translate('ui.retry'), run: reload }]} /> : translate('ai.studio.notConnected')}
          <button onClick={reload}>{translate('ai.studio.retryConnection')}</button>
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
  const translate = useTranslate();
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
          setError(error instanceof Error ? error.message : translate('ai.studio.modelsFailed'));
        }
      });
    return () => controller.abort();
  }, [attempt, translate]);
  return { config, error, reload: () => setAttempt((value) => value + 1) };
}
function ChatWelcome({ chat }: { readonly chat: ChatThread }) {
  const translate = useTranslate();
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-mark" aria-hidden="true">
        ✦
      </div>
      <h2>{translate('ai.studio.welcome.title')}</h2>
      <p>
        {translate('ai.studio.welcome.line1')}
        <br />
        {translate('ai.studio.welcome.line2')}
      </p>
      <div className="chat-starters">
        {[translate('ai.studio.starter.improve'), translate('ai.studio.starter.mobile'), translate('ai.studio.starter.explain')].map((prompt) => (
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
