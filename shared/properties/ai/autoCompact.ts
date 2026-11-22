// "Auto-compact at": the share of the context window at which the agent compacts the conversation by itself.
// One preference per person (the app's settings file), an integer percentage, or none: the agent's own default.
//
// What applies it, per agent, and why only Claude:
//   - Claude Code reads `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (the percentage of the window at which auto-compaction triggers; it is in
//     the installed adapter's bundled CLI). Stacki puts it in the environment of the adapter process it spawns (agentHost.ts), so
//     it applies to adapters started after the choice, which is every new chat's first message after the adapter has idled out.
//   - Codex compacts by a token count (`model_auto_compact_token_limit`), not a percentage, and the window is only known once a
//     session reports it, after the process is spawned. Stacki sets nothing for Codex, so the setting is not offered for it.
import { assert } from '../../core/assert';
import type { AgentId } from './agentIds';

export const AUTO_COMPACT_LIMITS = {
  /** Lowest and highest percentage that may be saved: lower compacts constantly, higher leaves no room for the summary. */
  percentMin: 30,
  percentMax: 95,
} as const;

/** The choices Settings offers besides "Agent default". */
export const AUTO_COMPACT_PRESETS = [50, 60, 70, 80, 90] as const;

/** The environment variable Claude Code reads. */
export const AUTO_COMPACT_VARIABLE = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';

/** Whether Stacki can apply the setting for this agent; the setting is hidden for an agent that cannot (autoCompactSupported). */
export function autoCompactSupported(agent: AgentId): boolean {
  return agent === 'claude';
}

/** A saved percentage: an integer from the lowest to the highest bound; anything else is rejected at the boundary. */
export function parseAutoCompactPercent(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
    throw new Error('Auto-compact: expected an integer percentage');
  }
  if (input < AUTO_COMPACT_LIMITS.percentMin || input > AUTO_COMPACT_LIMITS.percentMax) {
    throw new Error('Auto-compact: percentage out of range');
  }
  return input;
}

/** The variables that apply `percent` to a spawned adapter for `agent`; none for the agent's own default or an agent that cannot. */
export function autoCompactEnvironment(agent: AgentId, percent: number | undefined): Readonly<Record<string, string>> {
  if (percent === undefined || !autoCompactSupported(agent)) {
    return {};
  }
  parseAutoCompactPercent(percent);
  const environment = { [AUTO_COMPACT_VARIABLE]: String(percent) };
  assert(Object.keys(environment).length === 1, 'autoCompactEnvironment: one variable');
  return environment;
}

/** The bar's colour: blue below 70% of the window, amber from 70%, red from 90%; "unknown" before a window is reported. */
export type ContextBarTone = 'unknown' | 'blue' | 'amber' | 'red';

export function contextBarTone(percent: number | undefined): ContextBarTone {
  if (percent === undefined) {
    return 'unknown';
  }
  assert(Number.isFinite(percent), 'contextBarTone: a finite percentage');
  if (percent >= 90) {
    return 'red';
  }
  if (percent >= 70) {
    return 'amber';
  }
  return 'blue';
}
