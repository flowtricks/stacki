// Goal: no new frame or window can draw a person's page without saying what happens to the page's scrollbar. A
// classic scrollbar takes about 15px from the page, and only shows on some computers: the editor's canvas was fixed
// once, and Design mode's frames, added a day later, narrowed their pages again because nothing asked.
//
// Method: a bounded scan of the app's, the main process's and Studio's sources for every place that makes an iframe,
// a webview or a window. Each is listed below with its treatment (shared/properties/canvasScrollbar.ts says what each means) and the
// scan proves the treatment is in the file. A new one, or one that lost its treatment, fails here. The widths
// themselves are held by pageFrameChromium.test.js (still frames and copies), canvasScrollbarChromium.test.js (the
// canvas's live frames) and thumbs.test.js (the project thumbnail). The scan also checks lines it must see and must
// not, so a pattern that matches nothing cannot pass.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const SCANNED = ['src', 'electron', 'shared', 'studio/src', 'studio/adapters', 'studio/demo'];
const SKIPPED_FOLDERS = new Set(['node_modules', 'vendor', 'dist', 'generated']);
const FILES_MAX = 20_000;
const FRAME_CREATION =
  /<(?:iframe|webview)(?=\s|$)|createElement\(\s*['"](?:iframe|webview)['"]|new (?:BrowserWindow|WebContentsView|BrowserView)\(|\bopenWindow\(\{/g;

const STILL_USE = /\{\.\.\.STILL_PAGE_FRAME\}|setAttribute\('scrolling', STILL_PAGE_FRAME\.scrolling\)/g;

/**
 * Every place, by file: how many it makes, and what each of them is. `proof` is what must be in the named files.
 * - canvas: a live page on the canvas, inside a frame CanvasScrollbar tells to hide its bar.
 * - still: nobody scrolls it by hand; each takes STILL_PAGE_FRAME.
 * - copy: still, and written by the app, which also takes the page's reserved gutter off it.
 * - own: the person scrolls it with nothing beside it, so it keeps Chromium's bar.
 * - none: no page of the person's is drawn in it at a width the app claims.
 */
const SURFACES = {
  'src/features/preview/PreviewFrame.tsx': {
    frames: 1,
    treatment: 'canvas',
    proof: { 'src/features/preview/CanvasView.tsx': /<CanvasScrollbar /, 'src/features/preview/PreviewPane.tsx': /<SizedFrame / },
  },
  'src/features/preview/SizedFrame.tsx': { frames: 0, treatment: 'canvas', proof: { 'src/features/preview/SizedFrame.tsx': /<CanvasScrollbar / } },
  'src/app/shell/AppShell.tsx': { frames: 1, treatment: 'canvas', proof: { 'src/app/shell/AppShell.tsx': /<PreviewModeStage / } },
  'studio/src/features/preview/PreviewCanvas.tsx': {
    frames: 1,
    treatment: 'canvas',
    proof: { 'studio/src/features/preview/PreviewCanvas.tsx': /<SizedFrame / },
  },
  'studio/src/features/preview/InteractivePreview.tsx': {
    frames: 1,
    treatment: 'canvas',
    proof: { 'studio/src/features/preview/InteractivePreview.tsx': /<PreviewModeStage / },
  },
  'src/app/designMode/DesignFrameDocument.tsx': { frames: 1, treatment: 'copy' },
  'src/features/audits/renderedDom.ts': { frames: 1, treatment: 'copy' },
  'src/features/palette/InsertPreview.tsx': { frames: 1, treatment: 'still' },
  'src/features/palette/ComponentPreviewPopup.tsx': { frames: 1, treatment: 'still' },
  'src/features/palette/snapshotProducer.ts': { frames: 1, treatment: 'still' },
  'electron/project/thumbs.ts': {
    frames: 1,
    treatment: 'none',
    why: 'the project thumbnail: a window, which takes the rule as a user stylesheet before it is pictured',
    proof: { 'electron/project/thumbs.ts': /insertCSS\(CANVAS_SCROLLBAR_CSS, \{ cssOrigin: 'user' \}\)/ },
  },
  'src/app/shell/AppPanes.tsx': { frames: 1, treatment: 'own', why: 'an old version of the site, filling the pane, only looked through' },
  'src/features/apps/AppFrame.tsx': { frames: 1, treatment: 'none', why: 'a Stacki app’s own interface' },
  'electron/previewServer/studioEntry.ts': { frames: 1, treatment: 'none', why: 'the page that holds Studio itself' },
  'electron/main.ts': { frames: 2, treatment: 'none', why: 'the app’s window, and the maker of the audit’s measuring window' },
  'electron/handlers/auditMeasure.ts': {
    frames: 1,
    treatment: 'none',
    why: 'measures load performance as a desktop browser meets the page, scrollbar included; nothing is drawn',
  },
};

/** The lines of `text` that are code: a comment may name a frame without making one. */
function code(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const read = (file) => code(fs.readFileSync(repoPath(file), 'utf8'));
const count = (text, pattern) => [...text.matchAll(pattern)].length;

function sourceFiles() {
  const files = [];
  const pending = SCANNED.filter((folder) => fs.existsSync(repoPath(folder)));
  let visited = 0;
  while (pending.length > 0 && visited < FILES_MAX) {
    const folder = pending.pop();
    for (const entry of fs.readdirSync(repoPath(folder), { withFileTypes: true })) {
      visited += 1;
      const file = path.posix.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) {
          pending.push(file);
        }
      } else if (/\.(ts|tsx|mts|js|jsx|mjs|html|astro)$/.test(entry.name)) {
        files.push(file);
      }
    }
  }
  assert.ok(visited < FILES_MAX, 'the scan stays within its bound');
  return files;
}

test('the scan sees every way of making a frame, and not a mention of one', () => {
  const seen = [
    '<iframe\n  src={url}',
    '<webview src="x">',
    "document.createElement('iframe')",
    'new BrowserWindow({',
    'new WebContentsView()',
    'openWindow({',
  ];
  for (const line of seen) {
    assert.equal(count(code(line), FRAME_CREATION), 1, line);
  }
  for (const line of ['// <iframe ... />', "detail: '<iframe>'", "const tags = ['iframe']", "querySelectorAll('iframe')"]) {
    assert.equal(count(code(line), FRAME_CREATION), 0, line);
  }
});

test('every frame and window the app makes says what happens to a page’s scrollbar', () => {
  const found = {};
  for (const file of sourceFiles()) {
    const made = count(read(file), FRAME_CREATION);
    if (made > 0) {
      found[file] = made;
    }
  }
  const listed = Object.fromEntries(
    Object.entries(SURFACES)
      .filter(([, surface]) => surface.frames > 0)
      .map(([file, surface]) => [file, surface.frames]),
  );
  assert.deepEqual(found, listed, 'a new frame or window is listed in SURFACES with its treatment (shared/properties/canvasScrollbar.ts)');
});

test('each listed treatment is in the code', () => {
  for (const [file, surface] of Object.entries(SURFACES)) {
    switch (surface.treatment) {
      case 'copy':
        assert.equal(count(read(file), STILL_USE), surface.frames, `${file}: each frame takes STILL_PAGE_FRAME`);
        assert.match(read(file), /\bhidePageRootScrollbar\(\w/, `${file}: its copy loses the root’s bar and gutter`);
        break;
      case 'still':
        assert.equal(count(read(file), STILL_USE), surface.frames, `${file}: each frame takes STILL_PAGE_FRAME`);
        break;
      case 'canvas':
        assert.ok(surface.proof !== undefined, `${file}: a canvas frame names what draws its bar`);
        break;
      case 'own':
      case 'none':
        assert.ok(surface.why.length > 0, `${file}: says why`);
        break;
      default:
        assert.fail(`${file}: unknown treatment ${surface.treatment}`);
    }
    for (const [proofFile, pattern] of Object.entries(surface.proof ?? {})) {
      assert.match(read(proofFile), pattern, `${file}: ${proofFile}`);
    }
  }
});
