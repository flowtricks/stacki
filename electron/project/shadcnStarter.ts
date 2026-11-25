import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { boolean, object, record, text } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import { err, ok } from '../../shared/core/result';
import {
  parseShadcnIconSelection,
  parseShadcnPresetCode,
  parseShadcnPresetSelection,
  SHADCN_STARTER_DEFAULTS,
  type ShadcnPresetReply,
  type ShadcnStyle,
  type StarterRequest,
} from '../../shared/ipc/shadcnStarter';
import type { CreatePackageManager } from '../../shared/properties/packageManager';
import { MAIN_LIMITS } from '../lib/mainLimits';
import { writeNewProjectDefaults } from './newProjectDefaults';
import { shadcnRegistryItems, verifyShadcnRegistryInstall, writeShadcnStarterCatalog } from './shadcnStarterCatalog';
import { writeShadcnStarterContent } from './shadcnStarterContent';
import { runCreateCommand, startSiteHistory } from './starter';

// Pin the CLI because preset decoding, icon transforms and Astro output are one tested contract.
export const SHADCN_CLI_PACKAGE = 'shadcn@4.23.0';
// The CLI decodes b0 to Nova, Neutral and Lucide for each supported base.
const DEFAULT_PRESET = 'b0';
const INSPECT_TIMEOUT_MS = 60_000;
const INSPECTION_LIMIT = 4;
const GENERATED_ROOT_ENTRIES_MAX = 64;
const GENERATED_CONFIG_BYTES_MAX = 16_384;
const GENERATION_FOLDER = 'generation';
const STAGED_COMMAND_OPTIONS = { waitForStop: true, outputBytesMax: MAIN_LIMITS.commandOutputBytesMax } as const;

type ShadcnRequest = Extract<StarterRequest, { readonly starter: 'shadcn' }>;
type Log = (chunk: string) => void;
type CommandRunner = typeof runCreateCommand;

const LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
} as const satisfies Record<CreatePackageManager, string>;

const FOREIGN_LOCKFILES = ['yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'] as const;

let activeInspections = 0;

export async function inspectShadcnPreset(preset: string, run: CommandRunner = runCreateCommand): Promise<ShadcnPresetReply> {
  if (activeInspections >= INSPECTION_LIMIT) {
    return err({ message: 'shadcn is still checking other preset codes. Try again in a moment.' });
  }
  activeInspections += 1;
  try {
    return ok(await decodePreset(preset, os.tmpdir(), run));
  } catch (error: unknown) {
    return err({ message: errorMessage(error) });
  } finally {
    activeInspections -= 1;
  }
}

export async function createShadcnStarter(
  request: ShadcnRequest,
  onLog: Log,
  run: CommandRunner = runCreateCommand,
): Promise<{ readonly projectPath: string }> {
  const { parentPath, name, shadcn, packageManager: manager = 'npm' } = request;
  const parent = await fs.promises.realpath(parentPath);
  const destination = path.join(parent, name);
  refuseExistingDestination(destination);
  const managerVersion = await readManagerVersion(manager, run);
  await run('git', ['--version'], os.tmpdir(), undefined, { ...STAGED_COMMAND_OPTIONS, timeoutMs: INSPECT_TIMEOUT_MS });
  const preset = shadcn.preset === undefined ? undefined : await decodePreset(shadcn.preset, os.tmpdir(), run);
  const style = preset?.style ?? shadcn.style ?? SHADCN_STARTER_DEFAULTS.style;
  if (shadcn.style !== undefined && shadcn.style !== style) {
    throw new Error('The selected shadcn style does not match the preset code.');
  }

  const staging = await fs.promises.mkdtemp(path.join(parent, '.stacki-shadcn-'));
  try {
    const directory = path.join(staging, GENERATION_FOLDER, name);
    const environment = await stagingEnvironment(staging, manager);
    const cli = async (argumentsList: readonly string[], cwd: string): Promise<string> => {
      onLog(`\n> ${SHADCN_CLI_PACKAGE} ${argumentsList.join(' ')}\n`);
      try {
        return await runShadcn(manager, argumentsList, cwd, run, { ...STAGED_COMMAND_OPTIONS, environment }, onLog);
      } catch (error: unknown) {
        throw new Error(`shadcn ${argumentsList[0] ?? 'CLI'} failed. ${errorMessage(error)}`);
      }
    };
    await createShadcnFiles({ request, manager, directory, staging, style }, cli);
    // Data Table and the upstream Create gallery use these packages.
    const install = [manager === 'npm' ? 'install' : 'add', '@tanstack/react-table@8.21.3', 'react-qr-code@2.2.0'];
    onLog(`\n> ${manager} ${install.join(' ')}\n`);
    await run(managerCommand(manager), install, directory, onLog, { ...STAGED_COMMAND_OPTIONS, environment });
    confirmPackageManager(directory, manager);
    await recordProjectManager(directory, manager, managerVersion);
    await writeShadcnStarterContent(directory, { rtl: shadcn.rtl });
    await writeShadcnStarterCatalog(directory, { base: shadcn.base });
    const defaults = writeNewProjectDefaults(directory);
    if (!defaults.written) {
      throw new Error(defaults.reason);
    }
    // The official CLI starts Git at init. Its first commit predates the starter files.
    await fs.promises.rm(path.join(directory, '.git'), { recursive: true, force: true });
    const gitOptions = { ...STAGED_COMMAND_OPTIONS, environment };
    await startSiteHistory(directory, 'shadcn', onLog, gitOptions);
    await run('git', ['rev-parse', '--verify', 'HEAD'], directory, undefined, gitOptions);
    publishGeneratedSite(directory, destination);
    // Opening the canonical path keeps project containment checks consistent through symlinked parents.
    return { projectPath: destination };
  } finally {
    try {
      await fs.promises.rm(staging, { recursive: true, force: true });
    } catch (error: unknown) {
      onLog(`\nCould not clean up ${staging}. ${errorMessage(error)}\n`);
    }
  }
}

async function createShadcnFiles(
  options: {
    readonly request: ShadcnRequest;
    readonly manager: CreatePackageManager;
    readonly directory: string;
    readonly staging: string;
    readonly style: ShadcnStyle;
  },
  cli: (argumentsList: readonly string[], cwd: string) => Promise<string>,
): Promise<void> {
  const { request, manager, directory, staging, style } = options;
  const { name, shadcn } = request;
  await cli(
    [
      'init',
      '--cwd',
      GENERATION_FOLDER,
      '--template',
      'astro',
      '--no-monorepo',
      '--name',
      name,
      '--base',
      shadcn.base,
      '--preset',
      shadcn.preset ?? (style === SHADCN_STARTER_DEFAULTS.style ? DEFAULT_PRESET : style),
      '--yes',
      shadcn.pointer ? '--pointer' : '--no-pointer',
      shadcn.rtl ? '--rtl' : '--no-rtl',
    ],
    staging,
  );
  confirmPackageManager(directory, manager);
  const initial = await readGeneratedConfig(directory);
  if (initial.iconLibrary !== shadcn.iconLibrary) {
    await cli(['migrate', 'icons', '--from', initial.iconLibrary, '--to', shadcn.iconLibrary, '--yes'], directory);
  }
  const configured = await readGeneratedConfig(directory);
  if (configured.iconLibrary !== shadcn.iconLibrary) {
    throw new Error(`shadcn did not configure ${shadcn.iconLibrary} icons.`);
  }
  if (configured.style !== `${shadcn.base}-${style}`) {
    throw new Error(`shadcn did not configure the ${shadcn.base}-${style} style.`);
  }
  if (configured.rtl !== shadcn.rtl) {
    throw new Error('shadcn did not configure the requested text direction.');
  }
  // Some registry items depend on Button, which init already generated inside this attempt.
  await cli(['add', ...shadcnRegistryItems(shadcn.base), '--yes', '--overwrite'], directory);
  verifyShadcnRegistryInstall(directory, shadcn.base);
  confirmPackageManager(directory, manager);
}

async function decodePreset(preset: string, directory: string, run: CommandRunner): Promise<ReturnType<typeof parseShadcnPresetSelection>> {
  const code = parseShadcnPresetCode(preset);
  try {
    const output = await runShadcn('npm', ['preset', 'decode', code, '--json'], directory, run, {
      ...STAGED_COMMAND_OPTIONS,
      timeoutMs: INSPECT_TIMEOUT_MS,
      stdoutOnly: true,
    });
    const data: unknown = JSON.parse(output);
    const fields = record(data);
    if (fields['code'] !== code) {
      throw new Error('shadcn did not return this preset code.');
    }
    return parseShadcnPresetSelection(fields['values']);
  } catch (error: unknown) {
    throw new Error(`Could not verify the shadcn preset. ${errorMessage(error)}`);
  }
}

async function runShadcn(
  manager: CreatePackageManager,
  argumentsList: readonly string[],
  directory: string,
  run: CommandRunner,
  options: Parameters<CommandRunner>[4],
  onLog?: Log,
): Promise<string> {
  // `npm exec` is the same runner as npx, using the npm executable checked before creation.
  const launcher = manager === 'npm' ? ['exec', '--yes', '--'] : ['dlx'];
  return run(managerCommand(manager), [...launcher, SHADCN_CLI_PACKAGE, ...argumentsList], directory, onLog, options);
}

function managerCommand(manager: CreatePackageManager): string {
  return process.platform === 'win32' ? `${manager}.cmd` : manager;
}

async function readManagerVersion(manager: CreatePackageManager, run: CommandRunner): Promise<string> {
  const output = await run(managerCommand(manager), ['--version'], os.tmpdir(), undefined, {
    ...STAGED_COMMAND_OPTIONS,
    timeoutMs: INSPECT_TIMEOUT_MS,
    stdoutOnly: true,
  });
  const version = output.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Could not determine the installed ${manager} version.`);
  }
  return version;
}

async function stagingEnvironment(staging: string, manager: CreatePackageManager): Promise<NodeJS.ProcessEnv> {
  const scratch = path.join(staging, '.scratch');
  await fs.promises.mkdir(scratch);
  await fs.promises.mkdir(path.join(staging, GENERATION_FOLDER));
  // The package runner starts from the nearest manifest. Keep the CLI launcher separate
  // from the empty generation folder so an ancestor's manager cannot take over.
  await fs.promises.writeFile(path.join(staging, 'package.json'), '{"name":"stacki-shadcn-setup","private":true}\n', { flag: 'wx' });
  if (manager === 'pnpm') {
    // The nearest workspace must be owned by this run, even inside another pnpm workspace.
    await fs.promises.writeFile(path.join(staging, 'pnpm-workspace.yaml'), 'packages: []\n', { flag: 'wx' });
  }
  return {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    // On a Corepack installation, each subprocess would otherwise consult the
    // destination's ancestors before the new project's manifest has its own pin.
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    SHADCN_TEMPLATE_DIR: undefined,
    SHADCN_GITHUB_URL: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: scratch,
    ...(manager === 'npm' ? { npm_config_workspaces: 'false' } : {}),
  };
}

function confirmPackageManager(directory: string, manager: CreatePackageManager): void {
  const lockfile = LOCKFILES[manager];
  const expected = fs.lstatSync(path.join(directory, lockfile), { throwIfNoEntry: false });
  if (expected?.isFile() !== true) {
    throw new Error(`shadcn did not install the website with ${manager}.`);
  }
  for (const filename of [...Object.values(LOCKFILES), ...FOREIGN_LOCKFILES]) {
    if (filename !== lockfile && fs.existsSync(path.join(directory, filename))) {
      throw new Error(`shadcn wrote ${filename} while installing with ${manager}.`);
    }
  }
}

const parseGeneratedConfig = object({ style: text, rtl: boolean });

async function readGeneratedConfig(directory: string) {
  const data = await readGeneratedJSON(path.join(directory, 'components.json'));
  return { ...parseGeneratedConfig(data), ...parseShadcnIconSelection(data) };
}

async function recordProjectManager(directory: string, manager: CreatePackageManager, version: string): Promise<void> {
  const file = path.join(directory, 'package.json');
  const manifest = record(await readGeneratedJSON(file));
  // Once relocated, Corepack and Stacki must both keep using this project's manager.
  await fs.promises.writeFile(file, `${JSON.stringify({ ...manifest, packageManager: `${manager}@${version}` }, undefined, 2)}\n`, 'utf8');
}

async function readGeneratedJSON(filename: string): Promise<unknown> {
  const file = await fs.promises.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(GENERATED_CONFIG_BYTES_MAX + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) {
      throw new Error('The generated shadcn configuration exceeds its size limit.');
    }
    const data: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    return data;
  } finally {
    await file.close();
  }
}

function refuseExistingDestination(destination: string): void {
  const entry = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (entry !== undefined) {
    throw new Error(`${path.basename(destination)} already exists in that folder.`);
  }
}

function publishGeneratedSite(directory: string, destination: string): void {
  const names = fs.readdirSync(directory);
  assert(names.includes('package.json'), 'A generated project must have a package manifest before publication');
  assert(names.includes('.git'), 'A generated project must have Git history before publication');
  if (names.length > GENERATED_ROOT_ENTRIES_MAX) {
    throw new Error('The generated shadcn project exceeds its root entry limit.');
  }
  // Exclusive mkdir is the no-clobber operation on every supported platform. The moves
  // stay on this volume, so large installed directories aren't recopied or dereferenced.
  try {
    fs.mkdirSync(destination);
  } catch (error: unknown) {
    if (toRecord(error)?.['code'] === 'EEXIST') {
      throw new Error(`${path.basename(destination)} already exists in that folder.`);
    }
    throw error;
  }
  let movedCount = 0;
  try {
    for (const name of names) {
      refuseExistingDestination(path.join(destination, name));
      fs.renameSync(path.join(directory, name), path.join(destination, name));
      movedCount += 1;
    }
  } catch (error: unknown) {
    for (const name of names.slice(0, movedCount)) {
      fs.renameSync(path.join(destination, name), path.join(directory, name));
    }
    fs.rmdirSync(destination);
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
