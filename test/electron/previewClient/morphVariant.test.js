// Goal: a prop hover preview on the canvas stays on show until it is cancelled or
// committed. On stacki.build the hero heading's hovered `variant` showed and then went
// back to the written value while the pointer still rested on the option: a pull the
// page made for its own reasons (a patch-now after selection, the dev server's
// page-changed) fetched the plain page and painted it over the preview.
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
  const fetched = [];
  const painted = [];
  let restored = 0;
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
  });
  return { preview, fetched, painted, restored: () => restored };
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

test('cancel and commit end the preview, so pulls are plain again', async () => {
  const cancelled = setup();
  cancelled.preview.receive({ type: 'avb:variant', override: OVERRIDE });
  await settle();
  assert.equal(cancelled.preview.receive({ type: 'avb:variant-cancel' }), true);
  assert.deepEqual(cancelled.preview.headers(), {}, 'cancel: the written value renders');
  assert.equal(cancelled.restored(), 1, 'cancel puts the page back');

  const committed = setup();
  committed.preview.receive({ type: 'avb:variant', override: OVERRIDE });
  await settle();
  committed.preview.receive({ type: 'avb:variant-commit' });
  assert.deepEqual(committed.preview.headers(), {}, 'commit: the write renders itself');
  assert.equal(committed.restored(), 0, 'commit keeps what is shown until the write lands');
});

test('a malformed message is not a preview and changes nothing', () => {
  const { preview, fetched } = setup();
  assert.equal(preview.receive({ type: 'avb:variant', override: { ...OVERRIDE, prop: '' } }), false);
  assert.equal(preview.receive({ type: 'avb:something-else' }), false);
  assert.deepEqual(fetched, []);
  assert.deepEqual(preview.headers(), {});
});
