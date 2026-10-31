// Goal: exercise the shared style panel against a disposable real Astro project.
// Method: use Studio's pinned development dependencies and remove the draft on exit;
// the repository root does not declare Astro and must not supply an incidental version.
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { writeStudioConfig } from '../scripts/workspace';

const execute = promisify(execFile);
const FIXTURE_FOLDERS = [
  'src/pages',
  'src/components',
  'src/styles',
  'public',
  '.stacki/studio/state',
];

export async function startStyleFixture(
  sources: {
    readonly page?: string;
    readonly component?: string;
    readonly prepare?: (root: string) => Promise<void>;
  } = {},
) {
  await mkdir('.studio', { recursive: true });
  const root = await mkdtemp(path.resolve('.studio/style-parity-'));
  const port = await availablePort();
  const astro = path.resolve('node_modules/astro/bin/astro.mjs');
  for (const folder of FIXTURE_FOLDERS) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module","name":"style-parity"}');
  await writeFile(path.join(root, 'src/pages/index.astro'), sources.page ?? pageSource);
  await writeFile(
    path.join(root, 'src/components/Card.astro'),
    sources.component ?? componentSource,
  );
  await writeFile(
    path.join(root, 'src/styles/global.css'),
    '.sheet { padding: 12px; }\np { line-height: 1.5; }\n:root { --accent: rgb(30, 140, 80); }\n',
  );
  await writeFile(
    path.join(root, 'public/pattern.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>',
  );
  await sources.prepare?.(root);
  await writeStudioConfig(root, path.resolve('.'), port);
  try {
    await execute(
      process.execPath,
      [
        astro,
        'dev',
        '--background',
        '--config',
        './astro.studio.config.ts',
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
      ],
      { cwd: root, timeout: 60000 },
    );
    try {
      await waitForWatcher(root, port);
    } catch (error) {
      await execute(process.execPath, [astro, 'dev', 'stop'], { cwd: root, timeout: 20000 });
      throw error;
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    url: `http://localhost:${port}/studio`,
    async stop() {
      await execute(process.execPath, [astro, 'dev', 'stop'], { cwd: root, timeout: 20000 });
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function waitForWatcher(root: string, port: number) {
  // HTTP readiness and watcher "ready" can both precede working route discovery.
  // Probe actual route updates so tests cannot create pages in that startup gap.
  const file = path.join(root, 'src/pages/stacki-fixture-ready.astro');
  const deadline = performance.now() + 10_000;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (performance.now() >= deadline) {
        break;
      }
      await writeFile(file, '<h1>Fixture watcher ready</h1>');
      const response = await fetch(`http://127.0.0.1:${port}/stacki-fixture-ready`, {
        // First-route compilation shares this deadline; a one-second request
        // limit fails healthy fixtures when the regression suite is using CPU.
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
      });
      const content = await response.text();
      if (response.ok && content.includes('Fixture watcher ready')) {
        return;
      }
      await setTimeout(50);
    }
    throw new Error('Fixture route discovery did not become ready within 10 seconds');
  } finally {
    await rm(file, { force: true });
  }
}
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
const pageSource = `---
import Card from '../components/Card.astro';
import '../styles/global.css';
---
<html><head><title>Style parity</title></head><body>
<Card />
<div class="parent"><p id="target" class:list={["sheet", "component", "query-only"]}>Style target <span id="child">Inherited text</span></p></div>
</body></html>
<style>.parent { color: rgb(20, 60, 100); font-size: 22px; } body { margin: 30px; }</style>
`;
const componentSource = `---
const example = true;
---
<div class="card">Component</div>
<style is:global>
  /* Keep the component and its unrelated rules intact. */
  .card { display: block; }
  .component { opacity: 0.9; width: 300px; background-image: url("/pattern.svg"); border-radius: 8px; --custom-detail: 2; }
  .component:hover { opacity: 0.8; }
  .parent .component { letter-spacing: 1px; }
  @media (max-width: 600px) { .query-only { padding: 20px; } }
  .unrelated { outline: 3px solid red; }
</style>
`;
