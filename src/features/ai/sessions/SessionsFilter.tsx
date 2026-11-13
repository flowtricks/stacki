// The filter button of the sessions list and its menu: show archived chats, only unread, only pinned, and one
// agent. The order of the list is the person's own (drag), so the menu says so rather than offering a sort.
// A mark on the funnel tells that something other than the defaults is on.
import { AGENT_IDS, agentLabel } from '../../../../shared/properties/ai/agentIds';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { FilterIcon } from '../../../ui/Icons';
import Menu, { useMenuTrigger } from '../../../ui/Menu';
import type { MenuEntry } from '../../../ui/Menu';
import { setChatListFilter, useAiState } from '../aiStore';
import type { ChatListFilter } from '../aiStore';
import { isCustomFilter } from './sessionsModel';

export function SessionsFilter() {
  const translate = useTranslate();
  const { filter } = useAiState();
  const trigger = useMenuTrigger();
  return (
    <>
      <button
        ref={trigger.ref}
        className={`ghost ai-filter-button${isCustomFilter(filter) ? ' on' : ''}`}
        aria-label={translate('ai.sessions.filter')}
        title={translate('ai.sessions.filter')}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        onClick={trigger.toggle}
      >
        <FilterIcon size={14} />
      </button>
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
      on: filter.showArchived,
      onChange: (showArchived) => change('showArchived', showArchived),
    },
    {
      kind: 'toggle',
      id: 'unread',
      label: translate('ai.sessions.filter.unread'),
      on: filter.onlyUnread,
      onChange: (onlyUnread) => change('onlyUnread', onlyUnread),
    },
    {
      kind: 'toggle',
      id: 'pinned',
      label: translate('ai.sessions.filter.pinned'),
      on: filter.onlyPinned,
      onChange: (onlyPinned) => change('onlyPinned', onlyPinned),
    },
    { kind: 'divider', id: 'divider-agent' },
    {
      kind: 'submenu',
      id: 'agent',
      label: translate('ai.agent.switch.menu'),
      value: filter.agent === undefined ? translate('ai.sessions.filter.all') : agentLabel(filter.agent),
      entries: [
        {
          kind: 'item',
          id: 'agent-all',
          label: translate('ai.sessions.filter.all'),
          checked: filter.agent === undefined,
          onSelect: () => change('agent', undefined),
        },
        ...AGENT_IDS.map((agent): MenuEntry => ({
          kind: 'item',
          id: `agent-${agent}`,
          label: agentLabel(agent),
          checked: filter.agent === agent,
          onSelect: () => change('agent', agent),
        })),
      ],
    },
    { kind: 'divider', id: 'divider-order' },
    { kind: 'note', id: 'order', text: translate('ai.sessions.filter.order') },
  ];
}
