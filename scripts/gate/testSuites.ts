// The test suites that need something unusual, keyed by repository path. Every
// other `*.test.js` and `*.test.ts` under test/ runs as `node <file>` in the
// shared pool (testDiscovery.ts finds them). A key that names no test file is
// an error, so this list cannot go stale; the move tool rewrites its keys when
// a test moves.

export interface SuiteOptions {
  // `alone`: after the pool, one at a time, with nothing else running. For
  // suites that measure timing or drive a real window.
  readonly phase?: 'alone';
  // Why a failure is tolerated: the gate reports it and passes. Every entry
  // says what makes it flaky, so it can be fixed rather than forgotten.
  readonly flaky?: string;
  // `electron`: run under the Electron binary rather than Node.
  readonly runner?: 'electron';
  // Flags for Node before the file.
  readonly nodeArguments?: readonly string[];
  // `renderer`: reads the renderer bundle (dist/renderer), so a run that names
  // this suite builds it. The full gate always builds it (gatePlan.ts).
  readonly build?: 'renderer';
}

// Node warns when it reads a typeless .ts module as ESM; the suites that load
// one through esbuild's output would print it on every run.
const QUIET_TYPELESS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];

export const TEST_SUITES: Readonly<Record<string, SuiteOptions>> = {
  'test/electron/preload/hoverCost.test.js': {
    phase: 'alone',
    flaky: 'measures hover cost in milliseconds; a loaded machine can miss the budget',
  },
  'test/renderer/style/popoverDropdown.test.js': {
    phase: 'alone',
    flaky: 'drives a real window, whose focus another window can take',
  },
  // A stylesheet read that starts before an edit can land after it under load
  // and restore the old value; until that race is understood, it runs where
  // its timing assumptions hold.
  'test/renderer/style/selectorWell.test.js': { phase: 'alone' },
  'test/electron/project/thumbs.test.js': { phase: 'alone', runner: 'electron' },
  // Loads an app page over the real `stacki-app:` scheme, which only Electron has.
  'test/electron/handlers/appFrameFetch.test.js': { runner: 'electron' },
  // Loads the UI kit inside an app frame over the real `stacki-app:` scheme, which only Electron has.
  'test/electron/handlers/appUiKitServe.test.js': { runner: 'electron' },
  // Samples pixels around an overlay frame composited by real Chromium, which only Electron has.
  'test/electron/handlers/appFrameTransparency.test.js': { runner: 'electron' },
  'test/scripts/build/buildLayout.test.ts': { build: 'renderer' },
  'test/renderer/app/viteModules.test.ts': { nodeArguments: ['--experimental-vm-modules'] },
  'test/renderer/content/contentFields.test.js': { nodeArguments: QUIET_TYPELESS },
  'test/renderer/variables/fluid.test.js': { nodeArguments: QUIET_TYPELESS },
};
