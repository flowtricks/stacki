// Mount real text controls with the layout metadata hook and scripted canvas replies.
// Verify effective placeholders, refreshes, overrides, resets and stale page responses
// without writing the displayed fallback into the page's authored props.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'layout-text.cjs');
buildSync({
  stdin: {
    contents: `
      export { default as PropField } from ${sourceSpecifier('src/features/props/PropField.tsx')};
      export { PropValuePolicyContext } from
        ${sourceSpecifier('src/features/props/propValuePolicy.ts')};
      export { useLayoutText } from ${sourceSpecifier('src/features/props/useLayoutText.ts')};
      export { setCanvasFrame, receiveCanvasReply, noteCanvasReady } from
        ${sourceSpecifier('src/editor/canvasQuery.ts')};
    `,
    resolveDir: repoPath('src'),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { PropField, PropValuePolicyContext, useLayoutText, setCanvasFrame, receiveCanvasReply, noteCanvasReady } = require(output);
const root = createRoot(document.getElementById('root'));
const requests = [];
const changes = [];
const change = (...args) => changes.push(args);
const base = {
  isLayout: true,
  projectPath: '/church',
  filePath: '/church/src/pages/index.astro',
  node: { id: 'layout', kind: 'component', name: 'BaseLayout', props: {} },
};
function Preview(props) {
  const layoutText = useLayoutText(props);
  return React.createElement(
    PropValuePolicyContext.Provider,
    { value: props.valuePolicy ?? 'instance' },
    React.createElement(PropField, {
      field: { name: 'title', type: 'string' },
      value: props.node.props.title,
      assetContext: { layoutText },
      onChange: change,
    }),
    React.createElement(PropField, {
      field: { name: 'description', type: 'string', default: 'SITE_DESCRIPTION' },
      value: props.node.props.description,
      assetContext: { layoutText },
      onChange: change,
    }),
  );
}
async function render(props) {
  await act(async () => root.render(React.createElement(Preview, props)));
}
async function answer(request, pageText) {
  assert.equal(request.pageText, true);
  await act(async () => receiveCanvasReply({ id: request.id, found: true, pageText }));
}
function placeholders() {
  return [document.querySelector('input').placeholder, document.querySelector('textarea').placeholder];
}
async function checkFallbacks() {
  await render(base);
  await answer(requests.at(-1), { title: 'The Church International', description: 'Find hope.' });
  assert.deepEqual(placeholders(), ['The Church International', 'Find hope.']);
  assert.equal(document.querySelector('input').value, '');
  assert.equal(document.querySelector('textarea').value, '');
  assert.equal(document.querySelector('.prop-label.set') ?? undefined, undefined);
  await act(async () => noteCanvasReady());
  await answer(requests.at(-1), { title: 'Updated site name', description: '' });
  assert.deepEqual(placeholders(), ['Updated site name', '']);
  await act(async () => noteCanvasReady());
  await answer(requests.at(-1), {});
  assert.deepEqual(placeholders(), ['', 'SITE_DESCRIPTION']);
}
async function checkOverrides() {
  const override = { type: 'string', value: 'My page' };
  await render({ ...base, node: { ...base.node, props: { title: override } } });
  await answer(requests.at(-1), { title: 'My page | Church', description: 'Site description' });
  assert.equal(document.querySelector('input').value, 'My page');
  assert.deepEqual(placeholders(), ['', 'Site description']);
  const requestCount = requests.length;
  await render({
    ...base,
    node: { ...base.node, props: { title: override, description: override } },
  });
  await render({ ...base, isLayout: false });
  await render({ ...base, valuePolicy: 'defaults' });
  assert.equal(requests.length, requestCount);
  assert.deepEqual(placeholders(), ['', '']);
  await render(base);
  await answer(requests.at(-1), { title: 'Site name', description: 'Site description' });
  assert.deepEqual(placeholders(), ['Site name', 'Site description']);
}
async function checkStaleReplies() {
  await act(async () => noteCanvasReady());
  const stale = requests.at(-1);
  await render({ ...base, projectPath: '/another', filePath: '/another/index.astro' });
  assert.deepEqual(placeholders(), ['', 'SITE_DESCRIPTION']);
  await answer(stale, { title: 'Old title', description: 'Old description' });
  assert.deepEqual(placeholders(), ['', 'SITE_DESCRIPTION']);
  await answer(requests.at(-1), { title: 'New title', description: 'New description' });
  assert.deepEqual(placeholders(), ['New title', 'New description']);
  await act(async () => noteCanvasReady());
  const earlier = requests.at(-1);
  await act(async () => noteCanvasReady());
  await answer(requests.at(-1), { title: 'Latest title' });
  await answer(earlier, { title: 'Earlier title' });
  assert.equal(placeholders()[0], 'Latest title');
}
(async () => {
  try {
    setCanvasFrame({ postMessage: (message) => requests.push(message) });
    await checkFallbacks();
    await checkOverrides();
    await checkStaleReplies();
    assert.deepEqual(changes, []);
    console.log('layout-text: placeholders, refresh, overrides and stale replies passed');
  } finally {
    await act(async () => root.unmount());
    setCanvasFrame(undefined);
    dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
