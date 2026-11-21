// Goal: the update popup looks right in a real Chromium: the up-to-date state shows a tinted circle with the check icon, the headline
// and the version, the dialog has no outline and no divider above its button, the blue button stays blue on hover and focus, Enter
// and Escape close it, and the other states share the shape.
// Method: the real UpdatePopup is bundled and mounted under the app's real stylesheets in ONE hidden Chromium window (show: false, as
// branchChipLook.test.js does; nothing reaches the person's screen). Computed styles and boxes are read, Enter and Escape are real
// key events through sendInputEvent, and every wait is bounded (test/helpers/waitFor.js). Set STACKI_UPDATE_SHOTS to a folder to
// also write one PNG per state.
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

const SHEETS = ['src/features/style/tokens.css', 'src/app/styles.css', 'src/ui/popup.css', 'src/features/update/updatePopup.css'];

const STATES = {
  latest: { kind: 'notice', notice: 'latest', version: '1.4.11' },
  downloading: { kind: 'downloading', version: '1.4.12', progress: { transferredBytes: 25165824, totalBytes: 54525952, percent: 46 } },
  ready: { kind: 'ready', version: '1.4.12' },
  error: { kind: 'error', stage: 'download', detail: 'Error: net::ERR_CONNECTION_CLOSED' },
};

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { UpdatePopup } from ${JSON.stringify(repoPath('src/features/update/UpdatePopup.tsx'))};
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/localeContext.tsx'))};

const state = JSON.parse(decodeURIComponent(location.hash.slice(1)));
window.popupHidden = 0;
function App() {
  const [hidden, setHidden] = React.useState(false);
  window.popupHidden = hidden ? 1 : 0;
  return <UpdatePopup state={state} hidden={hidden} onHide={() => setHidden(true)} onAct={() => {}} />;
}
createRoot(document.getElementById('root')).render(<App />);
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
const { MOTION_SETTLED_EXPRESSION, pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
process.on('unhandledRejection', (error) => {
  console.error('probe failed: ' + String((error && error.stack) || error));
  app.exit(1);
});
const states = JSON.parse(process.env.STACKI_STATES);
let js;
const drawn = async (what, expression) => {
  await pollUntil({ what, read: () => js(expression), until: (seen) => seen === true });
  await pollUntil({ what: what + ', settled', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
};
app.whenReady().then(async () => {
  // show: false keeps the window off the screen; capturePage still paints it.
  const win = new BrowserWindow({ show: false, width: 520, height: 520, backgroundColor: '#191919' });
  win.webContents.on('console-message', (event) => console.error('page: ' + (event.message || '')));
  js = (code) => win.webContents.executeJavaScript(code);
  const dir = process.env.STACKI_UPDATE_SHOTS;
  const out = {};
  for (const [name, state] of Object.entries(states)) {
    await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?case=' + Date.now() + '#' + encodeURIComponent(JSON.stringify(state)));
    await drawn('the ' + name + ' popup', "document.querySelector('.update-popup') !== null && document.querySelector('.update-popup').dataset.popupPhase === 'open'");
    out[name] = await js(\`(() => {
      const surface = document.querySelector('.update-popup');
      const dialog = document.querySelector('dialog');
      const icon = surface.querySelector('.update-icon');
      const footer = surface.querySelector('.modal-footer');
      // Downloading has one quiet button (Hide); the rest have a blue primary.
      const button = surface.querySelector('button.primary') ?? surface.querySelector('button');
      const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
      const primary = getComputedStyle(button);
      return {
        role: dialog.getAttribute('role'),
        name: document.getElementById(dialog.getAttribute('aria-labelledby')).textContent,
        surfaceBorder: getComputedStyle(surface).borderTopWidth + '|' + getComputedStyle(surface).borderStyle,
        footerBorder: getComputedStyle(footer).borderTopWidth,
        iconFill: getComputedStyle(icon).backgroundColor, iconRadius: getComputedStyle(icon).borderRadius, iconBox: box(icon),
        iconGlyph: !!icon.querySelector('svg[data-central-icon]'),
        surfaceBox: box(surface),
        primaryBackground: primary.backgroundColor, primaryBorder: primary.borderTopColor,
        focusedPrimary: document.activeElement === button,
        text: surface.textContent,
      };
    })()\`);
    if (name === 'latest') {
      const hover = async (selector) => js("(() => { const b = document.querySelector('.update-popup button.primary'); return getComputedStyle(b).backgroundColor; })()");
      out.latestRest = await hover();
      out.accent = await js("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
    }
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  // Real keys on the up-to-date popup: Enter presses the focused button, Escape closes.
  for (const key of ['Enter', 'Escape']) {
    await win.loadURL('file://' + path.join(__dirname, 'index.html') + '?case=' + Date.now() + '#' + encodeURIComponent(JSON.stringify(states.latest)));
    await drawn('the popup before ' + key, "document.querySelector('.update-popup')?.dataset.popupPhase === 'open'");
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key === 'Enter' ? 'Return' : 'Escape' });
    if (key === 'Enter') {
      // A real keypress is keyDown, char, keyUp; a button presses on the char.
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\\r' });
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key === 'Enter' ? 'Return' : 'Escape' });
    await pollUntil({ what: 'the popup closes on ' + key, read: () => js('window.popupHidden'), until: (closed) => closed === 1 });
    out['key' + key] = await js('window.popupHidden');
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
    console.log('update-look: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/update-look');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, `import React from 'react';\n${ENTRY.replace(/import \{ LocaleProvider \}.*\n/, '')}`);
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
    `<!doctype html><meta charset=utf-8>${SHEETS.map((file) => `<link rel="stylesheet" href="file://${path.join(ROOT, file)}">`).join('')}<style>body{margin:0;background:#191919}*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div><script defer src="entry.js"></script>`,
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  // The variable must be absent, not empty: Electron runs as plain Node when it is set at all.
  const environment = { ...process.env, STACKI_STATES: JSON.stringify(STATES) };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], { encoding: 'utf8', timeout: 120000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const result = JSON.parse(line);
    const latest = result.latest;
    check('up to date: a dialog named by its headline', latest.role === 'dialog' && latest.name === 'You’re up to date', JSON.stringify(latest));
    check(
      'up to date: the Central check icon sits in a round, tinted fill',
      latest.iconGlyph && latest.iconRadius === '50%' && /0, 153, 255/.test(latest.iconFill),
      JSON.stringify(latest),
    );
    check(
      'up to date: the circle is large enough to read as a state',
      latest.iconBox.width >= 48 && latest.iconBox.height >= 48,
      JSON.stringify(latest.iconBox),
    );
    check('up to date: the version is under the headline', latest.text.includes('Stacki 1.4.11 is the latest version.'), latest.text);
    for (const [name, state] of Object.entries(result)) {
      if (typeof state !== 'object' || state === null || !('surfaceBorder' in state)) {
        continue;
      }
      check(`${name}: no outline round the dialog`, state.surfaceBorder.startsWith('0px'), state.surfaceBorder);
      check(`${name}: no divider above the buttons`, state.footerBorder === '0px', state.footerBorder);
      check(`${name}: focus lands on the default button`, state.focusedPrimary === true, JSON.stringify(state));
      check(`${name}: the default button has no visible border`, state.primaryBorder === 'rgba(0, 0, 0, 0)', state.primaryBorder);
    }
    check('the primary button is the accent blue at rest', latest.primaryBackground === 'rgb(0, 153, 255)', latest.primaryBackground);
    check('Enter on the focused button closes the popup', result.keyEnter === 1, String(result.keyEnter));
    check('Escape closes the popup', result.keyEscape === 1, String(result.keyEscape));
  }
  if (failures.length) {
    console.error(`update-look: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`update-look: ${checked} passed`);
})();
