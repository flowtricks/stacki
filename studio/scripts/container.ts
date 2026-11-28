import { restoreGitWorkspace } from '../src/features/history/gitWorkspaceRestore';
import { gitDraftHeaders } from '../src/features/history/gitWorkspaceStorage';
import { boundedText } from '../src/features/updates/catalog';
import { restorePublishRepository } from '../src/features/publishing/publishBootstrap';
import { published } from '../src/features/publishing/publishFailure';
import { restoreCmsDeletions } from '../src/features/cms/cmsDeleted';
import { restoreAssetState } from '../src/features/assets/assetState';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { linkImageDependencies } from './dependencies';
import { writeStudioConfig } from './workspace';
import { Room } from '../src/features/collaboration/rooms';
import { preparePath } from '../src/features/project/projectServer';
import { sourcePath, filePath } from '../src/shared/validation';
import { withStudioTelemetryDisabled } from '../vendor/stacki/shared/properties/studioTelemetry';
import { createStartupReporter } from '../src/features/startup/startupReporter';
import { READINESS_LIMITS, waitUntilReady } from '../src/features/startup/readiness';
import { performance } from 'node:perf_hooks';

const root = '/workspace';
const backend = process.env['STUDIO_BACKEND_URL'];
const token = process.env['STUDIO_CONTAINER_TOKEN'];
if (!backend || !token) {
  throw new Error('Container backend configuration is missing');
}
const bootstrapHeaders = { 'x-studio-token': token };
// The boot screen shows these as they begin. Reporting never delays or fails the start (startupReporter.ts).
const reporter = createStartupReporter({
  backend,
  token,
  sinceStartMs: () => performance.now(),
  post: (url, init) => fetch(url, init),
  log: (message) => console.log(message),
});
// Stage timings are printed too, so a cold start can be read from the container's own log.
const timings = (label: string) => console.log(`[start] ${label} at ${Math.floor(performance.now())} ms`);
reporter.report('repository');
console.log('Restoring repository and shared drafts');
const bootstrap = await fetch(backend + '/studio/internal/bootstrap', {
  method: 'POST',
  headers: bootstrapHeaders,
  signal: AbortSignal.timeout(60_000),
});
if (!bootstrap.ok) {
  throw new Error('Could not load repository connection.');
}
const connection: unknown = JSON.parse(await boundedText(bootstrap, 16_384));
const baseline = published(await restorePublishRepository(root, connection));
await writeFile(path.join(root, '.stacki/studio/state/github-base.json'), JSON.stringify({ sha: baseline }));
await restoreGitWorkspace(root, connection, baseline);
timings('repository restored');
reporter.report('drafts');
const headers = await gitDraftHeaders(root);
// The draft inventory and the asset inventory do not depend on each other, nor do restoring
// the two: one round trip each instead of four in a row.
const [filesResponse, assetsResponse] = await Promise.all([
  fetch(backend + '/studio/internal/files', { headers }),
  fetch(backend + '/studio/internal/assets', { headers }),
]);
if (!filesResponse.ok) {
  throw new Error('Could not restore draft inventory');
}
if (!assetsResponse.ok) {
  throw new Error('Could not restore assets');
}
const files: unknown = await filesResponse.json();
if (!Array.isArray(files) || files.length > 1000) {
  throw new Error('Invalid draft inventory');
}
const assets: unknown = await assetsResponse.json();
if (!Array.isArray(assets) || assets.length > 1000) {
  throw new Error('Invalid asset inventory');
}
await Promise.all([restoreDraftFiles(files), restoreDraftAssets(assets, headers)]);
await restoreCmsDeletions(root);
await restoreAssetState(root);
timings('drafts restored');
reporter.report('dependencies');
if (!(await linkImageDependencies(root))) {
  console.log('Installing changed site dependencies from cache');
  // Installing runs the dependencies' scripts, which have no use for Studio's own token. Nothing else starts until
  // it is back: the preview, which Studio itself runs in, needs it.
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  await command('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund', '--cache', '/opt/npm-cache']);
  process.env['STUDIO_CONTAINER_TOKEN'] = token;
}
timings('dependencies ready');
reporter.report('server');
console.log('Starting Astro preview');
await writeStudioConfig(root, '/opt/studio', 4350);
const preview = startCommand(
  process.execPath,
  [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'dev', '--config', 'astro.studio.config.ts', '--host', '0.0.0.0', '--port', '4350', '--ignore-lock'],
  0,
);
// Warming runs beside Astro; the container lives exactly as long as Astro does.
void warmPreview().catch((error: unknown) => console.log(`Preview warm-up failed: ${error instanceof Error ? error.message : 'unknown'}`));
await preview;

// Compiling the home page and reading the catalog here, before anyone asks, moves the slowest first-request work
// (Astro's first compile, Vite's dependency scan, the project scan) into the time the editor is still loading.
async function warmPreview() {
  const clock = { now: () => Date.now(), sleep: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)) };
  const served = await waitUntilReady(
    async () => {
      const response = await fetch('http://127.0.0.1:4350/studio/api/status', {
        headers: { 'x-studio-token': token ?? '' },
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      return response.ok;
    },
    clock,
    READINESS_LIMITS,
  );
  if (!served.ok) {
    console.log(`Astro did not answer: ${served.error.kind} after ${served.error.attempts} attempts`);
    return;
  }
  timings(`server answering (${served.value.attempts} probes)`);
  reporter.report('compile');
  // The project catalog is the first thing the editor asks for and costs about a second when cold; the home page
  // is the first thing the canvas asks for. Both are read now, together, so neither waits for the person.
  // A page that fails to compile is the person's to see in the editor; warming only reports it.
  const headers = { 'x-studio-token': token ?? '' };
  const warm = (url: string) =>
    fetch(url, { headers, signal: AbortSignal.timeout(120_000) }).then(
      async (response) => {
        await response.arrayBuffer();
        return response.status;
      },
      (error: unknown) => (error instanceof Error ? error.message : 'failed'),
    );
  const [catalog, page] = await Promise.all([warm('http://127.0.0.1:4350/studio/api/project'), warm('http://127.0.0.1:4350/')]);
  timings(`catalog read (${catalog}), home page compiled (${page})`);
  reporter.report('ready');
  await reporter.settled();
}
async function restoreDraftFiles(files: readonly unknown[]) {
  for (let offset = 0; offset < files.length; offset += 4) {
    await Promise.all(
      files.slice(offset, offset + 4).map(async (input: unknown) => {
        const file = sourcePath(input);
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        try {
          await access(path.join(root, file));
        } catch {
          await writeFile(path.join(root, file), '');
        }
        const room = new Room(root, file);
        await room.initialize();
        room.document.destroy();
      }),
    );
  }
}
async function restoreDraftAssets(assets: readonly unknown[], headers: Readonly<Record<string, string>>) {
  for (let offset = 0; offset < assets.length; offset += 4) {
    await Promise.all(
      assets.slice(offset, offset + 4).map(async (input: unknown) => {
        const file = filePath(input);
        const response = await fetch(backend + '/studio/internal/asset?file=' + encodeURIComponent(file), { headers });
        if (!response.ok) {
          throw new Error('Could not restore asset');
        }
        await writeFile(await preparePath(root, file), new Uint8Array(await response.arrayBuffer()));
      }),
    );
  }
}
function command(executable: string, args: string[], timeoutMs = 180_000) {
  return startCommand(executable, args, timeoutMs);
}
function startCommand(executable: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    // The image sets these too; applying them here covers a project's older Dockerfile.
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', env: withStudioTelemetryDisabled(process.env) });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined;
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${executable} failed (${code})`));
      }
    });
  });
}
