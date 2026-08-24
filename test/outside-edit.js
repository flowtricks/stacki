// An edit made outside the app.
//
//   node test/outside-edit.js
//
// The canvas patches itself instead of reloading, and it learns that there is
// something to patch over the dev server's HMR socket: the server saw a file
// change and said so. That works right up until the socket stops listening —
// a dev server restarted under a canvas that stayed open, a machine that
// slept, a reconnect that landed on something else holding the same port.
// Nothing announces that. The page simply never updates again, and the only
// way to see an edit is to press refresh, which is exactly what was reported:
// "it doesn't seem like stacki is live updating when i make changes to code
// outside of the app".
//
// The app does not need the socket to know. It watches the project itself, for
// its own reasons, so it hears about every change either way — and it can say
// so straight to the frame. Patching twice for one edit costs a fetch and a
// diff that finds nothing; not patching at all costs the feature.
//
// Only for changes the app did NOT make: its own writes are what the socket is
// reliably good at, and saying it twice per keystroke is a fetch per keystroke.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  // --- the canvas patches when it is asked to ---------------------------------
  // The real client, in a real document, told by a message rather than by HMR.
  const bundle = path.join(buildDir, 'morph-client.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'electron', 'morphClient.js')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    // The page gets this from Vite; here there is no socket at all, which is
    // the situation being tested.
    define: { 'import.meta.hot': 'undefined' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const PAGE = (word) =>
    `<!doctype html><html><head><title>t</title></head><body>` +
    `<h1 id="probe">probe ${word}</h1></body></html>`;
  const dom = new JSDOM(PAGE('one'), { url: 'http://localhost:4321/probe' });
  const { window } = dom;
  let served = PAGE('one');
  let fetches = 0;
  window.fetch = async () => {
    fetches++;
    return { ok: true, status: 200, text: async () => served };
  };
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.fetch = window.fetch;
  global.DOMParser = window.DOMParser;
  global.CustomEvent = window.CustomEvent;
  global.Node = window.Node;
  global.Element = window.Element;

  require(bundle);
  await settle(30); // the client fetches its baseline as it loads
  check('the canvas takes a baseline of the server’s rendering', fetches === 1, `${fetches} fetches`);

  const say = async (message) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    await settle(40);
  };

  served = PAGE('two');
  await say({ type: 'avb:patch-now' });
  check(
    'a page told to patch shows what the file says now',
    window.document.getElementById('probe')?.textContent === 'probe two',
    window.document.getElementById('probe')?.textContent
  );
  check('without reloading anything', fetches === 2, `${fetches} fetches`);

  // Twice for one edit is the cost of not depending on the socket: the second
  // diff finds nothing and writes nothing.
  await say({ type: 'avb:patch-now' });
  check(
    'asking again when nothing changed leaves the page alone',
    window.document.getElementById('probe')?.textContent === 'probe two',
    window.document.getElementById('probe')?.textContent
  );

  served = PAGE('three');
  await say({ type: 'something-else' });
  check(
    'and a message that is not this one is not this one',
    window.document.getElementById('probe')?.textContent === 'probe two',
    window.document.getElementById('probe')?.textContent
  );

  // --- a word to the canvas that needs no answer --------------------------------
  const queryBundle = path.join(buildDir, 'canvas-query.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'canvasQuery.js')],
    outfile: queryBundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { setCanvasFrame, tellCanvas } = await import(`file://${queryBundle}?v=${Date.now()}`);
  const posted = [];
  setCanvasFrame({ postMessage: (m) => posted.push(m) });
  check('what the app says reaches the frame', tellCanvas({ type: 'avb:patch-now' }) === true);
  check('as the message the client is listening for', posted[0]?.type === 'avb:patch-now', JSON.stringify(posted));
  setCanvasFrame(null);
  check('and with no frame it says so rather than throwing', tellCanvas({ type: 'avb:patch-now' }) === false);

  // --- who says it, and when -----------------------------------------------------
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  check(
    'a change the app did not make is marked as coming from outside',
    /if \(!\(mine && Date\.now\(\) - mine < 1000\)\) notePageMayHaveChanged\(true\);/.test(main),
    'the app cannot tell an outside edit from its own'
  );
  check(
    'and the app’s own writes are not',
    /function markSelfWrite\(p\) \{[\s\S]*?notePageMayHaveChanged\(\);/.test(main),
    'every keystroke would ask the canvas for a fetch of its own'
  );
  check(
    'the flag survives the debounce that batches them',
    /pageChangeExternal = pageChangeExternal \|\| external;/.test(main),
    'an outside edit batched with an app write loses the flag'
  );

  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  check(
    'the app tells the canvas about an outside edit',
    /if \(d\?\.external\) tellCanvas\(\{ type: 'avb:patch-now' \}\);/.test(app),
    'nothing reaches the canvas when the socket is quiet'
  );
  const morph = fs.readFileSync(path.join(__dirname, '..', 'electron', 'morphClient.js'), 'utf8');
  check(
    'and the client still listens to the socket as well',
    /import\.meta\.hot\.on\('avb:page-changed', update\)/.test(morph),
    'the fast path is gone'
  );

  if (failures.length) {
    console.error(`\noutside-edit: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`outside-edit: ${checked} passed  [an edit the app did not make]`);
  process.exit(0);
})();
