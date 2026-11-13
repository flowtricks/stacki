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
import { resourcePath } from '../../lib/runtimePaths';

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

/**
 * The person's own CLI for `agent` on `pathValue` (a PATH as the terminal's
 * login shell would start with), resolved through links: the adapter runs the
 * unmodified binary, which reads the person's sign-in itself.
 */
export function findCli(agent: AgentId, pathValue: string): string | undefined {
  const names = process.platform === 'win32' ? [`${AGENTS[agent].cli}.exe`, `${AGENTS[agent].cli}.cmd`] : [AGENTS[agent].cli];
  const directories = pathValue.split(path.delimiter).filter((directory) => directory.length > 0);
  assert(directories.length <= 4_096, 'findCli: a PATH is bounded');
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const real = fs.realpathSync(candidate);
        if (fs.statSync(real).isFile()) {
          return real;
        }
      } catch {
        continue;
      }
    }
  }
  return undefined;
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
 * Claude: the current model ids and Claude Code's effort levels, from the Claude
 * Code model configuration docs (https://code.claude.com/docs/en/model-config);
 * the adapter's live list replaces them, with the names and descriptions Claude
 * Code's own /model picker shows. Codex: its reasoning efforts; its models come
 * only from the agent (`model/list` behind codex-acp's config options).
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
        { value: 'claude-fable-5-2', name: 'Fable 5.2', description: undefined },
        { value: 'claude-opus-5-5', name: 'Opus 5.5', description: undefined },
        { value: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: undefined },
        { value: 'claude-haiku-5-5', name: 'Haiku 5.5', description: undefined },
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
