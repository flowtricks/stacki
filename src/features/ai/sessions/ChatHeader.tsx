// The panel's header. On the list it reads "Chats" with the filter button and "+". In an open chat it is the way
// back to the list, the chat's title (double click renames it in place), a "⋯" menu with the same actions as
// the row's menu (letters included) and "+". Archiving or deleting the open chat returns to the list: the store
// does that, so the header only asks.
import { useEffect, useState } from 'react';
import type { ChatSummary } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { ChevronLeftIcon, MoreIcon, PlusIcon } from '../../../ui/Icons';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { newChat, openChat, preferredAgent, renameChat, useAiState } from '../aiStore';
import { chatMenuEntries } from './chatActions';
import { collapseAllItems, expandAllItems } from '../transcript/transcriptUi';
import { RenameField } from './RenameField';
import { SessionsFilter } from './SessionsFilter';
import { CHAT_TITLE_CHARS_MAX } from './sessionsModel';
import './sessions.css';

export function ChatHeader({ chat }: { readonly chat: ChatSummary | undefined }) {
  const translate = useTranslate();
  const newChatButton = (
    <button
      className="ghost"
      aria-label={translate('ai.sessions.newChat')}
      title={translate('ai.sessions.newChat')}
      onClick={() => void newChat(preferredAgent())}
    >
      <PlusIcon size={14} />
    </button>
  );
  if (chat === undefined) {
    return (
      <div className="ai-header">
        <h2>{translate('ai.sessions.chats')}</h2>
        <SessionsFilter />
        {newChatButton}
      </div>
    );
  }
  return (
    <div className="ai-header">
      <button
        className="ghost"
        aria-label={translate('ai.sessions.allChats')}
        title={translate('ai.sessions.allChats')}
        onClick={() => void openChat(undefined)}
      >
        <ChevronLeftIcon size={12} />
      </button>
      <OpenChatTitle chat={chat} />
      {newChatButton}
    </div>
  );
}

/** The title and its "⋯" menu; renaming swaps the title for a field in the same place. */
function OpenChatTitle({ chat }: { readonly chat: ChatSummary }) {
  const translate = useTranslate();
  const { sections } = useAiState();
  const trigger = useMenuTrigger();
  const [renaming, setRenaming] = useState(false);
  // Renaming replaces the menu's button before the menu can report that it closed.
  const { close: closeMenu } = trigger;
  useEffect(() => {
    if (renaming) {
      closeMenu();
    }
  }, [renaming, closeMenu]);
  if (renaming) {
    return (
      <RenameField
        initial={chat.title}
        limit={CHAT_TITLE_CHARS_MAX}
        label={translate('ai.sessions.chatName')}
        className="ai-header-rename"
        onCommit={(title) => {
          setRenaming(false);
          void renameChat(chat.id, title);
        }}
        onCancel={() => setRenaming(false)}
      />
    );
  }
  return (
    <>
      <h2 title={translate('ai.sessions.renameHint', { title: chat.title })} onDoubleClick={() => setRenaming(true)}>
        {chat.title}
      </h2>
      <button
        ref={trigger.ref}
        className="ghost"
        aria-label={translate('ai.sessions.chatActions')}
        title={translate('ai.sessions.chatActions')}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        onClick={trigger.toggle}
      >
        <MoreIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.sessions.chatActions')}
        placement="below-end"
        entries={
          trigger.open ? [...transcriptEntries(chat, translate), ...chatMenuEntries(chat, sections, { rename: () => setRenaming(true) }, translate)] : []
        }
        onClose={trigger.close}
      />
    </>
  );
}

/** What only the open chat's menu offers: folding every tool group, thought and long message of its transcript at once. */
function transcriptEntries(chat: ChatSummary, translate: Translator): readonly MenuEntry[] {
  return [
    { kind: 'item', id: 'expand-all', label: translate('ai.sessions.expandAll'), accelerator: 'e', onSelect: () => expandAllItems(chat.id) },
    { kind: 'item', id: 'collapse-all', label: translate('ai.sessions.collapseAll'), accelerator: 'c', onSelect: () => collapseAllItems(chat.id) },
    { kind: 'divider', id: 'divider-transcript' },
  ];
}
