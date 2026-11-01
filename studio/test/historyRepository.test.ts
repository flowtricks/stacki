// Goal: Studio reads the same commit graph and file diffs as Desktop without touching drafts.
// Method: fetch a real local Git repository through the production bounded runner;
// exercise branch filtering, cached reads, diffs and invalid boundary inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { HistoryRepository, historyHash } from '../src/features/history/historyRepository';
import { parseHistoryInfo } from '../src/features/history/historyContract';
import { publishGit } from '../src/features/publishing/publishGit';

const execute = promisify(execFile);

test('history reads real branches and diffs while preserving the shared draft', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-history-test-'));
  const origin = path.join(root, 'origin');
  const draft = path.join(root, 'draft');
  await mkdir(origin);
  await mkdir(draft);
  const git = async (...args: readonly string[]) => (await execute('git', args, { cwd: origin, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    const head = await prepareHistory(origin, git);
    await writeFile(path.join(draft, 'untouched.txt'), 'Unsaved draft\n');
    const metrics = historyFixture(draft, origin);
    const { history } = metrics;
    const all = await history.read(0, 'all');
    assert.equal(all.commits.length, 3);
    assert.equal(all.info.head, head);
    assert.deepEqual(all.info.branches, ['alternate', 'main']);
    assert.equal(metrics.grants(), 1, 'Local graph commands do not request additional GitHub grants');
    assert.ok(all.commits.every((commit) => commit.files === undefined));
    assert.ok(
      metrics.logCommands.every((args) => !args.includes('--name-status')),
      'Graph reads cannot trigger rename/blob downloads',
    );
    const before = metrics.commands();
    assert.deepEqual(await history.read(0, 'all'), all);
    assert.equal(metrics.commands(), before, 'A cached panel read starts no new Git commands');
    metrics.advance();
    assert.deepEqual(await history.read(0, 'all'), all);
    assert.equal(metrics.commands(), before + 1, 'Unchanged history polls references without fetching again');
    const current = await history.read(0, 'current');
    assert.equal(current.commits.length, 2);
    const detail = await history.commit(head);
    assert.equal(detail.commits.length, 1);
    assert.equal(detail.commits[0]?.files?.[0]?.kind, 'page');
    assert.ok(metrics.logCommands.at(-1)?.includes('--name-status'));
    await verifyHistoryDiff(history, draft, head);
    assert.equal(await readFile(path.join(draft, 'untouched.txt'), 'utf8'), 'Unsaved draft\n');
    await git('checkout', 'main');
    await writeFile(path.join(origin, 'src/pages/index.astro'), '<h1>Outside change</h1>\n');
    await git('commit', '-am', 'Outside change');
    metrics.advance();
    const updated = await history.read(0, 'current');
    assert.equal(updated.info.head, await git('rev-parse', 'HEAD'));
    assert.equal(updated.commits[0]?.subject, 'Outside change');
    await git('mv', 'src/pages/index.astro', 'src/pages/renamed.astro');
    await git('commit', '-m', 'Rename page');
    metrics.advance();
    const renamed = await history.read(0, 'current');
    const rename = await history.commit(renamed.info.head);
    assert.equal(rename.commits[0]?.files?.[0]?.status, 'R');
    assert.equal(rename.commits[0]?.files?.[0]?.from, 'src/pages/index.astro');
    await assert.rejects(history.commit('0'.repeat(40)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('history boundaries reject malformed metadata and commits', () => {
  const valid = {
    repository: 'test/history',
    branch: 'main',
    branches: ['main'],
    head: 'a'.repeat(40),
  };
  assert.deepEqual(parseHistoryInfo(valid), valid);
  for (const bad of [
    null,
    {},
    { ...valid, repository: '../secret' },
    { ...valid, head: 'HEAD' },
    { ...valid, branches: Array(101).fill('main') },
    { ...valid, branches: [17] },
  ]) {
    assert.throws(() => parseHistoryInfo(bad));
  }
  assert.throws(() => historyHash('--all'), /Invalid history commit/);
});

async function initializeRepository(git: (...args: readonly string[]) => Promise<string>) {
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'History Test');
  await git('config', 'user.email', 'history@example.test');
}

test('older history deepens the bounded fetch without losing or repeating commits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-history-pages-'));
  const origin = path.join(root, 'origin');
  const draft = path.join(root, 'draft');
  await mkdir(origin);
  await mkdir(draft);
  const git = async (...args: readonly string[]) => (await execute('git', args, { cwd: origin, timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    await initializeRepository(git);
    const tree = await git('write-tree');
    let parent: string | undefined;
    for (let index = 0; index < 35; index++) {
      parent = await git('commit-tree', tree, '-m', `Commit ${index}`, ...(parent ? ['-p', parent] : []));
    }
    assert.ok(parent);
    await git('update-ref', 'refs/heads/main', parent);
    const history = new HistoryRepository(
      draft,
      async () => ({
        ok: true,
        value: { repository: 'test/history', branch: 'main', token: 'test-only' },
      }),
      (context, args, input, options) =>
        publishGit(
          context,
          args.map((argument) => (argument === 'https://github.com/test/history.git' ? pathToFileURL(origin).href : argument)),
          input,
          options,
        ),
    );
    const first = await history.read(0, 'current');
    const older = await history.read(30, 'current');
    assert.equal(first.commits.length, 30);
    assert.equal(first.atEnd, false);
    assert.equal(older.commits.length, 5);
    assert.equal(older.atEnd, true);
    assert.equal(new Set([...first.commits, ...older.commits].map((commit) => commit.hash)).size, 35);
    assert.throws(() => history.read(-1, 'all'), /pagination is bounded/);
    assert.throws(() => history.read(300, 'all'), /pagination is bounded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareHistory(origin: string, git: (...args: readonly string[]) => Promise<string>) {
  await initializeRepository(git);
  await mkdir(path.join(origin, 'src/pages'), { recursive: true });
  await writeFile(path.join(origin, 'src/pages/index.astro'), '<h1>Before</h1>\n');
  await git('add', '.');
  await git('commit', '-m', 'First page');
  await writeFile(path.join(origin, 'src/pages/index.astro'), '<h1>After</h1>\n');
  await git('commit', '-am', 'Change heading');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', '-b', 'alternate');
  await writeFile(path.join(origin, 'alternate.txt'), 'Other branch\n');
  await git('add', '.');
  await git('commit', '-m', 'Other branch');
  return head;
}

function historyFixture(draft: string, origin: string) {
  let commands = 0;
  let grants = 0;
  const logCommands: (readonly string[])[] = [];
  let now = 0;
  const history = new HistoryRepository(
    draft,
    async () => {
      grants++;
      return {
        ok: true,
        value: { repository: 'test/history', branch: 'main', token: 'test-only' },
      };
    },
    (context, args, input, options) => {
      commands++;
      if (args[0] === 'log') {
        logCommands.push(args);
      }
      return publishGit(
        context,
        args.map((argument) => (argument === 'https://github.com/test/history.git' ? pathToFileURL(origin).href : argument)),
        input,
        options,
      );
    },
    () => now,
  );
  return {
    history,
    logCommands,
    grants: () => grants,
    commands: () => commands,
    advance: () => {
      now += 60_001;
    },
  };
}

async function verifyHistoryDiff(history: HistoryRepository, draft: string, head: string) {
  const diff = await history.diff({
    projectPath: draft,
    commit: head,
    path: 'src/pages/index.astro',
    from: undefined,
  });
  assert.equal(diff.ok, true);
  if (diff.ok) {
    assert.match(diff.value, /-<h1>Before<\/h1>/);
    assert.match(diff.value, /\+<h1>After<\/h1>/);
  }
}
