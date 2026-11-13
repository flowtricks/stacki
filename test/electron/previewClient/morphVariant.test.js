// Goal: a prop hover preview on the canvas stays on show until it is cancelled or
// committed. On stacki.build the hero heading's hovered `variant` showed and then went
// back to the written value while the pointer still rested on the option: a pull the
// page made for its own reasons (a patch-now after selection, the dev server's
// page-changed) fetched the plain page and painted it over the preview. The same pull
// after a click, made as the write was applied while the dev server still rendered the
// old file, painted the previous value between the preview and the written rendering:
// a flash. A commit therefore keeps the option for pulls until the write has rendered.
// Method: the canvas half (electron/previewClient/morphVariant.ts), bundled with esbuild
// and run with a recorded fetch and host. Each case reads which header a show sends, the
// headers a pull of the page would carry while the preview is on show, and that cancel,
// commit and a malformed message leave pulls plain again.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

function loadVariantModule() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-morph-variant-'));
  const output = path.join(directory, 'variant.cjs');
  try {
    buildSync({
      entryPoints: [repoPath('electron/previewClient/morphVariant.ts')],
      outfile: output,
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      logLevel: 'silent',
    });
    return require(output);
  } finally {
    delete require.cache[output];
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const { createVariantPreview } = loadVariantModule();
const { VARIANT_HEADER, variantHeaderValue } = require('#dist/shared/page/variantOverride.js');

const OVERRIDE = { component: 'src/components/typography/Heading.astro', target: '0.0.0.1', prop: 'variant', value: 'h3' };

function setup() {
  const timers = [];
  const fetched = [];
  const painted = [];
  let restored = 0;
  let superseded = 0;
  global.location = { href: 'http://127.0.0.1:4321/' };
  global.fetch = (url, init) => {
    fetched.push(init.headers[VARIANT_HEADER]);
    return Promise.resolve({ ok: true, text: () => Promise.resolve(`<h1 class="${fetched.length}"></h1>`) });
  };
  const preview = createVariantPreview({
    paint: (html) => painted.push(html),
    restore: () => {
      restored++;
    },
    supersede: () => {
      superseded++;
    },
    schedule: (delayMs, run) => {
      const job = { delayMs, run, live: true };
      timers.push(job);
      return () => {
        job.live = false;
      };
    },
  });
  const expire = () => {
    for (const job of timers.splice(0)) {
      if (job.live) {
        job.run();
      }
    }
  };
  return { preview, fetched, painted, restored: () => restored, superseded: () => superseded, timers, expire };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a pull while a preview is on show asks for the previewed option, not the plain page', async () => {
  const { preview, fetched, painted } = setup();
  assert.deepEqual(preview.headers(), {}, 'no preview: a pull is plain');
  assert.equal(preview.receive({ type: 'avb:variant', override: OVERRIDE }), true);
  await settle();
  assert.deepEqual(fetched, [variantHeaderValue(OVERRIDE)]);
  assert.equal(painted.length, 1);
  assert.deepEqual(preview.headers(), { [VARIANT_HEADER]: variantHeaderValue(OVERRIDE) }, 'the pull keeps the preview');
  preview.forget();
  assert.deepEqual(preview.headers(), { [VARIANT_HEADER]: variantHeaderValue(OVERRIDE) }, 'a changed page still renders the hovered option');
});

test('cancel ends the preview, so pulls are plain again', async () => {
  const cancelled = setup();
  cancelled.preview.receive({ type: 'avb:variant', override: OVERRIDE });
  await settle();
  assert.equal(cancelled.preview.receive({ type: 'avb:variant-cancel' }), true);
  assert.deepEqual(cancelled.preview.headers(), {}, 'cancel: the written value renders');
  assert.equal(cancelled.restored(), 1, 'cancel puts the page back');
});

test('a commit holds the option for pulls until the write has rendered, then the page is pulled plain once', async () => {
  const { preview, painted, restored, superseded, timers, expire } = setup();
  const header = { [VARIANT_HEADER]: variantHeaderValue(OVERRIDE) };
  preview.receive({ type: 'avb:variant', override: OVERRIDE });
  await settle();
  assert.equal(painted.length, 1);
  preview.receive({ type: 'avb:variant-commit' });
  assert.equal(superseded(), 1, 'a plain pull already on its way predates the write and is dropped');
  assert.deepEqual(preview.headers(), header, 'the pull made as the write is applied still asks for the committed option');
  preview.forget();
  assert.deepEqual(preview.headers(), header, 'the dev server announcing the change asks for it too');
  assert.equal(restored(), 0, 'nothing plain is pulled while the write renders: no frame of the old value');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 2500);
  expire();
  assert.deepEqual(preview.headers(), {}, 'after the hold the written page renders itself');
  assert.equal(restored(), 1, 'one plain pull settles a write that never landed');
});

test('a commit keeps a show that is still being fetched: the committed option lands', async () => {
  const { preview, painted, fetched } = setup();
  preview.receive({ type: 'avb:variant', override: OVERRIDE });
  preview.receive({ type: 'avb:variant-commit' });
  await settle();
  assert.equal(fetched.length, 1);
  assert.equal(painted.length, 1, 'the click came before the render did; the render is not thrown away');
});

test('cancel, a new show and the next pick end or replace a hold', async () => {
  const cancelled = setup();
  cancelled.preview.receive({ type: 'avb:variant', override: OVERRIDE });
  await settle();
  cancelled.preview.receive({ type: 'avb:variant-commit' });
  cancelled.preview.receive({ type: 'avb:variant-cancel' });
  assert.deepEqual(cancelled.preview.headers(), {}, 'an undo ends the hold: the page it restores is not hidden');
  assert.equal(cancelled.restored(), 1);
  cancelled.expire();
  assert.equal(cancelled.restored(), 1, 'the ended hold does not fire again');

  // A to B to C quickly: each pick replaces the held option; only the last is held.
  const quick = setup();
  const pick = async (value) => {
    quick.preview.receive({ type: 'avb:variant', override: { ...OVERRIDE, value } });
    quick.preview.receive({ type: 'avb:variant-commit' });
    await settle();
  };
  await pick('h1');
  await pick('h2');
  await pick('h3');
  assert.deepEqual(quick.preview.headers(), { [VARIANT_HEADER]: variantHeaderValue({ ...OVERRIDE, value: 'h3' }) });
  assert.equal(quick.restored(), 0, 'no plain rendering between the picks');
  assert.equal(quick.timers.filter((job) => job.live).length, 1, 'one hold, the last');
  quick.expire();
  assert.equal(quick.restored(), 1);
});

test('a malformed message is not a preview and changes nothing', () => {
  const { preview, fetched } = setup();
  assert.equal(preview.receive({ type: 'avb:variant', override: { ...OVERRIDE, prop: '' } }), false);
  assert.equal(preview.receive({ type: 'avb:something-else' }), false);
  assert.deepEqual(fetched, []);
  assert.deepEqual(preview.headers(), {});
});
