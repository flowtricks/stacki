// Goal: shared metadata survives reopen without overwriting another writer or following links.
// Method: exercise the real document actors in isolated temporary projects and inspect disk bytes.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readProjectMetadata,
  writeProjectMetadata,
} from '#dist/electron/project/projectMetadata.js';
import {
  METADATA_FILES,
  metadataKind,
  type MetadataKind,
} from '#dist/shared/properties/projectMetadata.js';
import { DEFAULT_PUBLISH_CONFIG } from '#dist/shared/properties/publishConfig.js';
import { readPublishConfig } from '#dist/electron/project/publishConfig.js';

const firstSettings = {
  components: {
    version: 1,
    components: {
      'src/components/Wrapper.astro': {
        children: [{ component: 'src/components/Heading.astro', props: { slot: 'aside' } }],
      },
    },
  },
  guide: {
    version: 1,
    settings: {
      visible: true,
      numbers: false,
      color: '#888',
      opacity: 0.1,
      columns: { kind: 'count', count: 8 },
    },
  },
  pages: { version: 1, entries: ['about/', 'index.astro'] },
  componentSources: { version: 1, sources: [] },
  publish: {
    ...DEFAULT_PUBLISH_CONFIG,
    defaultTarget: 'hosting',
    githubAccount: 'owner',
    githubWorkflow: { kind: 'pull-request' },
    hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'website' },
    buildScript: 'build-site',
    beforePublish: ['prepare-site'],
    afterPublish: ['verify-site'],
  },
} satisfies Readonly<Record<MetadataKind, unknown>>;

for (const [key, value] of Object.entries(firstSettings)) {
  const kind = metadataKind(key);
  test(`${kind} creates its own file on first Desktop save without guide settings`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-first-settings-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, '.stacki');
    assert.deepEqual(readProjectMetadata(root, kind), { ok: true, value: {} });
    assert.equal(writeProjectMetadata(root, { kind, source: '{broken' }).ok, false);
    assert.equal(fs.existsSync(directory), false);
    const source = JSON.stringify(value);
    const changed = JSON.stringify(value, undefined, 2) + '\n';
    assert.equal(writeProjectMetadata(root, { kind, source }).ok, true);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(METADATA_FILES[kind])]);
    assert.deepEqual(readProjectMetadata(root, kind), { ok: true, value: { source } });
    assert.equal(writeProjectMetadata(root, { kind, source: changed, base: source }).ok, true);
    assert.equal(writeProjectMetadata(root, { kind, source, base: source }).ok, false);
    assert.deepEqual(readProjectMetadata(root, kind), { ok: true, value: { source: changed } });
    assert.equal(fs.readFileSync(path.join(root, METADATA_FILES[kind]), 'utf8'), changed);
    if (kind === 'publish') {
      assert.deepEqual(readPublishConfig(root), firstSettings.publish);
    }
  });
}

test('metadata creates once, saves against its base and reports external edits', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-metadata-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = '{"version":1,"components":{}}\n';
  assert.deepEqual(readProjectMetadata(root, 'components'), { ok: true, value: {} });
  assert.deepEqual(writeProjectMetadata(root, { kind: 'components', source }), {
    ok: true,
    value: { source },
  });
  const next = JSON.stringify({
    version: 1,
    components: {
      'src/components/Heading.astro': { text: 'Project heading' },
    },
  });
  assert.equal(writeProjectMetadata(root, { kind: 'components', source: next }).ok, false);
  assert.equal(
    writeProjectMetadata(root, { kind: 'components', source: next, base: source }).ok,
    true,
  );
  assert.equal(writeProjectMetadata(root, { kind: 'components', source, base: source }).ok, false);
  assert.equal(fs.readFileSync(path.join(root, '.stacki/components.json'), 'utf8'), next);
  assert.equal(
    writeProjectMetadata(root, { kind: 'components', source: '{broken', base: next }).ok,
    false,
  );
});

test('metadata refuses symlink directories and leaves the destination untouched', (context) => {
  if (process.platform === 'win32') {
    context.skip('Symlink privilege differs on Windows');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-metadata-link-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, '.stacki'), 'dir');
  assert.equal(
    writeProjectMetadata(root, {
      kind: 'components',
      source: '{"version":1,"components":{}}',
    }).ok,
    false,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('page and folder ordering uses shared metadata and rejects stale writes', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-order-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = JSON.stringify({
    version: 1,
    entries: ['about/', 'index.astro', 'about/story.astro'],
  });
  assert.deepEqual(readProjectMetadata(root, 'pages'), { ok: true, value: {} });
  assert.equal(writeProjectMetadata(root, { kind: 'pages', source }).ok, true);
  assert.deepEqual(readProjectMetadata(root, 'pages'), { ok: true, value: { source } });
  assert.equal(fs.readFileSync(path.join(root, '.stacki/pages.json'), 'utf8'), source);
  assert.equal(writeProjectMetadata(root, { kind: 'pages', source }).ok, false);
  assert.equal(writeProjectMetadata(root, { kind: 'pages', source: '{}', base: source }).ok, false);
});
