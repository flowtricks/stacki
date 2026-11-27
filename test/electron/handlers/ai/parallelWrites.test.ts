// Goal: replies that run at the same time in one project (a chat's reply and sends of comment pins) never offer to
// undo each other's work. Each reply's ledger snapshots the whole tree, so without this a reply's changes would list
// the others' files, and its "Undo" would put their old text back.
// Method: the real ChangeLedger and ParallelWrites over a fake disk and a fake git tree (a snapshot is a copy of the
// disk), two replies overlapped by hand in each order that matters, then undo asked for and the disk read.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChangeLedger, parseLedgerTurns, serializeLedger } from '#dist/electron/handlers/ai/changeLedger.js';
import { ParallelWrites } from '#dist/electron/handlers/ai/parallelWrites.js';
import { toTurnId } from '#dist/shared/properties/ai/chatModel.js';

const ROOT = path.resolve('/site');
const turn = (digit: string) => toTurnId(`t${digit.repeat(16)}`);

function project(files: Record<string, string>) {
  const disk = new Map(Object.entries(files).map(([name, text]) => [path.join(ROOT, name), text]));
  const trees: Map<string, string>[] = [];
  const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
  const tree = (name: string): Map<string, string> => {
    const found = trees[Number(name)];
    assert.ok(found !== undefined);
    return found;
  };
  const ledger = () =>
    new ChangeLedger(
      ROOT,
      {
        read: (file) => disk.get(file),
        write: (file, text) => void disk.set(file, text),
        create: (file, text) => void disk.set(file, text),
        trash: async (file) => void disk.delete(file),
      },
      {
        snapshot: async () => String(trees.push(new Map(disk)) - 1),
        changes: async (_root, before, after) => {
          const [first, last] = [tree(before), tree(after)];
          return [...new Set([...first.keys(), ...last.keys()])]
            .filter((file) => first.get(file) !== last.get(file))
            .map((file) => ({ path: relative(file), status: first.has(file) ? ('modified' as const) : ('added' as const) }));
        },
        blob: async (_root, name, file) => tree(name).get(path.join(ROOT, file)),
      },
      [],
    );
  return {
    ledger,
    write: (name: string, text: string) => void disk.set(path.join(ROOT, name), text),
    read: (name: string) => disk.get(path.join(ROOT, name)),
  };
}

test('a reply never lists what only another reply wrote, so undoing it leaves that work alone', async () => {
  const site = project({ 'chat.astro': 'old', 'pin.astro': 'old' });
  const parallel = new ParallelWrites();
  const [chat, pins] = [site.ledger(), site.ledger()];
  const chatWrites = parallel.join(ROOT);
  await chat.begin(turn('1'), 'on', chatWrites);
  const pinWrites = parallel.join(ROOT);
  await pins.begin(turn('2'), 'on', pinWrites);
  for (const [writes, ledger, name] of [
    [chatWrites, chat, 'chat.astro'],
    [pinWrites, pins, 'pin.astro'],
  ] as const) {
    parallel.wrote(writes, name);
    ledger.noteTouch(name);
    site.write(name, 'new');
  }
  const chatTurn = await chat.finish(turn('1'));
  parallel.leave(chatWrites);
  const pinTurn = await pins.finish(turn('2'));
  parallel.leave(pinWrites);
  assert.deepEqual(
    chatTurn.entries.map((entry) => [entry.path, entry.shared]),
    [['chat.astro', undefined]],
  );
  assert.deepEqual(
    pinTurn.entries.map((entry) => [entry.path, entry.shared]),
    [['pin.astro', undefined]],
  );
  assert.deepEqual(await chat.review(turn('1'), 'chat.astro', { kind: 'undo' }), { tag: 'done', review: 'undone' });
  assert.equal(site.read('chat.astro'), 'old');
  assert.equal(site.read('pin.astro'), 'new', 'the pins’ work is still there');
});

test('a file two replies wrote, or one no tool call named, is listed but never undone by either reply alone', async () => {
  const site = project({ 'both.astro': 'one two', 'shell.css': 'old' });
  const parallel = new ParallelWrites();
  const [chat, pins] = [site.ledger(), site.ledger()];
  const chatWrites = parallel.join(ROOT);
  await chat.begin(turn('1'), 'on', chatWrites);
  const pinWrites = parallel.join(ROOT);
  await pins.begin(turn('2'), 'on', pinWrites);
  parallel.wrote(chatWrites, 'both.astro');
  site.write('both.astro', '1 two');
  parallel.wrote(pinWrites, 'both.astro');
  site.write('both.astro', '1 2');
  site.write('shell.css', 'new'); // A shell command: no tool call says whose.
  for (const [ledger, writes, digit] of [
    [pins, pinWrites, '2'],
    [chat, chatWrites, '1'],
  ] as const) {
    const finished = await ledger.finish(turn(digit));
    parallel.leave(writes);
    assert.deepEqual(finished.entries.map((entry) => [entry.path, entry.shared]).sort(), [
      ['both.astro', true],
      ['shell.css', true],
    ]);
    const refused = await ledger.review(turn(digit), 'both.astro', { kind: 'undo' });
    assert.ok(refused.tag === 'failed' && refused.messageRef?.key === 'ai.error.sharedChange');
  }
  assert.equal(site.read('both.astro'), '1 2', 'both changes are still there');
  const written: unknown = JSON.parse(serializeLedger(chat.stored()));
  assert.equal(parseLedgerTurns(written)[0]?.entries[0]?.shared, true, 'kept across a restart');
  assert.deepEqual(await chat.review(turn('1'), 'both.astro', { kind: 'keep' }), { tag: 'done', review: 'kept' });
});

test('a reply that runs alone, or after the others ended, tracks everything as before', async () => {
  const site = project({ 'a.astro': 'old' });
  const parallel = new ParallelWrites();
  const earlier = parallel.join(ROOT);
  parallel.wrote(earlier, 'a.astro');
  parallel.leave(earlier);
  const elsewhere = parallel.join(path.resolve('/other'));
  const ledger = site.ledger();
  const writes = parallel.join(ROOT);
  await ledger.begin(turn('3'), 'on', writes);
  site.write('a.astro', 'new');
  const finished = await ledger.finish(turn('3'));
  parallel.leave(writes);
  parallel.leave(elsewhere);
  assert.deepEqual(
    finished.entries.map((entry) => [entry.path, entry.shared]),
    [['a.astro', undefined]],
    'another project’s reply is no overlap',
  );
});
