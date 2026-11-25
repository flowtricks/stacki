// Goal: "Snapshot before & after each AI change" holds its promises. Off, a turn takes no git snapshot at either end,
// keeps nothing and still starts and ends at once; on, both snapshots happen as they always did.
// The decision is made when a turn begins and kept on that turn, so a toggle mid-turn changes the next
// turn and never half of this one. A snapshot that fails, throws or never answers costs the turn only
// the wait: the model call goes ahead and the turn finishes as "unavailable".
// Methodology: fake snapshots that count every call (no git is spawned), a stand-in adapter that asks
// permission before its edit (the pause where the test flips the setting), temporary project folders,
// and the ledger driven directly for the failure and timeout cases.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { ChangeLedger } from '#dist/electron/handlers/ai/changeLedger.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { toTurnId, type ChatEvent } from '#dist/shared/properties/ai/chatModel.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');
const FIRST_TREE = 'a'.repeat(40);
const SECOND_TREE = 'b'.repeat(40);

const plainFiles = {
  read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  write: (file: string, text: string, expected: string) => {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, 'a witnessed write');
    fs.writeFileSync(file, text);
  },
  create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
  trash: async (file: string) => fs.rmSync(file),
};

function temporary(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stacki-track-${name}-`));
}

/** Snapshots that count every call, so "no git" is an assertion on a number. */
function countingSnapshots() {
  const calls = { snapshot: 0, changes: 0, blob: 0 };
  const trees = [FIRST_TREE, SECOND_TREE];
  return {
    calls,
    snapshots: {
      snapshot: async () => {
        calls.snapshot += 1;
        return trees[(calls.snapshot - 1) % 2];
      },
      changes: async () => {
        calls.changes += 1;
        return [];
      },
      blob: async () => {
        calls.blob += 1;
        return undefined;
      },
    },
  };
}

function totalCalls(calls: { readonly snapshot: number; readonly changes: number; readonly blob: number }): number {
  return calls.snapshot + calls.changes + calls.blob;
}

function hostWith(snapshots: ReturnType<typeof countingSnapshots>['snapshots'], setting: { track: boolean }) {
  const root = fs.realpathSync(temporary('project'));
  const userData = temporary('user');
  const bin = temporary('bin');
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'line one\nline two\n');
  const store = new ChatStore(path.join(userData, 'ai'));
  store.trust(root);
  const pushes: ChatEvent[] = [];
  const host = new AgentHost({
    userData,
    store,
    send: (channel: string, payload: unknown) => {
      if (channel === 'ai:events') {
        const push = parseAiEventsPush(payload);
        pushes.push(...push.events);
        host.acknowledge(push.chars);
      }
    },
    files: plainFiles,
    snapshots,
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir() }),
    now: () => 1_000,
    version: 'test',
    askBeforeTrust: () => false,
    trackChanges: () => setting.track,
    entryOf: () => FAKE_ADAPTER,
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) =>
      spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  return { root, store, host, pushes };
}

function ofKind<K extends ChatEvent['kind']>(events: readonly ChatEvent[], kind: K): Extract<ChatEvent, { readonly kind: K }>[] {
  return events.filter((event): event is Extract<ChatEvent, { readonly kind: K }> => event.kind === kind);
}

async function until(label: string, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Runs one editing turn, calling `atPermission` while the adapter waits to be allowed its edit. */
async function editingTurn(
  fixture: ReturnType<typeof hostWith>,
  chat: ReturnType<ChatStore['create']>,
  atPermission: () => void,
): Promise<{ readonly turn: string; readonly events: readonly ChatEvent[] }> {
  assert.ok(chat !== undefined);
  const before = fixture.pushes.length;
  const started = await fixture.host.prompt(fixture.root, chat.id, `please edit ${path.join(fixture.root, 'notes.txt')}`, []);
  assert.ok(started.ok);
  await until('the permission request', () => ofKind(fixture.pushes.slice(before), 'permission').length > 0);
  atPermission();
  const permission = ofKind(fixture.pushes.slice(before), 'permission')[0];
  assert.ok(permission !== undefined);
  assert.ok(fixture.host.answerPermission(fixture.root, chat.id, permission.request, { kind: 'option', optionId: 'yes' }).ok);
  await until('the end of the turn', () => ofKind(fixture.pushes.slice(before), 'turn-end').length > 0);
  return { turn: started.value.turn, events: fixture.pushes.slice(before) };
}

test('off: no snapshot at either end, the turn still ends, and the edit is reported as untracked', async (context) => {
  const { calls, snapshots } = countingSnapshots();
  const fixture = hostWith(snapshots, { track: false });
  context.after(() => fixture.host.stopAll());
  const chat = fixture.store.create(fixture.root, 'codex', 'New chat', 1);
  const turn = await editingTurn(fixture, chat, () => {
    assert.equal(totalCalls(calls), 0, 'the model call was not held up by a snapshot');
  });
  assert.equal(totalCalls(calls), 0, 'no git command ran for the whole turn');
  assert.equal(ofKind(turn.events, 'changes').length, 0, 'no ledger entries');
  assert.deepEqual(
    ofKind(turn.events, 'changes-untracked').map((event) => event.reason),
    ['off'],
  );
  assert.equal(ofKind(turn.events, 'turn-end').length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'notes.txt'), 'utf8'), 'line one\nline 2\n', 'the agent still edited the file');
});

test('on: both snapshots are taken and the change is kept for review, as before', async (context) => {
  const { calls, snapshots } = countingSnapshots();
  const fixture = hostWith(snapshots, { track: true });
  context.after(() => fixture.host.stopAll());
  const chat = fixture.store.create(fixture.root, 'codex', 'New chat', 1);
  const turn = await editingTurn(fixture, chat, () => {
    assert.equal(calls.snapshot, 1, 'the first snapshot is taken before the agent can edit');
  });
  assert.equal(calls.snapshot, 2, 'one snapshot at each end');
  assert.deepEqual(ofKind(turn.events, 'changes')[0]?.files, [{ path: 'notes.txt', change: 'modified', review: 'pending' }]);
  assert.equal(ofKind(turn.events, 'changes-untracked').length, 0);
});

test('a toggle takes effect on the next turn, and a turn keeps the decision it began with', async (context) => {
  const { calls, snapshots } = countingSnapshots();
  const setting = { track: true };
  const fixture = hostWith(snapshots, setting);
  context.after(() => fixture.host.stopAll());
  const chat = fixture.store.create(fixture.root, 'codex', 'New chat', 1);
  // Began on, switched off mid-turn: still finishes tracked, with its after-snapshot.
  const first = await editingTurn(fixture, chat, () => {
    setting.track = false;
  });
  assert.equal(calls.snapshot, 2, 'the turn that began tracked takes its second snapshot');
  assert.equal(ofKind(first.events, 'changes').length, 1);
  assert.equal(ofKind(first.events, 'changes-untracked').length, 0);
  // The next turn begins off: nothing more is spawned.
  fs.writeFileSync(path.join(fixture.root, 'notes.txt'), 'line one\nline two\n');
  const second = await editingTurn(fixture, chat, () => undefined);
  assert.equal(calls.snapshot, 2, 'the next turn took no snapshot');
  assert.equal(ofKind(second.events, 'changes-untracked').length, 1);
  // Began off, switched on mid-turn: stays untracked; the turn after is tracked again.
  fs.writeFileSync(path.join(fixture.root, 'notes.txt'), 'line one\nline two\n');
  const third = await editingTurn(fixture, chat, () => {
    setting.track = true;
  });
  assert.equal(calls.snapshot, 2, 'a turn that began untracked takes no snapshot after the toggle either');
  assert.equal(ofKind(third.events, 'changes-untracked').length, 1);
  fs.writeFileSync(path.join(fixture.root, 'notes.txt'), 'line one\nline two\n');
  const fourth = await editingTurn(fixture, chat, () => undefined);
  assert.equal(calls.snapshot, 4, 'the turn after the toggle is tracked');
  assert.equal(ofKind(fourth.events, 'changes').length, 1);
});

test('a snapshot that throws never blocks the turn: it ends as unavailable', async () => {
  const root = fs.realpathSync(temporary('throw'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  const broken = {
    snapshot: async (): Promise<string | undefined> => {
      throw new Error('index.lock exists');
    },
    changes: async () => [],
    blob: async () => undefined,
  };
  const ledger = new ChangeLedger(root, plainFiles, broken, []);
  const turn = toTurnId(`t${'6'.repeat(16)}`);
  await ledger.begin(turn, 'on');
  ledger.noteTouch(path.join(root, 'a.txt'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const finished = await ledger.finish(turn);
  assert.equal(finished.tracking, 'unavailable');
  assert.equal(finished.snapshotAfterMs, undefined, 'no tree at the start, so no second snapshot was tried');
  assert.deepEqual(
    finished.entries.map((entry) => entry.path),
    ['a.txt'],
    'the files tool calls named are still kept',
  );
});

test('an after-snapshot that throws or never answers ends the turn as unavailable', async () => {
  for (const failure of ['throws', 'hangs'] as const) {
    const root = fs.realpathSync(temporary(failure));
    let taken = 0;
    const snapshots = {
      snapshot: async (): Promise<string | undefined> => {
        taken += 1;
        if (taken === 1) {
          return FIRST_TREE;
        }
        if (failure === 'throws') {
          throw new Error('timed out');
        }
        return new Promise(() => undefined);
      },
      changes: async () => [],
      blob: async () => undefined,
    };
    const ledger = new ChangeLedger(root, plainFiles, snapshots, [], 50);
    const turn = toTurnId(`t${'7'.repeat(16)}`);
    await ledger.begin(turn, 'on');
    const finished = await ledger.finish(turn);
    assert.equal(finished.tracking, 'unavailable', failure);
    assert.deepEqual(finished.entries, []);
    assert.ok(finished.snapshotAfterMs !== undefined, 'the wait is measured');
  }
});

test('a start-of-turn snapshot that never answers is given up on at the deadline', async () => {
  const root = fs.realpathSync(temporary('hang'));
  const hung = { snapshot: () => new Promise<string | undefined>(() => undefined), changes: async () => [], blob: async () => undefined };
  const ledger = new ChangeLedger(root, plainFiles, hung, [], 50);
  const turn = toTurnId(`t${'8'.repeat(16)}`);
  await ledger.begin(turn, 'on');
  const finished = await ledger.finish(turn);
  assert.equal(finished.tracking, 'unavailable');
  assert.ok((finished.snapshotBeforeMs ?? 0) >= 40, 'it waited for the deadline, no longer');
  assert.ok((finished.snapshotBeforeMs ?? Number.POSITIVE_INFINITY) < 2_000);
});

test('timings are durations and a mode, never paths', async () => {
  const root = fs.realpathSync(temporary('timing'));
  const { snapshots } = countingSnapshots();
  const ledger = new ChangeLedger(root, plainFiles, snapshots, []);
  const turn = toTurnId(`t${'9'.repeat(16)}`);
  await ledger.begin(turn, 'on');
  const finished = await ledger.finish(turn);
  assert.equal(finished.tracking, 'tracked');
  assert.ok(Number.isInteger(finished.snapshotBeforeMs));
  assert.ok(Number.isInteger(finished.snapshotAfterMs));
  const off = new ChangeLedger(root, plainFiles, snapshots, []);
  await off.begin(turn, 'off');
  const untracked = await off.finish(turn);
  assert.equal(untracked.snapshotBeforeMs, undefined);
  assert.equal(untracked.snapshotAfterMs, undefined);
});

test('off: touches and edits are not read from disk, and finishing keeps nothing', async () => {
  const root = fs.realpathSync(temporary('off'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  let reads = 0;
  const files = { ...plainFiles, read: (file: string) => (reads++, plainFiles.read(file)) };
  const { calls, snapshots } = countingSnapshots();
  const ledger = new ChangeLedger(root, files, snapshots, []);
  const turn = toTurnId(`t${'a'.repeat(16)}`);
  await ledger.begin(turn, 'off');
  ledger.noteTouch(path.join(root, 'a.txt'));
  ledger.noteEdit();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const finished = await ledger.finish(turn);
  assert.equal(reads, 0, 'no file was read');
  assert.equal(totalCalls(calls), 0);
  assert.equal(finished.tracking, 'off');
  assert.equal(finished.edited, true);
  assert.deepEqual(finished.entries, []);
  assert.deepEqual(ledger.stored(), []);
  await assert.rejects(() => ledger.finish(turn), /a turn is open/);
});
