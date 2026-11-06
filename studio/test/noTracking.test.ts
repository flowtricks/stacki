// Goal: Studio cannot ship usage tracking unnoticed, and every launch point it owns carries
// the third-party opt-outs.
// Method: run the check on the real tree, then change one thing at a time in a passing fixture
// and pin each failure's message. `startDraft` runs for real against a stand-in Astro CLI that
// records its environment; `container.ts` starts work on import, so its launch is held by the
// source check. Nothing here contacts a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDraft } from '../scripts/dev';
import { findTrackingFailures, NO_TRACKING_SOURCE, type NoTrackingInput, type TextFile } from '../scripts/noTracking';
import { readNoTrackingInput } from '../scripts/noTrackingTree';
import { runPublishCommand } from '../vendor/stacki/electron/project/publishCommands';
import { STUDIO_TELEMETRY_DISABLED, withStudioTelemetryDisabled } from '../vendor/stacki/shared/properties/studioTelemetry';

const studio = fileURLToPath(new URL('../', import.meta.url));
const LAUNCH = 'spawn(tool, { env: withStudioTelemetryDisabled(process.env) });';
const TELEMETRY_SOURCE = "ASTRO_TELEMETRY_DISABLED: '1', VERCEL_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false'";
const DOCKERFILE = 'FROM node\nENV ASTRO_TELEMETRY_DISABLED=1\nENV VERCEL_TELEMETRY_DISABLED=1\nENV WRANGLER_SEND_METRICS=false\n';
const CLIENT = ['dist/index.html', 'dist/morph.js', 'dist/preview.js', 'dist/studio.css', 'dist/studio.js'].map((file) => ({ path: file, content: '' }));

function fixture(): NoTrackingInput {
  return {
    distribution: CLIENT,
    launchPoints: { containerScript: LAUNCH, desktopStudioLaunch: LAUNCH, devScript: LAUNCH, dockerfile: DOCKERFILE, telemetrySource: TELEMETRY_SOURCE },
    sharedSource: { adapters: [], files: ['shared/core/assert.ts'], imports: {}, modules: {} },
    source: [{ path: 'src/app/main.tsx', content: 'export const ready = true;' }],
  };
}

function withSource(content: string): NoTrackingInput {
  return { ...fixture(), source: [{ path: 'src/app/main.tsx', content }] };
}

function withClient(content: string): NoTrackingInput {
  const distribution: readonly TextFile[] = CLIENT.map((file) => (file.path === 'dist/studio.js' ? { ...file, content } : file));
  return { ...fixture(), distribution };
}

function withShared(files: readonly string[]): NoTrackingInput {
  return { ...fixture(), sharedSource: { adapters: [], files, imports: {}, modules: {} } };
}

test('the real tree passes', async () => {
  assert.deepEqual(findTrackingFailures(await readNoTrackingInput(studio, 'when-present')), []);
});

test('the fixture passes, so every failure below comes from its one change', () => {
  assert.deepEqual(findTrackingFailures(fixture()), []);
});

test('Desktop-only sources cannot be listed for Studio', () => {
  assert.deepEqual(findTrackingFailures(withShared(['electron/app/usageCounts.ts'])), [
    'shared-source.json: electron/app/usageCounts.ts is Desktop-only and must not ship in Studio.',
  ]);
  assert.deepEqual(findTrackingFailures(withShared(['electron/app/autoUpdate.ts'])), [
    'shared-source.json: electron/app/autoUpdate.ts is Desktop-only and must not ship in Studio.',
  ]);
  assert.deepEqual(findTrackingFailures(withShared(['services/usageCounts/src/index.ts'])), [
    "shared-source.json: services/usageCounts/src/index.ts is under services/, which holds Desktop's usage counter.",
  ]);
});

test('an adapter or module mapping cannot smuggle in a Desktop-only source', () => {
  const adapters = { ...fixture(), sharedSource: { adapters: ['electron/app/autoUpdate.ts'], files: [], imports: {}, modules: {} } };
  assert.equal(findTrackingFailures(adapters).length, 1);
  const modules = { ...fixture(), sharedSource: { adapters: [], files: [], imports: {}, modules: { 'electron/app/usageCounts.ts': 'src/x.ts' } } };
  assert.equal(findTrackingFailures(modules).length, 1);
});

test('a malformed shared source list fails instead of passing empty', () => {
  const expected = ['shared-source.json: expected files and adapters lists, and imports and modules maps.'];
  assert.deepEqual(findTrackingFailures({ ...fixture(), sharedSource: undefined }), expected);
  assert.deepEqual(findTrackingFailures({ ...fixture(), sharedSource: { files: [] } }), expected);
  assert.deepEqual(findTrackingFailures({ ...fixture(), sharedSource: { adapters: [], files: [1], imports: {}, modules: {} } }), expected);
});

const FORBIDDEN_SOURCE: readonly (readonly [string, string])[] = [
  ["fetch('https://stacki-usage-counts.example.workers.dev/daily');", "Stacki's usage counter URL"],
  ['await sendUsageCount(fetch);', "Stacki's usage counter sender"],
  ['navigator.sendBeacon(url, body);', 'a sendBeacon call'],
  ["import { autoUpdater } from 'electron-updater';", 'electron-updater'],
  ["import posthog from 'posthog-js';", 'an analytics package'],
  ["import * as Sentry from '@sentry/browser';", 'an analytics package'],
  ["import mixpanel from 'mixpanel-browser';", 'an analytics package'],
  ["import { Analytics } from '@segment/analytics-node';", 'an analytics package'],
  ["import * as amplitude from '@amplitude/analytics-browser';", 'an analytics package'],
  ["import Plausible from 'plausible-tracker';", 'an analytics package'],
  ["const script = 'https://www.googletagmanager.com/gtag/js';", 'an analytics host'],
  ["const script = 'https://plausible.io/js/script.js';", 'an analytics host'],
  ["const host = 'https://us.i.posthog.com';", 'an analytics host'],
  ["gtag('config', id);", 'an analytics SDK call'],
  ['Sentry.init({ dsn });', 'an analytics SDK call'],
];

test('every tracking marker fails in source and in the build', () => {
  for (const [content, label] of FORBIDDEN_SOURCE) {
    assert.ok(findTrackingFailures(withSource(content)).includes(`src/app/main.tsx: contains ${label}.`), content);
    assert.ok(findTrackingFailures(withClient(content)).includes(`dist/studio.js: contains ${label}.`), content);
  }
});

test('a lockfile entry or dependency fails as an analytics package', () => {
  const dependency = { path: 'package.json', content: '{"dependencies":{"@sentry/node":"^9.0.0"}}' };
  const lockfile = { path: 'package-lock.json', content: '{"packages":{"node_modules/posthog-node":{}}}' };
  assert.deepEqual(findTrackingFailures({ ...fixture(), source: [dependency, lockfile] }), [
    'package.json: contains an analytics package.',
    'package-lock.json: contains an analytics package.',
  ]);
});

test('inert names and everyday words are not tracking', () => {
  const content = [
    'const preference = { usageCountsEnabled: false };',
    'const parts = path.segment; const segment = 1; const amplitude = 2;',
    '// A plausible value for the sentry and the mixpanel words in prose.',
    "const file = 'segment.ts';",
  ].join('\n');
  assert.deepEqual(findTrackingFailures(withSource(content)), []);
});

test('the check does not scan itself but scans its neighbours', () => {
  const content = 'navigator.sendBeacon(url);';
  assert.deepEqual(findTrackingFailures({ ...fixture(), source: [{ path: NO_TRACKING_SOURCE, content }] }), []);
  assert.equal(findTrackingFailures({ ...fixture(), source: [{ path: 'scripts/release.ts', content }] }).length, 1);
});

test('the client may name only reviewed external hosts', () => {
  assert.deepEqual(findTrackingFailures(withClient('const link = "https://tracker.example.net/collect";')), [
    'dist/studio.js: names external host tracker.example.net, which is not in the reviewed allowlist.',
  ]);
  assert.deepEqual(findTrackingFailures(withClient('new WebSocket("wss://collect.example.net");')), [
    'dist/studio.js: names external host collect.example.net, which is not in the reviewed allowlist.',
  ]);
  // Hosts are exact: an allowed name cannot be borrowed as a prefix of someone else's domain.
  assert.equal(findTrackingFailures(withClient('fetch("https://github.com.example.net/x");')).length, 1);
  assert.deepEqual(findTrackingFailures(withClient('fetch("https://github.com/x"); fetch("http://localhost:4350");')), []);
});

test('a server bundle may name provider APIs, and a build without a client file fails', () => {
  const server = { path: 'dist/integration.mjs', content: 'fetch("https://api.sanity.io/v1");' };
  assert.deepEqual(findTrackingFailures({ ...fixture(), distribution: [...CLIENT, server] }), []);
  const partial = CLIENT.filter((file) => file.path !== 'dist/studio.js');
  assert.deepEqual(findTrackingFailures({ ...fixture(), distribution: partial }), [
    'dist/studio.js: missing from the build, so its external hosts cannot be checked.',
  ]);
});

test('without a build the check skips only the build, and a required build must exist', async () => {
  assert.deepEqual(findTrackingFailures({ ...fixture(), distribution: undefined }), []);
  const empty = await mkdtemp(path.join(os.tmpdir(), 'studio-no-tracking-'));
  try {
    for (const directory of ['adapters', 'scripts', 'src', 'templates', 'vendor/stacki/shared/properties']) {
      await mkdir(path.join(empty, 'studio', directory), { recursive: true });
    }
    await mkdir(path.join(empty, 'electron/previewServer'), { recursive: true });
    for (const file of [
      'studio/package.json',
      'studio/package-lock.json',
      'studio/scripts/container.ts',
      'studio/scripts/dev.ts',
      'studio/Dockerfile',
      'studio/vendor/stacki/shared/properties/studioTelemetry.ts',
      'electron/previewServer/studioLocal.ts',
    ]) {
      await writeFile(path.join(empty, file), '');
    }
    await writeFile(path.join(empty, 'studio/scripts/shared-source.json'), '{}');
    await assert.rejects(readNoTrackingInput(path.join(empty, 'studio'), 'required'), /no dist directory/);
    assert.equal((await readNoTrackingInput(path.join(empty, 'studio'), 'when-present')).distribution, undefined);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('each launch point must carry the opt-outs', () => {
  const launch = fixture().launchPoints;
  const required = 'must start Studio with env: withStudioTelemetryDisabled(process.env).';
  assert.deepEqual(findTrackingFailures({ ...fixture(), launchPoints: { ...launch, devScript: 'spawn(tool);' } }), [`scripts/dev.ts: ${required}`]);
  assert.deepEqual(findTrackingFailures({ ...fixture(), launchPoints: { ...launch, containerScript: 'spawn(tool);' } }), [`scripts/container.ts: ${required}`]);
  assert.deepEqual(findTrackingFailures({ ...fixture(), launchPoints: { ...launch, desktopStudioLaunch: 'spawn(tool);' } }), [
    `electron/previewServer/studioLocal.ts: ${required}`,
  ]);
  assert.deepEqual(findTrackingFailures({ ...fixture(), launchPoints: { ...launch, devScript: `${LAUNCH} spawn(other, { env: process.env });` } }), [
    'scripts/dev.ts: env: process.env would start a tool without the telemetry opt-outs.',
  ]);
});

test('each opt-out value must be set exactly, in the image and in the shared table', () => {
  const launch = fixture().launchPoints;
  for (const [name, value] of Object.entries(STUDIO_TELEMETRY_DISABLED)) {
    assert.deepEqual(findTrackingFailures({ ...fixture(), launchPoints: { ...launch, dockerfile: DOCKERFILE.replace(`ENV ${name}=${value}\n`, '') } }), [
      `Dockerfile: must set ENV ${name}=${value}.`,
    ]);
    assert.deepEqual(
      findTrackingFailures({ ...fixture(), launchPoints: { ...launch, telemetrySource: TELEMETRY_SOURCE.replace(`${name}: '${value}'`, `${name}: 'on'`) } }),
      [`shared/properties/studioTelemetry.ts: must set ${name} to ${value}.`],
    );
  }
});

test('the opt-outs override inherited values and keep the rest of the environment', () => {
  const environment = withStudioTelemetryDisabled({ PATH: '/bin', WRANGLER_SEND_METRICS: 'true' });
  assert.equal(environment['PATH'], '/bin');
  assert.equal(environment['WRANGLER_SEND_METRICS'], 'false');
  assert.equal(environment['ASTRO_TELEMETRY_DISABLED'], '1');
  assert.equal(environment['VERCEL_TELEMETRY_DISABLED'], '1');
});

const RECORD_ENVIRONMENT = 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.STUDIO_TEST_RECORD, JSON.stringify(process.env));\n';

async function recorded(file: string): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(typeof value === 'object' && value !== null);
  return Object.fromEntries(Object.entries(value));
}

test('astro-studio dev starts Astro with the opt-outs, over an inherited value', async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-no-tracking-dev-')));
  const workspace = path.join(root, 'workspace');
  const record = path.join(root, 'environment.json');
  const previous = { ...process.env };
  context.after(async () => {
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(workspace, 'node_modules/astro/bin'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), '{}');
  await writeFile(path.join(workspace, 'node_modules/astro/bin/astro.mjs'), RECORD_ENVIRONMENT);
  process.env['STUDIO_WORKSPACE'] = workspace;
  process.env['STUDIO_TEST_RECORD'] = record;
  process.env['WRANGLER_SEND_METRICS'] = 'true';
  await startDraft(studio, root, 4399);
  const environment = await recorded(record);
  for (const [name, value] of Object.entries(STUDIO_TELEMETRY_DISABLED)) {
    assert.equal(environment[name], value, name);
  }
});

test('a publish forwards what Studio was started with, so the shared code needs no change', { skip: process.platform === 'win32' }, async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-no-tracking-publish-')));
  const record = path.join(root, 'environment.json');
  const previous = { ...process.env };
  context.after(async () => {
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  });
  const wrangler = path.join(root, 'node_modules/.bin/wrangler');
  await mkdir(path.dirname(wrangler), { recursive: true });
  await writeFile(wrangler, `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.STUDIO_TEST_RECORD, JSON.stringify(process.env));\n`);
  await chmod(wrangler, 0o755);
  process.env = { ...withStudioTelemetryDisabled(previous), STUDIO_TEST_RECORD: record };
  await runPublishCommand(root, { executable: 'wrangler', arguments: ['deploy'], environment: {} });
  assert.equal((await recorded(record))['WRANGLER_SEND_METRICS'], 'false');
});
