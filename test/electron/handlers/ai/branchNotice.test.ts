// Goal: when an AI turn leaves the project on a different git branch than it began on, the transcript says so, because Publish
// sends the current branch and a branch nobody chose is easy to publish from. The notice is independent of the snapshot setting,
// names the branch as data (never interpolated into a command), and a slow, failing or missing git can never hold up or
// break the turn's end.
// Methodology: the real AgentHost against the stand-in adapter (test/fixtures/ai/fakeAdapter.mjs), with `currentBranch`
// replaced by a scripted reader whose answers are the turn's start and end. Negative space: same branch, unknown start,
// unknown end, a throwing reader, a reader that never answers, no reader at all, and a name that looks like shell syntax.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';
import type { ChatEvent } from '#dist/shared/properties/ai/chatModel.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');
const noSnapshots = { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined };
const plainFiles = {
  read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  write: (file: string, text: string) => fs.writeFileSync(file, text),
  create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
  trash: async (file: string) => fs.rmSync(file),
};

type Reader = ((root: string) => Promise<string | undefined>) | undefined;

function hostWith(currentBranch: Reader) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-branch-project-')));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-branch-user-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-branch-bin-'));
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const store = new ChatStore(path.join(userData, 'ai'));
  const pushes: ChatEvent[] = [];
  const host: AgentHost = new AgentHost({
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
    snapshots: noSnapshots,
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir() }),
    now: () => 1_000,
    version: 'test',
    askBeforeTrust: () => true,
    // Snapshots off: the branch check must not depend on the change ledger.
    trackChanges: () => false,
    entryOf: () => FAKE_ADAPTER,
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) =>
      spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] }),
    ...(currentBranch === undefined ? {} : { currentBranch }),
  });
  return { root, store, host, events: (): readonly ChatEvent[] => pushes };
}

/** A reader that answers the start and then the end of one turn, in order, recording what it was asked about. */
function scripted(answers: readonly (string | undefined | 'throw' | 'hang')[]): { readonly read: Reader; readonly asked: string[] } {
  const asked: string[] = [];
  let call = 0;
  const read = async (root: string): Promise<string | undefined> => {
    asked.push(root);
    const answer = answers[call++];
    if (answer === 'throw') {
      throw new Error('git is broken');
    }
    if (answer === 'hang') {
      return new Promise<string | undefined>(() => undefined);
    }
    return answer;
  };
  return { read, asked };
}

async function until(label: string, attemptsMax: number, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < attemptsMax; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function runTurn(reader: Reader, attemptsMax = 200): Promise<readonly ChatEvent[]> {
  const { root, store, host, events } = hostWith(reader);
  try {
    store.trust(root);
    const chat = store.create(root, 'codex', 'New chat', 1);
    assert.ok(chat !== undefined);
    assert.ok((await host.prompt(root, chat.id, 'hello', [])).ok);
    await until('the end of the turn', attemptsMax, () => events().some((event) => event.kind === 'turn-end'));
    return events();
  } finally {
    host.stopAll();
  }
}

function notices(events: readonly ChatEvent[]) {
  return events.flatMap((event) => (event.kind === 'notice' ? [event] : []));
}

test('a turn that ends on another branch says which, as a warning before the turn ends', async () => {
  const script = scripted(['main', 'feature/header']);
  const events = await runTurn(script.read);
  const found = notices(events).filter((notice) => notice.textRef?.key === 'git.branch.aiChanged');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'warning');
  assert.deepEqual(found[0]?.textRef?.params, { name: 'feature/header' });
  assert.equal(found[0]?.text, 'The AI created or switched to branch feature/header.');
  assert.ok(events.findIndex((event) => event.kind === 'notice') < events.findIndex((event) => event.kind === 'turn-end'), 'the notice precedes the end');
  assert.equal(script.asked.length, 2, 'one read at the start, one at the end');
});

test('the same branch, an unknown start or an unknown end make no notice', async () => {
  for (const answers of [
    ['main', 'main'],
    [undefined, 'feature/x'],
    ['main', undefined],
    ['main', 'throw'],
    ['throw', 'feature/x'],
  ] as const) {
    const events = await runTurn(scripted(answers).read);
    assert.equal(notices(events).length, 0, JSON.stringify(answers));
  }
});

test('no reader at all means no notice and the turn still ends', async () => {
  assert.equal(notices(await runTurn(undefined)).length, 0);
});

test('moving off every branch is worded as a detached HEAD, not as a branch called HEAD', async () => {
  const events = await runTurn(scripted(['main', 'HEAD']).read);
  const found = notices(events);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.textRef?.key, 'git.branch.aiDetached');
  assert.equal(found[0]?.textRef?.params, undefined);
});

test('a branch name that looks like shell syntax is only data in the notice', async () => {
  const hostile = 'feat$(touch pwned);`x`';
  const events = await runTurn(scripted(['main', hostile]).read);
  assert.deepEqual(notices(events)[0]?.textRef?.params, { name: hostile });
});

test('a git that never answers cannot hold the end of the turn', async () => {
  const started = Date.now();
  const events = await runTurn(scripted(['main', 'hang']).read, 400);
  assert.equal(notices(events).length, 0);
  assert.ok(Date.now() - started < 8_000, 'bounded by the read limit');
});
