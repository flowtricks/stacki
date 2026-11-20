// Goal: the New style locations tab (Settings, src/app/settings/StyleTagSettings.tsx) never scrolls sideways at the
// widths the Settings dialog's content area takes. Each scope shows a row with the location dropdown, a code block
// and a caption; the page scope here holds a chosen stylesheet whose path is long and no longer exists (the warning
// chip), so the long label, the chip and the editor are all on screen at once. None of them may be wider than the
// scrolling area, and the area keeps `scrollbar-gutter: stable`.
//
//   node test/renderer/settings/newStyleLocationsChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays the tab out. A harness bundles the real tab with
// styles.css and settings.css behind a stubbed `window.avb` (the styles file and the project's stylesheet list) and
// is loaded in one window, resized to each width in turn. For each width the probe waits (polling once per animation
// frame, bounded) until the tab has drawn and its layout holds still for a frame, then reads the scroll area's
// scrollWidth and clientWidth and every descendant's right edge against the area's. Nothing waits a fixed time.
// Screenshots are written to node_modules/.stacki-test/new-style-locations-width/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS_PX = [560, 720, 960];
const LONG_FILE = 'src/styles/a-very-long-folder-name-that-keeps-going/another-long-folder-name/a-stylesheet-with-a-very-long-name-indeed.css';

const HARNESS = `
import { createRoot } from 'react-dom/client';
import './src/app/styles.css';
import './src/app/settings/settings.css';
import { StyleTagSettingsPage } from './src/app/settings/StyleTagSettings';

const tag = { version: 2, attributes: 'is:global', content: '@layer components {\\n}' };
let source = JSON.stringify({
  version: 1,
  keep: [],
  newStyleLocations: { version: 1, page: { use: 'file', file: '${LONG_FILE}', tag }, component: { use: 'tag', tag } },
});
window.avb = {
  projectMetadata: async () => ({ ok: true, value: { source } }),
  writeProjectMetadata: async (input) => ({ ok: true, value: { source: input.write.source } }),
  listStyleFiles: async () => ({ files: ['src/styles/global.css', 'src/styles/${'x'.repeat(0)}components.css'].map((rel) => ({ rel, name: rel, path: '/p/' + rel, size: 1 })) }),
};
createRoot(document.getElementById('root')).render(
  <div className="app-settings"><div className="app-settings-layout"><main className="app-settings-main">
    <div className="app-settings-scroll"><div className="app-settings-content"><div className="app-settings-panel"><StyleTagSettingsPage projectPath="/p" /></div></div></div>
  </main></div></div>,
);
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css">' +
  '<style>html,body{margin:0;background:#111}#root{height:900px}</style></head><body><div id="root"></div>' +
  '<script src="harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const WIDTHS = ${JSON.stringify(WIDTHS_PX)};
const MEASURE = \`new Promise((resolve) => {
  let frames = 0;
  let last = '';
  const step = () => {
    frames += 1;
    const body = document.querySelector('.app-settings-scroll');
    const shape = body === null ? '' : body.scrollWidth + 'x' + body.scrollHeight + ':' + body.clientWidth;
    if (body !== null && shape === last && document.fonts.status === 'loaded' && document.querySelector('.cm-editor') !== null && document.querySelector('.style-tags-chip') !== null) {
      const limit = body.getBoundingClientRect().right;
      const wide = [...body.querySelectorAll('*')]
        .filter((element) => element.getBoundingClientRect().right > limit + 0.5)
        .slice(0, 10)
        .map((element) => element.tagName.toLowerCase() + '.' + String(element.className).split(' ').join('.'));
      resolve({ scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, gutter: getComputedStyle(body).scrollbarGutter, wide });
      return;
    }
    last = shape;
    if (frames > 600) {
      resolve({ error: 'the dialog did not settle' });
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})\`;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ show: false, width: WIDTHS[0], height: 900, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(DIRECTORY, 'host.html'));
    for (const width of WIDTHS) {
      win.setContentSize(width, 900);
      const measured = await win.webContents.executeJavaScript(MEASURE);
      fs.writeFileSync(path.join(DIRECTORY, 'width-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      results.push({ width, ...measured });
    }
    console.log('RESULT ' + JSON.stringify({ results }));
  } catch (error) {
    console.log('RESULT ' + JSON.stringify({ error: String(error && error.stack || error) }));
  }
  app.exit(0);
});
`;

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('new-style-locations-width: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/new-style-locations-width');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  buildSync({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 16 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      for (const result of output.results) {
        if (result.error !== undefined) {
          failures.push(`${result.width}px: ${result.error}`);
          continue;
        }
        if (result.scrollWidth > result.clientWidth) {
          failures.push(`${result.width}px: the tab scrolls sideways (scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth})`);
        }
        if (result.wide.length > 0) {
          failures.push(`${result.width}px: wider than the scroll area: ${result.wide.join(', ')}`);
        }
        if (result.gutter !== 'stable') {
          failures.push(`${result.width}px: the scroll area keeps scrollbar-gutter: stable (it is ${result.gutter})`);
        }
      }
    }
  }
  if (failures.length > 0) {
    console.error(`new-style-locations-width: ${failures.length} checks failed\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`new-style-locations-width: passed  [screenshots in ${directory}]`);
  }
})();
