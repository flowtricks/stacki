// One chat in the sessions list: a quiet status mark (a running loader or an unread dot), the title on one
// line, and at the end its pin, age and agent, which a hovered row swaps for a "⋯" button that opens the
// chat's menu. The same menu opens on a right click or the Menu key. Letters work on a focused row exactly
// as they do in the open menu (P pin, U unread, R rename, F fork, A archive, D delete).
// Archived rows are not opened or dragged: they offer Restore and the menu's Restore and Delete.
import { useEffect } from 'react';
import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { agentLabel } from '../../../../shared/properties/ai/agentIds';
import type { ChatSection, ChatSummary } from '../../../../shared/properties/ai/chatModel';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { ClaudeLogo, CodexLogo } from '../../../ui/agentLogos';
import { MoreIcon, PinIcon } from '../../../ui/Icons';
import { LoaderDots } from '../../../ui/LoaderDots';
import Menu, { useMenuTrigger } from '../../../ui/Menu';
import { openChat, renameChat } from '../aiStore';
import { chatMenuEntries, runChatAction } from './chatActions';
import { RenameField } from './RenameField';
import { useChatWords } from '../useChatWords';
import { CHAT_TITLE_CHARS_MAX, ageLabel, contextSummary, rowShortcut } from './sessionsModel';

export interface ChatRowProps {
  readonly chat: ChatSummary;
  readonly sections: readonly ChatSection[];
  readonly running: boolean;
  readonly renaming: boolean;
  readonly now: number;
  /** The drag hook's props for this row (`data-drag-item`, pointer and Alt+Arrow handlers); absent on rows that cannot be dragged. */
  readonly dragProps: (HTMLAttributes<HTMLButtonElement> & { readonly 'data-drag-item'?: string }) | undefined;
  readonly onRenameStart: () => void;
  readonly onRenameEnd: () => void;
}

export function ChatRow(props: ChatRowProps) {
  const { chat, sections, running, renaming, now, dragProps } = props;
  const translate = useTranslate();
  const words = useChatWords();
  const { formatDate, formatRelativeTime } = useFormat();
  const trigger = useMenuTrigger();
  const archived = chat.archivedAt !== undefined;
  const host = { rename: props.onRenameStart };
  // Renaming replaces the row, and its menu with it, before the menu can report that it closed.
  const { close: closeMenu } = trigger;
  useEffect(() => {
    if (renaming) {
      closeMenu();
    }
  }, [renaming, closeMenu]);
  const openMenu = (): void => {
    if (!trigger.open) {
      trigger.toggle();
    }
  };
  if (renaming) {
    return (
      <li className="ai-list-row is-renaming" data-chat={chat.id}>
        <span className="ai-row-lead" />
        <RenameField
          initial={chat.title}
          limit={CHAT_TITLE_CHARS_MAX}
          label={translate('ai.sessions.chatName')}
          onCommit={(title) => {
            props.onRenameEnd();
            void renameChat(chat.id, title);
          }}
          onCancel={props.onRenameEnd}
        />
      </li>
    );
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    dragProps?.onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openMenu();
      return;
    }
    const action = rowShortcut(event);
    if (action !== undefined) {
      event.preventDefault();
      void runChatAction(action, chat, host, translate);
    }
  };
  const detail = [agentLabel(chat.agent), formatRelativeTime(chat.updatedAt, now), contextSummary(chat.context, words)]
    .filter((part) => part !== undefined)
    .join(' · ');
  return (
    <li
      className={`ai-list-row${chat.unread ? ' is-unread' : ''}${chat.pinned ? ' is-pinned' : ''}${archived ? ' is-archived' : ''}${trigger.open ? ' has-menu' : ''}`}
      data-chat={chat.id}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu();
      }}
    >
      {archived ? (
        <span className="ai-list-open is-static" title={detail}>
          <span className="ai-row-lead" />
          <span className="ai-list-title">{chat.title}</span>
          <button className="ai-row-restore" onClick={() => void runChatAction('restore', chat, host, translate)}>
            {translate('ai.sessions.restore')}
          </button>
        </span>
      ) : (
        <button {...dragProps} className="ai-list-open" title={chat.title} onClick={() => void openChat(chat.id)} onKeyDown={onKeyDown}>
          <span className="ai-row-lead">
            {chat.unread ? <span className="ai-unread-dot" role="img" aria-label={translate('ai.sessions.unread')} /> : undefined}
          </span>
          <span className="ai-list-title">{chat.title}</span>
          <span className="ai-row-meta" title={detail}>
            {chat.pinned && <PinIcon size={11} aria-label={translate('ai.sessions.pinned')} />}
            {chat.agent === 'claude' ? <ClaudeLogo size={11} /> : <CodexLogo size={11} />}
            {running ? (
              <LoaderDots label={translate('ai.sessions.running')} dotPx={3} />
            ) : (
              <span className="ai-list-time">{ageLabel(chat.updatedAt, now, { ...words, formatDate })}</span>
            )}
          </span>
        </button>
      )}
      <button
        ref={trigger.ref}
        className="ai-row-more"
        aria-label={translate('ai.sessions.actionsFor', { name: chat.title })}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        onClick={trigger.toggle}
      >
        <MoreIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.sessions.actionsMenu', { name: chat.title })}
        placement="below-end"
        entries={trigger.open ? chatMenuEntries(chat, sections, host, translate) : []}
        onClose={trigger.close}
      />
    </li>
  );
}
