// The model chip ("Sonnet 5.5  Medium") and the menu it opens: the agent's first models with number
// shortcuts, "Effort" (a submenu), the switches the agent offers (Ultracode, Fast mode), "More models"
// and, last, "Agent" to change provider.
//
// Why the provider sits here and not in the "+" menu: it decides which models there are, so it is part of
// the same choice; and as the last row it does not push the models, the thing people change, down the menu.
// Before the first message the provider is replaced (the empty chat is swapped); after it, choosing the
// other provider opens a new chat and keeps this one (switchProvider).
import { AGENT_IDS, agentLabel, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { splitModels, toggleOptions } from '../../../../shared/properties/ai/agentPresentation';
import { ClaudeLogo, CodexLogo } from '../../../ui/agentLogos';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { rememberAgent, switchProvider } from '../aiStore';
import { currentChoiceName, modelOption, type ComposerSettings } from './composerSettings';
import { effortEntries, effortLabel } from './EffortSubmenu';
import { StatusChip } from './StatusChip';

/** The rows of the model menu for these settings. Pure: the chip below only opens it. */
export function modelMenuEntries(settings: ComposerSettings): readonly MenuEntry[] {
  const entries: MenuEntry[] = [];
  const model = modelOption(settings);
  const split = model === undefined ? undefined : splitModels(settings.agent, model.choices);
  if (model !== undefined && split !== undefined) {
    split.primary.forEach((choice, index) => {
      entries.push({
        kind: 'item',
        id: `model:${choice.value}`,
        label: choice.name,
        numberKey: index + 1,
        checked: choice.value === model.currentValue,
        onSelect: () => settings.pick(model.id, choice.value),
      });
    });
  }
  const effort = effortEntries(settings);
  if (effort !== undefined) {
    if (entries.length > 0) {
      entries.push({ kind: 'divider', id: 'divider-effort' });
    }
    entries.push({ kind: 'submenu', id: 'effort', label: 'Effort', value: effortLabel(settings) ?? 'Default', entries: effort });
  }
  for (const toggle of toggleOptions(settings.agent, settings.options)) {
    entries.push({
      kind: 'toggle',
      id: `toggle:${toggle.optionId}`,
      label: toggle.label,
      on: toggle.on,
      onChange: (next) => settings.pick(toggle.optionId, next ? toggle.onValue : toggle.offValue),
    });
  }
  if (model !== undefined && split !== undefined && split.more.length > 0) {
    entries.push({
      kind: 'submenu',
      id: 'more-models',
      label: 'More models',
      entries: split.more.map((choice) => ({
        kind: 'item' as const,
        id: `more:${choice.value}`,
        label: choice.name,
        checked: choice.value === model.currentValue,
        onSelect: () => settings.pick(model.id, choice.value),
      })),
    });
  }
  if (entries.length > 0) {
    entries.push({ kind: 'divider', id: 'divider-agent' });
  }
  entries.push({ kind: 'submenu', id: 'agent', label: 'Agent', value: agentLabel(settings.agent), entries: agentEntries(settings) });
  return entries;
}

function agentEntries(settings: ComposerSettings): readonly MenuEntry[] {
  return AGENT_IDS.map((id) => ({
    kind: 'item' as const,
    id: `agent:${id}`,
    label: agentLabel(id),
    icon: <AgentLogo agent={id} />,
    checked: id === settings.agent,
    ...(settings.started && id !== settings.agent ? { description: 'Switches to a new chat' } : {}),
    onSelect: () => {
      if (id !== settings.agent) {
        rememberAgent(id);
        void switchProvider(settings.chat, id, { started: settings.started });
      }
    },
  }));
}

export function ModelMenu({ settings }: { readonly settings: ComposerSettings }) {
  const trigger = useMenuTrigger();
  const model = modelOption(settings);
  const modelName = currentChoiceName(model) ?? agentLabel(settings.agent);
  const level = effortLabel(settings);
  return (
    <>
      <StatusChip
        buttonRef={trigger.ref}
        open={trigger.open}
        disabled={settings.running}
        tone="plain"
        ariaLabel="Model"
        title={settings.running ? 'The model changes when the agent is done' : `${modelName}${level === undefined ? '' : `, ${level} effort`}`}
        onClick={trigger.toggle}
      >
        <span className="ai-chip-logo">
          <AgentLogo agent={settings.agent} />
        </span>
        <span className="ai-chip-text">{modelName}</span>
        {level !== undefined && <span className="ai-chip-quiet">{level}</span>}
      </StatusChip>
      <Menu open={trigger.open} anchor={trigger.anchor} entries={modelMenuEntries(settings)} label="Model" placement="above-start" onClose={trigger.close} />
    </>
  );
}

function AgentLogo({ agent }: { readonly agent: AgentId }) {
  switch (agent) {
    case 'claude':
      return <ClaudeLogo size={12} />;
    case 'codex':
      return <CodexLogo size={12} className="ai-logo-codex" />;
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}
