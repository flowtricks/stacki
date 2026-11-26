// The sign-in settings a person set only in their shell's startup files, for the AI panel's agents.
//
// Why: an app opened from the Dock or a launcher (macOS, Linux) never runs .zprofile, .zshrc or .profile, so
// an API key, a config folder or a company proxy set there is missing, although the same CLI works in a
// terminal. Stacki asks the person's shell once, the way its own terminal starts it (a login shell that is
// also interactive, so .zshrc counts), and takes only the names on the lists below.
//
// What keeps this narrow:
// - Only listed names are kept, and each agent gets only its own list: Claude never sees a Codex key, nor
//   Codex an Anthropic one. A cloud provider's credentials are taken only when that provider is switched on.
// - Only the agent's own CLI and adapter get them. Installers, the dev server, git and the terminal do not
//   (the terminal's shell reads its startup files itself).
// - The app's own environment wins over the shell's.
// - A value is never logged, written to disk or sent to the window.
//
// Windows: nothing is read. Variables set for the user or the system already reach every app; variables set
// only in a PowerShell profile are not read.
//
// Bounds: the shell is asked once per run of the app, asynchronously and only when the AI panel first needs
// it; it has LOGIN_SHELL_LIMITS.readMsMax to answer in at most outputBytesMax of output. When it cannot be
// read, the agents start with the app's own environment.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { assert } from '../../shared/core/assert';
import type { AgentId } from '../../shared/properties/ai/agentIds';

export const LOGIN_SHELL_LIMITS = {
  readMsMax: 10_000,
  outputBytesMax: 1024 * 1024,
  valueCharsMax: 32 * 1024,
} as const satisfies Record<string, number>;

/**
 * Names that are the same thing spelled twice. When the app's own environment has either spelling, neither is
 * taken from the shell: the CLIs prefer the lower-case one, which would let the shell win over the app.
 */
const PROXY_PAIRS = [
  ['https_proxy', 'HTTPS_PROXY'],
  ['http_proxy', 'HTTP_PROXY'],
  ['no_proxy', 'NO_PROXY'],
] as const;

const PROXY_NAMES: readonly string[] = PROXY_PAIRS.flat();

/** A cloud provider: its switches, and the names taken only when one of them is on. */
interface CloudSettings {
  readonly switches: readonly string[];
  readonly names: readonly string[];
}

interface AgentSettings {
  readonly names: readonly string[];
  readonly clouds: readonly CloudSettings[];
}

/**
 * The lists, from each CLI's own documentation.
 * Claude: https://code.claude.com/docs/en/env-vars, /authentication, /amazon-bedrock, /claude-platform-on-aws,
 * /google-vertex-ai, /microsoft-foundry and /network-config.
 * Codex: https://developers.openai.com/codex/environment-variables and /auth, and the codex-acp adapter's
 * README (OPENAI_API_KEY, CODEX_API_KEY). Codex documents no proxy variable; its HTTP client reads the usual ones.
 * A custom Codex provider may name any variable (`env_key` in config.toml): those cannot be listed here.
 */
export const SIGN_IN_SETTINGS: Readonly<Record<AgentId, AgentSettings>> = {
  claude: {
    names: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_PROFILE',
      'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_ORGANIZATION_ID',
      'ANTHROPIC_WORKSPACE_ID',
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'NODE_EXTRA_CA_CERTS',
      'CLAUDE_CODE_CERT_STORE',
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      ...PROXY_NAMES,
    ],
    clouds: [
      {
        switches: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'],
        names: [
          'AWS_PROFILE',
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_SESSION_TOKEN',
          'AWS_BEARER_TOKEN_BEDROCK',
          'AWS_SHARED_CREDENTIALS_FILE',
          'AWS_CONFIG_FILE',
          'AWS_REGION',
          'AWS_DEFAULT_REGION',
          'ANTHROPIC_BEDROCK_BASE_URL',
          'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
          'ANTHROPIC_BEDROCK_REGION_PREFIX',
          'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
          'ANTHROPIC_AWS_WORKSPACE_ID',
          'ANTHROPIC_AWS_API_KEY',
          'ANTHROPIC_AWS_BASE_URL',
          'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
          'CLAUDE_CODE_SKIP_MANTLE_AUTH',
          'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
        ],
      },
      {
        switches: ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'],
        names: [
          'CLOUD_ML_REGION',
          'ANTHROPIC_VERTEX_PROJECT_ID',
          'ANTHROPIC_VERTEX_BASE_URL',
          'GOOGLE_APPLICATION_CREDENTIALS',
          'GOOGLE_CLOUD_PROJECT',
          'GCLOUD_PROJECT',
          'CLAUDE_CODE_SKIP_VERTEX_AUTH',
          'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
          'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
          'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
          'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
          'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
        ],
      },
      {
        switches: ['CLAUDE_CODE_USE_FOUNDRY'],
        names: [
          'ANTHROPIC_FOUNDRY_RESOURCE',
          'ANTHROPIC_FOUNDRY_BASE_URL',
          'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
          'ANTHROPIC_FOUNDRY_API_KEY',
          'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
        ],
      },
    ],
  },
  codex: {
    names: [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'OPENAI_FEDERATION_RULE_ID',
      'OPENAI_IDENTITY_TOKEN_FILE',
      'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
      'CODEX_HOME',
      'CODEX_CA_CERTIFICATE',
      'SSL_CERT_FILE',
      ...PROXY_NAMES,
    ],
    clouds: [],
  },
};

/** Every name any agent may take: what is kept from the shell's answer. Everything else is dropped as it is read. */
const LISTED_NAMES: ReadonlySet<string> = new Set(
  Object.values(SIGN_IN_SETTINGS).flatMap((agent) => [...agent.names, ...agent.clouds.flatMap((cloud) => [...cloud.switches, ...cloud.names])]),
);

type Environment = Readonly<Record<string, string | undefined>>;

/** A switch variable as the CLIs read it: set, and not turned off. */
export function isSwitchedOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * `base` (the app's own environment) with `agent`'s settings from the login shell added where the app has none.
 */
export function withSignInSettings(agent: AgentId, base: Environment, shell: ReadonlyMap<string, string>): Environment {
  const lists = SIGN_IN_SETTINGS[agent];
  const inApp = (name: string): boolean => {
    const pair = PROXY_PAIRS.find((names) => names.some((candidate) => candidate === name));
    return (pair ?? [name]).some((candidate) => base[candidate] !== undefined);
  };
  const on = (name: string): boolean => isSwitchedOn(inApp(name) ? base[name] : shell.get(name));
  const wanted = [...lists.names, ...lists.clouds.filter((cloud) => cloud.switches.some(on)).flatMap((cloud) => [...cloud.switches, ...cloud.names])];
  const result: Record<string, string | undefined> = { ...base };
  for (const name of wanted) {
    const value = shell.get(name);
    if (value !== undefined && !inApp(name)) {
      result[name] = value;
    }
  }
  assert(
    Object.keys(base).every((name) => result[name] === base[name]),
    'withSignInSettings: the app’s own values stand',
  );
  return result;
}

/**
 * The listed variables in what the shell printed: NUL-separated `NAME=value` entries between two copies of
 * `mark`, which only this read knows, so nothing a startup file prints around them can be taken for one.
 * undefined when the marked block is not there.
 */
export function parseShellEnvironment(output: string, mark: string): ReadonlyMap<string, string> | undefined {
  assert(mark.length >= 16, 'parseShellEnvironment: a mark nothing prints by chance');
  const start = output.indexOf(mark);
  const end = start === -1 ? -1 : output.indexOf(mark, start + mark.length);
  if (end === -1) {
    return undefined;
  }
  const settings = new Map<string, string>();
  for (const entry of output.slice(start + mark.length, end).split('\0')) {
    const equals = entry.indexOf('=');
    const name = entry.slice(0, Math.max(equals, 0));
    const value = entry.slice(equals + 1);
    // An empty value says nothing, and an overlong one is not a setting.
    if (equals > 0 && LISTED_NAMES.has(name) && value !== '' && value.length <= LOGIN_SHELL_LIMITS.valueCharsMax) {
      settings.set(name, value);
    }
  }
  return settings;
}

export type LoginShellRead =
  | { readonly kind: 'read'; readonly settings: ReadonlyMap<string, string> }
  | { readonly kind: 'failed'; readonly reason: 'not-started' | 'timed-out' | 'too-large' | 'unreadable' };

export interface LoginShellRequest {
  readonly shell: string;
  readonly environment: Environment;
  readonly timeoutMs: number;
  readonly outputBytesMax: number;
}

/** Runs the shell once as a login, interactive shell and reads its exported variables. Never rejects. */
export function readLoginShell(request: LoginShellRequest): Promise<LoginShellRead> {
  assert(request.timeoutMs > 0, 'readLoginShell: the wait is bounded');
  assert(request.outputBytesMax > 0, 'readLoginShell: the output is bounded');
  const mark = `__STACKI_${randomBytes(16).toString('hex')}__`;
  // The words every common shell reads the same way (sh, bash, zsh, fish).
  const script = `printf '%s' '${mark}'; /usr/bin/env -0; printf '%s' '${mark}'`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(request.shell, ['-ilc', script], {
        // Its own session: an interactive shell with no terminal must not reach for the app's.
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Quieter startup files: no colours, pagers or update prompts.
        env: { ...request.environment, TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true' },
      });
    } catch {
      resolve({ kind: 'failed', reason: 'not-started' });
      return;
    }
    const started = child;
    let output = '';
    let bytes = 0;
    let settled = false;
    const settle = (read: LoginShellRead): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      output = '';
      // The whole group, so nothing a startup file started in it is left waiting on the pipe.
      if (started.exitCode === null && started.pid !== undefined) {
        try {
          process.kill(-started.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      started.stdout?.destroy();
      resolve(read);
    };
    const timer = setTimeout(() => settle({ kind: 'failed', reason: 'timed-out' }), request.timeoutMs);
    started.on('error', () => settle({ kind: 'failed', reason: 'not-started' }));
    started.stdout?.setEncoding('utf8');
    started.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > request.outputBytesMax) {
        settle({ kind: 'failed', reason: 'too-large' });
        return;
      }
      output += chunk;
      // Done as soon as the block is whole: a shell kept open by a startup file is not waited for.
      const settings = parseShellEnvironment(output, mark);
      if (settings !== undefined) {
        settle({ kind: 'read', settings });
      }
    });
    started.on('close', () => settle({ kind: 'failed', reason: 'unreadable' }));
  });
}

export interface LoginShellSettingsDeps {
  /** The app's own environment as an agent would start with it (lib/shellEnvironment.ts). */
  readonly environment: () => Environment;
  readonly platform?: NodeJS.Platform;
  /** The shell to ask; the person's (`SHELL`, else the account's) by default. */
  readonly shell?: () => string;
  /** One line for the main-process log. It never holds a value. */
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
}

/** The AI agents' environments. One per app run: the shell is asked once and the answer is held in memory only. */
export class LoginShellSettings {
  private pending: Promise<ReadonlyMap<string, string>> | undefined = undefined;

  constructor(private readonly deps: LoginShellSettingsDeps) {}

  /** `agent`'s environment: the app's, plus its sign-in settings from the login shell. Waits only for the first read. */
  async environmentFor(agent: AgentId): Promise<Environment> {
    const shell = await this.shellSettings();
    return withSignInSettings(agent, this.deps.environment(), shell);
  }

  private shellSettings(): Promise<ReadonlyMap<string, string>> {
    this.pending ??= this.read();
    return this.pending;
  }

  private async read(): Promise<ReadonlyMap<string, string>> {
    if ((this.deps.platform ?? process.platform) === 'win32') {
      return new Map();
    }
    const result = await readLoginShell({
      shell: (this.deps.shell ?? personsShell)(),
      environment: this.deps.environment(),
      timeoutMs: this.deps.timeoutMs ?? LOGIN_SHELL_LIMITS.readMsMax,
      outputBytesMax: LOGIN_SHELL_LIMITS.outputBytesMax,
    });
    if (result.kind === 'read') {
      return result.settings;
    }
    (this.deps.log ?? ((line: string) => console.info(line)))(
      `[ai] the login shell’s sign-in settings were not read (${result.reason}); agents start with the app’s own environment`,
    );
    return new Map();
  }
}

/** The shell the terminal starts (`SHELL`), else the one the account is registered with. */
function personsShell(): string {
  const named = process.env['SHELL'];
  if (named !== undefined && named !== '') {
    return named;
  }
  try {
    const registered = os.userInfo().shell;
    return registered === null || registered === '' ? '/bin/bash' : registered;
  } catch {
    return '/bin/bash';
  }
}
