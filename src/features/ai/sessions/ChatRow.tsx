// One chat in the sessions list, on two lines in a fixed 16px icon column: the agent's mark at the start (with
// the unread dot on its corner), the title on the first line (with a pin when pinned), and a dim second line
// with the agent and the age, or a running loader in place of the age. The hovered or focused row shows a "⋯"
// button at its end that opens the chat's menu; the title always stops short of that button, so it never
// moves when the button appears. The same menu opens on a right click or the Menu key. Letters work on a
// focused row exactly as they do in the open menu (P pin, R rename, F fork, A archive, D delete).
// The open chat's row carries the app's selected fill (the split layout keeps the list beside the chat).
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
  /** The chat open beside the list (split layout); its row has the selected fill. */
  readonly selected: boolean;
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
  // The full line, for the tooltip: the short age is exact there, and the context window is told only here.
  const detail = [agentLabel(chat.agent), formatRelativeTime(chat.updatedAt, now), contextSummary(chat.context, words)]
    .filter((part) => part !== undefined)
    .join(' · ');
  const age = ageLabel(chat.updatedAt, now, { ...words, formatDate });
  const classes = [
    'ai-list-row',
    chat.unread ? 'is-unread' : '',
    chat.pinned ? 'is-pinned' : '',
    archived ? 'is-archived' : '',
    props.selected ? 'is-selected' : '',
    trigger.open ? 'has-menu' : '',
  ].filter((name) => name !== '');
  const lead = (
    <span className="ai-row-lead">
      {chat.agent === 'claude' ? <ClaudeLogo size={14} /> : <CodexLogo size={14} />}
      {chat.unread ? <span className="ai-unread-dot" role="img" aria-label={translate('ai.sessions.unread')} /> : undefined}
    </span>
  );
  const meta = (
    <span className="ai-row-meta" title={detail}>
      {running ? <LoaderDots label={translate('ai.sessions.running')} dotPx={3} /> : undefined}
      <span className="ai-row-agent">{agentLabel(chat.agent)}</span>
      {running ? undefined : <span className="ai-list-time">{age}</span>}
    </span>
  );
  return (
    <li
      className={classes.join(' ')}
      data-chat={chat.id}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu();
      }}
    >
      {archived ? (
        <span className="ai-list-open is-static" title={detail}>
          {lead}
          <span className="ai-row-text">
            <span className="ai-row-line">
              <span className="ai-list-title">{chat.title}</span>
            </span>
            {meta}
          </span>
          <button className="ai-row-restore" onClick={() => void runChatAction('restore', chat, host, translate)}>
            {translate('ai.sessions.restore')}
          </button>
        </span>
      ) : (
        <button
          {...dragProps}
          className="ai-list-open"
          title={chat.title}
          aria-current={props.selected ? 'true' : undefined}
          onClick={() => void openChat(chat.id)}
          onKeyDown={onKeyDown}
        >
          {lead}
          <span className="ai-row-text">
            <span className="ai-row-line">
              <span className="ai-list-title">{chat.title}</span>
              {chat.pinned && <PinIcon size={11} className="ai-row-pin" aria-label={translate('ai.sessions.pinned')} />}
            </span>
            {meta}
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
