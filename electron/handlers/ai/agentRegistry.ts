// The agents the AI panel can drive and where each one's pieces are: the
// person's own command-line tool (found on their PATH, signed in by them) and
// the ACP adapter Stacki installs for it on demand (agentInstaller.ts).
//
// Each adapter is pinned: an exact version, the lockfile Stacki ships for it
// (resources/agents/, every tarball's integrity inside), the lockfile's SHA-256
// and the SHA-256 of the adapter's entry file once installed. A version bump is
// a deliberate change to this file, the lockfile and both digests together;
// test/electron/handlers/ai/agentRegistry.test.ts pins the lockfile digests.
// i18n-ignore-file: the fallback option names stand in for the names the agent's adapter reports (data, shown as the adapter sent them), and model names are not translated.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { AGENTS, AGENT_IDS, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { ChatOption } from '../../../shared/properties/ai/chatModel';
import { pathEnvironmentValue } from '../../lib/platform';
import { resourcePath } from '../../lib/runtimePaths';
import { claudeInstalledVersion, isOlderVersion } from './cliVersion';
import { pathExtensions } from './windowsCommand';

export interface AdapterSpec {
  readonly agent: AgentId;
  readonly packageName: string;
  readonly version: string;
  /** The shipped lockfile, under dist/resources/. */
  readonly lockResource: string;
  readonly lockSha256: string;
  /** The adapter's entry, relative to the install folder. */
  readonly entry: string;
  readonly entrySha256: string;
  /** What the install adds to disk, for the install button (without optional platform binaries). */
  readonly installMegabytes: number;
  /** The variable that points the adapter at the person's own CLI. */
  readonly cliVariable: 'CLAUDE_CODE_EXECUTABLE' | 'CODEX_PATH';
  /** The mode a new chat starts in: the one that asks before every edit and command. */
  readonly askMode: string;
  /**
   * The oldest CLI that lists today's models: the one this adapter's agent SDK was made for. The model list is the
   * CLI's own, so an older one shows older models, and the panel then offers to update it. It moves only with the
   * adapter's version (the test holds it to the lockfile). undefined: the CLI is not checked.
   */
  readonly cliVersionMin: string | undefined;
}

export const ADAPTERS: Readonly<Record<AgentId, AdapterSpec>> = {
  claude: {
    agent: 'claude',
    packageName: '@agentclientprotocol/claude-agent-acp',
    version: '0.105.0',
    lockResource: 'agents/claude-agent-acp.lock.json',
    lockSha256: '18711117babecc42223037f813c8ccb6ac64342f41e9aba86794eca4078b7613',
    entry: 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
    entrySha256: 'f766071bfb432f79036ca90c67efc5306373be6b5129a240820d03146d2f4cb9',
    installMegabytes: 75,
    cliVariable: 'CLAUDE_CODE_EXECUTABLE',
    askMode: 'default',
    cliVersionMin: '2.1.322',
  },
  codex: {
    agent: 'codex',
    packageName: '@agentclientprotocol/codex-acp',
    version: '2.6.0',
    lockResource: 'agents/codex-acp.lock.json',
    lockSha256: 'a09ec17a87ded93b8b0836799a5361ed851c4a1e03632a7e84578f2ab75b9b2f',
    entry: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    entrySha256: '733b7521c2a437a34ed016d45a6f46bebff2bac123a172467574ee827db98b99',
    installMegabytes: 21,
    cliVariable: 'CODEX_PATH',
    askMode: 'read-only',
    cliVersionMin: undefined,
  },
};

/** The folder one pinned adapter installs into: userData/agents/<agent>-<version>. */
export function adapterDirectory(userData: string, spec: AdapterSpec): string {
  assert(path.isAbsolute(userData), 'adapterDirectory: userData is absolute');
  const directory = path.join(userData, 'agents', `${spec.agent}-${spec.version}`);
  assert(path.basename(directory).startsWith(spec.agent), 'adapterDirectory: named for its agent');
  return directory;
}

/** The marker an install leaves once its entry's digest checked out. */
export const INSTALL_MARKER = '.stacki-installed.json';

/**
 * The adapter's entry file when the pinned version is installed and still the
 * bytes that were checked; undefined otherwise. Hashing ~2 MB costs a few
 * milliseconds and runs once per adapter start, so a changed file is caught
 * before it runs, not only at install.
 */
export function installedEntry(userData: string, spec: AdapterSpec): string | undefined {
  const directory = adapterDirectory(userData, spec);
  if (!fs.existsSync(path.join(directory, INSTALL_MARKER))) {
    return undefined;
  }
  const entry = path.join(directory, ...spec.entry.split('/'));
  let digest: string;
  try {
    digest = sha256File(entry);
  } catch {
    return undefined;
  }
  return digest === spec.entrySha256 ? entry : undefined;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The shipped lockfile's bytes, refused unless they are the pinned ones. */
export function readPinnedLock(spec: AdapterSpec): Buffer {
  const bytes = fs.readFileSync(resourcePath(spec.lockResource));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== spec.lockSha256) {
    throw new Error(`The ${AGENTS[spec.agent].label} adapter's lockfile is not the pinned one; nothing was installed.`);
  }
  assert(bytes.length > 0, 'readPinnedLock: a lockfile has content');
  return bytes;
}

/** The package.json the lockfile was made for: one exact dependency. */
export function adapterPackageJson(spec: AdapterSpec): string {
  const manifest = { name: `stacki-agent-${spec.agent}`, private: true, version: '0.0.0', dependencies: { [spec.packageName]: spec.version } };
  const source = `${JSON.stringify(manifest)}\n`;
  assert(source.includes(spec.version), 'adapterPackageJson: pins the version');
  return source;
}

/** How `findCli` asks the disk about a candidate: tests give a fake one, so a Windows PATH is searched on any host. */
export interface CliFileSystem {
  /** The candidate resolved through links when it is a file, or undefined when it is not one. */
  readonly resolveFile: (candidate: string) => string | undefined;
  /** A small text file, or undefined when it cannot be read: where an install records its version. Absent: nothing is read. */
  readonly readText?: (file: string) => string | undefined;
}

export interface FindCliOptions {
  /** The environment the CLI would start in; its PATH is read case-insensitively on Windows, where the variable is `Path`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: CliFileSystem;
}

/** Far above a real package.json; a larger file is not read for a version. */
const PACKAGE_JSON_BYTES_MAX = 256 * 1024;

export const realCliFileSystem: CliFileSystem = {
  resolveFile: (candidate) => {
    try {
      const real = fs.realpathSync(candidate);
      return fs.statSync(real).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  },
  readText: (file) => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size <= PACKAGE_JSON_BYTES_MAX ? fs.readFileSync(file, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  },
};

/** The version of the CLI at `file` (as `findCli` answered it), when its install says it. Only Claude Code's is read. */
export function installedCliVersion(agent: AgentId, file: string, fileSystem: CliFileSystem = realCliFileSystem): string | undefined {
  const readText = fileSystem.readText;
  return agent !== 'claude' || readText === undefined ? undefined : claudeInstalledVersion(file, readText);
}

/**
 * The person's own CLI for `agent` on the PATH of `options.environment` (as the
 * terminal's login shell would start with), resolved through links: the adapter
 * runs the unmodified binary, which reads the person's sign-in itself. The PATH
 * is read through `pathEnvironmentValue`: a copy of the Windows environment is a
 * plain object, and a bare `['PATH']` read on it misses `Path`, which made every
 * installed CLI look missing (issue 82). On Windows the file names come from
 * PATHEXT (always with the .exe and .cmd kinds), as the system's own lookup does.
 *
 * The first one on the PATH is used, with one exception: when its version is known and a later one is newer, the
 * newest is used. Why: an app opened from the Dock searches the usual tool folders in its own order
 * (lib/shellEnvironment.ts), not the order the person's terminal uses, so a copy left behind by an earlier way of
 * installing Claude Code (npm, ~/.claude/local) could win over the up to date one, and the panel then showed that
 * copy's old models. A first one whose version cannot be read (a wrapper of the person's own) is kept.
 */
export function findCli(agent: AgentId, options: FindCliOptions): string | undefined {
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? realCliFileSystem;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const cli = AGENTS[agent].cli;
  const names = platform === 'win32' ? pathExtensions(options.environment).map((extension) => `${cli}${extension}`) : [cli];
  const directories = pathEnvironmentValue(options.environment, platform)
    .split(api.delimiter)
    .map((directory) => (platform === 'win32' ? directory.trim().replace(/^"(.*)"$/, '$1') : directory))
    .filter((directory) => directory.length > 0);
  assert(directories.length <= 4_096, 'findCli: a PATH is bounded');
  assert(names.length > 0, 'findCli: at least one file name is tried');
  let best: { readonly file: string; readonly version: string } | undefined;
  for (const directory of directories) {
    for (const name of names) {
      const found = fileSystem.resolveFile(api.join(directory, name));
      if (found === undefined) {
        continue;
      }
      const version = installedCliVersion(agent, found, fileSystem);
      if (best === undefined) {
        if (version === undefined) {
          return found;
        }
        best = { file: found, version };
      } else if (version !== undefined && isOlderVersion(best.version, version)) {
        best = { file: found, version };
      }
    }
  }
  return best?.file;
}

export function adapterSpecs(): readonly AdapterSpec[] {
  const specs = AGENT_IDS.map((id) => ADAPTERS[id]);
  assert(
    specs.every((spec, index) => spec.agent === AGENT_IDS[index]),
    'adapterSpecs: one spec per agent, in order',
  );
  return specs;
}

/**
 * The settings a new chat offers before its agent has reported its own (it does
 * the first time a session starts, or when the host probes it; agentHost.ts).
 * Claude: Claude Code's own model aliases and effort levels
 * (https://code.claude.com/docs/en/model-config). Why aliases without versions,
 * never model ids: an alias runs the newest model of its family that the
 * person's CLI knows, so this list cannot go stale or name a model the CLI
 * cannot run, and a pick made from it is the same value the CLI's own list uses,
 * so it still holds once that list arrives. The versions shown are only ever the
 * ones the CLI reports. Codex: its reasoning efforts; its models come only from
 * the agent (`model/list` behind codex-acp's config options).
 */
export const FALLBACK_OPTIONS: Readonly<Record<AgentId, readonly ChatOption[]>> = {
  claude: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'default',
      choices: [
        { value: 'default', name: 'Default (recommended)', description: 'The model Claude Code picks for your plan' },
        { value: 'opus', name: 'Opus', description: undefined },
        { value: 'fable', name: 'Fable', description: undefined },
        { value: 'sonnet', name: 'Sonnet', description: undefined },
        { value: 'haiku', name: 'Haiku', description: undefined },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'default',
      choices: [
        { value: 'default', name: 'Default', description: undefined },
        { value: 'low', name: 'Low', description: undefined },
        { value: 'medium', name: 'Medium', description: undefined },
        { value: 'high', name: 'High', description: undefined },
        { value: 'xhigh', name: 'Extra high', description: undefined },
        { value: 'max', name: 'Max', description: undefined },
      ],
    },
  ],
  codex: [
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      currentValue: 'medium',
      choices: [
        { value: 'low', name: 'Low', description: undefined },
        { value: 'medium', name: 'Medium', description: undefined },
        { value: 'high', name: 'High', description: undefined },
        { value: 'xhigh', name: 'Extra high', description: undefined },
      ],
    },
  ],
};
