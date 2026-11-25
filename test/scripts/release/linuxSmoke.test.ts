// Goal: the packaged-app probe must obey the same IPC contract as the renderer.
// Method: execute its actual generated expression with the real startup parser;
// simulate terminal output only after startup is accepted, and check cleanup.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import {
  linuxSmokeRendererProbe,
  linuxSmokeTerminalStart,
} from '#dist/scripts/release/linuxSmoke.js';
import { parseIpcPayload, type IpcPayloads } from '#dist/shared/ipc/ipcPayloads.js';

type TerminalListener = (event: { readonly id: string; readonly data: string }) => void;

test('the smoke startup builder stays compatible with required IPC fields', () => {
  const payload: IpcPayloads['terminal:start'] = linuxSmokeTerminalStart('/site');
  assert.deepEqual(parseIpcPayload('terminal:start', payload), payload);
  assert.throws(() => linuxSmokeTerminalStart(''), /Smoke project path is required/);
  assert.throws(() => linuxSmokeTerminalStart('x'.repeat(4097)), /path exceeds limit/);
});

test('the Linux package probe sends a valid measured terminal startup', async () => {
  let started = false;
  let closed = false;
  let unsubscribed = false;
  let receive: TerminalListener | undefined;
  const bridge = {
    platform: 'linux',
    watchProject: (project: unknown) => {
      assert.equal(parseIpcPayload('watch:start', project), '/site');
      return { ok: true };
    },
    onTerminalData: (listener: TerminalListener) => {
      receive = listener;
      return () => {
        unsubscribed = true;
      };
    },
    startTerminal: (input: unknown) => {
      const payload = parseIpcPayload('terminal:start', input);
      assert.equal(payload.id, 'linux-smoke');
      assert.equal(payload.cwd, '/site');
      assert.ok(payload.cols > 0);
      assert.ok(payload.rows > 0);
      started = true;
      return { ok: true };
    },
    terminalInput: (id: string, command: string) => {
      assert.ok(started, 'Native input must follow accepted startup');
      assert.equal(command, "printf 'stacki-%s' 'linux-pty-ok'\n");
      assert.ok(receive, 'The probe must subscribe before writing input');
      receive({ id, data: 'stacki-linux-pty-ok' });
    },
    closeTerminal: (input: unknown) => {
      assert.equal(parseIpcPayload('terminal:close', input).id, 'linux-smoke');
      closed = true;
    },
  };
  const probe = new Script(linuxSmokeRendererProbe('/site'));
  const result: unknown = await probe.runInNewContext(
    { window: { avb: bridge }, document: { querySelector: () => ({ children: ['ready'] }) } },
    { timeout: 1000 },
  );
  assert.equal(result, 'linux-package-ok');
  assert.ok(closed, 'The probe must close its terminal');
  assert.ok(unsubscribed, 'The probe must remove its listener');
});
