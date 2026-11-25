// Goal: the folder walk behind every project scan cannot loop, crash or stall on the shapes real
// projects have: symlink cycles, links to nowhere, folders it may not read, a folder deleted
// while it runs, and trees far larger than any fixed cap. What it cannot read comes back as data.
// Method: generated trees in a temporary folder (test/helpers/projectFixtures.ts); each case walks
// the tree and checks the visited files and the reported problems. The termination bound is
// the tree's own size: the walk never visits more entries than the tree holds real files and links.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildProject, removeProject, permissionsEnforced } from '../../helpers/projectFixtures.ts';
import { walkFolder, type WalkEntry } from '#dist/electron/project/projectWalk.js';

function walked(root: string): { readonly files: readonly string[]; readonly problems: ReturnType<typeof walkFolder> } {
  const files: string[] = [];
  const problems = walkFolder(root, (entry: WalkEntry) => {
    if (entry.kind === 'file') {
      files.push(path.relative(root, entry.path).split(path.sep).join('/'));
    }
    return undefined;
  });
  return { files, problems };
}

test('a link back to an ancestor ends the walk and is reported once', (context) => {
  const built = buildProject({ 'a/file.txt': 'x', 'a/b/up': { symlink: '../..' }, 'a/self': { symlink: '.' } });
  context.after(() => removeProject(built.root));
  const { files, problems } = walked(built.root);
  assert.deepEqual(files, ['a/file.txt']);
  assert.deepEqual(problems.map((problem) => problem.kind).sort(), ['link-cycle', 'link-cycle']);
});

test('two links to one folder list its files once', (context) => {
  const built = buildProject({ 'shared/a.txt': 'x', one: { symlink: 'shared' }, two: { symlink: 'shared' } });
  context.after(() => removeProject(built.root));
  const { files } = walked(built.root);
  assert.equal(files.filter((file) => file.endsWith('a.txt')).length, 1);
});

test('a link to a folder elsewhere is followed; a link to nothing is reported', (context) => {
  const outside = buildProject({ 'docs/guide.md': '# g' });
  const built = buildProject({ linked: { symlink: path.join(outside.root, 'docs') }, gone: { symlink: 'nowhere' }, 'real.txt': 'x' });
  context.after(() => {
    removeProject(built.root);
    removeProject(outside.root);
  });
  const { files, problems } = walked(built.root);
  assert.deepEqual([...files].sort(), ['linked/guide.md', 'real.txt']);
  assert.deepEqual(
    problems.map((problem) => [problem.kind, path.basename(problem.path), problem.code]),
    [['unreadable-link', 'gone', 'ENOENT']],
  );
});

test('a folder that cannot be read is reported and the rest is listed', (context) => {
  if (!permissionsEnforced()) {
    context.skip('permission bits are not enforced for this user');
    return;
  }
  const built = buildProject({ 'ok/a.txt': 'x', 'locked/b.txt': 'x', locked: { directory: true, mode: 0o000 } });
  context.after(() => removeProject(built.root));
  const { files, problems } = walked(built.root);
  assert.deepEqual(files, ['ok/a.txt']);
  assert.deepEqual(
    problems.map((problem) => [problem.kind, problem.code]),
    [['unreadable-folder', 'EACCES']],
  );
});

test('a root that does not exist, or is a file, reports instead of throwing', (context) => {
  const built = buildProject({ 'file.txt': 'x' });
  context.after(() => removeProject(built.root));
  assert.deepEqual(
    walkFolder(path.join(built.root, 'missing'), () => undefined).map((problem) => problem.code),
    ['ENOENT'],
  );
  assert.deepEqual(
    walkFolder(path.join(built.root, 'file.txt'), () => undefined).map((problem) => problem.code),
    ['ENOTDIR'],
  );
});

test('a folder deleted while the walk runs is skipped without a crash', (context) => {
  const built = buildProject({ 'a/x.txt': 'x', 'b/y.txt': 'y', 'c/z.txt': 'z' });
  context.after(() => removeProject(built.root));
  const files: string[] = [];
  walkFolder(built.root, (entry) => {
    if (entry.kind === 'directory' && entry.name === 'a') {
      // The next folder vanishes after the walk has listed its parent but before it opens it.
      fs.rmSync(path.join(built.root, 'b'), { recursive: true });
    }
    if (entry.kind === 'file') {
      files.push(entry.name);
    }
    return undefined;
  });
  assert.ok(files.includes('x.txt'));
  assert.ok(files.includes('z.txt'));
  assert.ok(!files.includes('y.txt'));
});

test('a visitor can skip a folder and it is not opened', (context) => {
  const built = buildProject({ 'node_modules/pkg/index.js': 'x', 'src/a.astro': 'x' });
  context.after(() => removeProject(built.root));
  const files: string[] = [];
  walkFolder(built.root, (entry) => {
    if (entry.kind === 'directory' && entry.name === 'node_modules') {
      return 'skip';
    }
    if (entry.kind === 'file') {
      files.push(entry.name);
    }
    return undefined;
  });
  assert.deepEqual(files, ['a.astro']);
});

test('a very deep and a very wide tree are walked in full, with no cap', (context) => {
  const deep = Array.from({ length: 150 }, (_unused, index) => `d${index}`).join('/');
  const files: Record<string, string> = { [`${deep}/leaf.txt`]: 'x' };
  for (let index = 0; index < 1500; index += 1) {
    files[`wide/f${index}.txt`] = 'x';
  }
  const built = buildProject(files);
  context.after(() => removeProject(built.root));
  const listed = walked(built.root);
  assert.equal(listed.files.length, 1501);
  assert.deepEqual(listed.problems, []);
});
