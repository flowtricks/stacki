// The model chip ("Sonnet 5.5  Medium") and the menu it opens: the agent's first models with number
// shortcuts, "Effort" (a submenu), the switches the agent offers (Ultracode, Fast mode), "More models"
// and, last, "Agent" to change provider.
//
// Why the provider sits here and not in the "+" menu: it decides which models there are, so it is part of
// the same choice; and as the last row it does not push the models, the thing people change, down the menu.
// Before the first message the provider is replaced (the empty chat is swapped); after it, choosing the
// other provider opens a new chat and keeps this one (switchProvider).
import { agentLabel } from '../../../../shared/properties/ai/agentIds';
import { splitModels, toggleOptions } from '../../../../shared/properties/ai/agentPresentation';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { AgentLogo, agentSwitchEntries } from '../agentSwitch';
import { currentChoiceName, modelOption, type ComposerSettings } from './composerSettings';
import { effortEntries, effortLabel } from './EffortSubmenu';
import { StatusChip } from './StatusChip';

/** The rows of the model menu for these settings. Pure: the chip below only opens it. */
export function modelMenuEntries(settings: ComposerSettings, translate: Translator): readonly MenuEntry[] {
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
  const effort = effortEntries(settings, translate);
  if (effort !== undefined) {
    if (entries.length > 0) {
      entries.push({ kind: 'divider', id: 'divider-effort' });
    }
    entries.push({
      kind: 'submenu',
      id: 'effort',
      label: translate('ai.composer.effort'),
      value: effortLabel(settings, translate) ?? translate('ai.composer.default'),
      entries: effort,
    });
  }
  for (const toggle of toggleOptions(settings.agent, settings.options)) {
    entries.push({
      kind: 'toggle',
      id: `toggle:${toggle.optionId}`,
      label: toggle.labelKey === undefined ? toggle.label : translate(toggle.labelKey),
      on: toggle.on,
      onChange: (next) => settings.pick(toggle.optionId, next ? toggle.onValue : toggle.offValue),
    });
  }
  if (model !== undefined && split !== undefined && split.more.length > 0) {
    entries.push({
      kind: 'submenu',
      id: 'more-models',
      label: translate('ai.composer.moreModels'),
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
  entries.push({
    kind: 'submenu',
    id: 'agent',
    label: translate('ai.agent.switch.menu'),
    value: agentLabel(settings.agent),
    entries: agentSwitchEntries({ agent: settings.agent, chat: settings.chat, started: settings.started, badges: settings.agentBadges ?? {}, translate }),
  });
  // Last, so a slip while choosing a model cannot land on it: forgets the remembered mode, model, effort and switches.
  entries.push({ kind: 'divider', id: 'divider-reset' });
  entries.push({
    kind: 'item',
    id: 'reset',
    label: translate('ai.composer.model.reset'),
    description: translate('ai.composer.model.resetHint', { agent: agentLabel(settings.agent) }),
    disabled: !settings.canReset,
    onSelect: settings.reset,
  });
  return entries;
}

export function ModelMenu({ settings }: { readonly settings: ComposerSettings }) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const model = modelOption(settings);
  const modelName = currentChoiceName(model) ?? agentLabel(settings.agent);
  const level = effortLabel(settings, translate);
  return (
    <>
      <StatusChip
        buttonRef={trigger.ref}
        open={trigger.open}
        disabled={settings.running}
        tone="plain"
        ariaLabel={translate('ai.composer.model')}
        title={
          settings.running
            ? translate('ai.composer.model.locked')
            : level === undefined
              ? modelName
              : translate('ai.composer.model.title', { model: modelName, effort: level })
        }
        onClick={trigger.toggle}
      >
        <span className="ai-chip-logo">
          <AgentLogo agent={settings.agent} />
        </span>
        <span className="ai-chip-text">{modelName}</span>
        {level !== undefined && <span className="ai-chip-quiet">{level}</span>}
      </StatusChip>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        entries={modelMenuEntries(settings, translate)}
        label={translate('ai.composer.model')}
        placement="above-start"
        onClose={trigger.close}
      />
    </>
  );
}
