// Goal: Add Worker's setup leaves a site that Publish's own readiness check accepts, and says why when it cannot.
// Method: fixture sites in temporary folders; the deploy tool's presence and its install are faked, so no network or
// process is involved. Each successful setup is followed by checkWorkerReady and checkHostingReady, the checks Publish
// runs before it builds, so setup and Publish are held to one answer. Refusals cover sites that cannot be set up,
// authored configs that name nothing to deploy, install failures, and an install that leaves the tool missing.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setUpWorkerHosting, outputDirectory, workerConfigSource, compatibilityDate } from '#dist/electron/project/publishWorkerSetup.js';
import { checkWorkerReady, workerConfigParse } from '#dist/electron/project/publishWorkerConfig.js';
import { checkHostingReady } from '#dist/electron/project/publishCommands.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parseWorkerSetupRequest, parseWorkerSetupResult, publishNeedsWorkerSetup } from '#dist/shared/properties/publishWorkerSetup.js';

const request = { accountId: 'account', project: 'my-site' } as const;
const today = () => new Date('2026-11-24T12:00:00Z');

async function site(context: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-worker-setup-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  return root;
}

/** A fake tool: installed once the fake install has run, and every install it was asked for recorded. */
function fakeTool(options: { readonly installed: boolean; readonly installWorks: boolean; readonly installLeavesTool?: boolean }) {
  let installed = options.installed;
  const installs: { readonly root: string; readonly executable: string; readonly arguments: readonly string[] }[] = [];
  return {
    installs,
    seams: {
      toolInstalled: () => installed,
      today,
      install: async (root: string, command: { readonly executable: string; readonly arguments: readonly string[] }) => {
        installs.push({ root, executable: command.executable, arguments: command.arguments });
        if (!options.installWorks) {
          throw new Error('npm ERR! //registry.example/:_authToken=secret');
        }
        installed = options.installLeavesTool ?? true;
      },
    },
  };
}

const astroSite = {
  'package.json': JSON.stringify({ name: 'site', scripts: { build: 'astro build' }, dependencies: { astro: '^5.0.0' } }),
  'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
  'package-lock.json': '{}',
};

test('Add Worker sets up a static Astro site so Publish’s readiness check passes', async (context) => {
  const root = await site(context, astroSite);
  const tool = fakeTool({ installed: false, installWorks: true });
  // Before setup, Publish refuses with the one sentence the dialog offers setup for.
  const before = await checkWorkerReady(root, tool.seams);
  assert.equal(before.ok, false);
  assert.equal(before.ok ? undefined : before.error.messageRef?.key, 'publish.worker.setup.needed');
  const result = await setUpWorkerHosting(root, request, tool.seams);
  assert.deepEqual(result, { kind: 'ready', hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'my-site' } });
  assert.deepEqual(parseWorkerSetupResult(result), result);
  const written = await readFile(path.join(root, 'wrangler.jsonc'), 'utf8');
  assert.deepEqual(workerConfigParse(path.join(root, 'wrangler.jsonc'), written), {
    name: 'my-site',
    compatibility_date: '2026-11-24',
    assets: { directory: './dist' },
  });
  // The deploy tool was added with the site's own package manager, as a development dependency.
  assert.deepEqual(tool.installs, [{ root, executable: 'npm', arguments: ['install', '--save-dev', 'wrangler'] }]);
  const ready = await checkWorkerReady(root, tool.seams);
  assert.ok(ready.ok);
  // Setting up again is a no-op that stays ready: the config is the site's now and is never rewritten.
  assert.deepEqual(await setUpWorkerHosting(root, request, tool.seams), result);
  assert.equal(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'), written);
  assert.equal(tool.installs.length, 1);
});

test('Publish’s own pre-build check accepts what setup wrote', async (context) => {
  const root = await site(context, { ...astroSite, 'node_modules/.bin/wrangler': '' });
  const config = { ...DEFAULT_PUBLISH_CONFIG, hosting: { provider: 'cloudflare-workers', ...request } } as const;
  const refused = await checkHostingReady(root, config);
  assert.equal(refused.ok, false);
  const result = await setUpWorkerHosting(root, request, { ...fakeTool({ installed: true, installWorks: true }).seams });
  assert.equal(result.kind, 'ready');
  const accepted = await checkHostingReady(root, config);
  assert.ok(accepted.ok);
});

test('Setup uses the site’s package manager and build folder', async (context) => {
  const root = await site(context, {
    'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.0', dependencies: { astro: '^5.0.0' } }),
    'astro.config.ts': "export default { outDir: './build/' };\n",
  });
  const tool = fakeTool({ installed: false, installWorks: true });
  assert.equal((await setUpWorkerHosting(root, request, tool.seams)).kind, 'ready');
  assert.equal(tool.installs[0]?.executable, 'pnpm');
  const value = workerConfigParse('wrangler.jsonc', await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  assert.deepEqual(value['assets'], { directory: './build' });
});

test('A site with Cloudflare’s Astro adapter deploys its server and its assets', async (context) => {
  for (const [range, main] of [
    ['^12.6.0', './dist/_worker.js/index.js'],
    ['^13.0.0', '@astrojs/cloudflare/entrypoints/server'],
  ] as const) {
    const root = await site(context, {
      'package.json': JSON.stringify({ dependencies: { astro: '^5.0.0', '@astrojs/cloudflare': range } }),
      'astro.config.mjs': "export default { output: 'server' };\n",
    });
    assert.equal((await setUpWorkerHosting(root, request, fakeTool({ installed: true, installWorks: true }).seams)).kind, 'ready');
    const value = workerConfigParse('wrangler.jsonc', await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
    assert.equal(value['main'], main);
    assert.deepEqual(value['assets'], { binding: 'ASSETS', directory: './dist' });
    assert.deepEqual(value['compatibility_flags'], ['nodejs_compat']);
  }
});

test('Sites that cannot be set up say why and are left untouched', async (context) => {
  const cases = [
    [{}, 'publish.worker.setup.notSite'],
    [{ 'package.json': '{not json' }, 'publish.worker.setup.notSite'],
    [{ 'package.json': JSON.stringify({ dependencies: { astro: '5', '@astrojs/node': '9' } }) }, 'publish.worker.setup.otherHost'],
    [{ 'package.json': '{}', 'astro.config.mjs': "export default { output: 'server' };" }, 'publish.worker.setup.onDemand'],
    [{ 'package.json': '{}', 'astro.config.mjs': 'export default { outDir: folder };' }, 'publish.worker.setup.outputFolder'],
    [{ 'package.json': '{}', 'astro.config.mjs': "export default { outDir: '../outside' };" }, 'publish.worker.setup.outputFolder'],
    [{ 'package.json': '{}', 'wrangler.toml': 'name = "other"\npages_build_output_dir = "dist"\n' }, 'publish.worker.setup.existingConfig'],
    [{ 'package.json': '{}', 'wrangler.json': '{invalid' }, 'publish.worker.error.configUnreadable'],
  ] as const;
  for (const [files, key] of cases) {
    const root = await site(context, files);
    const before = (await readdir(root)).sort();
    const tool = fakeTool({ installed: false, installWorks: true });
    const result = await setUpWorkerHosting(root, request, tool.seams);
    assert.equal(result.kind, 'failed', key);
    assert.equal(result.kind === 'failed' ? result.messageRef?.key : undefined, key);
    assert.deepEqual((await readdir(root)).sort(), before, `${key} writes nothing`);
    assert.equal(tool.installs.length, 0, `${key} installs nothing`);
    assert.equal((await checkWorkerReady(root, tool.seams)).ok, false, `${key} stays unready for Publish too`);
  }
});

test('An install failure or a tool still missing after it is a sanitized refusal, and Publish agrees', async (context) => {
  for (const options of [
    { installed: false, installWorks: false },
    { installed: false, installWorks: true, installLeavesTool: false },
  ]) {
    const root = await site(context, astroSite);
    const tool = fakeTool(options);
    context.mock.method(console, 'warn', () => undefined);
    const result = await setUpWorkerHosting(root, request, tool.seams);
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') {
      assert.equal(result.messageRef?.key, 'publish.worker.setup.installFailed');
      assert.doesNotMatch(result.message, /secret|npm ERR/);
    }
    const ready = await checkWorkerReady(root, tool.seams);
    assert.equal(ready.ok, false);
  }
});

test('An authored config that already deploys only needs the tool', async (context) => {
  const authored = '{ // Mine.\n"name":"site","main":"./worker.js"}';
  const root = await site(context, { 'package.json': '{}', 'wrangler.jsonc': authored });
  const tool = fakeTool({ installed: false, installWorks: true });
  assert.equal((await setUpWorkerHosting(root, request, tool.seams)).kind, 'ready');
  assert.equal(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'), authored);
  assert.equal(tool.installs.length, 1);
});

test('Setup helpers hold their bounds', () => {
  assert.equal(outputDirectory(undefined), './dist');
  assert.equal(outputDirectory("outDir: 'public/site'"), './public/site');
  assert.equal(outputDirectory("outDir: '/absolute'"), undefined);
  assert.equal(outputDirectory("outDir: '.'"), undefined);
  assert.equal(compatibilityDate(today()), '2026-11-24');
  assert.throws(() => compatibilityDate(new Date(Number.NaN)), /real date/);
  assert.throws(() => workerConfigSource('Bad Name', '2026-11-24', { kind: 'static', directory: './dist' }), /valid Worker/);
  assert.throws(() => workerConfigSource('site', 'today', { kind: 'static', directory: './dist' }), /calendar date/);
});

test('The Worker setup contract accepts only bounded names and results', () => {
  assert.deepEqual(parseIpcPayload('publish:workerSetup', { projectPath: '/site', worker: request }), { projectPath: '/site', worker: request });
  for (const input of [
    undefined,
    {},
    { accountId: '', project: 'site' },
    { accountId: 'account', project: 'Site' },
    { accountId: 'account', project: '-site' },
    { accountId: 'account', project: 'a'.repeat(64) },
    { accountId: '--help', project: 'site' },
  ]) {
    assert.throws(() => parseWorkerSetupRequest(input));
  }
  for (const input of [
    undefined,
    { kind: 'ready' },
    { kind: 'ready', hosting: { provider: 'vercel', accountId: 'a', project: 'b' } },
    { kind: 'failed', message: '' },
    { kind: 'done' },
  ]) {
    assert.throws(() => parseWorkerSetupResult(input));
  }
  // A reference that does not parse is dropped; the English sentence stays.
  assert.deepEqual(parseWorkerSetupResult({ kind: 'failed', message: 'No.', messageRef: { key: 42 } }), { kind: 'failed', message: 'No.' });
  const needed = { kind: 'failed', message: 'x', messageRef: { key: 'publish.worker.setup.needed' }, github: false, hosting: false } as const;
  assert.equal(publishNeedsWorkerSetup(needed), true);
  assert.equal(publishNeedsWorkerSetup({ ...needed, messageRef: { key: 'publish.command.timeLimit' } }), false);
  assert.equal(publishNeedsWorkerSetup({ kind: 'done', github: true, hosting: true }), false);
});
