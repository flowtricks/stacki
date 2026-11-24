// Goal: Stacki's own Wrangler install is planned, verified and moved into place atomically, and detection only ever
// accepts a whole, pinned copy. The negative space matters most: a lockfile with another hash or version, a missing
// lockfile, a damaged or other-version copy, and leftovers of an interrupted install must never count as installed.
// Method: run prepare and finish against temporary folders, playing npm's part by writing the files npm would write.
// Nothing is downloaded and npm never runs. Platform paths are computed for each operating system as pure values.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WRANGLER_PIN,
  checkAppWrangler,
  discardWranglerInstall,
  finishWranglerInstall,
  prepareWranglerInstall,
  publishToolsDirectory,
  setAppToolsDirectory,
  wranglerInstallPlan,
  wranglerToolRoot,
} from '#dist/electron/project/publishToolInstall.js';
import { wranglerAvailableWithoutPATH } from '#dist/electron/project/publishExecutable.js';

async function toolsFolder(context: TestContext): Promise<string> {
  const tools = await mkdtemp(path.join(tmpdir(), 'stacki-tools-'));
  context.after(() => rm(tools, { recursive: true, force: true }));
  return tools;
}

// What a successful `npm install` leaves in the staging folder, with fields a test can spoil.
async function playNPM(
  staging: string,
  overrides: { readonly version?: string; readonly integrity?: string; readonly lockfile?: boolean } = {},
): Promise<void> {
  const version = overrides.version ?? WRANGLER_PIN.version;
  const integrity = overrides.integrity ?? WRANGLER_PIN.integrity;
  const packageFolder = path.join(staging, 'node_modules', 'wrangler');
  await mkdir(path.join(packageFolder, 'bin'), { recursive: true });
  await writeFile(path.join(packageFolder, 'package.json'), JSON.stringify({ name: 'wrangler', version, bin: { wrangler: './bin/wrangler.js' } }));
  await writeFile(path.join(packageFolder, 'bin', 'wrangler.js'), '');
  if (overrides.lockfile !== false) {
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/wrangler': { version, integrity } } };
    await writeFile(path.join(staging, 'package-lock.json'), JSON.stringify(lock));
  }
}

test('the tools folder is the app data folder on each operating system', () => {
  assert.equal(publishToolsDirectory('/Users/designer', 'darwin', {}), path.join('/Users/designer', 'Library', 'Application Support', 'Stacki', 'tools'));
  assert.equal(publishToolsDirectory('/home/designer', 'linux', {}), path.join('/home/designer', '.config', 'Stacki', 'tools'));
  assert.equal(publishToolsDirectory('/home/designer', 'linux', { XDG_CONFIG_HOME: '/data/config' }), path.join('/data/config', 'Stacki', 'tools'));
  // A relative XDG folder would land the tools wherever Stacki started, so it is ignored.
  assert.equal(publishToolsDirectory('/home/designer', 'linux', { XDG_CONFIG_HOME: 'config' }), path.join('/home/designer', '.config', 'Stacki', 'tools'));
  assert.equal(
    publishToolsDirectory('/Users/designer', 'win32', { APPDATA: 'C:\\Users\\designer\\AppData\\Roaming' }),
    path.win32.join('C:\\Users\\designer\\AppData\\Roaming', 'Stacki', 'tools'),
  );
  assert.equal(publishToolsDirectory('/Users/designer', 'win32', {}), path.win32.join('/Users/designer', 'AppData', 'Roaming', 'Stacki', 'tools'));
  assert.throws(() => publishToolsDirectory('relative', 'darwin', {}), /absolute home/);
});

test('the plan installs beside the pinned target, explicitly and without scripts', () => {
  const plan = wranglerInstallPlan('/tools', 'abc-123');
  assert.equal(plan.target, path.join('/tools', 'wrangler', WRANGLER_PIN.version));
  assert.equal(plan.staging, path.join('/tools', 'wrangler', '.staging-abc-123'));
  for (const flag of ['--ignore-scripts', '--global=false', '--package-lock=true', '--no-audit', '--no-fund']) {
    assert.ok(plan.arguments.includes(flag), flag);
  }
  assert.equal(plan.arguments[plan.arguments.indexOf('--prefix') + 1], plan.staging);
  assert.throws(() => wranglerInstallPlan('/tools', '../escape'), /plain token/);
});

test('a verified install moves into place and is detected as ready', async (context) => {
  const tools = await toolsFolder(context);
  assert.deepEqual(checkAppWrangler(tools), { kind: 'missing' });
  const plan = prepareWranglerInstall(tools, 'one');
  assert.ok(plan.ok);
  const manifest: unknown = JSON.parse(await readFile(path.join(plan.value.staging, 'package.json'), 'utf8'));
  assert.deepEqual(manifest, { name: 'stacki-publish-tools', private: true, dependencies: { wrangler: WRANGLER_PIN.version } });
  await playNPM(plan.value.staging);
  assert.deepEqual(checkAppWrangler(tools), { kind: 'missing' }, 'a staged install is not used before it is verified');
  assert.deepEqual(finishWranglerInstall(plan.value), { ok: true, value: undefined });
  assert.equal(existsSync(plan.value.staging), false);
  assert.deepEqual(checkAppWrangler(tools), { kind: 'ready' });
});

test('another hash, another version, or no lockfile is refused and discarded', async (context) => {
  const cases = [{ integrity: 'sha512-AAAA' }, { version: '4.0.0' }, { lockfile: false }] as const;
  for (const spoiled of cases) {
    const tools = await toolsFolder(context);
    const plan = prepareWranglerInstall(tools, 'bad');
    assert.ok(plan.ok);
    await playNPM(plan.value.staging, spoiled);
    assert.deepEqual(finishWranglerInstall(plan.value), { ok: false, error: 'verify' }, JSON.stringify(spoiled));
    assert.equal(existsSync(plan.value.staging), false, 'the refused install is removed');
    assert.equal(checkAppWrangler(tools).kind, 'missing');
  }
});

test('a damaged copy is replaced, and other versions and leftovers are swept', async (context) => {
  const tools = await toolsFolder(context);
  const target = wranglerToolRoot(tools);
  // A copy without its manifest (an interrupted older write) and a manifest that is not JSON.
  await mkdir(path.join(target, 'node_modules', 'wrangler'), { recursive: true });
  await writeFile(path.join(target, 'node_modules', 'wrangler', 'package.json'), '{ not json');
  assert.deepEqual(checkAppWrangler(tools), { kind: 'corrupt' });
  const leftover = path.join(tools, 'wrangler', '.staging-old');
  const older = path.join(tools, 'wrangler', '3.0.0');
  await mkdir(leftover, { recursive: true });
  await mkdir(older, { recursive: true });
  const plan = prepareWranglerInstall(tools, 'fresh');
  assert.ok(plan.ok);
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(older), false);
  await playNPM(plan.value.staging);
  assert.ok(finishWranglerInstall(plan.value).ok);
  assert.deepEqual(checkAppWrangler(tools), { kind: 'ready' });
});

test('a copy of another version is a mismatch, not ready', async (context) => {
  const tools = await toolsFolder(context);
  const folder = path.join(wranglerToolRoot(tools), 'node_modules', 'wrangler');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'wrangler', version: '3.99.0' }));
  assert.deepEqual(checkAppWrangler(tools), { kind: 'mismatch', version: '3.99.0' });
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'not-wrangler', version: WRANGLER_PIN.version }));
  assert.deepEqual(checkAppWrangler(tools), { kind: 'corrupt' });
});

test('discarding removes only staging folders', () => {
  assert.throws(() => discardWranglerInstall({ staging: '/tools/wrangler/4.0.0', target: '/tools/wrangler/4.0.1' }), /Only staging folders/);
  const plan = wranglerInstallPlan('/tools', 'x');
  assert.throws(() => discardWranglerInstall({ staging: plan.target, target: plan.target }), /never removes the installed tool/);
});

test('a site without Wrangler finds Stacki’s pinned copy once it is installed', async (context) => {
  const tools = await toolsFolder(context);
  const site = await mkdtemp(path.join(tmpdir(), 'stacki-tools-site-'));
  context.after(async () => {
    setAppToolsDirectory(undefined);
    await rm(site, { recursive: true, force: true });
  });
  setAppToolsDirectory(tools);
  const before = wranglerAvailableWithoutPATH(site);
  const plan = prepareWranglerInstall(tools, 'site');
  assert.ok(plan.ok);
  await playNPM(plan.value.staging);
  assert.ok(finishWranglerInstall(plan.value).ok);
  assert.equal(wranglerAvailableWithoutPATH(site), true);
  // The test checkout itself may ship Wrangler (Studio does), so only the after-install answer is pinned down.
  assert.equal(typeof before, 'boolean');
});
