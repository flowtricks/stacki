// The AI panel signs Claude in with a subscription (or another non-key sign-in), never with an Anthropic API key,
// so nobody is billed per use without knowing. Every Claude process the panel starts goes through both halves of
// this file; each closes routes the other cannot:
//
// - The environment: ANTHROPIC_API_KEY is removed, however it got there (the app's own environment, a terminal
//   launch, the login shell).
// - The flag settings (`--settings`, or `_meta.claudeCode.options.settings` through the adapter): an empty
//   `apiKeyHelper` and an empty ANTHROPIC_API_KEY. Why: a settings file's `env` block replaces the inherited
//   environment, and a helper is a settings key, so removing the variable alone leaves both. Command-line settings
//   rank above user, project and project-local files (https://code.claude.com/docs/en/settings#settings-precedence).
//   Checked with Claude Code 2.1.332 against a local fake API: with a made-up key in a user, project or local `env`
//   block or helper, requests carried only the other sign-in, and with none nothing was sent. Other `env` entries stay.
//
// What neither half can close, because it outranks the command line or is not a setting: managed (organisation)
// settings, and the key a Claude Console sign-in saves. `claude auth status` reports both as `api_key` or
// `api_key_helper` when they would be used, so no session starts without a status check that found another sign-in
// (agentSetup.ts `permit`).
import type { AgentId } from '../../shared/properties/ai/agentIds';

type Environment = Readonly<Record<string, string | undefined>>;

const API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

/** The settings that switch the key routes off for one process or session; nothing is written to the person's files. */
export const CLAUDE_NO_API_KEY_SETTINGS = { apiKeyHelper: '', env: { [API_KEY_VARIABLE]: '' } } as const;

/** `--settings` for a Claude command, with `more` settings of the command's own in the same argument. */
export function claudeSettingsArguments(more: Readonly<Record<string, unknown>> = {}): readonly string[] {
  return ['--settings', JSON.stringify({ ...more, ...CLAUDE_NO_API_KEY_SETTINGS })];
}

/** The environment a process of `agent` starts with: Claude's never holds an API key (Windows ignores a name's case). */
export function withoutClaudeAPIKey(agent: AgentId, environment: Environment): Environment {
  if (agent !== 'claude') {
    return environment;
  }
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== API_KEY_VARIABLE));
}

/** What the adapter is asked with when it opens or reopens a session (`session/new`, resume, load and fork). */
export function claudeSessionMeta(agent: AgentId): { readonly _meta?: Readonly<Record<string, unknown>> } {
  return agent === 'claude' ? { _meta: { claudeCode: { options: { settings: CLAUDE_NO_API_KEY_SETTINGS } } } } : {};
}
