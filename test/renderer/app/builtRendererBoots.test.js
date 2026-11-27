// The built app starts: the renderer bundle that ships runs every module and paints its first real frame.
//
//   node test/renderer/app/builtRendererBoots.test.js
//
// Why: an import cycle between two icon modules was harmless until one of them read the other's export while loading.
// The production bundle then threw "Cannot access … before initialization" before React started, so the app opened
// blank. Every suite passed: those that bundle with esbuild turn the early read into `undefined`, and the soaks load
// the renderer from Vite's development server, which orders modules differently from the shipped file.
//
// Method: the real built app (dist/electron/main.js with dist/renderer, which `npm test` builds) is started with no
// project, a temporary user data folder, the mock keychain and a hidden window. This file is also its preload, which
// waits for the renderer's own report that its shell has painted (`boot:first-frame`, preload/preloadBridge.ts) and
// collects every error the page logs. The report must arrive, with no error.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const LIMITS = { bootMsMax: 60_000, errorsMax: 20, errorCharsMax: 600 };

function probe() {
  const { app, ipcMain } = require('electron');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-built-boot-'));
  app.setPath('userData', userData);
  const errors = [];
  let finished = false;
  const finish = (painted) => {
    if (finished) {
      return;
    }
    finished = true;
    process.stdout.write(`RESULT ${JSON.stringify({ painted, errors })}\n`);
    app.exit(0);
  };
  const note = (text) => {
    if (errors.length < LIMITS.errorsMax) {
      errors.push(String(text).slice(0, LIMITS.errorCharsMax));
    }
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => {
      if (event.level === 'error') {
        note(event.message);
        // An error the page never caught means no frame is coming: report it now, not at the bound.
        if (event.message.startsWith('Uncaught')) {
          finish(false);
        }
      }
    });
    contents.on('render-process-gone', (_gone, details) => note(`the renderer process ended: ${details.reason}`));
  });
  ipcMain.on('boot:first-frame', () => finish(true));
  setTimeout(() => finish(false), LIMITS.bootMsMax).unref();
}

function main() {
  const { runElectronProbe } = require('../../helpers/electronProbe.js');
  if (!fs.existsSync(repoPath('dist/renderer/index.html'))) {
    console.error('builtRendererBoots: dist/renderer is not built (run `npx vite build`; `npm test` builds it)');
    process.exit(1);
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // The shipped renderer, never a development server someone has running.
  delete environment.VITE_DEV_SERVER_URL;
  const argumentsList = ['-r', repoPath('test/helpers/hiddenFlowPreload.js'), '-r', __filename, repoPath('dist/electron/main.js'), '--use-mock-keychain'];
  const run = runElectronProbe(require('electron'), argumentsList, { env: environment });
  const line = String(run.stdout)
    .split('\n')
    .find((text) => text.startsWith('RESULT '));
  if (line === undefined) {
    console.error(`builtRendererBoots: the app gave no result (status ${run.status})\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
  }
  const result = JSON.parse(line.slice('RESULT '.length));
  if (!result.painted || result.errors.length > 0) {
    console.error(`builtRendererBoots: the built app ${result.painted ? 'logged errors' : 'never painted its first frame'}\n  ${result.errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log('builtRendererBoots: the built app painted its first frame with no error');
}

if (process.versions.electron !== undefined && process.type === 'browser') {
  probe();
} else {
  main();
}
