// Restart only the test's isolated Astro daemon, preserving its draft and Yjs snapshots.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function restartPropPreview(root: string, port: string): Promise<void> {
  assert.ok(root.includes('/.studio/'), 'Restart requires an isolated Studio draft');
  assert.match(port, /^\d{4,5}$/, 'Restart requires an explicit local preview port');
  const execute = promisify(execFile);
  const astro = path.join(root, 'node_modules/astro/bin/astro.mjs');
  await execute(process.execPath, [astro, 'dev', 'stop'], { cwd: root, timeout: 20_000 });
  await execute(
    process.execPath,
    [
      astro,
      'dev',
      '--background',
      '--config',
      './astro.studio.config.ts',
      '--port',
      port,
      '--host',
      '127.0.0.1',
    ],
    { cwd: root, timeout: 60_000 },
  );
}
