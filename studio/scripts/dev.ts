import { restoreCmsDeletions } from '../src/features/cms/cmsDeleted';
import { restoreAssetState } from '../src/features/assets/assetState';
import { mkdir, realpath, readFile, writeFile, symlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { writeStudioConfig, exists } from './workspace';
import { copyProject } from './copyProject';
import { prepareStudioLocal } from '../vendor/stacki/electron/previewServer/studioLocalMove';

export async function startDraft(packageRoot: string, source: string, port: number) {
  const requested = path.resolve(process.env['STUDIO_WORKSPACE'] ?? '.studio/workspace');
  await mkdir(requested, { recursive: true });
  const workspace = await realpath(requested);
  // A draft from an older Studio keeps its state: it moves into `.stacki/studio/`
  // before anything here reads or creates the new folder.
  prepareStudioLocal(workspace);
  const identity = path.join(workspace, '.stacki/studio/state/project.json');
  if (await exists(identity)) {
    const previous: unknown = JSON.parse(await readFile(identity, 'utf8'));
    if (previous !== source) {
      throw new Error(
        'This draft belongs to another project. Set STUDIO_WORKSPACE to a different directory.',
      );
    }
  }
  if (!(await exists(path.join(workspace, 'package.json')))) {
    await copyProject(source, workspace, packageRoot);
    if (await exists(path.join(source, 'node_modules'))) {
      await symlink(path.join(source, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
    } else {
      await run('npm', ['ci'], workspace);
    }
  }
  await mkdir(path.join(workspace, '.stacki/studio/state'), { recursive: true });
  await writeFile(identity, JSON.stringify(source));
  const baseline = path.join(workspace, '.stacki/studio/state/github-base.json');
  if (!(await exists(baseline))) {
    try {
      const result = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        timeout: 5000,
      });
      await writeFile(baseline, JSON.stringify({ sha: result.stdout.trim() }));
    } catch {
      /* Local previews do not require a Git repository. Publish reports missing setup. */
    }
  }
  await restoreCmsDeletions(workspace);
  await restoreAssetState(workspace);
  await writeStudioConfig(workspace, packageRoot, port);
  console.log(`Draft workspace: ${workspace}\nStudio: http://localhost:${port}/studio`);
  await run(
    process.execPath,
    [
      path.join(workspace, 'node_modules/astro/bin/astro.mjs'),
      'dev',
      '--config',
      './astro.studio.config.ts',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      // Keep terminal-owned previews in the foreground even in an agent environment.
      ...(process.argv.includes('--background') ? ['--background'] : ['--ignore-lock']),
    ],
    workspace,
  );
}
function run(executable: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'inherit', env: process.env });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    // Closing a terminal sends SIGHUP; forward it before the CLI loses its child.
    process.once('SIGHUP', stop);
    child.on('error', reject);
    child.on('exit', (code) => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      process.off('SIGHUP', stop);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with status ${code}`));
      }
    });
  });
}
