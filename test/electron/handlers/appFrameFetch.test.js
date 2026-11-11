// An app reads its own bundle files with fetch (docs/apps.md, "The sandbox").
//
//   npx electron test/electron/handlers/appFrameFetch.test.js
//
// Goal: an app document, served from `stacki-app://<id>/` under its sandboxing
// content security policy, is an opaque origin, so `fetch('config.json')` is a
// cross-origin request that arrives with `Origin: null`. It must succeed: the
// scheme is registered `corsEnabled` and the files are answered with
// `Access-Control-Allow-Origin: *`.
//
// Methodology: run under the Electron binary, register the scheme with the
// privileges main.ts registers (APP_SCHEME_PRIVILEGES), serve a fixture project
// through the real serveAppRequest, load the app's page in a hidden window, and
// read what its script fetched, with its own origin, which proves the fetch was
// cross-origin (`null`), not a same-origin read.

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

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>loading</title></head>
<body><script src="app.js"></script></body></html>`;
const SCRIPT = `fetch('config.json')
  .then((response) => response.json())
  .then((config) => { document.title = 'fetched:' + config.greeting + ':' + self.origin; })
  .catch((error) => { document.title = 'failed:' + error.message; });`;

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-fetch-'));
  const bundle = path.join(root, '.stacki', 'apps', 'fetcher');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'index.html'), PAGE);
  fs.writeFileSync(path.join(bundle, 'app.js'), SCRIPT);
  fs.writeFileSync(path.join(bundle, 'config.json'), JSON.stringify({ greeting: 'hello' }));
  const manifest = { manifestVersion: 1, id: 'fetcher', name: 'Fetcher', version: '1.0.0', entry: 'index.html' };
  fs.writeFileSync(path.join(bundle, 'stacki-app.json'), JSON.stringify(manifest));
  const lock = {
    version: 1,
    apps: [
      {
        id: 'fetcher',
        version: '1.0.0',
        sha256: '0'.repeat(64),
        installedAt: '2026-01-01T00:00:00.000Z',
        source: { kind: 'file', fileName: 'fetcher.zip' },
        update: undefined,
        autoUpdate: false,
      },
    ],
  };
  fs.writeFileSync(path.join(root, '.stacki', 'apps', 'apps.json'), serializeAppsLock(lock));
  return root;
}

async function titleOnceSettled(window) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const title = window.webContents.getTitle();
    if (title !== 'loading' && title !== '') {
      return title;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return window.webContents.getTitle();
}

app.whenReady().then(async () => {
  const root = fixtureProject();
  protocol.handle(APP_SCHEME, (request) => serveAppRequest(request.url, root));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadURL(`${APP_SCHEME}://fetcher/index.html`);
    const title = await titleOnceSettled(window);
    // The page's own origin is `null`: the fetch was cross-origin, and CORS let it through.
    check('the opaque-origin app fetched its own config.json', title === 'fetched:hello:null', title);
    const direct = serveAppRequest(`${APP_SCHEME}://fetcher/config.json`, root);
    check(
      'bundle files allow any origin',
      direct.headers.get('access-control-allow-origin') === '*',
      String(direct.headers.get('access-control-allow-origin')),
    );
    const missing = serveAppRequest(`${APP_SCHEME}://fetcher/absent.json`, root);
    check('a missing file is still a 404', missing.status === 404, String(missing.status));
  } finally {
    window.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`app frame fetch: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    app.exit(1);
    return;
  }
  console.log(`app frame fetch: ${checked} checks passed`);
  app.exit(0);
});
