// How the composer presents each agent's session settings: the order of modes,
// which one is "Recommended", which ones need a confirmation, the effort names
// and copy, which options are two-choice switches (Ultracode, Fast mode), and
// which agents can compact a conversation.
//
// Why a table here and not the protocol: ACP carries the choices an agent offers
// (ids, names, descriptions) but not the product decisions around them. Claude's
// "recommended effort" is computed inside the adapter and only sent to clients
// that declare JetBrains AIR capabilities, which Stacki does not (docs/contracts.md,
// "Protocol capabilities Stacki declares"); "Auto is recommended" and the order of
// the mode menu are not in the protocol at all. This file is the only place
// "Recommended" lives. Everything here is data keyed by the agent's own option
// and choice ids, so a choice the table does not know is shown in the adapter's
// order with the adapter's own name: a newer adapter degrades to plain rows, it
// never hides a choice.
import { assert } from '../../core/assert';
import type { AgentId } from './agentIds';
import { AI_LIMITS } from './aiLimits';
import type { ChatOption } from './chatModel';

type Choice = ChatOption['choices'][number];

export interface ModePresentation {
  /** Choice ids in menu order; a choice not listed follows them in the adapter's order. */
  readonly order: readonly string[];
  /** The choice marked "Recommended". */
  readonly recommended: string | undefined;
  /** Choices that give the agent unrestricted access: choosing one asks for confirmation once. */
  readonly dangerous: readonly string[];
  /** The id of the option that holds the modes. */
  readonly optionId: string;
  /** Codex keeps "plan" in a second option (`collaboration_mode`), shown as one more row of the mode menu. */
  readonly planOptionId: string | undefined;
}

export interface EffortPresentation {
  readonly optionId: string;
  /** Choice ids in menu order. */
  readonly order: readonly string[];
  /** Choices left out of the menu (the adapter's "use my default"). */
  readonly hidden: readonly string[];
  /** Shorter names for the adapter's own ("xhigh" is "Extra"). */
  readonly labels: Readonly<Record<string, string>>;
  readonly recommended: string | undefined;
  /** Choices that get an information icon, with what it says. */
  readonly info: Readonly<Record<string, string>>;
  readonly description: string;
}

export interface AgentPresentation {
  readonly modes: ModePresentation;
  readonly effort: EffortPresentation;
  /** The option that holds the models, and how many models the menu lists before "More models". */
  readonly modelOptionId: string;
  readonly modelsPrimaryMax: number;
  /** Options shown as switch rows when they offer exactly "on" and "off". */
  readonly toggleOptionIds: readonly string[];
  /** Names for the switches, since the adapter's are terse ("Fast"). */
  readonly toggleLabels: Readonly<Record<string, string>>;
  /** The agent has a compact command (Claude's `/compact`); Codex has none in its recorded commands. */
  readonly canCompact: boolean;
}

const EFFORT_DESCRIPTION = 'Higher effort means more thorough responses, but takes longer and uses your limits faster.';

export const AGENT_PRESENTATION: Readonly<Record<AgentId, AgentPresentation>> = {
  claude: {
    modes: {
      optionId: 'mode',
      order: ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'],
      recommended: 'auto',
      dangerous: ['bypassPermissions'],
      planOptionId: undefined,
    },
    effort: {
      optionId: 'effort',
      order: ['low', 'medium', 'high', 'xhigh', 'max'],
      hidden: ['default'],
      labels: { xhigh: 'Extra' },
      recommended: 'medium',
      info: { max: 'Max effort can use your limits quickly.' },
      description: EFFORT_DESCRIPTION,
    },
    modelOptionId: 'model',
    modelsPrimaryMax: 4,
    toggleOptionIds: ['ultracode', 'fast'],
    toggleLabels: { ultracode: 'Ultracode', fast: 'Fast mode' },
    canCompact: true,
  },
  codex: {
    modes: {
      optionId: 'mode',
      order: ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
      recommended: undefined,
      dangerous: ['agent-full-access'],
      planOptionId: 'collaboration_mode',
    },
    effort: {
      optionId: 'reasoning_effort',
      order: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      hidden: [],
      labels: { xhigh: 'Extra' },
      recommended: 'medium',
      info: { max: 'Max effort can use your limits quickly.', ultra: 'Ultra delegates work to other agents and can use your limits quickly.' },
      description: EFFORT_DESCRIPTION,
    },
    modelOptionId: 'model',
    modelsPrimaryMax: 4,
    toggleOptionIds: ['fast-mode'],
    toggleLabels: { 'fast-mode': 'Fast mode' },
    canCompact: false,
  },
};

/** The choices in the table's order; any the table does not name follow in the adapter's order. */
export function orderedChoices(order: readonly string[], choices: readonly Choice[]): readonly Choice[] {
  assert(choices.length <= AI_LIMITS.configChoicesMax, 'orderedChoices: the choices come from a parsed option');
  const listed = order.flatMap((value) => choices.filter((choice) => choice.value === value));
  const rest = choices.filter((choice) => !order.includes(choice.value));
  const ordered = [...listed, ...rest];
  assert(ordered.length === choices.length, 'orderedChoices: every choice is shown once');
  return ordered;
}

export function modeChoices(agent: AgentId, choices: readonly Choice[]): readonly Choice[] {
  return orderedChoices(AGENT_PRESENTATION[agent].modes.order, choices);
}

/** Whether choosing this mode gives the agent unrestricted access, so the person is asked first. */
export function isDangerousMode(agent: AgentId, mode: string): boolean {
  return AGENT_PRESENTATION[agent].modes.dangerous.includes(mode);
}

export function isRecommendedMode(agent: AgentId, mode: string): boolean {
  return AGENT_PRESENTATION[agent].modes.recommended === mode;
}

/** The effort rows: the table's order, the hidden choice left out, each with the name the menu shows. */
export function effortRows(agent: AgentId, choices: readonly Choice[]): readonly { readonly value: string; readonly label: string; readonly choice: Choice }[] {
  const effort = AGENT_PRESENTATION[agent].effort;
  const rows = orderedChoices(effort.order, choices)
    .filter((choice) => !effort.hidden.includes(choice.value))
    .map((choice) => ({ value: choice.value, label: effort.labels[choice.value] ?? choice.name, choice }));
  assert(rows.length <= choices.length, 'effortRows: never more rows than choices');
  return rows;
}

export function isRecommendedEffort(agent: AgentId, value: string): boolean {
  return AGENT_PRESENTATION[agent].effort.recommended === value;
}

/** The first models are listed; the rest sit behind "More models". The split keeps the adapter's order. */
export function splitModels(agent: AgentId, choices: readonly Choice[]): { readonly primary: readonly Choice[]; readonly more: readonly Choice[] } {
  const primaryMax = AGENT_PRESENTATION[agent].modelsPrimaryMax;
  const split = { primary: choices.slice(0, primaryMax), more: choices.slice(primaryMax) };
  assert(split.primary.length + split.more.length === choices.length, 'splitModels: every model is in one list');
  return split;
}

/** A two-choice on/off option the menu shows as a switch row. */
export interface ToggleOption {
  readonly optionId: string;
  readonly label: string;
  readonly on: boolean;
  /** The values to send to switch it on and off. */
  readonly onValue: 'on';
  readonly offValue: 'off';
}

/** The options the agent offers that the table says are switches, in the table's order; an option that is not a clean on/off is left out. */
export function toggleOptions(agent: AgentId, options: readonly ChatOption[]): readonly ToggleOption[] {
  const presentation = AGENT_PRESENTATION[agent];
  const toggles: ToggleOption[] = [];
  for (const optionId of presentation.toggleOptionIds) {
    const option = options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      continue;
    }
    const values = option.choices.map((choice) => choice.value).sort();
    if (values.length !== 2 || values[0] !== 'off' || values[1] !== 'on') {
      continue;
    }
    toggles.push({ optionId, label: presentation.toggleLabels[optionId] ?? option.name, on: option.currentValue === 'on', onValue: 'on', offValue: 'off' });
  }
  assert(toggles.length <= presentation.toggleOptionIds.length, 'toggleOptions: only the switches the table names');
  return toggles;
}

export function canCompact(agent: AgentId): boolean {
  return AGENT_PRESENTATION[agent].canCompact;
}
