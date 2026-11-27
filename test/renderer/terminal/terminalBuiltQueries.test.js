// Goal: the xterm that ships in the built app answers a program's startup
// queries and keeps drawing. The Desktop build once broke xterm's mode query
// (DECRQM, `CSI ? Ps $ p`): lowering `||=` while minifying made esbuild drop a
// variable declaration, so the query threw inside xterm's write loop and the
// terminal never drew again. Codex 0.171 sends that query before it draws, so
// it showed an empty terminal. Neither `npm run dev` nor the unbundled package
// has the fault, so only the built output can show it.
// Method: xterm is built through the repository's own vite.config.mjs, as
// `vite build` builds the renderer, then imported into Node and fed the bytes a
// terminal program writes. No window is opened: parsing and replies need none.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { repoPath } = require('../../helpers/sources.js');

const ENTRY = 'virtual:stacki-built-xterm';
const REPLY_MS_MAX = 5_000;

async function buildXterm() {
  const { build } = await import('vite');
  const entry = {
    name: 'stacki-built-xterm-entry',
    resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : undefined),
    load: (id) => (id === `\0${ENTRY}` ? "export { Terminal } from '@xterm/xterm';" : undefined),
  };
  const result = await build({
    root: repoPath('.'),
    configFile: repoPath('vite.config.mjs'),
    logLevel: 'silent',
    plugins: [entry],
    build: {
      write: false,
      emptyOutDir: false,
      rollupOptions: { input: ENTRY, preserveEntrySignatures: 'strict' },
    },
  });
  const chunks = [result].flat().flatMap((bundle) => bundle.output.filter((item) => item.type === 'chunk'));
  assert.equal(chunks.length, 1, 'xterm builds into one chunk');
  return chunks[0].code;
}

// Resolves once xterm has parsed `data`. A parser that throws never calls back,
// so the wait is bounded and the failure names what was written.
function write(terminal, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`xterm stopped parsing at ${JSON.stringify(data)}`)), REPLY_MS_MAX);
    terminal.write(data, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('built xterm answers mode queries and keeps drawing', async () => {
  const output = repoPath('node_modules/.stacki-test/terminal-built-xterm.mjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, await buildXterm());
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) {
    globalThis.window = globalThis;
  }
  try {
    const { Terminal } = await import(pathToFileURL(output).href);
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: false });
    let replies = '';
    terminal.onData((data) => {
      replies += data;
    });
    // The order Codex 0.171 starts in: the mode query first, then the device and
    // cursor queries whose replies it waits for before drawing.
    await write(terminal, '\x1b[?1007$p');
    await write(terminal, '\x1b[c\x1b[6n');
    // The ANSI form of the query takes the same path through xterm.
    await write(terminal, '\x1b[4$p');
    await write(terminal, 'drawn after the queries');
    assert.match(replies, /\x1b\[\?1007;[0-4]\$y/, 'the private mode query is answered');
    assert.match(replies, /\x1b\[\?1;2c/, 'the device attributes query is answered');
    assert.match(replies, /\x1b\[1;1R/, 'the cursor position query is answered');
    assert.match(replies, /\x1b\[4;[0-4]\$y/, 'the ANSI mode query is answered');
    assert.equal(terminal.buffer.active.getLine(0)?.translateToString(true), 'drawn after the queries');
    terminal.dispose();
  } finally {
    if (!hadWindow) {
      delete globalThis.window;
    }
  }
});
