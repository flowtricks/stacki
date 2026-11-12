// Goal: a pending change's two sides can be read back for the diff view, and
// only while it is pending: a settled change keeps no content, so asking for it
// answers "not available" rather than an empty text that would read as a deletion.
// Methodology: a real ledger over a temporary project finishes a turn with a
// modified, a created and a deleted file; `diffOf` and `diffOfTurns` (the reviews
// file path the IPC handler uses) are checked before and after Keep and Undo,
// through the serialized and re-parsed ledger, with unknown turns and paths.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChangeLedger, diffOfTurns, parseLedgerTurns, serializeLedger } from '#dist/electron/handlers/ai/changeLedger.js';
import { toTurnId } from '#dist/shared/properties/ai/chatModel.js';

const files = {
  read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  write: (file: string, text: string, expected: string) => {
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
    fs.writeFileSync(file, text);
  },
  create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
  trash: async (file: string) => fs.rmSync(file),
};
const noSnapshots = { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined };

test('a pending file’s before and after are readable until it is settled', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ledger-diff-')));
  fs.writeFileSync(path.join(root, 'edit.md'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'gone.md'), 'bye\n');
  const ledger = new ChangeLedger(root, files, noSnapshots, []);
  const turn = toTurnId(`t${'8'.repeat(16)}`);
  await ledger.begin(turn);
  for (const name of ['edit.md', 'new.md', 'gone.md']) {
    ledger.noteTouch(path.join(root, name));
  }
  fs.writeFileSync(path.join(root, 'edit.md'), 'one\n2\n');
  fs.writeFileSync(path.join(root, 'new.md'), 'fresh\n');
  fs.rmSync(path.join(root, 'gone.md'));
  await ledger.finish(turn);

  assert.deepEqual(ledger.diffOf(turn, 'edit.md'), { oldText: 'one\ntwo\n', newText: 'one\n2\n' });
  assert.deepEqual(ledger.diffOf(turn, path.join(root, 'edit.md')), { oldText: 'one\ntwo\n', newText: 'one\n2\n' }, 'an absolute path names the same file');
  assert.deepEqual(ledger.diffOf(turn, 'new.md'), { oldText: undefined, newText: 'fresh\n' }, 'a created file has no old side');
  assert.deepEqual(ledger.diffOf(turn, 'gone.md'), { oldText: 'bye\n', newText: undefined }, 'a deleted file has no new side');

  // The IPC handler reads the reviews file, not the live ledger: the same answers through it.
  const stored = parseLedgerTurns(JSON.parse(serializeLedger(ledger.stored())));
  assert.deepEqual(diffOfTurns(stored, turn, 'edit.md'), ledger.diffOf(turn, 'edit.md'));

  await ledger.review(turn, 'edit.md', { kind: 'keep' });
  assert.equal(ledger.diffOf(turn, 'edit.md'), undefined, 'a kept change keeps no content');
  await ledger.review(turn, 'new.md', { kind: 'undo' });
  assert.equal(ledger.diffOf(turn, 'new.md'), undefined, 'neither does an undone one');
  assert.notEqual(ledger.diffOf(turn, 'gone.md'), undefined, 'the file still pending is unaffected');
  const settled = parseLedgerTurns(JSON.parse(serializeLedger(ledger.stored())));
  assert.equal(diffOfTurns(settled, turn, 'edit.md'), undefined, 'after the round trip too');
  assert.notEqual(diffOfTurns(settled, turn, 'gone.md'), undefined);
});

test('an unknown turn or path has no diff', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ledger-none-')));
  const ledger = new ChangeLedger(root, files, noSnapshots, []);
  assert.equal(ledger.diffOf(toTurnId(`t${'9'.repeat(16)}`), 'a.md'), undefined);
  assert.equal(diffOfTurns([], toTurnId(`t${'9'.repeat(16)}`), 'a.md'), undefined);
  assert.equal(ledger.diffOf(toTurnId(`t${'9'.repeat(16)}`), '/etc/hosts'), undefined, 'outside the project');
});
