// An edit made outside the app.
//
//   node test/electron/previewClient/outsideEdit.test.js
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
const { pathToFileURL } = require('url');
const { containsCode, readAppSource, readSource } = require('../../helpers/sourceText.js');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });

  // --- the canvas patches when it is asked to ---------------------------------
  // The real client, in a real document, told by a message rather than by HMR.
  const bundle = path.join(buildDirectory, 'morph-client.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('dist/electron/previewClient/morphClient.js')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    // The page gets this from Vite; here there is no socket at all, which is
    // the situation being tested.
    define: { 'import.meta.hot': 'undefined' },
    // Main prepends the patcher's bounds from shared/core/limits.ts (step 7).
    banner: {
      js: `const AVB_PREVIEW_LIMITS = Object.freeze(${JSON.stringify({
        previewMarkersMax: require('#dist/shared/core/limits.js').LIMITS.previewMarkersMax,
        previewMorphWorkMax: require('#dist/shared/core/limits.js').LIMITS.previewMorphWorkMax,
      })});`,
    },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const PAGE = (word) =>
    `<!doctype html><html><head><title>t</title></head><body>` +
    `<h1 id="probe">probe ${word}</h1></body></html>`;
  const dom = new JSDOM(PAGE('one'), {
    url: 'http://localhost:4321/probe#avb-design',
  });
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
  check(
    'the canvas takes a baseline of the server’s rendering',
    fetches === 1,
    `${fetches} fetches`,
  );

  const say = async (message) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    await settle(40);
  };

  served = PAGE('two');
  await say({ type: 'avb:patch-now' });
  check(
    'a page told to patch shows what the file says now',
    window.document.getElementById('probe')?.textContent === 'probe two',
    window.document.getElementById('probe')?.textContent,
  );
  check('without reloading anything', fetches === 2, `${fetches} fetches`);

  // Twice for one edit is the cost of not depending on the socket: the second
  // diff finds nothing and writes nothing.
  await say({ type: 'avb:patch-now' });
  check(
    'asking again when nothing changed leaves the page alone',
    window.document.getElementById('probe')?.textContent === 'probe two',
    window.document.getElementById('probe')?.textContent,
  );

  served = PAGE('three');
  await say({ type: 'something-else' });
  check(
    'and a message that is not this one is not this one',
    window.document.getElementById('probe')?.textContent === 'probe two',
    window.document.getElementById('probe')?.textContent,
  );

  // A subscribed socket can miss a structural render. Only the editor parent
  // can bypass the push grace period after the source write is acknowledged.
  window.document.dispatchEvent(new window.CustomEvent('studio:render-push', { detail: true }));
  const beforeImmediate = fetches;
  await say({ type: 'avb:patch-now', immediate: true });
  check('other senders cannot request an immediate render', fetches === beforeImmediate);
  window.dispatchEvent(
    new window.MessageEvent('message', {
      source: window.parent,
      data: { type: 'avb:patch-now', immediate: true },
    }),
  );
  await settle(40);
  check('accepted structure bypasses the 1500ms push delay', fetches === beforeImmediate + 1);
  check(
    'the complete structural render reaches the DOM immediately',
    window.document.getElementById('probe')?.textContent === 'probe three',
  );
  window.document.dispatchEvent(new window.CustomEvent('studio:render-push', { detail: false }));

  // --- a word to the canvas that needs no answer --------------------------------
  const queryBundle = path.join(buildDirectory, 'canvas-query.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/editor/canvasQuery.ts')],
    outfile: queryBundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { setCanvasFrame, tellCanvas } = await import(
    `${pathToFileURL(queryBundle).href}?v=${Date.now()}`
  );
  const posted = [];
  setCanvasFrame({ postMessage: (message) => posted.push(message) });
  check('what the app says reaches the frame', tellCanvas({ type: 'avb:patch-now' }) === true);
  check(
    'as the message the client is listening for',
    posted[0]?.type === 'avb:patch-now',
    JSON.stringify(posted),
  );
  setCanvasFrame(undefined);
  check(
    'and with no frame it says so rather than throwing',
    tellCanvas({ type: 'avb:patch-now' }) === false,
  );

  // --- who says it, and when -----------------------------------------------------
  const main = fs.readFileSync(repoPath('dist/electron/main.js'), 'utf8');
  const watcher = fs.readFileSync(repoPath('dist/electron/project/projectWatcher.js'), 'utf8');
  check(
    'a change the app did not make is marked as coming from outside',
    // The document actors hear it too (plan §7): a hint to re-read, not an authority.
    new RegExp(
      String.raw`if \(isSelfWrite\(changed\)\) \{\s*return;\s*\}\s*` +
        String.raw`noteExternalChange\(changed\);\s*notePageMayHaveChanged\(true\);`,
    ).test(watcher),
    'the app cannot tell an outside edit from its own',
  );
  check(
    'and the app’s own writes are not',
    /function noteAppWrite\(\)[^{]*\{[\s\S]*?notePageMayHaveChanged\(\);/.test(main),
    'every keystroke would ask the canvas for a fetch of its own',
  );
  check(
    'the flag survives the debounce that batches them',
    /pageChangeExternal = pageChangeExternal \|\| external;/.test(main),
    'an outside edit batched with an app write loses the flag',
  );

  // The app shell and the modules it was split into (src/app).
  const app = readAppSource();
  check(
    'the app tells the canvas about an outside edit',
    containsCode(app, "if (event.external) { tellCanvas({ type: 'avb:patch-now' }); }"),
    'nothing reaches the canvas when the socket is quiet',
  );
  const morph = readSource('electron/previewClient/morphClient.ts');
  check(
    'and the client still listens to the socket as well',
    /import\.meta\.hot\.on\('avb:page-changed', \(\) => \{[\s\S]{0,200}?requestUpdate\(\);/.test(
      morph,
    ),
    'the fast path is gone',
  );

  // --- an outside edit while the page has unsaved edits ---------------------------
  // The pending save used to win: the watcher dropped the change while the page
  // was dirty, and the whole-model save overwrote the file without looking.
  // Now every edit names the bytes it was stated against (plan §11 step 0; a
  // page's edits are requests since step 9, a Markdown page's since step 10),
  // and main refuses the ones whose bytes are gone. The real handlers run in the
  // windowless harness.
  {
    const os = require('os');
    const { createHash } = require('crypto');
    const { diffCodePatch } = require('#dist/shared/engine/codePatch.js');
    const { mainHarness } = await import('../../helpers/mainHarness.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-outside-edit-'));
    fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(root, 'user'));
    const harness = mainHarness(path.join(root, 'user'));
    try {
      const file = path.join(root, 'src', 'pages', 'index.astro');
      fs.writeFileSync(file, '<main>\n  <h1>Opened</h1>\n</main>\n');
      const read = await harness.invoke('page:read', file);
      // The user edits the heading in the app: a request against these bytes.
      const text = read.model.nodes[0].children[0].children[0];
      const target = { path: [0, 0, 0], kind: 'text', span: { start: text.start, end: text.end } };
      const node = { ...text, value: 'Typed in the app' };
      // Meanwhile an editor saves the same heading.
      const outside = '<main>\n  <h1>Saved in an editor</h1>\n</main>\n';
      fs.writeFileSync(file, outside);
      const saved = await harness.invoke('page:edit', {
        pagePath: file,
        authoredChecksum: read.checksum,
        edit: { tag: 'replace-node', target, node },
      });
      check(
        'the pending edit is refused',
        saved.ok === false && saved.error.code === 'rejected',
        JSON.stringify(saved),
      );
      check(
        'naming the bytes now on disk',
        saved.error?.diskChecksum === createHash('sha256').update(outside).digest('hex'),
        saved.error?.diskChecksum,
      );
      check(
        'and the outside edit is still on disk, byte for byte',
        fs.readFileSync(file, 'utf8') === outside,
      );
      check(
        'with no temporary file left beside it',
        !fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('.stacki-write-')),
      );
      // Keeping the local version is still possible, but only as a deliberate
      // act: the user reviews it as text and saves that text as a patch of the
      // bytes they were shown (the conflict notice's review, step 8).
      const mine = '<main>\n  <h1>Typed in the app</h1>\n</main>\n';
      const patch = diffCodePatch(outside, mine);
      const kept = await harness.invoke('page:edit', {
        pagePath: file,
        authoredChecksum: saved.error.diskChecksum,
        edit: { tag: 'code-patch', hunks: patch.value },
      });
      check(
        'keeping the local version patches the bytes on disk',
        kept.ok === true,
        JSON.stringify(kept.error),
      );
      check('and puts the local edit on disk', fs.readFileSync(file, 'utf8') === mine);
      check(
        'and never as a whole model: no such channel exists (step 10)',
        !harness.handlers.has('page:write') && !harness.handlers.has('page:serialize'),
      );
    } finally {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  if (failures.length) {
    console.error(
      `\noutside-edit: ${failures.length} failed, ${checked - failures.length} passed\n`,
    );
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`outside-edit: ${checked} passed  [an edit the app did not make]`);
  process.exit(0);
})();
