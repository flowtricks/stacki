// Goal: the Electron side of the style-panel soak. It starts the app exactly as `npm run dev`
// does (dist/electron/main.js, renderer from VITE_DEV_SERVER_URL), with the fixture project
// reopened, and hands the main window to the scenario module named in STACKI_SOAK_SCENARIO.
//
// Method: an isolated user-data directory, set before the app is ready, so nothing of a
// person's own Stacki (recents, settings, the project they have open) is read or written; the
// dev reopen file main.ts reads on the renderer's first `project:pending` names the fixture.
// The window is sized for a repeatable layout and kept painting while it is behind other
// windows, because a throttled background window would hold back the very frames the
// recorder watches. The scenario's resolved value is the exit code.

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { repoPath } = require('../sources.js');

const WINDOW_WIDTH_PX = 1440;
const WINDOW_HEIGHT_PX = 900;
const WINDOW_WAIT_MS_MAX = 60000;
const WINDOW_POLL_MS = 100;

const { app, BrowserWindow } = electron;
const project = process.env.STACKI_SOAK_PROJECT ?? '';
const userData = process.env.STACKI_SOAK_USER_DATA ?? '';
const scenarioModule = process.env.STACKI_SOAK_SCENARIO ?? '';
if (project.length === 0 || userData.length === 0 || scenarioModule.length === 0) {
  throw new Error('electronEntry: STACKI_SOAK_PROJECT, STACKI_SOAK_USER_DATA and STACKI_SOAK_SCENARIO are required');
}
app.setPath('userData', userData);
fs.writeFileSync(path.join(userData, 'dev-reopen.json'), JSON.stringify({ path: project }), 'utf8');

async function mainWindow() {
  for (let waitedMs = 0; waitedMs < WINDOW_WAIT_MS_MAX; waitedMs += WINDOW_POLL_MS) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window !== undefined) {
      return window;
    }
    await new Promise((resolve) => setTimeout(resolve, WINDOW_POLL_MS));
  }
  throw new Error('electronEntry: the main window never opened');
}

require(repoPath('dist/electron/main.js'));

app.whenReady().then(async () => {
  let code = 1;
  try {
    const window = await mainWindow();
    window.setContentSize(WINDOW_WIDTH_PX, WINDOW_HEIGHT_PX);
    window.webContents.setBackgroundThrottling(false);
    const options = JSON.parse(process.env.STACKI_SOAK_OPTIONS ?? '{}');
    const scenario = require(scenarioModule);
    code = await scenario.runInElectron({ window, project, options });
  } catch (error) {
    console.error('[soak] the run failed:', error);
    code = 1;
  }
  app.exit(code);
});
