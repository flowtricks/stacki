// Goal: updating Studio must preserve each site's existing offline draft namespace.
// Method: validate both boundaries, scan real manifests, and compare old and scoped cache keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentStorageName, parseWorkspaceId } from '../src/shared/workspaceIdentity';
import { readWorkspaceId } from '../src/features/project/projectIdentity';
import { scanProject } from '../src/features/project/projectServer';
import { parseProject } from '../src/features/project/projectClient';

const project = {
  name: 'Site',
  pages: [],
  collections: [],
  assets: [],
  classes: [],
  components: [],
};

test('workspace identity is optional, bounded, and validated by the browser contract', () => {
  assert.equal(parseProject(project).workspaceId, undefined);
  const identifier = 'church-copy-2026-10-23';
  assert.equal(parseProject({ ...project, workspaceId: identifier }).workspaceId, identifier);
  assert.equal(parseWorkspaceId('a'.repeat(100)), 'a'.repeat(100));
  for (const input of ['', '../old', 'a:b', 'a/b', 'a b', 'a'.repeat(101), 42, null, {}, []]) {
    assert.throws(() => parseWorkspaceId(input), /Invalid/);
    assert.throws(() => parseProject({ ...project, workspaceId: input }), /Invalid/);
  }
});

test('workspace namespaces retain the deployed format without reading legacy or other site drafts', () => {
  const origin = 'https://cms.flowdev.workers.dev';
  const file = 'src/pages/index.astro';
  const legacy = documentStorageName(origin, file);
  const current = documentStorageName(origin, file, 'church-copy-2026-10-23');
  assert.equal(legacy, `astro-studio:${origin}:${file}`);
  assert.equal(current, `astro-studio:${origin}:church-copy-2026-10-23:${file}`);
  assert.notEqual(current, legacy);
  assert.notEqual(current, documentStorageName(origin, file, 'another-site'));
  assert.notEqual(current, documentStorageName(origin, 'src/pages/about.astro', 'church-copy-2026-10-23'));
});

test('project scans carry the manifest workspace identity across the server and browser boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-workspace-'));
  try {
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'public'));
    assert.equal(await readWorkspaceId(root), undefined);
    const manifest = path.join(root, 'package.json');
    await writeFile(manifest, JSON.stringify({ studio: { workspaceId: 'church-copy-2026-10-23' } }));
    assert.equal(parseProject(await scanProject(root)).workspaceId, 'church-copy-2026-10-23');
    for (const input of ['{}', '{"studio":{}}']) {
      await writeFile(manifest, input);
      assert.equal(await readWorkspaceId(root), undefined);
    }
    for (const input of ['{', 'null', '{"studio":null}', '{"studio":{"workspaceId":"../old"}}']) {
      await writeFile(manifest, input);
      await assert.rejects(readWorkspaceId(root));
    }
    await writeFile(manifest, ' '.repeat(1_000_001));
    await assert.rejects(readWorkspaceId(root), /Project manifest exceeds 1 MB limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
