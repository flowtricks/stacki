// Goal: the selected Worker account wins without rewriting authored or generated configuration.
// Method: temporary files cover formats and cleanup; Windows paths test diagnostics on every OS.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { withWorkerAccount, workerConfigParse } from '#dist/electron/project/publishWorkerConfig.js';

test('Worker configuration diagnostics accept Windows paths on every platform', () => {
  const filename = String.raw`C:\Users\runner\site\wrangler.jsonc`;
  assert.deepEqual(workerConfigParse(filename, '{"name":"site",}'), { name: 'site' });
  assert.throws(() => workerConfigParse(filename, '{invalid'), /Cannot read Wrangler configuration/);
});

for (const filename of ['wrangler.jsonc', 'wrangler.toml']) {
  test(`Worker account overrides ${filename}, preserving paths and bindings`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'stacki-worker-config-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const source = filename.endsWith('.toml')
      ? 'name = "site"\naccount_id = "old"\nmain = "./worker.js"\n[vars]\nTITLE = "Hello"\n'
      : '{ // Keep comments.\n"name":"site","account_id":"old","main":"./worker.js",' + '"vars":{"TITLE":"Hello"}}';
    await writeFile(path.join(root, filename), source);
    await withWorkerAccount(root, 'selected', async (configuration) => {
      assert.equal(path.dirname(configuration), root);
      const value: unknown = JSON.parse(await readFile(configuration, 'utf8'));
      assert.deepEqual(value, {
        name: 'site',
        account_id: 'selected',
        main: './worker.js',
        vars: { TITLE: 'Hello' },
      });
    });
    assert.equal(await readFile(path.join(root, filename), 'utf8'), source);
    assert.deepEqual(await readdir(root), [filename]);
  });
}

test('Worker deploy uses build redirects and cleans up failures', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-worker-build-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.wrangler/deploy'), { recursive: true });
  await mkdir(path.join(root, 'output'));
  await writeFile(path.join(root, 'wrangler.json'), '{"account_id":"authored"}');
  await writeFile(path.join(root, '.wrangler/deploy/config.json'), '{"configPath":"../../output/wrangler.json"}');
  await writeFile(path.join(root, 'output/wrangler.json'), '{"account_id":"generated","main":"./server.js","assets":{"directory":"./client"}}');
  await assert.rejects(
    withWorkerAccount(root, 'selected', async (configuration) => {
      assert.equal(path.dirname(configuration), path.join(root, 'output'));
      const value: unknown = JSON.parse(await readFile(configuration, 'utf8'));
      assert.deepEqual(value, {
        account_id: 'selected',
        main: './server.js',
        assets: { directory: './client' },
      });
      throw new Error('Deployment failed');
    }),
    /Deployment failed/,
  );
  assert.deepEqual(await readdir(path.join(root, 'output')), ['wrangler.json']);
});

test('Worker config rejects missing, oversized, invalid, and escaping files', async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'stacki-worker-invalid-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'site');
  await mkdir(path.join(root, '.wrangler/deploy'), { recursive: true });
  const deploy = async () => {
    assert.fail('Invalid config must never deploy');
  };
  await assert.rejects(withWorkerAccount(root, 'selected', deploy), /Configure this project/);
  await writeFile(path.join(root, 'wrangler.json'), 'x'.repeat(65_537));
  await assert.rejects(withWorkerAccount(root, 'selected', deploy), /64 KiB/);
  await writeFile(path.join(root, 'wrangler.json'), '{invalid');
  await assert.rejects(withWorkerAccount(root, 'selected', deploy), /Cannot read/);
  await writeFile(path.join(temporary, 'outside.json'), '{}');
  await writeFile(path.join(root, '.wrangler/deploy/config.json'), '{"configPath":"../../../outside.json"}');
  await assert.rejects(withWorkerAccount(root, 'selected', deploy), /inside the publish snapshot/);
});
