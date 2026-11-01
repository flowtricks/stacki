// Goal: publishing executes installed scripts in order and stops at the first operating failure.
// Method: run real npm subprocesses in temporary projects; no provider or network is contacted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPublishScripts, deployHosting } from '#dist/electron/project/publishCommands.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';

test('hooks preserve order and stop on failure', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-publish-hooks-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: { first: 'node hook.cjs', fail: 'node fail.cjs', last: 'node hook.cjs' },
    }),
  );
  await writeFile(path.join(root, 'hook.cjs'), "require('node:fs').appendFileSync('order.txt', process.env.STACKI_PUBLISH_TARGET + '\\n');");
  await writeFile(path.join(root, 'fail.cjs'), 'process.exit(7);');
  await assert.rejects(runPublishScripts(root, ['first', 'fail', 'last'], { STACKI_PUBLISH_TARGET: 'hosting' }), /npm failed/);
  assert.equal(await readFile(path.join(root, 'order.txt'), 'utf8'), 'hosting\n');
  await assert.rejects(deployHosting(root, DEFAULT_PUBLISH_CONFIG), /Choose a hosting provider/);
});
