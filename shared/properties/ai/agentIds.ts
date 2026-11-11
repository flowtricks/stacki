// The coding agents the AI chat panel drives, by the person's own sign-in.
// Stacki never shows a login form and never reads a token: the agent's own
// command-line tool owns the sign-in, run in Stacki's terminal (`signInCommand`).
// The UI names each agent by its product ("Claude", not "Claude Code").
import { assert } from '../../core/assert';

export const AGENT_IDS = ['claude', 'codex'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentDescription {
  readonly id: AgentId;
  /** The name the panel shows. */
  readonly label: string;
  /** The command-line tool the adapter runs, found on the person's PATH. */
  readonly cli: string;
  /** What the terminal runs so the person can sign in themselves. */
  readonly signInCommand: string;
  /** What to type once it starts, when the command does not sign in by itself. */
  readonly signInHint: string;
  /** Where the tool is installed from, for the "not installed" state. */
  readonly installURL: string;
}

export const AGENTS: Readonly<Record<AgentId, AgentDescription>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    cli: 'claude',
    signInCommand: 'claude',
    signInHint: 'Type /login, then follow the steps.',
    installURL: 'https://claude.com/product/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cli: 'codex',
    signInCommand: 'codex login',
    signInHint: 'Follow the steps in your browser.',
    installURL: 'https://developers.openai.com/codex/cli',
  },
};

export function parseAgentId(input: unknown): AgentId {
  const found = AGENT_IDS.find((id) => id === input);
  if (found === undefined) {
    throw new Error('AgentId: unknown agent');
  }
  assert(AGENTS[found].id === found, 'AgentId: every id has its description');
  return found;
}

export function agentLabel(id: AgentId): string {
  const label = AGENTS[id].label;
  assert(label.length > 0, 'agentLabel: every agent has a label');
  assert(!label.endsWith(' Code'), 'agentLabel: the panel names the product ("Claude"), not the CLI');
  return label;
}
