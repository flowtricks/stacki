// Studio gets its own module graph so its preview hooks cannot interfere with
// Electron's canvas. Both servers read and write the same website source folder.
import { spawn, type ChildProcess } from 'node:child_process';
import { prepareStudioLocal } from './studioLocalMove';
import { STUDIO_STATE_DIRECTORY } from '../../shared/properties/studioLocal';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from '../../shared/core/assert';
import { record } from '../../shared/core/boundary';
import { err, ok, type Result } from '../../shared/core/result';
import { releaseVersion } from '../../shared/ipc/studioRelease';

export function hasLocalStudio(project: string): boolean {
  try {
    const directory = path.join(project, 'studio');
    if (!lstatSync(directory).isDirectory()) {
      return false;
    }
    const metadata = path.join(directory, 'src/shared/release.json');
    const information = lstatSync(metadata);
    if (!information.isFile() || information.size > 4096) {
      return false;
    }
    const input: unknown = JSON.parse(readFileSync(metadata, 'utf8'));
    releaseVersion(record(input)['version']);
    return true;
  } catch {
    return false;
  }
}

export function createLocalStudio(project: string, log: (text: string) => void) {
  let lifecycle: 'open' | 'closed' = 'open';
  let pending: Promise<Result<string, string>> | undefined;
  const children = new Set<ChildProcess>();
  return {
    open(): Promise<Result<string, string>> {
      if (lifecycle === 'closed') {
        return Promise.resolve(err('The website preview has closed.'));
      }
      pending ??= launchLocalStudio(realpathSync(project), {
        active: () => lifecycle === 'open',
        track: (child) => {
          assert(children.size === 0, 'Only one local Studio process may run per project');
          children.add(child);
          child.once('exit', () => children.delete(child));
        },
        log,
      });
      return pending;
    },
    close(): void {
      lifecycle = 'closed';
      for (const child of children) {
        stopLocalStudio(child);
      }
      children.clear();
    },
  };
}

interface LaunchHost {
  readonly active: () => boolean;
  readonly track: (child: ChildProcess) => void;
  readonly log: (text: string) => void;
}

async function launchLocalStudio(
  project: string,
  host: LaunchHost,
): Promise<Result<string, string>> {
  const assets = path.join(project, 'studio/dist');
  if (!existsSync(path.join(assets, 'integration.mjs'))) {
    return err(
      'Studio needs a build. Run npm --prefix studio run build, then restart the preview.',
    );
  }
  const port = await availablePort();
  if (!host.active()) {
    return err('The website preview has closed.');
  }
  const configuration = writeLocalStudioConfig(project, assets, port);
  const child = spawn(
    process.execPath,
    [
      path.join(project, 'node_modules/astro/bin/astro.mjs'),
      'dev',
      '--config',
      path.relative(project, configuration),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--ignore-lock',
    ],
    { cwd: project, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  host.track(child);
  let failure: string | undefined;
  child.once('error', (error) => {
    failure = error.message;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: unknown) => {
      assert(Buffer.isBuffer(chunk), 'Studio process output must be bytes');
      host.log(chunk.toString('utf8').slice(-24_000));
    });
  }
  const origin = `http://127.0.0.1:${port}`;
  // Bound startup to roughly one minute, including probes and backoff.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!host.active() || child.exitCode !== null || failure) {
      stopLocalStudio(child);
      return err(failure ?? 'Studio stopped. Check the website preview log.');
    }
    if (await localStudioReady(origin)) {
      return ok(origin);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  stopLocalStudio(child);
  return err('Studio did not start. Check the website preview log and restart the preview.');
}

export function writeLocalStudioConfig(project: string, assets: string, port: number): string {
  assert(Number.isSafeInteger(port), 'Studio port must be an integer');
  assert(port >= 1024, 'Studio port must be a nonprivileged TCP port');
  assert(port <= 65535, 'Studio port must be a nonprivileged TCP port');
  const names = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.mts'];
  const userConfig = names.find((name) => existsSync(path.join(project, name)));
  const source = userConfig
    ? `import config from ${JSON.stringify(pathToFileURL(path.join(project, userConfig)).href)};`
    : 'const config = {};';
  const integration = pathToFileURL(path.join(assets, 'integration.mjs')).href;
  const directory = path.join(project, 'node_modules/.avb');
  const state = path.join(project, STUDIO_STATE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  // `.stacki/studio/` ignores its own contents; an older `.studio-state` moves in.
  prepareStudioLocal(project);
  mkdirSync(state, { recursive: true });
  if (lstatSync(state).isSymbolicLink()) {
    throw new Error('Studio session storage must be a real directory');
  }
  const file = path.join(directory, 'astro.studio.config.mjs');
  writeFileSync(
    file,
    `${source}\nimport studio from ${JSON.stringify(integration)};
export default { ...config, devToolbar: { enabled: false },
  cacheDir: './node_modules/.avb/studio-cache',
  vite: { ...config.vite, cacheDir: './node_modules/.avb/studio-vite-cache' },
  integrations: [...(config.integrations ?? []),
    studio(${JSON.stringify({ root: project, assets, port, editing: 'source' })})]
};\n`,
  );
  return file;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address !== null, 'Listening Studio probe must have an address');
  assert(typeof address !== 'string', 'Studio probe must use TCP');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function localStudioReady(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin + '/studio/api/session', {
      signal: AbortSignal.timeout(500),
      redirect: 'error',
    });
    if (!response.ok) {
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return false;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    // Session replies are tiny. Bound both bytes and chunks before parsing JSON.
    for (let count = 0; count < 64; count += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return record(value)['kind'] === 'local';
      }
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) {
        break;
      }
      size += bytes.byteLength;
      if (size > 4096) {
        break;
      }
      chunks.push(bytes);
    }
    await reader.cancel();
    return false;
  } catch {
    return false;
  }
}

function stopLocalStudio(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).once(
        'error',
        () => child.kill(),
      );
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    child.kill();
  }
}
