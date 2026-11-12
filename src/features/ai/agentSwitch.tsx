// Changing the agent: the list both switchers share (the account header above the composer and the
// model menu's "Agent" row), the state badge each agent carries, and the agent's mark.
//
// Why one list: the two places must never disagree about what switching does. Before the first message
// the empty chat is replaced; after it, a new chat opens and this one stays (switchProvider). A signed-out
// or missing agent can still be chosen: the new chat then shows that agent's own sign-in or install card.
import type { ReactNode } from 'react';
import type { AgentAvailability, SetupState } from '../../../shared/ipc/aiChat';
import { AGENT_IDS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { ChatId } from '../../../shared/properties/ai/chatModel';
import type { Translator } from '../../lib/i18n/localeContext';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import type { MenuEntry } from '../../ui/Menu';
import { rememberAgent, switchProvider, type AiState } from './aiStore';

export type AgentBadge = 'ready' | 'sign-in' | 'not-installed' | 'installing';

/** Where each agent stands, for the badge in the list; undefined while nothing is known yet (no badge). */
export function agentBadge(state: Pick<AiState, 'agents' | 'setups'>, agent: AgentId): AgentBadge | undefined {
  const setup: SetupState | undefined = state.setups.get(agent);
  const availability: AgentAvailability | undefined = state.agents.find((entry) => entry.agent === agent);
  if (setup !== undefined) {
    switch (setup.step) {
      case 'missing':
        return 'not-installed';
      case 'installing':
        return 'installing';
      case 'signed-out':
      case 'signing-in':
        return 'sign-in';
      case 'ready':
        return 'ready';
      case 'failed':
        break;
      default: {
        const exhaustive: never = setup;
        return exhaustive;
      }
    }
  }
  if (availability === undefined) {
    return undefined;
  }
  switch (availability.state) {
    case 'missing-cli':
    case 'needs-install':
      return 'not-installed';
    case 'installing':
      return 'installing';
    case 'sign-in':
      return 'sign-in';
    case 'ready':
      return 'ready';
    case 'failed':
      return undefined;
    default: {
      const exhaustive: never = availability;
      return exhaustive;
    }
  }
}

export function badgeText(badge: AgentBadge, translate: Translator): string {
  switch (badge) {
    case 'ready':
      return translate('ai.agent.badge.ready');
    case 'sign-in':
      return translate('ai.agent.badge.signIn');
    case 'not-installed':
      return translate('ai.agent.badge.notInstalled');
    case 'installing':
      return translate('ai.agent.badge.installing');
    default: {
      const exhaustive: never = badge;
      return exhaustive;
    }
  }
}

/** One row per agent: its mark, a state badge, and the check at the end on the current one. */
export function agentSwitchEntries(input: {
  readonly agent: AgentId;
  readonly chat: ChatId;
  readonly started: boolean;
  readonly badges: Readonly<Partial<Record<AgentId, AgentBadge>>>;
  readonly translate: Translator;
}): readonly MenuEntry[] {
  return AGENT_IDS.map((id) => {
    const badge = input.badges[id];
    return {
      kind: 'item' as const,
      id: `agent:${id}`,
      label: agentLabel(id),
      icon: <AgentLogo agent={id} />,
      checked: id === input.agent,
      ...(badge === undefined ? {} : { pill: badgeText(badge, input.translate) }),
      ...(input.started && id !== input.agent ? { description: input.translate('ai.agent.switch.newChat') } : {}),
      onSelect: () => {
        if (id !== input.agent) {
          rememberAgent(id);
          void switchProvider(input.chat, id, { started: input.started });
        }
      },
    };
  });
}

export function AgentLogo({ agent, size = 12 }: { readonly agent: AgentId; readonly size?: number }): ReactNode {
  switch (agent) {
    case 'claude':
      return <ClaudeLogo size={size} />;
    case 'codex':
      return <CodexLogo size={size} className="ai-logo-codex" />;
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}
