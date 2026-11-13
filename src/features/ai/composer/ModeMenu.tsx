// The mode chip ("Manual", "Plan", "Bypass permissions") and the Mode menu: one row per mode with the
// agent's own description, a number to press, a "Recommended" pill where agentPresentation.ts names one
// and a check on the current mode. A new chat starts in the mode the person used last (else the agent's
// own default); full access comes back only because the person chose it, through the confirmation below.
//
// Choosing a mode that gives the agent unrestricted access (isDangerousMode) asks once per chat through
// the app's confirmation dialog; after the yes, switching away and back in the same chat does not ask again.
import { agentLabel } from '../../../../shared/properties/ai/agentIds';
import { isDangerousMode, isRecommendedMode, modeChoices } from '../../../../shared/properties/ai/agentPresentation';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { currentChoiceName, modeOption, planOption, type ComposerSettings } from './composerSettings';
import { StatusChip } from './StatusChip';

/** Chats where the person already agreed to unrestricted access; this window's memory, like the chat's open state. */
const confirmedChats = new Set<ChatId>();

/** Forgets the agreements (tests, and a project switch). */
export function forgetDangerousModeConfirmations(): void {
  confirmedChats.clear();
}

/** The plan row Codex adds, standing for its separate `collaboration_mode` option. */
const PLAN_ROW_ID = 'plan';

/** Picks a mode, asking first when it is a dangerous one and the chat has not agreed yet. */
async function chooseMode(settings: ComposerSettings, optionId: string, value: string, label: string, translate: Translator): Promise<boolean> {
  if (isDangerousMode(settings.agent, value) && !confirmedChats.has(settings.chat)) {
    const answer = await confirmDialog({
      title: translate('ai.composer.mode.confirm.title', { mode: label }),
      body: translate('ai.composer.mode.confirm.body', { agent: agentLabel(settings.agent) }),
      confirmLabel: translate('ai.composer.mode.confirm.action', { mode: label }),
      cancelLabel: translate('ai.composer.mode.confirm.cancel'),
      danger: true,
    });
    if (answer !== true) {
      return false;
    }
    confirmedChats.add(settings.chat);
  }
  settings.pick(optionId, value);
  return true;
}

/** The rows of the Mode menu. Pure: the chip below only opens it. */
export function modeMenuEntries(settings: ComposerSettings, translate: Translator): readonly MenuEntry[] {
  const entries: MenuEntry[] = [{ kind: 'heading', id: 'heading', label: translate('ai.composer.mode') }];
  const option = modeOption(settings);
  if (option === undefined) {
    return entries;
  }
  const planning = planOption(settings);
  // Codex's plan switch is on while it says so; its other modes are then not the one in use.
  const planOn = planning?.currentValue === PLAN_ROW_ID;
  const choices = modeChoices(settings.agent, option.choices);
  choices.forEach((choice, index) => {
    entries.push({
      kind: 'item',
      id: `mode:${choice.value}`,
      label: choice.name,
      ...(choice.description === undefined ? {} : { description: choice.description }),
      numberKey: index + 1,
      checked: choice.value === option.currentValue && !planOn,
      ...(isRecommendedMode(settings.agent, choice.value) ? { pill: translate('ai.composer.recommended') } : {}),
      onSelect: () => {
        void chooseMode(settings, option.id, choice.value, choice.name, translate).then((picked) => {
          // Leaving Codex's plan switch is part of choosing another mode, but only once the choice went through.
          if (picked && planning !== undefined && planOn) {
            settings.pick(planning.id, 'default');
          }
        });
      },
    });
  });
  if (planning !== undefined && planning.choices.some((choice) => choice.value === PLAN_ROW_ID) && choices.length < 9) {
    entries.push({
      kind: 'item',
      id: 'mode:plan',
      label: translate('ai.composer.mode.plan'),
      description: translate('ai.composer.mode.planHint'),
      numberKey: choices.length + 1,
      checked: planOn,
      onSelect: () => settings.pick(planning.id, PLAN_ROW_ID),
    });
  }
  return entries;
}

/** What the chip says: the current mode's name, or "Plan" while Codex's plan switch is on. */
export function modeLabel(settings: ComposerSettings, translate: Translator): string | undefined {
  const planning = planOption(settings);
  if (planning?.currentValue === PLAN_ROW_ID) {
    return translate('ai.composer.mode.plan');
  }
  return currentChoiceName(modeOption(settings));
}

export function ModeMenu({ settings }: { readonly settings: ComposerSettings }) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const option = modeOption(settings);
  const label = modeLabel(settings, translate);
  if (option === undefined || label === undefined) {
    return undefined;
  }
  const dangerous = isDangerousMode(settings.agent, option.currentValue) && planOption(settings)?.currentValue !== PLAN_ROW_ID;
  return (
    <>
      <StatusChip
        buttonRef={trigger.ref}
        open={trigger.open}
        disabled={settings.running}
        tone={dangerous ? 'danger' : 'plain'}
        ariaLabel={translate('ai.composer.mode')}
        title={settings.running ? translate('ai.composer.mode.locked') : translate('ai.composer.mode.title', { mode: label })}
        onClick={trigger.toggle}
      >
        <span className="ai-chip-text">{label}</span>
      </StatusChip>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        entries={modeMenuEntries(settings, translate)}
        label={translate('ai.composer.mode')}
        placement="above-start"
        widthPxMin={260}
        onClose={trigger.close}
      />
    </>
  );
}
