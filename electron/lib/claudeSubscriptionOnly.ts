// The AI panel runs Claude on a Claude subscription only, so nobody is billed per use without knowing. This file
// switches off every route to another kind of billing that can be switched off; agentSetup.ts then accepts only a
// sign-in it can prove is a subscription, and claudeBilling.ts watches what a running session says it uses.
//
// Every Claude process the panel starts goes through both halves of this file; each closes what the other cannot:
//
// - The environment: the variables below are removed, however they got there (the app's own environment, a terminal
//   launch, the login shell), and the folder Anthropic sign-in profiles are read from is pointed at nothing.
// - The flag settings (`--settings`, or `_meta.claudeCode.options.settings` through the adapter): an empty
//   `apiKeyHelper`, the same variables empty and the same profile folder. Why: a settings file's `env` block replaces
//   the inherited environment, and a helper is a settings key. Command-line settings rank above user, project and
//   project-local files (https://code.claude.com/docs/en/settings#settings-precedence).
//
// Checked with Claude Code 2.1.332 against a local fake API, with made-up credentials only: with a bearer token, API
// key, gateway address, extra header, Bedrock, Vertex or Foundry switch, or named profile in a user, project or local
// `env` block, a subscription sign-in was still the one used, and without one the CLI said it was not signed in. A
// Console or federation profile on disk was not read. Other `env` entries stay.
//
// What stays allowed: a claude.ai sign-in and CLAUDE_CODE_OAUTH_TOKEN (the long-lived token of `claude setup-token`,
// which needs a subscription). CLAUDE_CONFIG_DIR only moves the CLI's folder; the sign-in found there is checked
// like any other.
//
// What neither half can close, because it outranks the command line: managed (organisation) settings. The status
// check refuses a key, token or cloud provider they put in effect; a custom API address they set is not reported.
import os from 'node:os';
import type { AgentId } from '../../shared/properties/ai/agentIds';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Variables that choose another kind of billing, or send requests (and the sign-in) somewhere else. Why the API
 * address and extra headers: a gateway bills as its owner likes, and a header can carry a key.
 */
export const CLAUDE_BLOCKED_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
] as const;

/** Where Anthropic sign-in profiles (Console and federation) are read from: nothing can be inside the null device. */
const PROFILE_FOLDER_VARIABLE = 'ANTHROPIC_CONFIG_DIR';

const BLOCKED: ReadonlySet<string> = new Set([...CLAUDE_BLOCKED_VARIABLES, PROFILE_FOLDER_VARIABLE]);

/** The settings that switch the other routes off for one process or session; nothing is written to the person's files. */
export const CLAUDE_SUBSCRIPTION_SETTINGS: { readonly apiKeyHelper: ''; readonly env: Readonly<Record<string, string>> } = {
  apiKeyHelper: '',
  env: { ...Object.fromEntries(CLAUDE_BLOCKED_VARIABLES.map((name) => [name, ''])), [PROFILE_FOLDER_VARIABLE]: os.devNull },
};

/** `--settings` for a Claude command, with `more` settings of the command's own in the same argument. */
export function claudeSettingsArguments(more: Readonly<Record<string, unknown>> = {}): readonly string[] {
  return ['--settings', JSON.stringify({ ...more, ...CLAUDE_SUBSCRIPTION_SETTINGS })];
}

/** The environment a process of `agent` starts with: Claude's holds no other route (Windows ignores a name's case). */
export function claudeSubscriptionEnvironment(agent: AgentId, environment: Environment): Environment {
  if (agent !== 'claude') {
    return environment;
  }
  const kept = Object.entries(environment).filter(([name]) => !BLOCKED.has(name.toUpperCase()));
  return { ...Object.fromEntries(kept), [PROFILE_FOLDER_VARIABLE]: os.devNull };
}

/**
 * The messages of Claude's own that the adapter is asked to pass on as `_claude/sdkMessage`: what each turn says it
 * signs in with, and the plan's usage limits (shared/properties/ai/claudeBilling.ts reads them).
 */
const RAW_MESSAGES = [{ type: 'system', subtype: 'init' }, { type: 'rate_limit_event' }] as const;

/**
 * What the adapter is asked with when it opens or reopens a session (`session/new`, resume, load and fork): the
 * settings above, the messages above, and `allow`, the permission rules the session has besides the person's own
 * (permission lists merge with their files', so nothing of theirs is replaced).
 */
export function claudeSessionMeta(agent: AgentId, allow: readonly string[]): { readonly _meta?: Readonly<Record<string, unknown>> } {
  const settings = { ...CLAUDE_SUBSCRIPTION_SETTINGS, ...(allow.length === 0 ? {} : { permissions: { allow } }) };
  return agent === 'claude' ? { _meta: { claudeCode: { options: { settings }, emitRawSDKMessages: RAW_MESSAGES } } } : {};
}
