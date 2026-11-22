// The AI panel's agent choice: a dialog with one Dropdown per surface (new chats, "Fix with AI", "Build an
// app") listing "Default" and the project's agents by provider, and a notice in the chat when a saved choice
// no longer applies. The choices and their rules are agentChoiceStore.ts and shared/properties/ai/agentChoices.ts.
//
// An agent the panel cannot run as is listed, not hidden, and disabled with the reason: a Codex agent (Codex
// takes no main-thread agent), or a definition with a problem (Settings > Agents shows which).
import { useEffect, type ReactNode } from 'react';
import { AGENT_IDS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import { AGENT_CHOICE_SUPPORT, AGENT_SURFACES, type AgentSurface, type ResolvedAgentChoice } from '../../../shared/properties/ai/agentChoices';
import type { ProjectAgent } from '../../../shared/properties/projectAgents';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import Popup from '../../ui/Popup';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { chooseAgent, refreshDefinitions, resolvedChoice, useAgentChoices, type AgentChoiceState } from './agentChoiceStore';
import './agentChoices.css';

const SURFACE_LABELS: Readonly<Record<AgentSurface, MessageKey>> = {
  chat: 'ai.agents.surface.chat',
  auditFix: 'ai.agents.surface.auditFix',
  appBuild: 'ai.agents.surface.appBuild',
};

const DEFAULT_VALUE = 'default';

/** The provider's official mark, as the composer's agent menu draws it. */
export function ProviderLogo({ provider, size }: { readonly provider: AgentId; readonly size: number }): ReactNode {
  switch (provider) {
    case 'claude':
      return <ClaudeLogo size={size} />;
    case 'codex':
      return <CodexLogo size={size} />;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function optionValue(agent: Pick<ProjectAgent, 'provider' | 'name'>): string {
  return `${agent.provider}:${agent.name}`;
}

export function AgentChoicesDialog({ onClose }: { readonly onClose: () => void }) {
  const translate = useTranslate();
  const state = useAgentChoices();
  useEffect(() => {
    void refreshDefinitions();
  }, []);
  return (
    <Popup className="modal ai-agent-choices" labelledBy="ai-agent-choices-title" onClose={onClose}>
      {({ close }) => (
        <div className="ai-agent-choices-body">
          <h2 id="ai-agent-choices-title">{translate('ai.agents.title')}</h2>
          <p className="ai-agent-choices-intro">{translate('ai.agents.intro')}</p>
          <ChoiceRows state={state} />
          <div className="ai-agent-choices-actions">
            <button type="button" className="ai-primary" onClick={close}>
              {translate('ai.agents.done')}
            </button>
          </div>
        </div>
      )}
    </Popup>
  );
}

function ChoiceRows({ state }: { readonly state: AgentChoiceState }) {
  const translate = useTranslate();
  if (state.definitions.kind === 'unknown') {
    // The rows' own shape while the definitions are read, so nothing jumps when they arrive.
    return (
      <div className="ai-agent-choices-rows">
        <SkeletonRows count={AGENT_SURFACES.length} row={() => <Skeleton height="30px" radius="6px" />} />
      </div>
    );
  }
  if (state.definitions.kind === 'unavailable') {
    return (
      <p className="ai-agent-choices-notice" role="alert">
        {translate('ai.agents.unavailable')}
      </p>
    );
  }
  const agents = state.definitions.agents;
  return (
    <div className="ai-agent-choices-rows">
      {agents.length === 0 && <p className="ai-agent-choices-notice">{translate('ai.agents.none')}</p>}
      {AGENT_SURFACES.map((surface) => (
        <ChoiceRow key={surface} surface={surface} state={state} agents={agents} />
      ))}
    </div>
  );
}

function ChoiceRow(props: { readonly surface: AgentSurface; readonly state: AgentChoiceState; readonly agents: readonly ProjectAgent[] }) {
  const translate = useTranslate();
  const resolved = resolvedChoice(props.surface, props.state);
  const options: DropdownOption[] = [
    { value: DEFAULT_VALUE, label: translate('ai.agents.default'), description: translate('ai.agents.default.hint'), pinned: true },
    ...AGENT_IDS.flatMap((provider) =>
      props.agents
        .filter((agent) => agent.provider === provider)
        .map((agent): DropdownOption => {
          const reason =
            AGENT_CHOICE_SUPPORT[provider] === 'unsupported'
              ? translate('ai.agents.codexUnsupported')
              : agent.problems.length > 0
                ? translate('ai.agents.invalid')
                : undefined;
          return {
            value: optionValue(agent),
            label: agent.name,
            group: agentLabel(provider),
            groupIcon: <ProviderLogo provider={provider} size={12} />,
            icon: <ProviderLogo provider={provider} size={14} />,
            ...(reason === undefined
              ? agent.description === undefined
                ? {}
                : { description: agent.description }
              : { description: reason, title: reason, disabled: true }),
          };
        }),
    ),
  ];
  const value = resolved.kind === 'agent' ? optionValue(resolved.agent) : DEFAULT_VALUE;
  const label = translate(SURFACE_LABELS[props.surface]);
  return (
    <div className="ai-agent-choice">
      <span className="ai-agent-choice-label">{label}</span>
      <Dropdown
        ariaLabel={label}
        value={value}
        options={options}
        optionLayout="stacked"
        menuWidthMin={260}
        onChange={(picked) => {
          const agent = props.agents.find((candidate) => optionValue(candidate) === picked);
          chooseAgent(props.surface, agent === undefined ? undefined : { provider: agent.provider, name: agent.name });
        }}
      />
      <ChoiceNotice surface={props.surface} resolved={resolved} />
    </div>
  );
}

/** Why a saved choice is not used, in a line under its row; nothing when it is used or there is none. */
function ChoiceNotice({ surface, resolved }: { readonly surface: AgentSurface; readonly resolved: ResolvedAgentChoice }) {
  const translate = useTranslate();
  const text = noticeText(surface, resolved, translate);
  return text === undefined ? undefined : (
    <p className="ai-agent-choices-notice" role="status">
      {text}
    </p>
  );
}

function noticeText(surface: AgentSurface, resolved: ResolvedAgentChoice, translate: ReturnType<typeof useTranslate>): string | undefined {
  const surfaceLabel = translate(SURFACE_LABELS[surface]);
  switch (resolved.kind) {
    case 'default':
    case 'agent':
      return undefined;
    case 'missing':
      return translate('ai.agents.missing', { name: resolved.choice.name, surface: surfaceLabel });
    case 'unsupported':
      return translate('ai.agents.unsupported', { name: resolved.choice.name, surface: surfaceLabel });
    default: {
      const exhaustive: never = resolved;
      return exhaustive;
    }
  }
}

/**
 * The open chat's quiet line when a saved choice no longer applies, so a task that ran with the default agent
 * is never a surprise: one line per surface, with the way to change it.
 */
export function AgentChoiceNotices({ onChoose }: { readonly onChoose: () => void }) {
  const translate = useTranslate();
  const state = useAgentChoices();
  if (state.definitions.kind !== 'known') {
    return undefined;
  }
  const lines = AGENT_SURFACES.flatMap((surface) => {
    const text = noticeText(surface, resolvedChoice(surface, state), translate);
    return text === undefined ? [] : [{ surface, text }];
  });
  if (lines.length === 0) {
    return undefined;
  }
  return (
    <div className="ai-agent-choice-banner" role="status">
      {lines.map((line) => (
        <span key={line.surface}>{line.text}</span>
      ))}
      <button type="button" className="ghost" onClick={onChoose}>
        {translate('ai.agents.change')}
      </button>
    </div>
  );
}
