// Goal: watching a project can never take the app down or stop it opening. A folder the system
// cannot watch (missing, unreadable, over the watcher limit) is reported on the handle and the
// rest is still watched; a watcher that fails while running (its folder removed, handles run
// out) is closed, not thrown as an uncaught `error` event; a project whose astro.config moves
// `srcDir` is watched where its pages really are.
// Method: `watchProject` runs with an injected `watch` that records what it was asked to watch
// and can throw on creation or emit `error` afterwards, over generated projects in a temporary folder.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type * as fs from 'node:fs';
import { buildProject, removeProject } from '../../helpers/projectFixtures.ts';
import { watchProject } from '#dist/electron/project/projectWatcher.js';

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

function watching(root: string, failures: Readonly<Record<string, string>> = {}) {
  const asked: string[] = [];
  const watchers: FakeWatcher[] = [];
  // eslint-disable-next-line no-restricted-syntax -- the fake watcher stands in for fs.watch's overloaded signature.
  const watch = ((directory: string) => {
    asked.push(path.relative(root, directory).split(path.sep).join('/'));
    const code = failures[path.relative(root, directory)];
    if (code !== undefined) {
      throw Object.assign(new Error(code), { code });
    }
    const watcher = new FakeWatcher();
    watchers.push(watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
  const handle = watchProject({
    projectPath: root,
    send: () => undefined,
    isSelfWrite: () => false,
    noteExternalChange: () => undefined,
    notePageMayHaveChanged: () => undefined,
    scheduleThumb: () => undefined,
    mediaPattern: /\.png$/,
    watch,
  });
  return { handle, asked, watchers };
}

test('src, public and the folder settings are watched', (context) => {
  const built = buildProject({ 'package.json': '{}', 'src/pages/index.astro': '', 'public/a.png': '', '.stacki/folders.json': '{}' });
  context.after(() => removeProject(built.root));
  const { handle, asked } = watching(built.root);
  context.after(() => handle.close());
  assert.deepEqual(asked.filter((entry) => !entry.startsWith('.stacki/apps')).slice(0, 3), ['src', 'public', '.stacki']);
  assert.deepEqual(handle.degraded, []);
});

test('a folder that cannot be watched is reported and the others are still watched', (context) => {
  const built = buildProject({ 'package.json': '{}', 'src/pages/index.astro': '', 'public/a.png': '' });
  context.after(() => removeProject(built.root));
  const { handle, asked } = watching(built.root, { src: 'ENOSPC' });
  context.after(() => handle.close());
  assert.ok(asked.includes('public'), 'public is still watched');
  assert.deepEqual(
    handle.degraded.map((entry) => [path.relative(built.root, entry.directory), entry.code]),
    [['src', 'ENOSPC']],
  );
});

test('a watcher that errors while running is closed and the error is absorbed', (context) => {
  const built = buildProject({ 'package.json': '{}', 'src/pages/index.astro': '' });
  context.after(() => removeProject(built.root));
  const { handle, watchers } = watching(built.root);
  context.after(() => handle.close());
  const first = watchers[0];
  assert.ok(first !== undefined);
  assert.doesNotThrow(() => first.emit('error', Object.assign(new Error('gone'), { code: 'EPERM' })));
  assert.equal(first.closed, true);
  assert.deepEqual(
    handle.degraded.map((entry) => entry.code),
    ['EPERM'],
  );
});

test('a project with no src folder opens with nothing to watch there', (context) => {
  const built = buildProject({ 'package.json': '{}' });
  context.after(() => removeProject(built.root));
  const { handle } = watching(built.root, { src: 'ENOENT' });
  context.after(() => handle.close());
  assert.deepEqual(
    handle.degraded.map((entry) => entry.code),
    ['ENOENT'],
  );
});

test('a literal srcDir in astro.config is the folder that is watched', (context) => {
  const built = buildProject({ 'package.json': '{}', 'astro.config.mjs': "export default { srcDir: './website' };", 'website/pages/index.astro': '' });
  context.after(() => removeProject(built.root));
  const { handle, asked } = watching(built.root);
  context.after(() => handle.close());
  assert.equal(asked[0], 'website');
});
