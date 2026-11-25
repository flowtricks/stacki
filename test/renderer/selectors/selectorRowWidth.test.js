// A selector longer than the panel stays inside its row, and the row's lock
// stays where it can be clicked. Every lock, a stylesheet heading's and each
// row's, with or without the row's trash beside it, sits in one column.
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

// One row as SelectorsPanel's SelectorRow renders it: locked, or unused with
// its trash before its lock (laid out though hidden until hover).
function rowMarkup(selector, kind = 'kept') {
  const trash = kind === 'unused' ? '<button class="ghost selectors-remove-one" aria-label="Remove">T</button>' : '';
  return (
    '<div class="selectors-row-slot">' +
    `<div class="selectors-row is-${kind}">` +
    `<code class="selectors-selector">${selector}</code>` +
    `<span class="selectors-actions">${trash}<button class="ghost selectors-lock ${kind === 'kept' ? 'on' : ''}" aria-label="Lock">L</button></span>` +
    '</div></div>'
  );
}

// A stylesheet heading as SheetSection renders it, with its lock.
const HEADING =
  '<div class="selectors-heading"><h3 class="selectors-heading-name selectors-file">patterns.css</h3>' +
  '<span class="tip-anchor selectors-sheet-lock-anchor"><button class="ghost selectors-sheet-lock" aria-label="Lock patterns.css">L</button></span></div>';

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
    [
      'src/features/style/tokens.css', // The sheets styles.css imports first (its @import is not followed in a concatenation).
      'src/ui/controls.css',
      'src/ui/dropdown.css',
      'src/ui/resetLabel.css',
      'src/app/styles.css',
      'src/features/selectors/selectors.css',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:0;background:#1a1a1a}</style>' +
      `<div class="selectors-panel"><div class="selectors-body" style="width:${LIST_WIDTH_PX}px">` +
      `<section class="selectors-group"><div class="selectors-group-body">${HEADING}` +
      rowMarkup(LONG_SELECTOR) +
      rowMarkup('.mapboxgl-ctrl-logo') +
      rowMarkup('.pattern-a', 'unused') +
      '</div></section>' +
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
         const heading = document.querySelector('.selectors-sheet-lock').getBoundingClientRect();
         const trash = document.querySelector('.selectors-remove-one').getBoundingClientRect();
         const rows = [...document.querySelectorAll('.selectors-row')].map((row) => {
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
         return { rows, headingLockRight: Math.round(heading.right), trashRight: Math.round(trash.right) };
       })()\`);
       console.log(JSON.stringify(result));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const measured = JSON.parse(line);
    const [long, short, unused] = measured.rows;
    check('there are two rows to measure', long !== undefined && short !== undefined, line);
    if (long !== undefined && short !== undefined) {
      check('a long selector keeps its row inside the list', long.rowRight <= long.listRight, JSON.stringify(long));
      check('its lock is inside the list', long.lockRight <= long.listRight, JSON.stringify(long));
      check('its lock is what a click there reaches', long.lockHit, JSON.stringify(long));
      check('the selector is cut short with an ellipsis, not the row widened', long.textClipped, JSON.stringify(long));
      check('a short selector also ends at the list edge', short.rowRight === short.listRight, JSON.stringify(short));
      check('both locks line up', long.lockRight === short.lockRight, `${long.lockRight} vs ${short.lockRight}`);
    }
    check('there is a row with a trash to measure', unused !== undefined, line);
    if (unused !== undefined && short !== undefined) {
      check('a row with its trash keeps its lock in the column', unused.lockRight === short.lockRight, `${unused.lockRight} vs ${short.lockRight}`);
      check('the trash sits before the lock', measured.trashRight <= unused.lockRight - 12, JSON.stringify(measured));
      check(
        'the stylesheet heading lock lines up with the row locks',
        measured.headingLockRight === short.lockRight,
        `${measured.headingLockRight} vs ${short.lockRight}`,
      );
    }
  }

  if (failures.length) {
    console.error(`selector-row-width: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selector-row-width: ${checked} passed  [real layout]`);
})();
