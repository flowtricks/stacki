// Goal: local Studio shares website source without overwriting project configuration.
// Method: use temporary projects to check installation detection, generated paths,
// session storage boundaries, startup failures, and the browser entry's loopback restriction;
// and that Studio's own folders move into the self-ignored `.stacki/studio/` once, whole.
// Stand-in Astro CLIs record the real spawned environments: Studio's child carries the telemetry
// opt-outs, and the canvas spawn, which Studio shares a host with, gains none of them.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { studioEntryHTML } from '#dist/electron/previewServer/studioEntry.js';
import { prepareStudioLocal } from '#dist/electron/previewServer/studioLocalMove.js';
import { isStudioLocalPath } from '#dist/shared/properties/studioLocal.js';
import { createLocalStudio, hasLocalStudio, writeLocalStudioConfig } from '#dist/electron/previewServer/studioLocal.js';
import { setToolPathHome, spawnAstroServer } from '#dist/electron/lib/nodeTools.js';
import { STUDIO_TELEMETRY_DISABLED } from '#dist/shared/properties/studioTelemetry.js';
import { once } from 'node:events';

setToolPathHome(os.homedir());

test('local configuration uses website source and leaves its Astro config intact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-local-'));
  try {
    const config = 'export default { site: "https://example.com" };\n';
    await writeFile(path.join(root, 'astro.config.mjs'), config);
    const generated = writeLocalStudioConfig(root, path.join(root, 'studio/dist'), 4399);
    assert.equal(generated, path.join(root, 'node_modules/.avb/astro.studio.config.mjs'));
    const source = await readFile(generated, 'utf8');
    assert.ok(
      source.includes(
        JSON.stringify({
          root,
          assets: path.join(root, 'studio/dist'),
          port: 4399,
          editing: 'source',
        }),
      ),
    );
    assert.ok(source.includes('astro.config.mjs'));
    assert.doesNotMatch(source, /\.studio\/workspace/);
    assert.equal(await readFile(path.join(root, 'astro.config.mjs'), 'utf8'), config);
    // Session storage sits inside `.stacki/studio/`, which ignores its own contents.
    assert.equal(await readFile(path.join(root, '.stacki/studio/.gitignore'), 'utf8'), '*\n');
    assert.throws(() => writeLocalStudioConfig(root, root, 80), /nonprivileged/);
    assert.throws(() => writeLocalStudioConfig(root, root, 1.5), /integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing, malformed and symlinked Studio installations are not started', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-detection-'));
  try {
    assert.equal(hasLocalStudio(root), false);
    const metadata = path.join(root, 'studio/src/shared');
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(metadata, 'release.json'), '{"version":"0.1.48"}');
    assert.equal(hasLocalStudio(root), true);
    const studio = createLocalStudio(root, () => {});
    const result = await studio.open();
    assert.equal(result.ok, false);
    studio.close();
    assert.deepEqual(await studio.open(), { ok: false, error: 'The website preview has closed.' });
    await writeFile(path.join(metadata, 'release.json'), '{"version":4}');
    assert.equal(hasLocalStudio(root), false);
    await writeFile(path.join(metadata, 'release.json'), 'x'.repeat(4097));
    assert.equal(hasLocalStudio(root), false);
    const other = path.join(root, 'other');
    await mkdir(other);
    await symlink(path.join(root, 'studio'), path.join(other, 'studio'), 'dir');
    assert.equal(hasLocalStudio(other), false);
    await mkdir(path.join(root, '.stacki/studio'), { recursive: true });
    await symlink(other, path.join(root, '.stacki/studio/state'), 'dir');
    assert.throws(() => writeLocalStudioConfig(root, root, 4399), /real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the website entry embeds only a local Studio origin', () => {
  const html = studioEntryHTML('http://127.0.0.1:4399');
  assert.match(html, /title="Stacki Studio" src="http:\/\/127.0.0.1:4399\/studio"/);
  for (const origin of ['https://example.com', 'javascript:alert(1)', 'http://127.0.0.1']) {
    assert.throws(() => studioEntryHTML(origin), /local HTTP origin/);
  }
});

test("an older Studio's folders move into .stacki/studio once, whole", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-move-'));
  try {
    await mkdir(path.join(root, '.studio-state/drafts'), { recursive: true });
    await writeFile(path.join(root, '.studio-state/drafts/a.bin'), 'draft');
    await mkdir(path.join(root, '.stacki-studio'));
    await writeFile(path.join(root, '.stacki-studio/update.lock'), 'lock');
    prepareStudioLocal(root);
    assert.equal(await readFile(path.join(root, '.stacki/studio/.gitignore'), 'utf8'), '*\n');
    assert.equal(await readFile(path.join(root, '.stacki/studio/state/drafts/a.bin'), 'utf8'), 'draft');
    assert.equal(await readFile(path.join(root, '.stacki/studio/updates/update.lock'), 'utf8'), 'lock');
    await mkdir(path.join(root, '.studio-state'));
    prepareStudioLocal(root);
    assert.equal(
      await readFile(path.join(root, '.stacki/studio/state/drafts/a.bin'), 'utf8'),
      'draft',
      'a second old folder never replaces or merges into the moved one',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only Studio-owned paths read as Studio state', () => {
  for (const owned of ['.stacki/studio', '.stacki/studio/state/a.bin', '.studio-state', 'x/.stacki-studio/y']) {
    assert.equal(isStudioLocalPath(owned), true, owned);
  }
  for (const site of ['.stacki/components.json', '.stacki/studios.json', 'studio/src/app.ts', 'src/studio-state.ts']) {
    assert.equal(isStudioLocalPath(site), false, site);
  }
  assert.throws(() => isStudioLocalPath('.stacki\\studio'), /POSIX paths/);
});

const TELEMETRY_NAMES = Object.keys(STUDIO_TELEMETRY_DISABLED);
const RECORD_ENVIRONMENT = 'import { writeFileSync } from "node:fs";\nwriteFileSync("environment.json", JSON.stringify(process.env));\n';

async function recordedEnvironment(root: string): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = JSON.parse(await readFile(path.join(root, 'environment.json'), 'utf8'));
  assert.ok(typeof value === 'object' && value !== null);
  return Object.fromEntries(Object.entries(value));
}

// The host's own values decide what a child inherits, so each test states them.
function withHostEnvironment(context: TestContext, values: Readonly<Record<string, string>>): void {
  const previous = Object.fromEntries(TELEMETRY_NAMES.map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  for (const name of TELEMETRY_NAMES) {
    delete process.env[name];
  }
  Object.assign(process.env, values);
}

test('Studio started from Desktop carries the telemetry opt-outs, over an inherited value', async (context) => {
  withHostEnvironment(context, { WRANGLER_SEND_METRICS: 'true' });
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-telemetry-'));
  await mkdir(path.join(root, 'studio/dist'), { recursive: true });
  await writeFile(path.join(root, 'studio/dist/integration.mjs'), '');
  await mkdir(path.join(root, 'node_modules/astro/bin'), { recursive: true });
  await writeFile(
    path.join(root, 'node_modules/astro/bin/astro.mjs'),
    RECORD_ENVIRONMENT +
      [
        'import { createServer } from "node:http";',
        'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
        'createServer((request, response) => response.end(JSON.stringify({ kind: "local" }))).listen(port, "127.0.0.1");',
      ].join('\n'),
  );
  const studio = createLocalStudio(root, () => {});
  // Stop the child first: Windows cannot remove a directory a process is running in.
  context.after(async () => {
    studio.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const result = await studio.open();
  assert.equal(result.ok, true);
  const environment = await recordedEnvironment(root);
  assert.deepEqual(Object.fromEntries(TELEMETRY_NAMES.map((name) => [name, environment[name]])), STUDIO_TELEMETRY_DISABLED);
});

test("Desktop's canvas spawn keeps its environment", async (context) => {
  withHostEnvironment(context, {});
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-canvas-telemetry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'astro.mjs');
  await writeFile(bin, RECORD_ENVIRONMENT);
  const child = spawnAstroServer(root, bin, ['dev']);
  await once(child, 'exit');
  const environment = await recordedEnvironment(root);
  for (const name of TELEMETRY_NAMES) {
    assert.equal(environment[name], undefined, name);
  }
});
