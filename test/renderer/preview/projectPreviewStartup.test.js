// Goal: opening a project stays in loading until preview startup reaches a final outcome.
// Method: mount the real navigation/start hooks and hold scanning and startup independently;
// verify loading precedes the scan and final success/failure still controls the preview.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test('project opening starts the preview before waiting for scanning', async () => {
  const directory = repoPath('node_modules/.stacki-test/project-preview-startup');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'hooks.cjs');
  esbuild.buildSync({
    stdin: {
      contents: [
        `export {useSelectPage} from ${sourceSpecifier('src/app/state/appNavigation.ts')};`,
        `export {usePreviewStart} from ${sourceSpecifier('src/app/state/appLifecycle.ts')};`,
      ].join('\n'),
      resolveDir: repoPath('src'),
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useSelectPage, usePreviewStart } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const events = [];
  let scan;
  let startup;
  let open;
  let status;
  let url;
  window.avb = {
    addRecent: async () => ({ ok: true }),
    watchProject: async () => {
      events.push('watch');
      return { ok: true };
    },
    startDevServer: () => {
      events.push('start');
      return startup.promise;
    },
  };
  function Harness() {
    const [devStatus, setDevStatus] = React.useState('off');
    const [devUrl, setDevUrl] = React.useState(undefined);
    status = devStatus;
    url = devUrl;
    const core = {
      devLogRef: React.useRef(''),
      setDevStatus,
      setDevUrl,
      setBusy() {},
      setDevDiag() {},
      setDevLog() {},
      setTrailingSlash() {},
      setDevice() {},
      setLeftTab() {},
      setProject() {},
    };
    const toasts = { showToast: (message) => events.push(message) };
    const preview = usePreviewStart(core, toasts, { diagnose: () => events.push('diagnose') });
    const navigation = useSelectPage(
      {
        ...preview,
        ...toasts,
        rescan: () => {
          events.push('scan');
          return scan.promise;
        },
        openFile: async () => {},
      },
      core,
    );
    open = navigation.loadProject;
    return undefined;
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    for (const outcome of ['ready', 'failed']) {
      scan = deferred();
      startup = deferred();
      events.length = 0;
      let opening;
      await React.act(async () => {
        opening = open('/project');
      });
      assert.equal(status, 'starting', 'A slow scan must not show offline');
      assert.equal(url, undefined, 'A previous project URL must not remain visible');
      assert.deepEqual(events, ['watch', 'start', 'scan']);
      await React.act(async () => {
        scan.resolve({ pages: [] });
        await opening;
      });
      assert.equal(status, 'starting', 'Scanning does not settle preview startup');
      await React.act(async () => {
        if (outcome === 'ready') {
          startup.resolve({ url: 'http://localhost:4321' });
        } else {
          startup.reject(new Error('Startup attempts exhausted'));
        }
      });
      assert.equal(status, outcome === 'ready' ? 'on' : 'off');
      assert.equal(url, outcome === 'ready' ? 'http://localhost:4321' : undefined);
      assert.equal(events.includes('diagnose'), outcome === 'failed');
      if (outcome === 'failed') {
        assert.ok(events.includes('Preview failed to start: Startup attempts exhausted'));
      }
    }
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
