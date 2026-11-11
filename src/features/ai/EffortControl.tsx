// An agent's effort (reasoning) setting as Claude Code shows it: a compact
// segmented row of the levels the agent offers, not a menu. Falls back to a
// Dropdown when the agent offers more levels than fit a row.
import { assert } from '../../../shared/core/assert';
import type { ChatOption } from '../../../shared/properties/ai/chatModel';
import Dropdown from '../../ui/Dropdown';
import { SegmentedTabs } from '../../ui/SegmentedTabs';

const SEGMENTS_MAX = 6;

/** An effort option: the agent says so with the `thought_level` category. */
export function isEffort(option: ChatOption): boolean {
  return option.category === 'thought_level';
}

export function EffortControl({
  option,
  value,
  disabled,
  onPick,
}: {
  readonly option: ChatOption;
  readonly value: string;
  readonly disabled: boolean;
  readonly onPick: (value: string) => void;
}) {
  assert(isEffort(option), 'EffortControl: an effort option');
  assert(option.choices.length > 0, 'EffortControl: there is a level to choose');
  if (option.choices.length > SEGMENTS_MAX || disabled) {
    return (
      <Dropdown
        ariaLabel={option.name}
        className="ai-option"
        value={value}
        disabled={disabled}
        livePreview={false}
        options={option.choices.map((choice) => ({ value: choice.value, label: shortLevel(choice.name) }))}
        onChange={onPick}
      />
    );
  }
  return (
    <span className="ai-effort" title={option.name}>
      <SegmentedTabs
        label={option.name}
        value={value}
        tabs={option.choices.map((choice) => ({ value: choice.value, label: shortLevel(choice.name) }))}
        onPick={onPick}
      />
    </span>
  );
}

// "Extra high" and the like shorten to fit a segment; the full name is in the option's own list.
function shortLevel(name: string): string {
  const short: Readonly<Record<string, string>> = { 'Extra high': 'X-High', Default: 'Auto' };
  return short[name] ?? name;
}
