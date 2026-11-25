// Goal: publishing executes installed scripts in order and stops at the first operating failure.
// Desktop's publishes stay as they were: the shared command adds no telemetry setting of its own.
// Method: run real npm subprocesses in temporary projects; no provider or network is contacted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPublishCommand, runPublishScripts, deployHosting } from '#dist/electron/project/publishCommands.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';
import { STUDIO_TELEMETRY_DISABLED } from '#dist/shared/properties/studioTelemetry.js';

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

test("a Desktop publish adds none of Studio's telemetry opt-outs", { skip: process.platform === 'win32' }, async (context) => {
  const names = Object.keys(STUDIO_TELEMETRY_DISABLED);
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-publish-telemetry-'));
  context.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of names) {
    delete process.env[name];
  }
  const wrangler = path.join(root, 'node_modules/.bin/wrangler');
  await mkdir(path.dirname(wrangler), { recursive: true });
  await writeFile(wrangler, `#!${process.execPath}\nrequire('node:fs').writeFileSync('environment.json', JSON.stringify(process.env));\n`);
  await chmod(wrangler, 0o755);
  await runPublishCommand(root, { executable: 'wrangler', arguments: ['deploy'], environment: {} });
  const environment: unknown = JSON.parse(await readFile(path.join(root, 'environment.json'), 'utf8'));
  assert.ok(typeof environment === 'object' && environment !== null);
  for (const name of names) {
    assert.equal(name in environment, false, name);
  }
});
