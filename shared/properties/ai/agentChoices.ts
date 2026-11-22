// Which project agent the AI panel uses for each thing it does (its surfaces): a new chat, "Fix with
// AI" from the Audits panel, and "Build an app" from the Apps panel. Absent is the CLI's own default
// agent. The choice is a person's way of working in one project, so it is kept per project in this
// window's browser storage (like the composer's drafts), never in the project's tracked files.
//
// How a choice is applied, per provider:
// - Claude: the ACP adapter offers the project's agents as the session option `agent`
//   (claude-agent-acp 0.105.0, `session-config-options.js`), so a new chat carries the setting
//   `{ option: 'agent', value: <name> }` and main applies it once the session exists.
// - Codex: neither the Codex CLI nor its ACP adapter documents a way to run a session as a custom
//   agent (OpenAI's subagents page: an agent is spawned by naming it in a prompt), so a Codex agent
//   cannot be chosen; the menu says why instead of ignoring the choice.
//
// A choice whose agent was deleted, renamed or broken since reads as the default with a notice:
// `resolveAgentChoice` says which, and nothing is sent to the CLI for it.
import { assert } from '../../core/assert';
import { AGENT_IDS, type AgentId } from './agentIds';
import type { RememberedSetting } from './rememberedSettings';
import type { ProjectAgent } from '../projectAgents';

export const AGENT_SURFACES = ['chat', 'auditFix', 'appBuild'] as const;
export type AgentSurface = (typeof AGENT_SURFACES)[number];

export const AGENT_CHOICE_LIMITS = {
  /** Projects whose choices one window remembers; the least recently written goes first. */
  projectsMax: 50,
  /** Characters in a stored project path. */
  projectPathCharsMax: 1_024,
  /** Characters in a chosen agent's name, as the definitions bound it. */
  nameCharsMax: 64,
} as const satisfies Record<string, number>;

/** The session option the Claude adapter offers the project's agents under. */
export const CLAUDE_AGENT_OPTION_ID = 'agent';

/** Whether each provider can run a chat as a chosen agent. */
export const AGENT_CHOICE_SUPPORT: Readonly<Record<AgentId, 'session-option' | 'unsupported'>> = {
  claude: 'session-option',
  codex: 'unsupported',
};

export interface AgentChoice {
  readonly provider: AgentId;
  readonly name: string;
}

/** One project's choices: a surface without one uses the default agent. */
export type AgentChoices = Readonly<Record<AgentSurface, AgentChoice | undefined>>;

export const NO_AGENT_CHOICES: AgentChoices = { chat: undefined, auditFix: undefined, appBuild: undefined };

/** Every project's choices, in the order they were last written (oldest first). */
export interface StoredAgentChoices {
  readonly version: 1;
  readonly projects: readonly { readonly projectPath: string; readonly choices: AgentChoices }[];
}

export const EMPTY_STORED_AGENT_CHOICES: StoredAgentChoices = { version: 1, projects: [] };

function parseChoice(input: unknown): AgentChoice | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const provider = AGENT_IDS.find((id) => id === Reflect.get(input, 'provider'));
  const name: unknown = Reflect.get(input, 'name');
  if (provider === undefined || typeof name !== 'string' || name.length === 0 || name.length > AGENT_CHOICE_LIMITS.nameCharsMax) {
    return undefined;
  }
  return { provider, name };
}

function parseChoices(input: unknown): AgentChoices {
  if (typeof input !== 'object' || input === null) {
    return NO_AGENT_CHOICES;
  }
  const choices: AgentChoices = {
    chat: parseChoice(Reflect.get(input, 'chat')),
    auditFix: parseChoice(Reflect.get(input, 'auditFix')),
    appBuild: parseChoice(Reflect.get(input, 'appBuild')),
  };
  assert(Object.keys(choices).length === AGENT_SURFACES.length, 'parseChoices: one entry per surface');
  return choices;
}

/**
 * The stored choices, from browser storage's text. Total: anything unreadable is no choices, a damaged
 * project entry loses only itself, a repeated project keeps its last entry, and past the bound the
 * oldest entries are dropped, so a bad write never stops the panel from opening.
 */
export function parseStoredAgentChoices(raw: unknown): StoredAgentChoices {
  if (typeof raw !== 'string') {
    return EMPTY_STORED_AGENT_CHOICES;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return EMPTY_STORED_AGENT_CHOICES;
  }
  if (typeof parsed !== 'object' || parsed === null || Reflect.get(parsed, 'version') !== 1) {
    return EMPTY_STORED_AGENT_CHOICES;
  }
  const projects: unknown = Reflect.get(parsed, 'projects');
  if (!Array.isArray(projects)) {
    return EMPTY_STORED_AGENT_CHOICES;
  }
  const entries: readonly unknown[] = projects;
  const kept: { readonly projectPath: string; readonly choices: AgentChoices }[] = [];
  for (const entry of entries.slice(-AGENT_CHOICE_LIMITS.projectsMax * 2)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const projectPath: unknown = Reflect.get(entry, 'projectPath');
    if (typeof projectPath !== 'string' || projectPath.length === 0 || projectPath.length > AGENT_CHOICE_LIMITS.projectPathCharsMax) {
      continue;
    }
    const others = kept.filter((other) => other.projectPath !== projectPath);
    kept.length = 0;
    kept.push(...others, { projectPath, choices: parseChoices(Reflect.get(entry, 'choices')) });
  }
  const bounded = kept.slice(-AGENT_CHOICE_LIMITS.projectsMax);
  assert(bounded.length <= AGENT_CHOICE_LIMITS.projectsMax, 'parseStoredAgentChoices: bounded');
  return { version: 1, projects: bounded };
}

/** The text stored for the choices (what `parseStoredAgentChoices` reads back). */
export function serializeStoredAgentChoices(stored: StoredAgentChoices): string {
  assert(stored.projects.length <= AGENT_CHOICE_LIMITS.projectsMax, 'serializeStoredAgentChoices: bounded');
  return JSON.stringify(stored);
}

/** One project's choices; none stored is no choices. */
export function choicesFor(stored: StoredAgentChoices, projectPath: string): AgentChoices {
  return stored.projects.find((entry) => entry.projectPath === projectPath)?.choices ?? NO_AGENT_CHOICES;
}

/** The stored set with one surface's choice changed for one project, written last (so kept longest). */
export function withAgentChoice(
  stored: StoredAgentChoices,
  change: { readonly projectPath: string; readonly surface: AgentSurface; readonly choice: AgentChoice | undefined },
): StoredAgentChoices {
  assert(change.projectPath.length > 0, 'withAgentChoice: a project is named');
  assert(change.projectPath.length <= AGENT_CHOICE_LIMITS.projectPathCharsMax, 'withAgentChoice: the project path is bounded');
  const choices: AgentChoices = { ...choicesFor(stored, change.projectPath), [change.surface]: change.choice };
  const others = stored.projects.filter((entry) => entry.projectPath !== change.projectPath);
  const projects = [...others, { projectPath: change.projectPath, choices }].slice(-AGENT_CHOICE_LIMITS.projectsMax);
  return { version: 1, projects };
}

/** What a surface's choice means now, against the project's current definitions. */
export type ResolvedAgentChoice =
  | { readonly kind: 'default' }
  | { readonly kind: 'agent'; readonly agent: ProjectAgent }
  /** The chosen agent is gone (deleted, renamed) or broken: the default is used, and the panel says so. */
  | { readonly kind: 'missing'; readonly choice: AgentChoice }
  /** The chosen agent's provider cannot take an agent in a chat (Codex): the default is used, and the panel says so. */
  | { readonly kind: 'unsupported'; readonly choice: AgentChoice };

export function resolveAgentChoice(choice: AgentChoice | undefined, agents: readonly ProjectAgent[]): ResolvedAgentChoice {
  if (choice === undefined) {
    return { kind: 'default' };
  }
  if (AGENT_CHOICE_SUPPORT[choice.provider] === 'unsupported') {
    return { kind: 'unsupported', choice };
  }
  const agent = agents.find((candidate) => candidate.provider === choice.provider && candidate.name === choice.name && candidate.problems.length === 0);
  if (agent === undefined) {
    return { kind: 'missing', choice };
  }
  assert(agent.provider === choice.provider, 'resolveAgentChoice: the agent is the chosen provider’s');
  return { kind: 'agent', agent };
}

/**
 * The settings a new chat of `provider` carries for a resolved choice: the agent's session option when the
 * choice is that provider's and usable, else none (the CLI's default agent). A chat started with another
 * provider than the choice's runs its default agent, as the panel's notice says.
 */
export function agentSettingsFor(resolved: ResolvedAgentChoice, provider: AgentId): readonly RememberedSetting[] {
  if (resolved.kind !== 'agent' || resolved.agent.provider !== provider) {
    return [];
  }
  assert(AGENT_CHOICE_SUPPORT[provider] === 'session-option', 'agentSettingsFor: only a provider that takes an agent gets one');
  return [{ option: CLAUDE_AGENT_OPTION_ID, value: resolved.agent.name }];
}

/** The provider a surface's new chat runs on: the chosen agent's when there is a usable one, else the panel's preferred. */
export function providerFor(resolved: ResolvedAgentChoice, preferred: AgentId): AgentId {
  return resolved.kind === 'agent' ? resolved.agent.provider : preferred;
}
