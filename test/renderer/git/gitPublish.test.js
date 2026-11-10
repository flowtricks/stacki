// Validate GitHub preflight replies, then mount the actual publish dialog with
// deferred IPC. The project path must reach the contract, and an obsolete project
// or unmounted dialog must never receive a stale authentication result.
const { toastMessages } = require('../../helpers/toastCapture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');
const { parseGitHubStatus, readGitHubStatus, repoSlug, webUrl } = require('../../helpers/rendererModule')('src/features/git/gitPublish.ts');

test('GitHub preflight parses each state and rejects impossible or oversized data', async () => {
  for (const status of [
    { installed: false, authed: false },
    { installed: true, authed: false },
    { installed: true, authed: true, user: undefined },
    { installed: true, authed: true, user: 'user' },
  ]) {
    assert.deepEqual(parseGitHubStatus(status), status);
  }
  for (const status of [
    jsonNull,
    {},
    { installed: false, authed: true },
    // Absence is `undefined` (AGENTS.md §6): an unknown user is never sent as null.
    { installed: true, authed: true, user: jsonNull },
    { installed: 1, authed: false },
    { installed: true, authed: true, user: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) },
  ]) {
    assert.throws(() => parseGitHubStatus(status));
  }
  let project;
  global.window = {
    avb: {
      ghStatus: async (value) => {
        project = value;
        return { installed: true, authed: true, user: 'person' };
      },
    },
  };
  assert.equal((await readGitHubStatus('/project')).ok, true);
  assert.equal(project, '/project');
  window.avb.ghStatus = async () => {
    throw new Error('bridge unavailable');
  };
  assert.deepEqual(await readGitHubStatus('/project'), { ok: false, error: 'bridge unavailable' });
  window.avb.ghStatus = async () => ({});
  await assert.rejects(readGitHubStatus('/project'), /Expected boolean/);
  await assert.rejects(readGitHubStatus('x'.repeat(32769)), /Path exceeds limit/);
  assert.equal(repoSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(webUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo');
  assert.equal(webUrl('https://example.com/repo'), 'https://example.com/repo');
});

test('publish dialog passes its project to preflight and ignores old replies', async () => {
  const output = repoPath('node_modules/.stacki-test/git-publish.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents:
        "export { default as PublishModal } from './src/features/git/PublishModal.tsx';\n" +
        'export { default as SwitchBranchModal } from ' +
        "'./src/features/git/SwitchBranchModal.tsx';\n",
      loader: 'js',
      resolveDir: ROOT,
    },
    outfile: output,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const reads = [];
  window.avb = {
    ghStatus: (project) => new Promise((resolve, reject) => reads.push({ project, resolve, reject })),
  };
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { PublishModal, SwitchBranchModal } = require(output);
  const root = createRoot(document.getElementById('root'));
  const show = (projectPath) =>
    act(async () =>
      root.render(
        React.createElement(PublishModal, {
          projectPath,
          defaultName: 'My project',
          branch: 'main',
          onClose() {},
          onPublish() {},
          openExternal() {},
        }),
      ),
    );
  try {
    await show('/first');
    assert.equal(reads[0].project, '/first');
    assert.match(document.body.textContent, /Checking GitHub CLI/);
    await show('/second');
    assert.equal(reads[1].project, '/second');
    await act(async () => reads[1].resolve({ installed: true, authed: true, user: 'current-user' }));
    await act(async () => reads[0].resolve({ installed: false, authed: false }));
    assert.match(document.body.textContent, /current-user/);
    assert.equal(document.querySelector('.modal-footer .primary').disabled, false);
    // The destination is the app's Dropdown, not a native select, and picking a row switches the form.
    assert.equal(document.querySelector('.modal select') === null, true);
    const destination = document.querySelector('[aria-label="Repository destination"]');
    assert.ok(destination.classList.contains('dd-trigger'));
    assert.equal(destination.textContent, 'Create a new repository');
    await act(async () => destination.click());
    const existing = [...document.querySelectorAll('.dd-option')].find((row) => row.textContent === 'Use an existing repository');
    await act(async () => existing.click());
    assert.equal(destination.textContent, 'Use an existing repository');
    assert.equal(document.body.textContent.includes('Repository name'), false);
    await show('/third');
    await act(async () => reads[2].reject(new Error('cannot inspect CLI')));
    assert.match(toastMessages(), /cannot inspect CLI/);
    assert.equal(document.querySelector('.modal-footer .primary').disabled, true);
    await show('/fourth');
    await act(async () => root.unmount());
    await act(async () => reads[3].resolve({ installed: true, authed: true, user: 'late-user' }));
    assert.equal(document.getElementById('root').textContent, '');
    const { renderToStaticMarkup } = require('react-dom/server');
    assert.throws(
      () =>
        renderToStaticMarkup(
          React.createElement(SwitchBranchModal, {
            from: 'main',
            to: 'topic',
            files: Array(100001).fill('a'),
            busy: undefined,
            onCancel() {},
            onLeaveHere() {},
            onCommitFirst() {},
          }),
        ),
      /Branch switch: file limit exceeded/,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
