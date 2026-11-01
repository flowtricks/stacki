// Goal: terminal data reaches renderer state only after bounded parsing.
// Methodology: exercise each pushed event and request result, reject malformed
// values, and verify transport failures remain explicit Result values.
const test = require('node:test');
const assert = require('node:assert/strict');
const terminal = require('../../helpers/rendererModule')('src/features/terminal/terminalBridge.ts');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');

test('terminal event parsers preserve valid bounded messages', () => {
  assert.deepEqual(terminal.parseTerminalData({ id: 'one', data: 'hello' }), {
    id: 'one',
    data: 'hello',
  });
  assert.deepEqual(terminal.parseTerminalExit({ id: 'one', exitCode: 2 }), {
    id: 'one',
    exitCode: 2,
  });
  assert.deepEqual(terminal.parseTerminalProcess({ id: 'one', name: 'zsh' }), {
    id: 'one',
    name: 'zsh',
  });
});

test('terminal event parsers reject incomplete and invalid messages', () => {
  for (const value of [PLATFORM_NULL, {}, { id: 1, data: 'x' }, { id: 'one', data: 2 }]) {
    assert.throws(() => terminal.parseTerminalData(value));
  }
  assert.throws(() => terminal.parseTerminalExit({ id: 'one', exitCode: -1 }));
  assert.throws(() => terminal.parseTerminalExit({ id: 'one', exitCode: 1.5 }));
  assert.throws(() => terminal.parseTerminalProcess({ id: 'one' }));
});

test('terminal requests validate replies and preserve transport failures', async () => {
  const calls = [];
  global.window = {
    avb: {
      startTerminal: async (payload) => {
        calls.push(['start', payload]);
        return { ok: true, id: payload.id };
      },
      resizeTerminal: async (payload) => {
        calls.push(['resize', payload]);
        return { ok: true };
      },
      closeTerminal: async (payload) => {
        calls.push(['close', payload]);
        throw new Error('pty unavailable');
      },
      terminalClipboardImage: async (bytes, mime) => {
        calls.push(['image', bytes.byteLength, mime]);
        return { ok: true, path: '/tmp/image.png' };
      },
      terminalInput: (id, data) => calls.push(['input', id, data]),
      terminalAck: (id, count) => calls.push(['ack', id, count]),
    },
  };
  assert.equal(
    (
      await terminal.startTerminal({
        id: 'one',
        cwd: '/project',
        autoLaunch: 'codex',
        cols: 92,
        rows: 18,
      })
    ).ok,
    true,
  );
  assert.equal((await terminal.resizeTerminal('one', 80, 24)).ok, true);
  assert.deepEqual(await terminal.closeTerminal('one'), {
    ok: false,
    error: 'pty unavailable',
  });
  assert.equal((await terminal.saveTerminalClipboardImage(new Uint8Array(2), 'image/png')).ok, true);
  terminal.sendTerminalInput('one', 'a');
  terminal.acknowledgeTerminalData('one', 1);
  assert.deepEqual(calls, [
    ['start', { id: 'one', cwd: '/project', autoLaunch: 'codex', cols: 92, rows: 18 }],
    ['resize', { id: 'one', cols: 80, rows: 24 }],
    ['close', { id: 'one' }],
    ['image', 2, 'image/png'],
    ['input', 'one', 'a'],
    ['ack', 'one', 1],
  ]);
  delete global.window;
});

test('terminal clipboard images are bounded before IPC', async () => {
  global.window = {
    avb: {
      terminalClipboardImage: async () => {
        throw new Error('oversized image reached IPC');
      },
    },
  };
  const bytes = new Uint8Array(terminal.TERMINAL_IMAGE_BYTES_MAX + 1);
  assert.deepEqual(await terminal.saveTerminalClipboardImage(bytes, 'image/png'), {
    ok: false,
    error: 'Clipboard image exceeds 20 MB.',
  });
  delete global.window;
});
