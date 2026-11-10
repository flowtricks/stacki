// Goal: the commit graph preserves inspection actions and owns asynchronous reads.
// Methodology: mount the real component with a stubbed IPC boundary, exercise
// expansion, file summaries and dialog actions, paging, branch scope, automatic refresh,
// and out-of-order repository responses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

const commit = (hash, parents, refs = []) => ({
  hash,
  shortHash: hash.slice(0, 7),
  parents,
  refs,
  isMerge: parents.length > 1,
  subject: `Commit ${hash}`,
  author: 'Designer',
  email: 'designer@example.com',
  when: '2026-10-20T10:00:00Z',
  files: [{ status: 'M', path: 'src/pages/index.astro', label: 'Home', kind: 'page' }],
});

test('graph inspection, filters, paging and stale responses', async () => {
  const directory = repoPath('node_modules/.stacki-test/history-timeline');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = path.join(directory, 'timeline.cjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/history/HistoryTimeline.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.Element = dom.window.Element;
  // JSDOM has no layout; dropdown keyboard focus still needs this browser method.
  window.Element.prototype.scrollIntoView = function () {};
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.matchMedia = () => ({ matches: true });
  const polls = new Map();
  let timerId = 0;
  window.setInterval = (callback, milliseconds) => {
    assert.equal(milliseconds, 15_000);
    polls.set(++timerId, callback);
    return timerId;
  };
  window.clearInterval = (timer) => polls.delete(timer);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Timeline = require(bundle).default;
  const requests = [];
  const actions = [];
  window.avb = {
    gitLog: (payload) => new Promise((resolve) => requests.push({ payload, resolve })),
    gitCommitDiff: async () => ({ ok: true, value: '@@ -1 +1 @@\n-before\n+after\n' }),
  };
  const root = createRoot(document.getElementById('root'));
  const merge = commit('a'.repeat(40), ['main001', 'feature'], ['HEAD -> main', 'tag: v1']);
  merge.files.push(
    { ...merge.files[0], path: 'new.astro', status: 'A' },
    { ...merge.files[0], path: 'gone.astro', status: 'D' },
    { ...merge.files[0], path: 'copy.astro', status: 'C' },
    { ...merge.files[0], path: 'renamed.astro', status: 'R', from: 'before.astro' },
  );
  const main = commit('main001', ['base001']);
  const feature = commit('feature', ['base001'], ['feature']);
  const base = commit('base001', []);
  base.files[0].status = 'A';
  const props = {
    projectPath: '/project',
    branch: 'main',
    head: merge.hash,
    userEmail: undefined,
    previewRef: undefined,
    onPreviewCommit: (value) => actions.push(['preview', value.hash]),
    onExitPreview: () => actions.push(['exit']),
    onRestoreFile: (value, file) => actions.push(['file', value.hash, file.path]),
    onRestoreProject: (value) => actions.push(['project', value.hash]),
  };
  const render = (values) => act(async () => root.render(React.createElement(Timeline, values)));
  const reply = (index, commits, atEnd) => act(async () => requests[index].resolve({ commits, atEnd }));
  const click = (element) => act(async () => element.click());
  try {
    await render(props);
    assert.equal(requests[0].payload.ref, undefined);
    await reply(0, [merge, main], false);
    assert.equal(document.querySelectorAll('.history-graph-drawing').length, 2);
    assert.equal(document.querySelector('.history-ref.current').textContent, 'HEAD');
    assert.match(document.querySelector('.history-refs').textContent, /main.*tag: v1/);
    assert.equal(document.querySelector('.history-day') === null, true);
    const subject = document.querySelector('.history-subject');
    await act(async () => subject.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
    assert.equal(document.querySelector('[role="tooltip"]').textContent, subject.textContent);
    await act(async () => subject.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })));
    await click(document.querySelector('.history-commit-head'));
    assert.equal(document.querySelector('.history-commit-head').getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.history-file') === null, true);
    assert.match(document.querySelector('.history-file-summary').textContent, /\+2−1~2/);
    await click(document.querySelector('.history-commit-actions button'));
    await click(document.querySelector('.history-view-files'));
    assert.equal(document.querySelector('dialog').open, true);
    assert.equal(document.querySelectorAll('dialog .history-file').length, 5);
    assert.equal(document.querySelector('.history-file-path').textContent, 'copy.astro');
    assert.match(document.querySelector('dialog').textContent, /From before.astro/);
    const filterButton = (label) => [...document.querySelectorAll('.history-file-filters button')].find((button) => button.textContent.startsWith(label));
    const visiblePaths = () =>
      [...document.querySelectorAll('dialog .history-file-open')].map((button) => button.getAttribute('aria-label').replace('View diff for ', ''));
    await click(filterButton('New'));
    assert.deepEqual(visiblePaths(), ['copy.astro', 'new.astro']);
    await click(filterButton('Deleted'));
    assert.deepEqual(visiblePaths(), ['gone.astro']);
    await click(filterButton('Changed'));
    assert.deepEqual(visiblePaths(), ['renamed.astro', 'src/pages/index.astro']);
    await click(filterButton('All'));
    await click(document.querySelector('[aria-label="Sort changed files"]'));
    await click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes('Status')));
    assert.deepEqual(visiblePaths(), ['renamed.astro', 'src/pages/index.astro', 'copy.astro', 'new.astro', 'gone.astro']);
    await click(filterButton('New'));
    await click(document.querySelector('.history-file-open'));
    await click(document.querySelector('.history-diff-toolbar button'));
    assert.deepEqual(visiblePaths(), ['copy.astro', 'new.astro']);
    assert.equal(filterButton('New').getAttribute('aria-pressed'), 'true');
    assert.match(document.querySelector('[aria-label="Sort changed files"]').textContent, /Status/);
    await act(async () => {
      document.querySelector('dialog').dispatchEvent(new window.Event('cancel', { cancelable: true }));
    });
    assert.equal(document.querySelector('dialog') === null, true);
    await click(document.querySelector('.history-view-files'));
    await click(document.querySelector('[aria-label="Close changed files"]'));
    assert.equal(document.querySelector('dialog') === null, true);
    await click(document.querySelector('.history-view-files'));
    await click(document.querySelector('[aria-label="View diff for src/pages/index.astro"]'));
    assert.equal(document.querySelectorAll('.history-diff-line.added').length, 1);
    assert.equal(document.querySelectorAll('.history-diff-line.deleted').length, 1);
    assert.deepEqual(actions, [['preview', merge.hash]]);
    await click(document.querySelector('.history-diff-toolbar button'));
    assert.equal(document.querySelectorAll('dialog .history-file').length, 5);
    await click(document.querySelector('[aria-label="View diff for src/pages/index.astro"]'));
    await click(document.querySelectorAll('.history-diff-toolbar button')[1]);
    assert.equal(document.querySelector('dialog') === null, true);
    await click(document.querySelector('[aria-label="Commit actions"]'));
    await click(document.querySelector('[role="menuitem"]'));
    assert.deepEqual(actions, [
      ['preview', merge.hash],
      ['file', merge.hash, 'src/pages/index.astro'],
      ['project', merge.hash],
    ]);
    await render({ ...props, previewRef: merge.hash });
    await click(document.querySelector('.history-commit-actions button'));
    assert.deepEqual(actions.at(-1), ['exit']);
    await click(document.querySelector('.history-more'));
    assert.equal(requests[1].payload.skip, 2);
    await reply(1, [feature, base], true);
    assert.equal(document.querySelectorAll('.history-graph-drawing').length, 4);
    assert.equal(document.querySelector('.history-more') === null, true);

    // The branch filter is the app's own Dropdown: open it, then pick the row.
    await click(document.querySelector('[aria-label="Filter commits by branch"]'));
    const currentBranch = [...document.querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Current branch');
    assert.ok(currentBranch, 'the filter offers the current branch');
    await click(currentBranch);
    assert.equal(document.querySelector('[aria-label="Filter commits by branch"]').textContent.trim(), 'Current branch');
    assert.match(document.querySelector('.history-graph-filter').getAttribute('title'), /^Showing commits on /);
    assert.equal(requests[2].payload.ref, 'HEAD');
    assert.equal(requests[2].payload.skip, 0);
    await render({ ...props, projectPath: '/another-project' });
    assert.equal(requests[3].payload.projectPath, '/another-project');
    await reply(3, [base], true);
    await reply(2, [merge, main, feature, base], true);
    assert.equal(document.querySelectorAll('.history-commit-head').length, 1);
    assert.match(document.querySelector('.history-subject').textContent, /base001/);
    await click(document.querySelector('.history-commit-head'));
    assert.equal(document.querySelector('.history-count-updated').textContent, '~0');
    assert.equal(document.querySelector('.history-graph-refresh') === null, true);
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(requests[4].payload.ref, 'HEAD');
    await reply(4, [base], true);
    assert.equal(document.querySelector('.history-commit-head').getAttribute('aria-expanded'), 'true');
    assert.equal(polls.size, 1, 'only the active project owns a polling timer');
    await act(async () => [...polls.values()][0]());
    await reply(5, [], true);
    assert.match(document.querySelector('.history-empty').textContent, /Nothing saved yet/);

    await render({ ...props, branch: 'new-design-test', head: 'feature-tip' });
    await reply(6, [commit('feature-tip', ['main-tip'], ['HEAD -> new-design-test']), commit('main-tip', [], ['main'])], true);
    const nodes = [...document.querySelectorAll('.history-graph-node')];
    assert.ok(nodes[0].classList.contains('history-graph-color-1'));
    assert.ok(nodes[1].classList.contains('history-graph-color-0'));
    assert.equal(document.querySelector('.history-ref-branch-1').textContent, 'new-design-test');
    assert.equal(document.querySelector('.history-ref-branch-0').textContent, 'main');
    assert.ok(document.querySelector('.history-graph-extension .history-graph-color-1'));
  } finally {
    await act(async () => root.unmount());
    assert.equal(polls.size, 0);
    const count = requests.length;
    window.dispatchEvent(new window.Event('focus'));
    assert.equal(requests.length, count, 'unmounted graphs stop listening');
    dom.window.close();
    delete global.window;
    delete global.document;
    delete global.HTMLElement;
    delete global.Node;
    delete global.Element;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
