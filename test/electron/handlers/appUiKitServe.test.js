// The UI kit is served from inside every app's origin (docs/apps.md, "Look and feel").
//
//   npx electron test/electron/handlers/appUiKitServe.test.js
//
// Goal: in a real app frame, sandboxed and opaque-origin under the app's content
// security policy, `__stacki/ui.css` and `__stacki/ui.js` load from the app's own
// `stacki-app://<id>/` origin, so a primary button inside `.stacki-ui` takes the
// editor's accent and radius and the kit's custom elements render the editor's components; a page that links nothing still reads the
// injected tokens (`var(--stacki-accent)`); the frame can fetch the kit like any
// of its own files; a reserved path the kit has no file for is a 404; and a file
// placed by hand in the app's own `__stacki/` folder stops the folder being served.
//
// Methodology: run under the Electron binary, register the scheme with the
// privileges main.ts registers (APP_SCHEME_PRIVILEGES), serve a fixture project
// through the real serveAppRequest, and load a host page whose sandboxed iframe
// (the sandbox AppFrame.tsx gives) loads the app. The app posts what it measured
// to its parent, which puts it in the window title for the test to read.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, protocol } = require('electron');

const { APP_SCHEME, APP_SCHEME_PRIVILEGES, serveAppRequest } = require('#dist/electron/handlers/appsHandlers.js');
const { serializeAppsLock } = require('#dist/shared/properties/apps.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
app.on('window-all-closed', () => {});

const KIT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>kit</title>
<link rel="stylesheet" href="__stacki/ui.css">
<script src="__stacki/ui.js"></script>
</head>
<body>
<div class="stacki-ui"><button class="primary" id="primary">Add</button></div>
<stacki-switch label="Pins" checked></stacki-switch>
<script src="probe.js"></script>
</body></html>`;
const PLAIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>plain</title>
<style>#mark { color: var(--stacki-accent); }</style>
</head><body><p id="mark">tokens only</p><script src="plain.js"></script></body></html>`;
const PROBE = `window.addEventListener('load', async () => {
  const primary = getComputedStyle(document.getElementById('primary'));
  const fetched = await fetch('__stacki/ui.js').then((response) => response.status, (error) => String(error));
  const missing = await fetch('__stacki/absent.css').then((response) => response.status, (error) => String(error));
  parent.postMessage({
    origin: self.origin,
    background: primary.backgroundColor,
    radius: primary.borderTopLeftRadius,
    upgraded: Boolean(customElements.get('stacki-dropdown')),
    switchRole: document.querySelector('stacki-switch button') && document.querySelector('stacki-switch button').getAttribute('role'),
    fetched, missing,
  }, '*');
});`;
const PLAIN = `parent.postMessage({ mark: getComputedStyle(document.getElementById('mark')).color, tokens: Boolean(document.querySelector('style[data-stacki-tokens]')) }, '*');`;

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-kit-'));
  const bundle = path.join(root, '.stacki', 'apps', 'kit');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'stacki-app.json'), JSON.stringify({ manifestVersion: 1, id: 'kit', name: 'Kit', version: '1.0.0', entry: 'index.html' }));
  fs.writeFileSync(path.join(bundle, 'index.html'), KIT_PAGE);
  fs.writeFileSync(path.join(bundle, 'plain.html'), PLAIN_PAGE);
  fs.writeFileSync(path.join(bundle, 'probe.js'), PROBE);
  fs.writeFileSync(path.join(bundle, 'plain.js'), PLAIN);
  const lock = {
    version: 1,
    apps: [
      {
        id: 'kit',
        version: '1.0.0',
        sha256: '0'.repeat(64),
        installedAt: '2026-01-01T00:00:00.000Z',
        source: { kind: 'file', fileName: 'kit.zip' },
        update: undefined,
        autoUpdate: false,
      },
    ],
  };
  fs.writeFileSync(path.join(root, '.stacki', 'apps', 'apps.json'), serializeAppsLock(lock));
  return root;
}

// The editor's side: a page with one sandboxed app frame, which reports by postMessage.
function hostPage(directory, appURL) {
  const file = path.join(directory, `host-${path.basename(appURL)}`);
  fs.writeFileSync(
    file,
    `<!doctype html><title>loading</title><iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" src="${appURL}"></iframe>
     <script>addEventListener('message', (event) => { document.title = 'report:' + JSON.stringify(event.data); });</script>`,
  );
  return file;
}

async function report(window) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const title = window.webContents.getTitle();
    if (title.startsWith('report:')) {
      return JSON.parse(title.slice('report:'.length));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { timedOut: window.webContents.getTitle() };
}

app.whenReady().then(async () => {
  const root = fixtureProject();
  protocol.handle(APP_SCHEME, (request) => serveAppRequest(request.url, root));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadFile(hostPage(root, `${APP_SCHEME}://kit/index.html`));
    const kit = await report(window);
    check('the app frame is an opaque origin', kit.origin === 'null', JSON.stringify(kit));
    check('ui.css styles the editor button in the accent', kit.background === 'rgb(0, 153, 255)', JSON.stringify(kit));
    check('with the editor radius', kit.radius === '8px', JSON.stringify(kit));
    check('ui.js defines the custom elements', kit.upgraded === true, JSON.stringify(kit));
    check('and upgrades the switch', kit.switchRole === 'switch', JSON.stringify(kit));
    check('the frame fetches ui.js from its own origin', kit.fetched === 200, JSON.stringify(kit));
    check('a reserved path with no kit file is a 404', kit.missing === 404, JSON.stringify(kit));

    await window.loadFile(hostPage(root, `${APP_SCHEME}://kit/plain.html`));
    const plain = await report(window);
    check('a page that links nothing has the tokens injected', plain.tokens === true, JSON.stringify(plain));
    check('so var(--stacki-accent) resolves', plain.mark === 'rgb(0, 153, 255)', JSON.stringify(plain));

    const css = serveAppRequest(`${APP_SCHEME}://kit/__stacki/ui.css`, root);
    check('ui.css is served as CSS', (css.headers.get('content-type') ?? '').startsWith('text/css'), String(css.headers.get('content-type')));
    check(
      'under the app policy',
      (css.headers.get('content-security-policy') ?? '').startsWith('sandbox '),
      String(css.headers.get('content-security-policy')),
    );

    // What a bundle can never ship (the bundle checker refuses it), placed by hand: the folder no longer runs at all.
    const planted = path.join(root, '.stacki', 'apps', 'kit', '__stacki');
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, 'ui.css'), 'body { background: red; }');
    const refused = serveAppRequest(`${APP_SCHEME}://kit/__stacki/ui.css`, root);
    check('a folder holding its own __stacki/ is not served', refused.status === 404, String(refused.status));
  } finally {
    window.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`app UI kit serving: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    app.exit(1);
    return;
  }
  console.log(`app UI kit serving: ${checked} checks passed`);
  app.exit(0);
});
