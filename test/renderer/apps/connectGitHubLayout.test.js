// The Load App From GitHub popup keeps its chrome fixed around a long
// repository list: the title and the one combined field (the account chip at its
// left, the search that also takes a pasted repository filling the rest) stay in
// view, only the list scrolls (inside its own region, never under the title),
// its ends fade while there is more past it, and the footer keeps the modal
// footer's 1px line. The field and the list have a gap between
// them, not touching, and there is no separate "public repository" control.
//
//   node test/renderer/apps/connectGitHubLayout.test.js
//
// jsdom has no layout, so this is measured in a real browser: the popup's frame
// and repository chooser (react-dom/server over the real components) holding
// forty tagged repositories, under the app's stylesheets, in a 900×600 window.
// The probe scrolls the list to its end and measures again, because the bug this
// pins (the list sliding up under the title) only showed once scrolled.
const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const REPOSITORY_COUNT = 40;

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('connect-github-layout: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/connect-github-layout');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const bundle = path.join(pageDirectory, 'connect.cjs');
  buildSync({
    entryPoints: [repoPath('src/features/apps/ConnectGitHub.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { ConnectFrame, RepositoryChooser } = require(bundle);
  const repositories = Array.from({ length: REPOSITORY_COUNT }, (_, index) => ({
    owner: 'example',
    name: `repository-${index}`,
    private: index % 2 === 0,
    updatedAt: '2026-01-01T00:00:00Z',
    stackiApp: true,
  }));
  const noop = () => {};
  // The scroll-edge hook uses a layout effect, which a server render skips; its warning is expected here.
  const consoleError = console.error;
  console.error = () => {};
  const markup = renderToStaticMarkup(
    React.createElement(
      ConnectFrame,
      { onCancel: noop },
      React.createElement(RepositoryChooser, {
        account: 'first',
        accounts: ['first', 'second'],
        list: { kind: 'ready', repositories },
        onAccount: noop,
        renderAvatar: () => React.createElement('span', { style: { display: 'inline-block', width: 20, height: 20 } }),
        onPick: noop,
      }),
    ),
  );
  console.error = consoleError;
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    [
      'src/features/style/tokens.css', // The sheets styles.css imports first (its @import is not followed in a concatenation).
      'src/ui/controls.css',
      'src/ui/dropdown.css',
      'src/ui/resetLabel.css',
      'src/app/styles.css',
      'src/ui/popup.css',
      'src/features/apps/apps.css',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#1a1a1a}</style>' +
      `<div class="popup-surface modal apps-connect">${markup}</div>`,
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 600, useContentSize: true });
       await win.loadFile(path.join(__dirname, 'index.html'));
       const result = await win.webContents.executeJavaScript(\`(() => {
         const box = (selector) => {
           const rectangle = document.querySelector(selector).getBoundingClientRect();
           return { top: Math.round(rectangle.top), bottom: Math.round(rectangle.bottom) };
         };
         const scroll = document.querySelector('.apps-connect-scroll');
         const field = document.querySelector('.apps-connect-field');
         const measure = () => ({
           modal: box('.apps-connect'),
           header: box('.apps-connect-header'),
           field: box('.apps-connect-field'),
           chip: (() => {
             const rectangle = document.querySelector('.apps-connect-field .dd-trigger').getBoundingClientRect();
             return { left: Math.round(rectangle.left), right: Math.round(rectangle.right), top: Math.round(rectangle.top), bottom: Math.round(rectangle.bottom) };
           })(),
           input: (() => {
             const input = document.querySelector('.apps-connect-field input');
             const rectangle = input.getBoundingClientRect();
             return { left: Math.round(rectangle.left), right: Math.round(rectangle.right), placeholder: input.placeholder };
           })(),
           fieldRight: Math.round(field.getBoundingClientRect().right),
           publicControls: [...document.querySelectorAll('.apps-connect button, .apps-connect a')].filter((element) => /public repository/i.test(element.textContent)).length,
           scroll: box('.apps-connect-scroll'),
           footer: box('.apps-connect-footer'),
           firstRow: box('.apps-connect-scroll [role=option]'),
           scrollTop: scroll.scrollTop,
           scrollHeight: scroll.scrollHeight,
           clientHeight: scroll.clientHeight,
           scrollOverflow: getComputedStyle(scroll).overflowY,
           bodyScrolls: document.querySelector('.apps-connect-body').scrollHeight > document.querySelector('.apps-connect-body').clientHeight,
           mask: getComputedStyle(scroll).maskImage || getComputedStyle(scroll).webkitMaskImage,
           footerBorder: getComputedStyle(document.querySelector('.apps-connect-footer')).borderTopWidth,
           viewport: window.innerHeight,
         });
         const before = measure();
         scroll.scrollTop = scroll.scrollHeight;
         return { before, after: measure() };
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
    const { before, after } = JSON.parse(line);
    check('the popup fits the window', before.modal.bottom <= before.viewport, line);
    check('the list overflows its region', before.scrollHeight > before.clientHeight, `${before.scrollHeight} vs ${before.clientHeight}`);
    check('the list region scrolls', before.scrollOverflow === 'auto' || before.scrollOverflow === 'scroll', before.scrollOverflow);
    check('the body itself does not scroll', before.bodyScrolls === false, line);
    check('the list fades its ends with a mask', typeof before.mask === 'string' && before.mask.includes('linear-gradient'), String(before.mask));
    check('the field says it takes a pasted URL', before.input.placeholder === 'Search repositories or paste a GitHub URL', before.input.placeholder);
    check('the account chip sits inside the field', before.chip.top >= before.field.top && before.chip.bottom <= before.field.bottom, line);
    check('the account chip is at the field’s left, before the input', before.chip.right <= before.input.left, line);
    check('the input fills the rest of the field', before.fieldRight - before.input.right <= 8, line);
    check('there is no separate public-repository control', before.publicControls === 0, String(before.publicControls));
    check('the field and the list have a gap', before.scroll.top - before.field.bottom >= 8, `${before.field.bottom} → ${before.scroll.top}`);
    check('the field sits under the title', before.field.top >= before.header.bottom, line);
    check('the footer keeps the modal footer line', before.footerBorder === '1px', before.footerBorder);
    check('the footer stays inside the popup', before.footer.bottom <= before.modal.bottom, line);
    // Scrolled to the end: the chrome is where it was, and the rows move inside their own region only.
    check('scrolling moved the list', after.scrollTop > 0, String(after.scrollTop));
    check('the title stays put when scrolled', after.header.top === before.header.top, line);
    check('the field stays put when scrolled', after.field.top === before.field.top, line);
    check('the list region stays under the field when scrolled', after.scroll.top >= after.field.bottom, line);
    check('the list region stays under the title when scrolled', after.scroll.top >= after.header.bottom, line);
    check('the list region ends above the footer', after.scroll.bottom <= after.footer.top, line);
    check('the scrolled-away rows leave through the region top', after.firstRow.top < after.scroll.top, line);
  }
  if (failures.length) {
    console.error(`connect-github-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`connect-github-layout: ${checked} passed  [real layout]`);
})();
