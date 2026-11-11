// Goal: the Share app popup is compact and reads like GitHub's new-repository
// dialog. The header's subject is the app itself (its tile with a small GitHub
// mark, "Share <name>", its version) over the modal's 1px line; one destination
// field holds the owner chip, "/" and the name input, with the name's check on
// one line under it; there is no separate account control for one signed-in
// account; the visibility is a segmented control with one muted line saying
// what the choice means (public: "Adds an MIT license"); the secret scan is a
// status row; Cancel and the primary action ("Share privately" or "Share
// publicly") sit together at the footer's right, and nothing primary floats in
// the body. A name that exists and a scan that found secrets disable Share, and
// the scan's warning expands to its findings. Success shows the repository
// link with Copy link and Invite people, the finished steps, the update switch
// (on) and Done at the footer's right, with no Cancel.
//
//   node test/renderer/apps/shareAppLayout.test.js
//
// Method: jsdom has no layout, and the segmented control's pill is placed by a
// layout effect, so the real components (ShareForm, SharedState, ShareFrame)
// are bundled for the browser and mounted with React in a real Chromium
// (Electron's), under the app's stylesheets, in a 900×700 window. The probe
// measures each state, clicks where a state needs it, and saves a screenshot of
// each state beside the page (node_modules/.stacki-test/share-app-layout/).
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

const STATES = ['default', 'public', 'problems', 'success'];

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('share-app-layout: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/share-app-layout');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = path.join(pageDirectory, 'entry.jsx');
  const share = JSON.stringify(repoPath('src/features/apps/ShareApp.tsx'));
  fs.writeFileSync(
    entry,
    `import React from 'react';
     import { createRoot } from 'react-dom/client';
     import { ShareForm, SharedState } from ${share};
     const app = { id: 'feedback-pins', name: 'Feedback pins', version: '1.2.0', icon: undefined };
     const owners = [
       { key: 'octocat/octocat', account: 'octocat', login: 'octocat', kind: 'user' },
       { key: 'octocat/acme', account: 'octocat', login: 'acme', kind: 'organization' },
     ];
     const repositories = [{ owner: 'octocat', name: 'existing-tool', private: true, updatedAt: '2026-01-01T00:00:00Z', stackiApp: false, organization: false }];
     const listingOf = () => ({ kind: 'ready', repositories });
     const clean = { kind: 'ready', scan: { kind: 'clean', filesScanned: 14 } };
     const finding = (line) => ({ file: 'src/main.tsx', line, rule: 'github-token', excerpt: 'const token = "ghp_••••";', lineSha256: 'a'.repeat(64) });
     const found = { kind: 'ready', scan: { kind: 'found', findings: [finding(3), finding(9)], truncated: false } };
     const colors = { octocat: '#6366f1', acme: '#10b981' };
     const renderAvatar = (login) =>
       React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: '50%', background: colors[login] ?? '#888', color: '#fff', fontSize: 10, fontWeight: 600 } }, (login ?? '?')[0].toUpperCase());
     const noop = () => {};
     const form = (extra) => React.createElement(ShareForm, { app, owners, accountCount: 1, listingOf, scan: clean, renderAvatar, onRescan: noop, onStart: noop, onCancel: noop, ...extra });
     const state = new URLSearchParams(location.search).get('state');
     const element =
       state === 'public' ? form({ initialVisibility: 'public' })
       : state === 'problems' ? form({ initialName: 'existing-tool', scan: found })
       : state === 'success' ? React.createElement(SharedState, {
           projectPath: '/project', notify: noop, onSwitched: noop, onSubmitToMarketplace: undefined, onDone: noop, account: 'octocat',
           app: { manifest: app },
           shared: { owner: 'octocat', repository: 'feedback-pins', visibility: 'private', tag: 'v1.2.0', asset: 'feedback-pins.zip', sha256: 'b'.repeat(64) },
         })
       : form({});
     createRoot(document.getElementById('surface')).render(element);`,
  );
  const bundle = path.join(pageDirectory, 'page.js');
  buildSync({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'transform',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [repoPath('node_modules')],
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    [
      'src/features/style/tokens.css', // The sheets styles.css imports first (its @import is not followed in a concatenation).
      'src/ui/controls.css',
      'src/ui/dropdown.css',
      'src/ui/resetLabel.css',
      'src/app/styles.css',
      'src/ui/popup.css',
      'src/ui/segmentedTabs.css',
      'src/ui/switch.css',
      'src/ui/codeBlock.css',
      'src/features/apps/apps.css',
      'src/features/apps/publish.css',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141414}</style>' +
      '<div id="surface" class="popup-surface modal apps-connect apps-share"></div><script src="page.js"></script>',
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const fs = require('fs');
     const path = require('path');
     app.disableHardwareAcceleration();
     // Each state closes its window before the next opens; the probe quits once all are measured.
     app.on('window-all-closed', () => {});
     const measure = \`(async () => {
       await new Promise((resolve) => setTimeout(resolve, 150));
       const box = (element) => {
         if (!element) return undefined;
         const r = element.getBoundingClientRect();
         return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
       };
       const modal = document.querySelector('.apps-share');
       const header = modal.querySelector('.apps-connect-header');
       const body = modal.querySelector('.apps-connect-body');
       const footer = modal.querySelector('.apps-connect-footer');
       const footerButtons = [...footer.querySelectorAll('button')].map((button) => ({ text: button.textContent.trim(), primary: button.classList.contains('primary'), disabled: button.disabled, box: box(button) }));
       const details = [...modal.querySelectorAll('.apps-share-scan-action')].find((button) => button.textContent.includes('Details'));
       let expanded;
       if (details) {
         details.click();
         await new Promise((resolve) => setTimeout(resolve, 100));
         expanded = { findings: modal.querySelectorAll('.apps-share-scan-detail .apps-scan-finding').length, ariaExpanded: details.getAttribute('aria-expanded') };
       }
       const indicator = modal.querySelector('.ui-tabs-indicator');
       const selectedTab = modal.querySelector('.ui-tab[aria-selected=true]');
       return {
         modal: box(modal),
         header: box(header),
         headerText: header.textContent,
         headerBorder: getComputedStyle(header).borderBottomWidth,
         badge: box(modal.querySelector('.apps-share-subject-badge')),
         tile: box(modal.querySelector('.apps-share-subject-icon')),
         body: box(body),
         footer: box(footer),
         footerBorder: getComputedStyle(footer).borderTopWidth,
         footerButtons,
         bodyPrimary: body.querySelectorAll('button.primary, .apps-button.primary').length,
         accountControl: modal.querySelectorAll('[aria-label="GitHub account"]').length,
         destination: box(modal.querySelector('.apps-share-destination')),
         chip: box(modal.querySelector('.apps-share-destination .dd-trigger')),
         chipText: modal.querySelector('.apps-share-destination .dd-trigger')?.textContent,
         slash: box(modal.querySelector('.apps-share-slash')),
         input: box(modal.querySelector('.apps-share-name')),
         inputValue: modal.querySelector('.apps-share-name')?.value,
         nameStatus: modal.querySelector('.apps-share-status')?.textContent,
         tabs: modal.querySelectorAll('.apps-share-visibility .ui-tab').length,
         tabsBox: box(modal.querySelector('.apps-share-visibility')),
         indicator: box(indicator),
         selectedTab: box(selectedTab),
         selectedTabText: selectedTab?.textContent,
         visibilityDetail: modal.querySelector('.apps-share-section .apps-share-detail')?.textContent,
         scanText: modal.querySelector('.apps-share-scan-text')?.textContent,
         expanded,
         link: modal.querySelector('.apps-share-link')?.textContent,
         linkActions: [...modal.querySelectorAll('.apps-share-link-action')].map((element) => element.textContent.trim()),
         switchChecked: modal.querySelector('[role=switch]')?.getAttribute('aria-checked'),
         steps: modal.querySelectorAll('.apps-step.done').length,
         viewport: window.innerHeight,
       };
     })()\`;
     app.whenReady().then(async () => {
       const results = {};
       for (const state of ${JSON.stringify(STATES)}) {
         const win = new BrowserWindow({ show: false, width: 900, height: 700, useContentSize: true });
         await win.loadFile(path.join(__dirname, 'index.html'), { query: { state } });
         results[state] = await win.webContents.executeJavaScript(measure);
         const rectangle = results[state].modal;
         const image = await win.webContents.capturePage({ x: rectangle.left - 24, y: rectangle.top - 24, width: rectangle.width + 48, height: rectangle.height + 48 });
         fs.writeFileSync(path.join(__dirname, state + '.png'), image.toPNG());
         win.destroy();
       }
       console.log(JSON.stringify(results));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const results = JSON.parse(line);
    for (const state of STATES) {
      const result = results[state];
      const detail = JSON.stringify(result);
      check(`${state}: the popup fits the window`, result.modal.bottom <= result.viewport, detail);
      check(`${state}: the header names the app`, result.headerText.includes('Share Feedback pins'), result.headerText);
      check(`${state}: the header shows the version`, result.headerText.includes('1.2.0'), result.headerText);
      check(`${state}: the GitHub mark sits on the app tile`, result.badge.right > result.tile.left && result.badge.left < result.tile.right + 8, detail);
      check(`${state}: the header has the 1px line`, result.headerBorder === '1px', result.headerBorder);
      check(`${state}: the footer has the 1px line`, result.footerBorder === '1px', result.footerBorder);
      check(`${state}: nothing primary floats in the body`, result.bodyPrimary === 0, String(result.bodyPrimary));
      const primary = result.footerButtons.filter((button) => button.primary);
      check(`${state}: one primary action, in the footer`, primary.length === 1, JSON.stringify(result.footerButtons));
      check(`${state}: the primary action is last, at the footer's right`, result.footerButtons.at(-1)?.primary === true, JSON.stringify(result.footerButtons));
      check(`${state}: the footer actions sit at the right`, result.footer.right - result.footerButtons.at(-1).box.right <= 20, detail);
    }
    for (const state of ['default', 'public', 'problems']) {
      const result = results[state];
      const detail = JSON.stringify(result);
      check(
        `${state}: Cancel sits beside the primary action`,
        result.footerButtons.length === 2 && result.footerButtons[0].text === 'Cancel',
        JSON.stringify(result.footerButtons),
      );
      check(`${state}: no account control for one account`, result.accountControl === 0, String(result.accountControl));
      check(
        `${state}: the owner chip is inside the destination`,
        result.chip.top >= result.destination.top && result.chip.bottom <= result.destination.bottom,
        detail,
      );
      check(`${state}: the chip shows the owner`, result.chipText.includes('octocat'), result.chipText);
      check(`${state}: owner, "/", name in that order`, result.chip.right <= result.slash.left && result.slash.right <= result.input.left, detail);
      check(`${state}: the name fills the rest of the field`, result.destination.right - result.input.right <= 8, detail);
      check(`${state}: the destination is one compact field`, result.destination.height <= 34, String(result.destination.height));
      check(`${state}: two visibility segments`, result.tabs === 2, String(result.tabs));
      check(`${state}: the segmented control is compact`, result.tabsBox.height <= 30 && result.tabsBox.width <= 200, JSON.stringify(result.tabsBox));
      check(
        `${state}: the pill covers the chosen segment`,
        Math.abs(result.indicator.left - result.selectedTab.left) <= 2 && result.indicator.width > 20,
        detail,
      );
    }
    const { default: initial, public: open, problems, success } = results;
    // The problems state is measured with its findings expanded, so only the closed states are held to the compact height.
    check('default: the popup stays compact', initial.modal.height <= 420, String(initial.modal.height));
    check('public: the popup stays compact', open.modal.height <= 420, String(open.modal.height));
    check('default: private is chosen', initial.selectedTabText === 'Private', initial.selectedTabText);
    check('default: the name is prefilled from the app id', initial.inputValue === 'feedback-pins', initial.inputValue);
    check('default: the name is available', initial.nameStatus.includes('Available'), initial.nameStatus);
    check('default: private explains who installs it', /Load App From GitHub/.test(initial.visibilityDetail), initial.visibilityDetail);
    check('default: the scan is one clean row', initial.scanText === 'No secrets found in 14 files', initial.scanText);
    check(
      'default: the action shares privately',
      initial.footerButtons.at(-1).text === 'Share privately' && !initial.footerButtons.at(-1).disabled,
      JSON.stringify(initial.footerButtons),
    );
    check('public: public is chosen', open.selectedTabText === 'Public', open.selectedTabText);
    check('public: the line says it adds the MIT license', /Adds an MIT license/.test(open.visibilityDetail), open.visibilityDetail);
    check('public: the action shares publicly', open.footerButtons.at(-1).text === 'Share publicly', JSON.stringify(open.footerButtons));
    check('problems: an existing name is said inline', /already exists/.test(problems.nameStatus), problems.nameStatus);
    check('problems: the scan row counts the findings', problems.scanText === '2 possible secrets found', problems.scanText);
    check(
      'problems: Details expands to the findings',
      problems.expanded?.findings === 2 && problems.expanded.ariaExpanded === 'true',
      JSON.stringify(problems.expanded),
    );
    check('problems: Share is disabled', problems.footerButtons.at(-1).disabled === true, JSON.stringify(problems.footerButtons));
    check('success: the link names the repository', success.link === 'octocat/feedback-pins', success.link);
    check(
      'success: Copy link and Invite people',
      JSON.stringify(success.linkActions) === JSON.stringify(['Copy link', 'Invite people']),
      JSON.stringify(success.linkActions),
    );
    check('success: the update switch is on', success.switchChecked === 'true', String(success.switchChecked));
    check('success: every step is done', success.steps === 4, String(success.steps));
    check(
      'success: Done ends it, without Cancel',
      success.footerButtons.length === 1 && success.footerButtons[0].text === 'Done',
      JSON.stringify(success.footerButtons),
    );
  }
  if (failures.length) {
    console.error(`share-app-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`share-app-layout: ${checked} passed  [real layout; screenshots in node_modules/.stacki-test/share-app-layout/]`);
})();
