// "Auto-compact at": the person's saved percentage (undefined: the agent's default), kept once in the renderer so the
// context panel's row and Settings show the same choice at once. The main process owns the saved value and applies it
// to adapters it starts afterwards (shared/properties/ai/autoCompact.ts); this file only reads and saves it, and goes
// back to what was saved when saving fails, so the picker never shows a choice the next launch will not have.
import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AUTO_COMPACT_PRESETS } from '../../../shared/properties/ai/autoCompact';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import FittedTooltip from '../../ui/FittedTooltip';
import { aiAutoCompactGet, aiAutoCompactSet } from './aiBridge';

const DEFAULT_VALUE = 'default';

let percent: number | undefined;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: number | undefined): void {
  if (next === percent) {
    return;
  }
  percent = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAutoCompactPercent(): number | undefined {
  useEffect(() => {
    if (!loaded) {
      loaded = true;
      void aiAutoCompactGet().then((reply) => {
        if (reply.ok) {
          publish(reply.value.percent);
        }
      });
    }
  }, []);
  return useSyncExternalStore(subscribe, () => percent);
}

/** Saves the choice and shows it at once; resolves to what the main process now holds. */
export async function saveAutoCompactPercent(next: number | undefined): Promise<void> {
  const previous = percent;
  publish(next);
  const reply = await aiAutoCompactSet(next);
  publish(reply.ok ? reply.value.percent : previous);
}

/** The custom dropdown of the presets and "Agent default", used by the context panel and by Settings. */
export function AutoCompactPicker({ ariaLabel, variant = 'full' }: { readonly ariaLabel: string; readonly variant?: 'full' | 'short' }) {
  const translate = useTranslate();
  const current = useAutoCompactPercent();
  // The short form is for the context panel: "Auto 80%" / "Auto: default" never wraps; the long words are the tooltip.
  const short = variant === 'short';
  const labelOf = (preset: number): string => (short ? translate('ai.autoCompact.percent', { percent: preset }) : `${preset}%`);
  const options: readonly DropdownOption<string>[] = [
    { value: DEFAULT_VALUE, label: translate(short ? 'ai.autoCompact.agentDefault' : 'ai.autoCompact.default') },
    ...AUTO_COMPACT_PRESETS.map((preset) => ({ value: String(preset), label: labelOf(preset) })),
  ];
  // A saved value that is not a preset (an edited settings file) still shows as itself.
  const value = current === undefined ? DEFAULT_VALUE : String(current);
  const shown = options.some((option) => option.value === value) ? options : [...options, { value, label: labelOf(Number(value)) }];
  const tip = useDelayedTooltip();
  const picker = (
    <Dropdown
      ariaLabel={ariaLabel}
      value={value}
      options={shown}
      menuWidthMin={160}
      onChange={(picked) => void saveAutoCompactPercent(picked === DEFAULT_VALUE ? undefined : Number(picked))}
    />
  );
  if (!short) {
    return picker;
  }
  return (
    <span className="ai-ring-auto" onMouseEnter={tip.show} onMouseLeave={tip.hide}>
      {picker}
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tip.value} preferred="above">
            {translate('ai.autoCompact.info')}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </span>
  );
}
