// Goal: the address bar's loading line gives up on a page that never answers and stays gone, and the next page
// switch raises it again. Before this, the line finished after its bound and rose again in the same render,
// because the frame was still waiting: it never cleared.
// Method: the real PageLoadLine and its store, bundled with esbuild, are mounted in jsdom. The line's own
// window timers are replaced by a manual queue, so its bound is run by hand with no waiting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/page-load-line');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { PageLoadLine, PAGE_LOAD_LINE_MS_MAX, PAGE_LOAD_LINE_FINISH_MS } from './src/features/preview/PageLoadLine.tsx';",
      "export { pageLoadStart, pageLoadEnd } from './src/features/preview/pageLoadState.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'line.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

test('a page that never answers clears the line, and the next switch raises it again', async (context) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (run, delayMs) => {
    nextTimer += 1;
    timers.set(nextTimer, { run, delayMs });
    return nextTimer;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const line = require(path.join(directory, 'line.js'));
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const drawn = () => document.querySelector('.page-load-line')?.className ?? 'none';
  const run = async (delayMs) => {
    const due = [...timers].find(([, timer]) => timer.delayMs === delayMs);
    assert.ok(due, `a ${delayMs}ms timer is waiting`);
    timers.delete(due[0]);
    await act(async () => due[1].run());
  };
  await act(async () => root.render(React.createElement(line.PageLoadLine)));
  assert.equal(drawn(), 'none');

  await act(async () => line.pageLoadStart('frame'));
  assert.equal(drawn(), 'page-load-line is-loading');
  await run(line.PAGE_LOAD_LINE_MS_MAX);
  assert.equal(drawn(), 'page-load-line is-finishing', 'the line gives up while the frame still waits');
  await run(line.PAGE_LOAD_LINE_FINISH_MS);
  assert.equal(drawn(), 'none');
  assert.equal(timers.size, 0, 'nothing raises it again');

  // The same frame switches to another page while the first never answered: PreviewFrame reports it anew.
  await act(async () => {
    line.pageLoadEnd('frame');
    line.pageLoadStart('frame');
  });
  assert.equal(drawn(), 'page-load-line is-loading', 'a new switch raises the line');
  await act(async () => line.pageLoadEnd('frame'));
  assert.equal(drawn(), 'page-load-line is-finishing');
  await run(line.PAGE_LOAD_LINE_FINISH_MS);
  assert.equal(drawn(), 'none');
});

test('PreviewFrame reports every page it switches to, not only the first one it waits for', () => {
  const frame = fs.readFileSync(repoPath('src/features/preview/PreviewFrame.tsx'), 'utf8');
  assert.match(frame, /\}, \[loading, frameId, target\.key\]\);/);
});
