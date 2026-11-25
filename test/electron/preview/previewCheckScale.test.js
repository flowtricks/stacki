// Goal: the preview token check reads the files a rendering came from at any
// size and any count (owner requirement: no size limit), and does it without
// stalling main's event loop. Before, a stamped file past the file bound read
// as "changed", a manifest past 512 files had no token, and each file was read
// and hashed whole in one synchronous call.
// Method: build a project in os.tmpdir with one huge page (STACKI_SCALE_MB, 24
// by default) and thousands of small components, stamp every one the way the
// dev plugin does, form the token with the shared manifest code, and run the
// real checkPreviewRender under measureOperation: the verdict must be `current`
// and the longest event-loop block must stay under the bound (the files are
// hashed a chunk at a time). Then change one byte of the huge file and the
// verdict must name it, and remove a component and it must be missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { lagMsBound, measureOperation, scaleMegabytes } = require('../../helpers/scaleFixtures.ts');
const { checkPreviewRender, sha256Text } = require('#dist/electron/preview/previewCheck.js');
const { canonicalManifest, manifestOf } = require('#dist/shared/page/previewToken.js');

const COMPONENTS = 3000;

function renderOf(project, files) {
  const stamps = files.map((relative) => ({
    file: relative,
    checksum: createHash('sha256')
      .update(fs.readFileSync(path.join(project, ...relative.split('/'))))
      .digest('hex'),
  }));
  const manifest = manifestOf(stamps);
  assert.ok(manifest.ok, 'the stamps form a manifest');
  return { token: sha256Text(canonicalManifest(manifest.value)), stamps: manifest.value };
}

test('a huge page and thousands of components are judged without stalling the loop', async (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-check-scale-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
  const row = '<li class="row">A line of the page, long enough to look like markup.</li>\n';
  const page = path.join(project, 'src', 'pages', 'big.astro');
  fs.writeFileSync(page, `---\n---\n<ul>\n${row.repeat(Math.ceil((scaleMegabytes() * 1024 * 1024) / row.length))}</ul>\n`);
  const files = ['src/pages/big.astro'];
  for (let index = 0; index < COMPONENTS; index++) {
    const relative = `src/components/C${String(index).padStart(5, '0')}.astro`;
    fs.writeFileSync(path.join(project, ...relative.split('/')), `<p>${index}</p>\n`);
    files.push(relative);
  }
  const render = renderOf(project, files.sort());
  assert.ok(render.stamps.length > 512, 'more files than the old manifest bound');

  const detail = `bytes=${fs.statSync(page).size} files=${files.length}`;
  const current = await measureOperation('previewCheck', detail, () => checkPreviewRender(project, render));
  assert.deepEqual(current.value, { tag: 'current' }, 'every stamped file still holds its bytes');
  assert.ok(current.lagMsMax < lagMsBound(), `the check yields while it reads: lag ${current.lagMsMax} ms`);

  const bytes = fs.readFileSync(page);
  bytes[bytes.length - 3] = bytes[bytes.length - 3] === 0x41 ? 0x42 : 0x41;
  fs.writeFileSync(page, bytes);
  assert.deepEqual(
    await checkPreviewRender(project, render),
    { tag: 'stale', reason: 'file-changed', file: 'src/pages/big.astro' },
    'one changed byte in the huge file is seen',
  );
  // Components sort before pages, so a removed one is the first file the judge reaches.
  fs.rmSync(path.join(project, 'src', 'components', 'C00007.astro'));
  assert.deepEqual(await checkPreviewRender(project, render), { tag: 'stale', reason: 'file-missing', file: 'src/components/C00007.astro' });
});
