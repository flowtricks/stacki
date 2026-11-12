// The effort rows of the model menu's "Effort" submenu: the muted line about what effort costs, then
// Low to Max (and Ultra for Codex) with a check on the current one, a "Recommended" pill where the
// table in agentPresentation.ts names one, and an info mark on the levels that spend limits fast.
import { AGENT_PRESENTATION, effortRows, isRecommendedEffort } from '../../../../shared/properties/ai/agentPresentation';
import type { MenuEntry } from '../../../ui/Menu';
import { currentChoiceName, effortOption, type ComposerSettings } from './composerSettings';

/** The rows to show under "Effort", or undefined when the agent offers no effort setting. */
export function effortEntries(settings: ComposerSettings): readonly MenuEntry[] | undefined {
  const option = effortOption(settings);
  if (option === undefined) {
    return undefined;
  }
  const presentation = AGENT_PRESENTATION[settings.agent].effort;
  const rows = effortRows(settings.agent, option.choices);
  if (rows.length === 0) {
    return undefined;
  }
  const entries: MenuEntry[] = [{ kind: 'note', id: 'effort-note', text: presentation.description }];
  for (const row of rows) {
    const info = presentation.info[row.value];
    entries.push({
      kind: 'item',
      id: `effort:${row.value}`,
      label: row.label,
      checked: row.value === option.currentValue,
      ...(isRecommendedEffort(settings.agent, row.value) ? { pill: 'Recommended' } : {}),
      ...(info === undefined ? {} : { info }),
      onSelect: () => settings.pick(option.id, row.value),
    });
  }
  return entries;
}

/** The name the chip and the "Effort" row show for the current level; undefined while the agent's own default is in use. */
export function effortLabel(settings: ComposerSettings): string | undefined {
  const option = effortOption(settings);
  if (option === undefined) {
    return undefined;
  }
  const row = effortRows(settings.agent, option.choices).find((candidate) => candidate.value === option.currentValue);
  return row === undefined ? currentChoiceNameIfShown(settings) : row.label;
}

// A current value the table hides ("default") is the agent's own pick, so no level is named.
function currentChoiceNameIfShown(settings: ComposerSettings): string | undefined {
  const option = effortOption(settings);
  const hidden = AGENT_PRESENTATION[settings.agent].effort.hidden;
  return option === undefined || hidden.includes(option.currentValue) ? undefined : currentChoiceName(option);
}
