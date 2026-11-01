// Goal: run native Desktop editor tests without touching personal projects or settings.
// Method: launch the built Electron app with an isolated user directory; only the
// folder picker is replaced. Real editor, IPC, filesystem, and Astro code still run.
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';

export async function startDesktopFixture(source: string, component?: string) {
  const repository = path.resolve('..');
  // macOS aliases /var and /tmp. Use the same physical root as project confinement.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'stacki-desktop-input-')));
  const project = path.join(directory, 'project');
  try {
    await prepareProject(project, source, component);
    const bootstrap = path.join(directory, 'bootstrap.cjs');
    await writeFile(
      bootstrap,
      [
        "const { app, dialog } = require('electron');",
        `app.setPath('userData', ${JSON.stringify(path.join(directory, 'user'))});`,
        `dialog.showOpenDialog = async () => ({ canceled: false,
        filePaths: [${JSON.stringify(project)}] });`,
        `require(${JSON.stringify(path.join(repository, 'dist/electron/main.js'))});`,
      ].join('\n'),
    );
    const require = createRequire(path.join(repository, 'package.json'));
    const executable: unknown = require('electron');
    assert.equal(typeof executable, 'string');
    assert.ok(typeof executable === 'string' && path.isAbsolute(executable));
    const environment = Object.fromEntries(
      Object.entries(process.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .filter(([name]) => !['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(name)),
    );
    const application = await _electron.launch({
      args: [bootstrap],
      executablePath: executable,
      env: environment,
      timeout: 30_000,
    });
    return {
      application,
      project,
      async stop() {
        await application.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function prepareProject(project: string, source: string, component: string | undefined) {
  await mkdir(path.join(project, 'src/pages'), { recursive: true });
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({
      name: 'desktop-input-fixture',
      type: 'module',
      scripts: { dev: 'astro dev' },
      dependencies: { astro: '7.3.8' },
    }),
  );
  await writeFile(path.join(project, 'astro.config.mjs'), 'export default { devToolbar: { enabled: false } };');
  await writeFile(path.join(project, 'src/pages/index.astro'), source);
  if (component !== undefined) {
    await mkdir(path.join(project, 'src/components'), { recursive: true });
    await writeFile(path.join(project, 'src/components/Card.astro'), component);
  }
  await prepareDependencies(project);
}

async function prepareDependencies(project: string) {
  const source = path.resolve('node_modules');
  const target = path.join(project, 'node_modules');
  await mkdir(target);
  const names = await readdir(source);
  assert.ok(names.length < 2000, 'The fixture dependency listing is bounded');
  // Desktop writes its project-relative preview config inside node_modules.
  // Linking that entire directory sends the config into the shared dependencies,
  // where its relative import cannot find this fixture's Astro config.
  for (const name of names) {
    if (name === '.bin' || !name.startsWith('.')) {
      await symlink(path.join(source, name), path.join(target, name), 'dir');
    }
  }
}
