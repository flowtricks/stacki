// What the status line's menus share: the settings the agent offers for this chat (already holding
// the value each is set to, live or chosen before the chat started), and the plain lookups on them.
// Pure, so the menus' rows can be built and tested without a browser.
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { AGENT_PRESENTATION } from '../../../../shared/properties/ai/agentPresentation';
import type { ChatId, ChatOption } from '../../../../shared/properties/ai/chatModel';

export interface ComposerSettings {
  readonly agent: AgentId;
  readonly chat: ChatId;
  /** The chat has a message: changing the provider then opens a new chat instead of replacing this one. */
  readonly started: boolean;
  /** A turn runs: settings apply to the next message, so the menus wait for the turn to end. */
  readonly running: boolean;
  /** Each option with `currentValue` set to what the chat uses (or will use when it starts). */
  readonly options: readonly ChatOption[];
  readonly pick: (optionId: string, value: string) => void;
  /** Each agent's state for the badge in the agent list; absent where nothing is known. */
  readonly agentBadges?: Readonly<Partial<Record<AgentId, 'ready' | 'sign-in' | 'not-installed' | 'installing'>>>;
}

export function optionById(options: readonly ChatOption[], optionId: string): ChatOption | undefined {
  return options.find((option) => option.id === optionId);
}

export function modelOption(settings: ComposerSettings): ChatOption | undefined {
  return optionById(settings.options, AGENT_PRESENTATION[settings.agent].modelOptionId);
}

export function effortOption(settings: ComposerSettings): ChatOption | undefined {
  return optionById(settings.options, AGENT_PRESENTATION[settings.agent].effort.optionId);
}

export function modeOption(settings: ComposerSettings): ChatOption | undefined {
  return optionById(settings.options, AGENT_PRESENTATION[settings.agent].modes.optionId);
}

/** Codex keeps "plan" in a second option; undefined for an agent that has none, or when it does not offer it. */
export function planOption(settings: ComposerSettings): ChatOption | undefined {
  const optionId = AGENT_PRESENTATION[settings.agent].modes.planOptionId;
  return optionId === undefined ? undefined : optionById(settings.options, optionId);
}

/** The name the agent gives the option's current choice, or undefined when the value is not one of its choices. */
export function currentChoiceName(option: ChatOption | undefined): string | undefined {
  return option?.choices.find((choice) => choice.value === option.currentValue)?.name;
}

/** The ids of the options that hold the mode: their value is never remembered for the next new chat. */
export function modeOptionIds(agent: AgentId): readonly string[] {
  const modes = AGENT_PRESENTATION[agent].modes;
  return modes.planOptionId === undefined ? [modes.optionId] : [modes.optionId, modes.planOptionId];
}
