import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boolean, object, record, text } from '../../shared/core/boundary';
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
import { writeNewProjectDefaults } from './newProjectDefaults';
import { shadcnRegistryItems, verifyShadcnRegistryInstall, writeShadcnStarterCatalog } from './shadcnStarterCatalog';
import { writeShadcnStarterContent } from './shadcnStarterContent';
import { runCreateCommand, startSiteHistory } from './starter';
import {
  confirmPackageManager,
  errorMessage,
  managerCommand,
  publishGeneratedSite,
  readGeneratedJSON,
  readManagerVersion,
  refuseExistingDestination,
  STAGED_COMMAND_OPTIONS,
  stagingEnvironment,
  withStarterStage,
  type CommandRunner,
  type Log,
} from './stagedStarter';

// Pin the CLI because preset decoding, icon transforms and Astro output are one tested contract.
export const SHADCN_CLI_PACKAGE = 'shadcn@4.23.0';
// The CLI decodes b0 to Nova, Neutral and Lucide for each supported base.
const DEFAULT_PRESET = 'b0';
const INSPECT_TIMEOUT_MS = 60_000;
const INSPECTION_LIMIT = 4;
const GENERATION_FOLDER = 'generation';

type ShadcnRequest = Extract<StarterRequest, { readonly starter: 'shadcn' }>;

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

  return withStarterStage(parent, 'shadcn', onLog, async (staging) => {
    const directory = path.join(staging, GENERATION_FOLDER, name);
    const environment = await prepareShadcnStage(staging, manager);
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
    confirmPackageManager(directory, manager, 'shadcn');
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
  });
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
  confirmPackageManager(directory, manager, 'shadcn');
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
  confirmPackageManager(directory, manager, 'shadcn');
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

async function prepareShadcnStage(staging: string, manager: CreatePackageManager): Promise<NodeJS.ProcessEnv> {
  const environment = await stagingEnvironment(staging, manager);
  await fs.promises.mkdir(path.join(staging, GENERATION_FOLDER));
  // The package runner starts from the nearest manifest. Keep the CLI launcher separate
  // from the empty generation folder so an ancestor's manager cannot take over.
  await fs.promises.writeFile(path.join(staging, 'package.json'), '{"name":"stacki-shadcn-setup","private":true}\n', { flag: 'wx' });
  if (manager === 'pnpm') {
    // The nearest workspace must be owned by this run, even inside another pnpm workspace.
    await fs.promises.writeFile(path.join(staging, 'pnpm-workspace.yaml'), 'packages: []\n', { flag: 'wx' });
  }
  return { ...environment, SHADCN_TEMPLATE_DIR: undefined, SHADCN_GITHUB_URL: undefined };
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
