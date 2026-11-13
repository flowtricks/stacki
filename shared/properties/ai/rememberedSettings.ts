// The composer settings a person used last, per agent: permission mode, model, effort and every other
// option the agent's menus offer (Fast mode, Ultracode, Codex's plan switch). A new chat starts with them,
// so "whichever you used last" carries over instead of every chat starting from the agent's default.
//
// Why per agent: Claude and Codex name different options and values, so one agent's model or mode must
// never be applied to the other. Why ids are not hard-coded: the set is whatever the agent's own option
// list contains, so a new option works without a change here.
//
// The record is stored by the main process (`remembered-settings.json` beside the agents' option cache) and
// read back with `parseRememberedFile`, which never throws: a damaged file is the defaults, a damaged
// entry loses only itself, and `usableSettings` drops any value the agent no longer offers.
import { assert } from '../../core/assert';
import { AGENT_IDS, type AgentId } from './agentIds';
import { AI_LIMITS } from './aiLimits';
import type { ChatOption } from './chatModel';

export interface RememberedSetting {
  readonly option: string;
  readonly value: string;
}

export type RememberedSettings = Readonly<Record<AgentId, readonly RememberedSetting[]>>;

/** Nothing remembered: every agent starts from its own defaults. */
export const NO_REMEMBERED_SETTINGS: RememberedSettings = { claude: [], codex: [] };

/** What a change to the remembered set does: remember one choice, or forget the agent's whole set. */
export type RememberAction = { readonly kind: 'set'; readonly option: string; readonly value: string } | { readonly kind: 'reset' };

function isBoundedText(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= AI_LIMITS.idCharsMax;
}

/** One agent's list from untrusted input: bad entries, repeated options and anything past the bound are dropped. */
function parseAgentSettings(input: unknown): readonly RememberedSetting[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const settings: RememberedSetting[] = [];
  const entries: readonly unknown[] = input;
  for (const entry of entries.slice(0, AI_LIMITS.configOptionsMax)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const option: unknown = Reflect.get(entry, 'option');
    const value: unknown = Reflect.get(entry, 'value');
    if (isBoundedText(option) && isBoundedText(value) && !settings.some((setting) => setting.option === option)) {
      settings.push({ option, value });
    }
  }
  assert(settings.length <= AI_LIMITS.configOptionsMax, 'parseAgentSettings: bounded');
  return settings;
}

/**
 * The remembered set as the wire carries it (`{ claude: [...], codex: [...] }`). Total: anything that is not the
 * expected shape reads as "nothing remembered" for the part that is damaged, so a damaged reply never stops the
 * panel and a damaged entry loses only itself.
 */
export function parseRememberedSettings(input: unknown): RememberedSettings {
  if (typeof input !== 'object' || input === null) {
    return NO_REMEMBERED_SETTINGS;
  }
  const parsed: RememberedSettings = { claude: parseAgentSettings(Reflect.get(input, 'claude')), codex: parseAgentSettings(Reflect.get(input, 'codex')) };
  assert(
    AGENT_IDS.every((agent) => parsed[agent].length <= AI_LIMITS.configOptionsMax),
    'parseRememberedSettings: every agent is bounded',
  );
  return parsed;
}

/** The remembered set from the stored file (`{ version, agents }`); a corrupt file is the defaults, so a chat always starts. */
export function parseRememberedFile(input: unknown): RememberedSettings {
  if (typeof input !== 'object' || input === null) {
    return NO_REMEMBERED_SETTINGS;
  }
  return parseRememberedSettings(Reflect.get(input, 'agents'));
}

/** The text stored for a remembered set (the shape `parseRememberedSettings` reads back). */
export function serializeRememberedSettings(settings: RememberedSettings): string {
  return `${JSON.stringify({ version: 1, agents: settings })}\n`;
}

/** The set after `action` for `agent`; the other agent's entries are untouched. Last writer wins per option. */
export function applyRemember(settings: RememberedSettings, agent: AgentId, action: RememberAction): RememberedSettings {
  if (action.kind === 'reset') {
    return { ...settings, [agent]: [] };
  }
  const kept = settings[agent].filter((setting) => setting.option !== action.option);
  const next = [...kept, { option: action.option, value: action.value }].slice(-AI_LIMITS.configOptionsMax);
  assert(
    next.some((setting) => setting.option === action.option),
    'applyRemember: the choice is remembered',
  );
  assert(next.length <= AI_LIMITS.configOptionsMax, 'applyRemember: bounded');
  return { ...settings, [agent]: next };
}

/**
 * The remembered values the agent still offers. An option the agent no longer has, or a value that is no
 * longer one of its choices (a retired model, a mode the environment forbids), is dropped without a word:
 * the chat then uses the agent's own default for it.
 */
export function usableSettings(options: readonly ChatOption[], settings: readonly RememberedSetting[]): readonly RememberedSetting[] {
  return settings.filter((setting) =>
    options.some((option) => option.id === setting.option && option.choices.some((choice) => choice.value === setting.value)),
  );
}

/** `base` with every entry of `over` replacing the entry for the same option. */
export function overlaySettings(base: readonly RememberedSetting[], over: readonly RememberedSetting[]): readonly RememberedSetting[] {
  const merged = [...base.filter((setting) => !over.some((other) => other.option === setting.option)), ...over];
  return merged.slice(0, AI_LIMITS.configOptionsMax);
}

/** Parses the payload of the `ai:remember` action. */
export function parseRememberAction(input: unknown): RememberAction {
  if (typeof input !== 'object' || input === null) {
    throw new Error('remember action: expected object');
  }
  const kind: unknown = Reflect.get(input, 'kind');
  if (kind === 'reset') {
    return { kind: 'reset' };
  }
  if (kind === 'set') {
    const option: unknown = Reflect.get(input, 'option');
    const value: unknown = Reflect.get(input, 'value');
    if (!isBoundedText(option)) {
      throw new Error('remember action.option: expected bounded text');
    }
    if (!isBoundedText(value)) {
      throw new Error('remember action.value: expected bounded text');
    }
    return { kind: 'set', option, value };
  }
  throw new Error('remember action: unknown kind');
}
