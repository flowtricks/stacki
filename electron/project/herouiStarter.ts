import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record } from '../../shared/core/boundary';
import { parseAbsolutePath } from '../../shared/ipc/astroCopy';
import { parseStarterName } from '../../shared/ipc/shadcnStarter';
import { parseCreatePackageManager, type CreatePackageManager } from '../../shared/properties/packageManager';
import { writeHeroUICatalog } from './herouiStarterCatalog';
import { heroUISiteManifest, writeHeroUISite } from './herouiStarterSite';
import { HEROUI_THEME_FILE } from './herouiStarterTheme';
import { writeNewProjectDefaults } from './newProjectDefaults';
import { installArguments } from './packageManager';
import {
  confirmPackageManager,
  errorMessage,
  managerCommand,
  publishGeneratedSite,
  readGeneratedJSON,
  readManagerVersion,
  refuseExistingDestination,
  STAGED_COMMAND_OPTIONS,
  STARTER_LOCKFILES,
  stagingEnvironment,
  withStarterStage,
  type CommandRunner,
  type Log,
} from './stagedStarter';
import { runCreateCommand } from './starter';

const GIT_TIMEOUT_MS = 60_000;

export async function createHeroUIStarter(
  request: { readonly parentPath: string; readonly name: string; readonly packageManager?: CreatePackageManager },
  onLog: Log,
  run: CommandRunner = runCreateCommand,
): Promise<{ readonly projectPath: string }> {
  const parent = await fs.promises.realpath(parseAbsolutePath(request.parentPath));
  const name = parseStarterName(request.name);
  const manager = request.packageManager === undefined ? 'npm' : parseCreatePackageManager(request.packageManager);
  const destination = path.join(parent, name);
  refuseExistingDestination(destination);
  const managerVersion = await readManagerVersion(manager, run);
  await run('git', ['--version'], os.tmpdir(), undefined, { ...STAGED_COMMAND_OPTIONS, timeoutMs: GIT_TIMEOUT_MS });

  return withStarterStage(parent, 'heroui', onLog, async (staging) => {
    const directory = path.join(staging, name);
    const environment = await stagingEnvironment(staging, manager);
    const options = { ...STAGED_COMMAND_OPTIONS, environment };
    const manifest = heroUISiteManifest(name, manager, managerVersion);
    onLog('\n> Writing the HeroUI site and component catalog\n');
    await writeHeroUISite(directory, manifest, manager);
    await writeHeroUICatalog(directory);
    const defaults = writeNewProjectDefaults(directory);
    if (!defaults.written) {
      throw new Error(defaults.reason);
    }

    const install = [
      ...installArguments(manager),
      ...(manager === 'npm' ? ['--workspaces=false', '--include=dev', '--package-lock=true'] : ['--prod=false', '--config.node-linker=hoisted']),
    ];
    onLog(`\n> ${manager} ${install.join(' ')}\n`);
    try {
      await run(managerCommand(manager), install, directory, onLog, options);
      confirmPackageManager(directory, manager, 'HeroUI');
      await verifyManifest(path.join(directory, 'package.json'), manifest);
    } catch (error: unknown) {
      throw new Error(`HeroUI dependency installation failed. ${errorMessage(error)}`);
    }

    onLog('\n> Creating the first Git commit\n');
    await initializeHistory({ directory, name, manager, environment }, run);
    onLog('\n> Publishing the HeroUI site\n');
    publishGeneratedSite(directory, destination);
    return { projectPath: destination };
  });
}

async function verifyManifest(file: string, expected: ReturnType<typeof heroUISiteManifest>): Promise<void> {
  const manifest = record(await readGeneratedJSON(file));
  for (const key of ['name', 'version', 'packageManager', 'private', 'type'] as const) {
    if (manifest[key] !== expected[key]) {
      throw new Error(`The installed package.json changed its ${key} field.`);
    }
  }
  for (const key of ['engines', 'scripts', 'dependencies', 'devDependencies'] as const) {
    const installed = record(manifest[key]);
    const entries = Object.entries(expected[key]);
    if (Object.keys(installed).length !== entries.length || entries.some(([name, value]) => installed[name] !== value)) {
      throw new Error(`The installed package.json changed its ${key} field.`);
    }
  }
}

async function initializeHistory(
  settings: {
    readonly directory: string;
    readonly name: string;
    readonly manager: CreatePackageManager;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
  run: CommandRunner,
): Promise<void> {
  const { directory, name, manager, environment } = settings;
  const git = (argumentsList: readonly string[]): Promise<string> =>
    run('git', argumentsList, directory, undefined, { ...STAGED_COMMAND_OPTIONS, timeoutMs: GIT_TIMEOUT_MS, environment, stdoutOnly: true });

  try {
    refuseExistingDestination(path.join(directory, '.git'));
    await git(['init', '--initial-branch=main']);
    await git(['add', '--all']);
    await git(['-c', 'user.name=Stacki', '-c', 'user.email=stacki@local.invalid', 'commit', '-m', `Start ${name} from HeroUI`]);
    const count = await git(['rev-list', '--count', 'HEAD']);
    if (count.trim() !== '1') {
      throw new Error('The starter needs exactly one initial commit.');
    }
    await git([
      'ls-files',
      '--error-unmatch',
      '--',
      '.stacki/components.json',
      '.stacki/styles.json',
      'src/pages/index.astro',
      'src/pages/example-components.astro',
      HEROUI_THEME_FILE,
      'package.json',
      STARTER_LOCKFILES[manager],
    ]);
    const status = await git(['status', '--porcelain', '--untracked-files=all']);
    if (status.trim().length > 0) {
      throw new Error('The first commit left uncommitted changes.');
    }
  } catch (error: unknown) {
    throw new Error(`HeroUI Git setup failed. ${errorMessage(error)}`);
  }
}
