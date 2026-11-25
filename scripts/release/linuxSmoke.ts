// Launch the shipped executable, not the development Electron. CDP exercises
// its real renderer, preload, IPC, and native terminal under a virtual display.
import assert = require('node:assert/strict');
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function parseRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object', 'Expected a protocol object');
  assert.ok(value, 'Expected a nonempty protocol object');
  return Object.fromEntries(Object.entries(value));
}

async function rendererSocket(): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch('http://127.0.0.1:9222/json/list', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => undefined);
    if (response?.ok) {
      const input: unknown = await response.json();
      assert.ok(Array.isArray(input));
      assert.ok(input.length <= 20, 'Unexpected number of debug targets');
      for (const target of input) {
        const page = parseRecord(target);
        if (page['type'] === 'page') {
          const url = page['webSocketDebuggerUrl'];
          assert.ok(typeof url === 'string');
          assert.ok(url.startsWith('ws://127.0.0.1:9222/'));
          return url;
        }
      }
    }
    await delay(250);
  }
  throw new Error('Packaged Stacki never opened its renderer');
}

async function evaluate(url: string, expression: string): Promise<void> {
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged renderer timed out')), 30000);
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Cannot connect to packaged renderer'));
      });
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        try {
          const data: unknown = event.data;
          assert.ok(typeof data === 'string');
          assert.ok(data.length < 100000, 'Protocol response exceeds limit');
          const input: unknown = JSON.parse(data);
          const message = parseRecord(input);
          if (message['id'] !== 1) {
            return;
          }
          clearTimeout(timer);
          assert.equal(message['error'], undefined, JSON.stringify(message));
          const result = parseRecord(message['result']);
          assert.equal(result['exceptionDetails'], undefined, JSON.stringify(result));
          assert.equal(parseRecord(result['result'])['value'], 'linux-package-ok');
          resolveResult();
        } catch (error: unknown) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  } finally {
    socket.close();
  }
}

export function linuxSmokeRendererProbe(project: string): string {
  const terminal = linuxSmokeTerminalStart(project);
  // The split printf argument prevents the terminal's command echo from being
  // mistaken for output: only a functioning native PTY can produce the marker.
  return `(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (window.avb && document.querySelector('#root')?.children.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (window.avb?.platform !== 'linux') throw new Error('Linux preload missing');
    if (!document.querySelector('#root')?.children.length) throw new Error('UI missing');
    if (typeof window.require !== 'undefined') throw new Error('Node exposed to renderer');
    const watched = await window.avb.watchProject(${JSON.stringify(project)});
    if (!watched.ok) throw new Error('Project IPC failed');
    let output = '';
    const unsubscribe = window.avb.onTerminalData(event => {
      if (event.id === 'linux-smoke') output = (output + event.data).slice(-65536);
    });
    try {
      const started = await window.avb.startTerminal(${JSON.stringify(terminal)});
      if (!started.ok) throw new Error(JSON.stringify(started));
      window.avb.terminalInput('linux-smoke', "printf 'stacki-%s' 'linux-pty-ok'\\n");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (output.includes('stacki-linux-pty-ok')) return 'linux-package-ok';
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Native terminal produced no output: ' + output);
    } finally {
      unsubscribe();
      await window.avb.closeTerminal({ id: 'linux-smoke' });
    }
  })()`;
}

export function linuxSmokeTerminalStart(project: string) {
  assert.ok(project.length > 0, 'Smoke project path is required');
  assert.ok(project.length <= 4096, 'Smoke project path exceeds limit');
  // The probe has no xterm layout. Supply a fixed, valid grid so the native
  // shell starts through the same measured-dimensions contract as the app.
  return { id: 'linux-smoke', cwd: project, cols: 80, rows: 24 } as const;
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'linux', 'Run the package smoke test on Linux');
  const executable = process.argv[2];
  assert.ok(executable, 'Pass the installed Stacki executable or extracted AppRun');
  const directory = mkdtempSync(join(tmpdir(), 'stacki-linux-smoke-'));
  const project = join(directory, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  const environment: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/bash' };
  delete environment['ELECTRON_RUN_AS_NODE'];
  delete environment['VITE_DEV_SERVER_URL'];
  const child = spawn(
    resolve(executable),
    [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
      `--user-data-dir=${join(directory, 'profile')}`,
      '--enable-sandbox',
    ],
    { env: environment, stdio: 'inherit' },
  );
  // Observe exit before probing so an early crash cannot leave a dangling wait.
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolveExit());
  });
  try {
    await Promise.race([
      rendererSocket().then((url) => evaluate(url, linuxSmokeRendererProbe(project))),
      exited.then(() => {
        throw new Error('Packaged Stacki exited before the smoke test');
      }),
    ]);
    console.log('Linux package: renderer, isolated preload, project IPC, and native PTY passed.');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      exited,
      delay(5000).then(() => {
        child.kill('SIGKILL');
      }),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
