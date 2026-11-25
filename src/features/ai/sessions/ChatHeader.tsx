// The panel's header. On the list it reads "Chats" with the filter button and "+". In an open chat it is the way
// back to the list, the chat's title (double click renames it in place), a "⋯" menu with the same actions as
// the row's menu (letters included) and "+". Archiving or deleting the open chat returns to the list: the store
// does that, so the header only asks.
// The buttons sit together at the end: the filter, the "⋯" menu, then "+". The window's own controls (expand to
// fill the editor, pop out) are rows in that menu, on the list as in an open chat. In the split layout the list is
// always beside the chat, so there is no way back to show and the filter moves into the list's own search row.
import { useEffect, useState } from 'react';
import type { ChatSummary } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import {
  AgentIcon,
  ChevronLeftIcon,
  CollapseVerticalIcon,
  ExpandVerticalIcon,
  LayoutIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoreIcon,
  PlusIcon,
  PreviewIcon,
} from '../../../ui/Icons';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { newChat, openChat, preferredAgent, renameChat } from '../aiStore';
import type { ChatLayout } from '../chatLayout';
import { saveReviewMode, useReviewMode, type ReviewMode } from '../reviewChanges';
import { collapseAllItems, expandAllItems } from '../transcript/transcriptUi';
import { RenameField } from './RenameField';
import { AgentChoicesDialog } from '../AgentChoices';
import { SessionsFilter } from './SessionsFilter';
import { CHAT_TITLE_CHARS_MAX } from './sessionsModel';
import { TipButton } from './TipButton';
import { ModesMenu } from './ModesMenu';
import './sessions.css';

/** The host's expand toggle: the panel over the whole editor area, or back in the side panel. Absent where the host has none (a floating window). */
export interface PanelExpansion {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

/** The host's pop out toggle: the panel as a window of its own, or back in the side panel. */
export interface PanelWindow {
  readonly floating: boolean;
  readonly onToggle: () => void;
}

export interface ChatHeaderProps {
  readonly chat: ChatSummary | undefined;
  readonly layout?: ChatLayout | undefined;
  readonly expansion?: PanelExpansion | undefined;
  readonly windowToggle?: PanelWindow | undefined;
}

export function ChatHeader({ chat, layout = 'stacked', expansion, windowToggle }: ChatHeaderProps) {
  const translate = useTranslate();
  const windowEntries = panelWindowEntries(expansion, windowToggle, translate);
  // The Modes button (comment pins and any other registered mode) sits before "+", on the list as in a chat.
  const trailing = (
    <>
      <ModesMenu />
      <TipButton label={translate('ai.sessions.newChat')} onClick={() => void newChat(preferredAgent())}>
        <PlusIcon size={14} />
      </TipButton>
    </>
  );
  if (chat === undefined) {
    return (
      <div className="ai-header">
        <h2>{translate('ai.sessions.chats')}</h2>
        {layout === 'stacked' && <SessionsFilter />}
        <PanelMenu entries={windowEntries} />
        {trailing}
      </div>
    );
  }
  return (
    <div className="ai-header">
      {layout === 'stacked' && (
        <TipButton className="panel-header-back" label={translate('ai.sessions.allChats')} onClick={() => void openChat(undefined)}>
          <ChevronLeftIcon size={14} className="icon-mirror-rtl" />
        </TipButton>
      )}
      <OpenChatTitle chat={chat} windowEntries={windowEntries} />
      {trailing}
    </div>
  );
}

/** The "⋯" menu of the list: only the window's own controls, and nothing at all where the host offers none. */
function PanelMenu({ entries }: { readonly entries: readonly MenuEntry[] }) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  if (entries.length === 0) {
    return undefined;
  }
  return (
    <>
      <TipButton buttonRef={trigger.ref} label={translate('ai.sessions.chatActions')} menu={{ open: trigger.open }} onClick={trigger.toggle}>
        <MoreIcon size={14} />
      </TipButton>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.sessions.chatActions')}
        placement="below-end"
        entries={trigger.open ? entries : []}
        onClose={trigger.close}
      />
    </>
  );
}

/** The window's own controls as menu rows: expand over the editor (or return), and pop out (or dock). Each row names what it will do. */
function panelWindowEntries(expansion: PanelExpansion | undefined, windowToggle: PanelWindow | undefined, translate: Translator): readonly MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (expansion !== undefined) {
    entries.push({
      kind: 'item',
      id: 'expand-panel',
      label: translate(expansion.expanded ? 'ai.panel.collapse' : 'ai.panel.expand'),
      icon: <LayoutIcon size={14} />,
      onSelect: expansion.onToggle,
    });
  }
  if (windowToggle !== undefined) {
    entries.push({
      kind: 'item',
      id: 'pop-out-panel',
      label: translate(windowToggle.floating ? 'ui.dockableWindow.dock' : 'ui.dockableWindow.undock'),
      icon: windowToggle.floating ? <MaximizeIcon size={14} /> : <MinimizeIcon size={14} />,
      onSelect: windowToggle.onToggle,
    });
  }
  return entries;
}

/** The title and its "⋯" menu; renaming swaps the title for a field in the same place. */
function OpenChatTitle({ chat, windowEntries }: { readonly chat: ChatSummary; readonly windowEntries: readonly MenuEntry[] }) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const reviewMode = useReviewMode();
  const [renaming, setRenaming] = useState(false);
  const [choosingAgents, setChoosingAgents] = useState(false);
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
      <TipButton buttonRef={trigger.ref} label={translate('ai.sessions.chatActions')} menu={{ open: trigger.open }} onClick={trigger.toggle}>
        <MoreIcon size={14} />
      </TipButton>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.sessions.chatActions')}
        placement="below-end"
        entries={trigger.open ? menuEntries(chat, windowEntries, reviewMode, { chooseAgents: () => setChoosingAgents(true) }, translate) : []}
        onClose={trigger.close}
      />
      {choosingAgents && <AgentChoicesDialog onClose={() => setChoosingAgents(false)} />}
    </>
  );
}

/**
 * The open chat's "⋯" menu: the window's own controls first, then the project agent each kind of task runs with, the
 * person-wide switch for being asked to Keep AI changes (it applies to every chat), and folding every tool group, thought and
 * long message of the transcript at once. What acts on the chat itself (pin, rename, fork, move, archive, delete) is the chat
 * list's row menu, not repeated here. Every row has an icon and none a paragraph: the longer words are the row's tooltip.
 */
function menuEntries(
  chat: ChatSummary,
  windowEntries: readonly MenuEntry[],
  reviewMode: ReviewMode,
  actions: { readonly chooseAgents: () => void },
  translate: Translator,
): readonly MenuEntry[] {
  return [
    ...windowEntries,
    ...(windowEntries.length === 0 ? [] : [{ kind: 'divider' as const, id: 'divider-window' }]),
    {
      kind: 'item',
      id: 'choose-agents',
      label: translate('ai.agents.menu'),
      icon: <AgentIcon size={14} />,
      tooltip: translate('ai.agents.menu.info'),
      onSelect: actions.chooseAgents,
    },
    {
      kind: 'item',
      id: 'review-changes',
      label: translate('ai.menu.reviewChanges'),
      icon: <PreviewIcon size={14} />,
      tooltip: translate('ai.menu.reviewChanges.info'),
      checked: reviewMode === 'review',
      onSelect: () => void saveReviewMode(reviewMode === 'review' ? 'auto' : 'review'),
    },
    { kind: 'divider', id: 'divider-review' },
    {
      kind: 'item',
      id: 'expand-all',
      label: translate('ai.sessions.expandAll'),
      icon: <ExpandVerticalIcon size={14} />,
      accelerator: 'e',
      onSelect: () => expandAllItems(chat.id),
    },
    {
      kind: 'item',
      id: 'collapse-all',
      label: translate('ai.sessions.collapseAll'),
      icon: <CollapseVerticalIcon size={14} />,
      accelerator: 'c',
      onSelect: () => collapseAllItems(chat.id),
    },
  ];
}
