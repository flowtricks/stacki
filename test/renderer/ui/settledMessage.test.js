// Goal: a refusal of a half-typed value is told as a toast only after it has stood still, and a cleared refusal clears at once, so a
// toast never reports a state the form has already left (owner rule: no paragraphs appended into the UI, no noisy toasts either).
// Method: bundle the real hook, mount it in jsdom with a short delay, change the message the way typing does, and read what it
// returns after each step. Negative space: a message that changes before the delay never shows, a cleared message returns
// undefined with no wait, and a delay that is not a positive whole number is refused by the hook's assertions.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath } = require('../../helpers/sources');

const DELAY_MS = 150;
const output = repoPath('node_modules/.stacki-test/settled-message.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: { contents: "export { useSettledMessage } from './src/ui/useSettledMessage';", resolveDir: repoPath('.'), loader: 'ts' },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = require('react-dom/client');
const { useSettledMessage } = require(output);

// The test drives the hook's timer instead of sleeping past it: setTimeout calls with the hook's delay go to a queue on a virtual
// clock that `wait` advances; every other timer (React's own) is the real one.
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const queued = new Map();
let virtualNowMs = 0;
let nextTimerId = 1;
global.setTimeout = (callback, delayMs, ...rest) => {
  if (delayMs !== DELAY_MS) {
    return realSetTimeout(callback, delayMs, ...rest);
  }
  const id = `virtual-${nextTimerId}`;
  nextTimerId += 1;
  queued.set(id, { callback, dueMs: virtualNowMs + delayMs });
  return id;
};
global.clearTimeout = (id) => {
  if (typeof id === 'string' && id.startsWith('virtual-')) {
    queued.delete(id);
    return;
  }
  realClearTimeout(id);
};
const wait = (ms) =>
  act(async () => {
    virtualNowMs += ms;
    for (const [id, timer] of [...queued]) {
      if (timer.dueMs <= virtualNowMs) {
        queued.delete(id);
        timer.callback();
      }
    }
  });

test('a message is returned only after it has stood still, and clears at once', async (context) => {
  const seen = [];
  function Probe({ message, delay }) {
    seen.push(useSettledMessage(message, delay));
    return undefined;
  }
  const root = createRoot(document.getElementById('root'));
  context.after(async () => act(async () => root.unmount()));
  const show = (message, delay = DELAY_MS) => act(async () => root.render(React.createElement(Probe, { message, delay })));
  const latest = () => seen.at(-1);

  await show('Not a complete address.');
  assert.equal(latest(), undefined, 'a fresh refusal waits');
  await show('Not a complete address, still.');
  await wait(DELAY_MS / 2);
  await show('Needs a placeholder.');
  await wait(DELAY_MS / 2);
  assert.equal(latest(), undefined, 'a refusal that changed before the delay never shows');
  await wait(DELAY_MS * 2);
  assert.equal(latest(), 'Needs a placeholder.', 'the refusal that stood still is told');
  await show(undefined);
  assert.equal(latest(), undefined, 'a cleared refusal clears with no wait');
  assert.ok(!seen.includes('Not a complete address.'), 'an overtaken refusal was never returned');
});

test('a delay that is not a positive whole number is refused', async () => {
  function Probe({ delay }) {
    useSettledMessage('x', delay);
    return undefined;
  }
  for (const delay of [0, -5, 1.5]) {
    const root = createRoot(document.createElement('div'));
    // The assertion throws during render; React rethrows it through the awaited act.
    await assert.rejects(async () => act(async () => root.render(React.createElement(Probe, { delay }))), /delay is/);
  }
});

test.after(() => {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  dom.window.close();
});
