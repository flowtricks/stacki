// The filter button of the sessions list and its menu: show archived chats, only unread, only pinned, and one
// agent. The order of the list is the person's own (drag), so the menu says so rather than offering a sort.
// A blue dot on the funnel tells that something other than the defaults is on, so a list that looks short says why.
import { AGENT_IDS, agentLabel } from '../../../../shared/properties/ai/agentIds';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { AgentIcon, FilterIcon, HideIcon, MailIcon, PinIcon } from '../../../ui/Icons';
import { ProviderLogo } from '../AgentChoices';
import Menu, { useMenuTrigger } from '../../../ui/Menu';
import type { MenuEntry } from '../../../ui/Menu';
import { setChatListFilter, useAiState } from '../aiStore';
import type { ChatListFilter } from '../aiStore';
import { isCustomFilter } from './sessionsModel';
import { TipButton } from './TipButton';

export function SessionsFilter() {
  const translate = useTranslate();
  const { filter, chats } = useAiState();
  const trigger = useMenuTrigger();
  const on = isCustomFilter(filter);
  // With no chats at all, archived ones included, there is nothing to filter, so there is no button.
  if (chats.length === 0) {
    return undefined;
  }
  return (
    <>
      <TipButton
        buttonRef={trigger.ref}
        className={`ai-filter-button${on ? ' on' : ''}`}
        label={translate('ai.sessions.filter')}
        menu={{ open: trigger.open }}
        onClick={trigger.toggle}
      >
        <FilterIcon size={14} />
        {on && <span className="ai-filter-badge" aria-hidden="true" />}
      </TipButton>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.sessions.filter')}
        placement="below-end"
        entries={trigger.open ? filterMenuEntries(filter, translate) : []}
        onClose={trigger.close}
      />
    </>
  );
}

export function filterMenuEntries(filter: ChatListFilter, translate: Translator): readonly MenuEntry[] {
  const change = <Key extends 'showArchived' | 'onlyUnread' | 'onlyPinned' | 'agent'>(key: Key, value: ChatListFilter[Key]): void =>
    setChatListFilter({ ...filter, [key]: value });
  return [
    {
      kind: 'toggle',
      id: 'archived',
      label: translate('ai.sessions.filter.archived'),
      icon: <HideIcon size={14} />,
      on: filter.showArchived,
      onChange: (showArchived) => change('showArchived', showArchived),
    },
    {
      kind: 'toggle',
      id: 'unread',
      label: translate('ai.sessions.filter.unread'),
      icon: <MailIcon size={14} />,
      on: filter.onlyUnread,
      onChange: (onlyUnread) => change('onlyUnread', onlyUnread),
    },
    {
      kind: 'toggle',
      id: 'pinned',
      label: translate('ai.sessions.filter.pinned'),
      icon: <PinIcon size={14} />,
      on: filter.onlyPinned,
      onChange: (onlyPinned) => change('onlyPinned', onlyPinned),
    },
    { kind: 'divider', id: 'divider-agent' },
    {
      kind: 'submenu',
      id: 'agent',
      label: translate('ai.agent.switch.menu'),
      icon: <AgentIcon size={14} />,
      value: filter.agent === undefined ? translate('ai.sessions.filter.all') : agentLabel(filter.agent),
      entries: [
        {
          kind: 'item',
          id: 'agent-all',
          label: translate('ai.sessions.filter.all'),
          icon: <AgentIcon size={14} />,
          checked: filter.agent === undefined,
          onSelect: () => change('agent', undefined),
        },
        ...AGENT_IDS.map((agent): MenuEntry => ({
          kind: 'item',
          id: `agent-${agent}`,
          label: agentLabel(agent),
          icon: <ProviderLogo provider={agent} size={14} />,
          checked: filter.agent === agent,
          onSelect: () => change('agent', agent),
        })),
      ],
    },
  ];
}
