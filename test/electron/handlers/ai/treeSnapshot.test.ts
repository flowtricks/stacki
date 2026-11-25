// Goal: a turn's tree snapshots name files as the change ledger does, relative to the project. A project is often a
// folder inside a larger repository (a monorepo), where git's tree paths start at the repository root: taken as they
// come, every change reads as a file the agent deleted, at a path that does not exist, and Undo would create it there.
// Methodology: a real repository in a temporary folder with the project one level down, the real snapshots and ledger,
// edits made on disk as a shell command would make them (no tool call names them), and a sibling edit that must stay out.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChangeLedger } from '#dist/electron/handlers/ai/changeLedger.js';
import { GIT_SNAPSHOTS } from '#dist/electron/handlers/ai/treeSnapshot.js';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { toTurnId } from '#dist/shared/properties/ai/chatModel.js';

setToolPathHome(os.homedir());

const files = {
  read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  write: (file: string, text: string) => fs.writeFileSync(file, text),
  create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
  trash: async (file: string) => fs.rmSync(file),
};

test('a project inside a larger repository sees its own changes, with their text', async (context) => {
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-tree-')));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const project = path.join(repository, 'site');
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  const save = (file: string, text: string) => fs.writeFileSync(path.join(repository, file), text);
  fs.mkdirSync(project);
  run('init', '-q', '-b', 'main');
  run('config', 'core.autocrlf', 'false');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  save('site/page.txt', 'before\n');
  save('site/gone.txt', 'was here\n');
  save('outside.txt', 'sibling\n');
  run('add', '-A');
  run('commit', '-qm', 'first');

  const ledger = new ChangeLedger(project, files, GIT_SNAPSHOTS, []);
  const turn = toTurnId('t0123456789abcdef');
  await ledger.begin(turn, 'on');
  save('site/page.txt', 'after\n');
  save('site/new.txt', 'made\n');
  fs.rmSync(path.join(project, 'gone.txt'));
  save('outside.txt', 'sibling changed\n');
  const finished = await ledger.finish(turn);

  const entries = [...finished.entries].sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(entries, [
    { path: 'gone.txt', before: 'was here\n', after: undefined, review: 'pending' },
    { path: 'new.txt', before: undefined, after: 'made\n', review: 'pending' },
    { path: 'page.txt', before: 'before\n', after: 'after\n', review: 'pending' },
  ]);
  assert.deepEqual(await ledger.review(turn, 'page.txt', { kind: 'undo' }), { tag: 'done', review: 'undone' });
  assert.equal(fs.readFileSync(path.join(project, 'page.txt'), 'utf8'), 'before\n');
  assert.ok(!fs.existsSync(path.join(project, 'site')), 'nothing is made under a doubled folder');
});
