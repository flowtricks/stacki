// Goal: NoticeToast says a one-time notice or a broken rule once, as a toast, and never as markup: it renders nothing, reports
// again only when the message changes, and ignores an absent or empty message (valid data becoming invalid, and back).
// Method: bundle the real component with esbuild, mount it in jsdom, subscribe to the app's own toast channel, and rerender.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

test('a notice is one toast per message, never DOM, and empty messages say nothing', async () => {
  const output = repoPath('node_modules/.stacki-test/notice-toast.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: "export { NoticeToast } from './src/ui/NoticeToast';\nexport { subscribeErrorToasts } from './src/ui/errorNotices';",
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { NoticeToast, subscribeErrorToasts } = require(output);
  const toasts = [];
  subscribeErrorToasts(
    (notice) => toasts.push([notice.kind, notice.message]),
    () => undefined,
  );
  const container = document.getElementById('root');
  const root = createRoot(container);
  const show = (message, kind) => React.act(async () => root.render(React.createElement(NoticeToast, { message, kind })));
  await show('Heading is required', 'error');
  await show('Heading is required', 'error');
  assert.deepEqual(toasts, [['error', 'Heading is required']], 'the same message is said once');
  assert.equal(container.innerHTML, '', 'nothing is appended to the page');
  await show(undefined, 'error');
  await show('', 'warning');
  assert.equal(toasts.length, 1, 'an absent or empty message says nothing');
  await show('Edits apply live', 'warning');
  assert.deepEqual(toasts.at(-1), ['warning', 'Edits apply live'], 'a new message is a new toast, with its kind');
  await React.act(async () => root.unmount());
});
