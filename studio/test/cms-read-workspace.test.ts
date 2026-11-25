// Goal: repeated CMS reads reuse the compiled workspace without serving stale source.
// Method: compare real staging paths, edit source/configuration, and exercise queued cleanup.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmsSources, CmsReadWorkspace } from '../src/features/cms/cmsSnapshot';

test('CMS reads reuse one immutable workspace and replace it after source or config edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-read-cache-'));
  const reads = new CmsReadWorkspace(root);
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'src/data.json'), '["before"]');
    const snapshot = await cmsSources(root);
    const first = await reads.read(snapshot, async (stage) => stage);
    const same = await reads.read(await cmsSources(root), async (stage) => stage);
    assert.equal(same, first);
    await writeFile(path.join(root, 'src/data.json'), '["after"]');
    const changed = await reads.read(await cmsSources(root), async (stage) => {
      assert.equal(await readFile(path.join(stage, 'src/data.json'), 'utf8'), '["after"]');
      return stage;
    });
    assert.notEqual(changed, first);
    await assert.rejects(access(first));
    await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{}}');
    const configured = await reads.read(await cmsSources(root), async (stage) => stage);
    assert.notEqual(configured, changed);
    await assert.rejects(access(changed));
    await reads.close();
    await assert.rejects(access(configured));
    await assert.rejects(
      reads.read(snapshot, async () => ''),
      /workspace has closed/,
    );
  } finally {
    await reads.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CMS replacement waits for an in-flight read before removing its snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-read-queue-'));
  const reads = new CmsReadWorkspace(root);
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'src/data.json'), '[1]');
    const snapshot = await cmsSources(root);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = reads.read(snapshot, async (stage) => {
      await gate;
      assert.equal(await readFile(path.join(stage, 'src/data.json'), 'utf8'), '[1]');
      return stage;
    });
    await writeFile(path.join(root, 'src/data.json'), '[2]');
    const next = reads.read(await cmsSources(root), async (stage) => stage);
    release();
    const [before, after] = await Promise.all([pending, next]);
    assert.notEqual(before, after);
    await assert.rejects(access(before));
  } finally {
    await reads.close();
    await rm(root, { recursive: true, force: true });
  }
});
