// A selector longer than the panel stays inside its row, and the row's lock
// stays where it can be clicked.
//
//   node test/renderer/selectors/selectorRowWidth.test.js
//
// Each row sits in a slot that is a one-track grid, so its height can close
// from 1fr to 0fr when the row leaves the tab. A grid item is as wide as its
// content unless told otherwise, so a long selector (`.inline-video_wrap.is-
// focused .button…`) stretched its row past the panel, and the lock, pinned to
// the row's right end, went with it: out of sight and out of reach. jsdom has
// no layout, so this is measured in a real browser: the row markup the panel
// renders, under the app's stylesheets, in a 280px-wide list.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const LIST_WIDTH_PX = 280;
const LONG_SELECTOR = '.inline-video_wrap.is-focused .button_icon_wrap .button_text_inner .button_main_wrap';

// One row as SelectorsPanel's SelectorRow renders it, locked.
function rowMarkup(selector) {
  return (
    '<div class="selectors-row-slot">' +
    '<div class="selectors-row is-kept">' +
    `<code class="selectors-selector">${selector}</code>` +
    '<span class="selectors-actions"><button class="ghost selectors-lock on" aria-label="Unlock">L</button></span>' +
    '</div></div>'
  );
}

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('selector-row-width: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }

  const pageDirectory = repoPath('node_modules/.stacki-test/selector-row-width');
  fs.mkdirSync(pageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    ['src/features/style/tokens.css', 'src/app/styles.css', 'src/features/selectors/selectors.css']
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:0;background:#1a1a1a}</style>' +
      `<div class="selectors-panel"><div class="selectors-body" style="width:${LIST_WIDTH_PX}px">` +
      rowMarkup(LONG_SELECTOR) +
      rowMarkup('.mapboxgl-ctrl-logo') +
      '</div></div>',
  );

  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 600, height: 400 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       const result = await win.webContents.executeJavaScript(\`(() => {
         const list = document.querySelector('.selectors-body').getBoundingClientRect();
         return [...document.querySelectorAll('.selectors-row')].map((row) => {
           const box = row.getBoundingClientRect();
           const lock = row.querySelector('.selectors-lock').getBoundingClientRect();
           const text = row.querySelector('.selectors-selector');
           const x = Math.round(lock.left + lock.width / 2);
           const y = Math.round(lock.top + lock.height / 2);
           const hit = document.elementFromPoint(x, y);
           return {
             listRight: Math.round(list.right),
             rowRight: Math.round(box.right),
             lockRight: Math.round(lock.right),
             textClipped: text.scrollWidth > text.clientWidth,
             lockHit: hit !== null && hit.closest('.selectors-lock') !== null,
           };
         });
       })()\`);
       console.log(JSON.stringify(result));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('['));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const [long, short] = JSON.parse(line);
    check('there are two rows to measure', long !== undefined && short !== undefined, line);
    if (long !== undefined && short !== undefined) {
      check('a long selector keeps its row inside the list', long.rowRight <= long.listRight, JSON.stringify(long));
      check('its lock is inside the list', long.lockRight <= long.listRight, JSON.stringify(long));
      check('its lock is what a click there reaches', long.lockHit, JSON.stringify(long));
      check('the selector is cut short with an ellipsis, not the row widened', long.textClipped, JSON.stringify(long));
      check('a short selector also ends at the list edge', short.rowRight === short.listRight, JSON.stringify(short));
      check('both locks line up', long.lockRight === short.lockRight, `${long.lockRight} vs ${short.lockRight}`);
    }
  }

  if (failures.length) {
    console.error(`selector-row-width: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selector-row-width: ${checked} passed  [real layout]`);
})();
