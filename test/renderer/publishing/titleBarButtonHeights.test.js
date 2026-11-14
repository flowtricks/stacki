// Goal: the Play (preview) button in the title bar is exactly as tall as the Publish split button and the branch chip beside it,
// in the wide bar and in a narrow one, and lit (blue) or not. They share one height, --titlebar-control-height, so a change to
// it moves all of them together; this pins that nobody gives one of them a height of its own again (Play was a separate 28px
// and stood taller than Publish).
// Method: jsdom has no layout, so this bundles the real TitleActions and DesktopPublishButton for the browser, mounts them in
// one `.titlebar` under the app's real stylesheets in a hidden Chromium window (as branchChipLook.test.js does), and compares
// getBoundingClientRect heights. It reads boxes only: no hover or pointer is involved, so it holds on Windows and Linux too.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

const SHEETS = [
  'src/features/style/tokens.css',
  'src/app/styles.css',
  'src/ui/popup.css',
  'src/ui/skeleton.css',
  'src/features/publishing/publishing.css',
  'src/features/git/branchIndicator.css',
];

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { TitleActions } from ${JSON.stringify(repoPath('src/app/shell/AppShell.tsx'))};
import { DesktopPublishButton } from ${JSON.stringify(repoPath('src/app/shell/DesktopPublishButton.tsx'))};

const params = new URLSearchParams(location.search);
const info = { isRepo: true, branch: 'main', branches: ['main'], remote: 'https://github.com/example/site.git', dirty: false, ahead: 0, parked: [], head: 'abc', trunk: 'main', defaultBranch: 'main' };
window.avb = {
  projectMetadata: async () => ({ ok: true, value: {} }),
  publishAvailability: async () => ({ github: 'pending', hosting: 'unconfigured' }),
  publishState: async () => ({ kind: 'idle' }),
  publishStart: async () => ({ kind: 'done', github: true, hosting: false }),
  gitInfo: async () => info,
  onFsChanged: () => () => {},
  onAssetsChanged: () => () => {},
  onCmsChanged: () => () => {},
  onCssChanged: () => () => {},
};
const app = { devUrl: 'http://localhost:4321', inPreview: params.get('preview') === 'on', previewRef: undefined, termOpen: false };
createRoot(document.getElementById('root')).render(
  <div className="titlebar" style={{ width: Number(params.get('width')) }}>
    <span className="spacer" />
    <TitleActions app={app} />
    <DesktopPublishButton projectPath="/project" flushSave={async () => {}} refresh={async () => {}} saveState={undefined} repository={info} onOpenBranches={() => {}} />
  </div>,
);
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 300, backgroundColor: '#191919' });
  const out = {};
  for (const [name, query] of Object.entries({ wide: 'width=760', wideLit: 'width=760&preview=on', narrow: 'width=360', narrowLit: 'width=360&preview=on' })) {
    await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?' + query);
    await sleep(700);
    out[name] = await win.webContents.executeJavaScript(\`(() => {
      const height = (element) => (element ? element.getBoundingClientRect().height : -1);
      return {
        play: height(document.querySelector('.preview-btn')),
        publishMain: height(document.querySelector('.stacki-publish-main > button')),
        publishArrow: height(document.querySelector('.stacki-publish-arrow')),
        publishSplit: height(document.querySelector('.stacki-publish-split')),
        chip: height(document.querySelector('.stacki-branch-chip')),
        token: getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('--titlebar-control-height').trim(),
      };
    })()\`);
  }
  console.log(JSON.stringify(out));
  app.quit();
});`;

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('title-bar-button-heights: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/title-bar-button-heights');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, ENTRY);
  buildSync({
    entryPoints: [entry],
    outfile: path.join(directory, 'entry.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    `<!doctype html><meta charset=utf-8>${SHEETS.map((file) => `<link rel="stylesheet" href="file://${path.join(ROOT, file)}">`).join('')}<style>body{margin:0;background:#191919}*,*::before,*::after{transition:none!important;animation:none!important}.titlebar{margin:24px}</style><div id="root"></div><script defer src="entry.js"></script>`,
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  // The variable must be absent, not empty: on Windows an empty value still counts as set and Electron then
  // runs as plain Node, where `app` is undefined.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], { encoding: 'utf8', timeout: 120000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const result = JSON.parse(line);
    for (const [name, heights] of Object.entries(result)) {
      const detail = `${name}: ${JSON.stringify(heights)}`;
      check(`${name}: Play is as tall as the Publish button`, heights.play > 0 && heights.play === heights.publishMain, detail);
      check(`${name}: Play is as tall as the Publish chevron`, heights.play === heights.publishArrow, detail);
      check(`${name}: Play is as tall as the whole split`, heights.play === heights.publishSplit, detail);
      check(`${name}: the branch chip is the same height too`, heights.chip === heights.play, detail);
      check(`${name}: they share the one height token`, heights.token === '1.5rem', detail);
    }
  }
  if (failures.length) {
    console.error(`title-bar-button-heights: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`title-bar-button-heights: ${checked} passed`);
})();
