// Verify effective media defaults through the real prop field and asset picker.
// Mount in JSDOM with a scripted asset inventory; defaults must preview without
// saving, while overrides, resets, URL editing and recipe policies retain their meaning.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'media-fallback.cjs');
buildSync({
  stdin: {
    contents: `
      export { default as PropField } from ${sourceSpecifier('src/features/props/PropField.tsx')};
      export { PropValuePolicyContext } from
        ${sourceSpecifier('src/features/props/propValuePolicy.ts')};
      export { getPendingAsset } from ${sourceSpecifier('src/ui/assetPick.ts')};
      export { assetReferenceFor } from ${sourceSpecifier('src/features/props/elementState.ts')};
      export { useLayoutMetadata } from
        ${sourceSpecifier('src/features/props/useLayoutMetadata.ts')};
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
const assets = ['og-image.jpg', 'override.jpg'].map((name) => ({
  name,
  rel: `public/${name}`,
  abs: `/project/public/${name}`,
  parent: 'public',
  root: 'public',
  isDir: false,
  size: 1024,
}));
window.avb = {
  listAssets: async () => ({ entries: assets }),
  onAssetsChanged: () => () => {},
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const {
  PropField,
  PropValuePolicyContext,
  getPendingAsset,
  assetReferenceFor,
  useLayoutMetadata,
  setCanvasFrame,
  receiveCanvasReply,
  noteCanvasReady,
} = require(output);
const root = createRoot(document.getElementById('root'));
const changes = [];
const baseField = { name: 'image', type: 'string', default: '/og-image.jpg' };
let fieldProps = {};
let policy = 'instance';

async function render(next = {}, nextPolicy = 'instance') {
  fieldProps = next;
  policy = nextPolicy;
  await act(async () => renderCurrent());
}
function renderCurrent() {
  root.render(
    React.createElement(
      PropValuePolicyContext.Provider,
      { value: policy },
      React.createElement(PropField, {
        field: baseField,
        assetContext: { projectPath: '/project', nodeName: 'BaseLayout' },
        ...fieldProps,
        onChange: change,
      }),
    ),
  );
}
function change(value) {
  changes.push(value);
  fieldProps = { ...fieldProps, value };
  renderCurrent();
}
async function click(text) {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  assert.ok(button, `Button exists: ${text}`);
  await act(async () => button.click());
}
function assetName() {
  return document.querySelector('.af-name')?.textContent;
}
function isSet() {
  return document.querySelector('.prop-label').classList.contains('set');
}

async function checkLocalFallback() {
  await render();
  assert.equal(assetName(), 'og-image.jpg');
  assert.match(document.querySelector('.af-thumb img').src, /public\/og-image\.jpg$/);
  assert.match(document.body.textContent, /Component fallback/);
  assert.equal(isSet(), false);
  assert.deepEqual(changes, []);
  await click('Choose Image…');
  assert.equal(getPendingAsset().current, 'public/og-image.jpg');
  await act(async () => getPendingAsset().onPick('public/override.jpg'));
  assert.equal(assetName(), 'override.jpg');
  assert.equal(isSet(), true);
  assert.doesNotMatch(document.body.textContent, /Component fallback/);
  assert.deepEqual(changes, [{ type: 'string', value: '/override.jpg' }]);
  await act(async () => {
    document.querySelector('.prop-label').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
  });
  assert.equal(assetName(), 'og-image.jpg');
  assert.equal(isSet(), false);
  assert.equal(changes.at(-1), undefined);
  await click('URL');
  assert.equal(document.querySelector('.asset-field input').value, '');
  assert.equal(document.querySelector('.asset-field input').placeholder, '/og-image.jpg');
  await click('Asset');
}

async function checkFallbackBoundaries() {
  await render({ value: { type: 'string', value: '' } });
  assert.equal(assetName(), 'No asset selected');
  assert.equal(isSet(), true);
  await render({ field: { ...baseField, default: undefined } });
  assert.equal(assetName(), 'No asset selected');
  await render({ field: { ...baseField, default: 'SITE_IMAGE', defaultExpr: true } });
  assert.equal(assetName(), 'No asset selected');
  // An expression default the schema reader followed to its imported file
  // previews that file, without writing the expression or the path.
  await render({ field: { ...baseField, default: 'heroImage.src', defaultExpr: true, defaultAsset: 'public/og-image.jpg' } });
  assert.equal(assetName(), 'og-image.jpg');
  assert.match(document.body.textContent, /Component fallback/);
  assert.equal(isSet(), false);
  await render({ field: { ...baseField, default: 'heroImage.src', defaultExpr: true, defaultAsset: 'public/og-image.jpg' } }, 'defaults');
  assert.equal(assetName(), 'No asset selected');
  await render({ field: { ...baseField, default: undefined, hint: 'Automatic' } });
  assert.equal(assetName(), 'No asset selected');
  await render({ field: { ...baseField, default: '/missing.jpg' } });
  assert.equal(assetName(), '/missing.jpg');
  assert.match(document.body.textContent, /not found in public\//);
  const branch = { field: { name: 'image', type: 'string' }, branchDefault: '/og-image.jpg' };
  await render(branch);
  assert.equal(assetName(), 'og-image.jpg');
  await render(branch, 'defaults');
  assert.equal(assetName(), 'No asset selected');
  await render({}, 'defaults');
  assert.equal(assetName(), 'No asset selected');
  await render({ value: { type: 'string', value: '/og-image.jpg' } }, 'defaults');
  assert.equal(assetName(), 'og-image.jpg');
  assert.equal(isSet(), true);
}

async function checkRemoteFallback() {
  const remote = 'https://example.com/social.jpg';
  await render({ field: { ...baseField, default: remote } });
  assert.equal(assetName(), 'social.jpg');
  assert.equal(document.querySelector('.af-thumb img').src, remote);
  assert.equal(document.querySelector('.asset-field input').value, '');
  assert.equal(document.querySelector('.asset-field input').placeholder, remote);
  assert.equal(isSet(), false);
  assert.match(document.body.textContent, /Component fallback/);
}

function LayoutPreview(props) {
  const metadata = useLayoutMetadata(props);
  const assetContext = {
    projectPath: props.projectPath,
    layoutImage: metadata?.image,
    layoutType: metadata?.type,
  };
  return React.createElement(
    React.Fragment,
    undefined,
    React.createElement(PropField, {
      field: { name: 'image', type: 'string' },
      value: props.node.props.image,
      assetContext,
      onChange: change,
    }),
    React.createElement(PropField, {
      field: { name: 'type', type: 'enum', options: ['website', 'article'] },
      value: props.node.props.type,
      assetContext,
      onChange: change,
    }),
  );
}

async function checkRuntimeFallback() {
  const requests = [];
  setCanvasFrame({ postMessage: (message) => requests.push(message) });
  const base = {
    isLayout: true,
    projectPath: '/church',
    filePath: '/church/src/pages/index.astro',
    node: { id: 'layout', kind: 'component', name: 'BaseLayout', props: {} },
  };
  const renderLayout = async (props) => {
    await act(async () => root.render(React.createElement(LayoutPreview, props)));
  };
  const answer = async (request, image) => {
    assert.equal(request.pageMetadata, true);
    await act(async () => receiveCanvasReply({ id: request.id, found: true, pageImage: image, pageType: 'website' }));
  };
  await renderLayout(base);
  await answer(requests.at(-1), 'https://cdn.example.com/church-share.jpg');
  assert.equal(assetName(), 'church-share.jpg');
  assert.equal(isSet(), false);
  assert.equal(document.querySelector('.bool-seg button.on').textContent, 'website');
  assert.equal(document.querySelectorAll('.prop-label.set').length, 0);
  await act(async () => noteCanvasReady());
  const stale = requests.at(-1);
  await renderLayout({ ...base, projectPath: '/another', filePath: '/another/index.astro' });
  assert.equal(assetName(), undefined, 'A project switch clears the previous remote card');
  await answer(stale, 'https://cdn.example.com/stale.jpg');
  assert.equal(assetName(), undefined, 'A late reply cannot restore the old project image');
  await answer(requests.at(-1), 'https://cdn.example.com/another.jpg');
  assert.equal(assetName(), 'another.jpg');
  await act(async () => noteCanvasReady());
  await answer(requests.at(-1), undefined);
  assert.equal(assetName(), undefined, 'Removed metadata clears the card');
  const requestCount = requests.length;
  await renderLayout({ ...base, isLayout: false });
  await renderLayout({ ...base, valuePolicy: 'defaults' });
  assert.equal(requests.length, requestCount, 'Only ordinary layouts query metadata');
  await renderLayout({
    ...base,
    node: { ...base.node, props: { image: { type: 'string', value: '/override.jpg' } } },
  });
  await answer(requests.at(-1), 'https://cdn.example.com/ignored.jpg');
  await click('Asset');
  assert.equal(assetName(), 'override.jpg');
  setCanvasFrame(undefined);
}

// A picked src/ image is written as `photo.src` wherever a URL is expected —
// a plain element, or a component prop typed as a string — and as the
// imported object otherwise. Handing a string prop the object renders a broken
// <img src="[object Object]">.
function checkAssetReference() {
  const schema = [
    { name: 'src', type: 'string' },
    { name: 'image', type: 'other' },
  ];
  assert.equal(assetReferenceFor('element', schema, 'image'), 'url');
  assert.equal(assetReferenceFor('component', schema, 'src'), 'url');
  assert.equal(assetReferenceFor('component', schema, 'image'), 'module');
  assert.equal(assetReferenceFor('component', schema, 'undeclared'), 'module');
}

(async () => {
  try {
    checkAssetReference();
    await checkLocalFallback();
    const changeCount = changes.length;
    await checkFallbackBoundaries();
    await checkRemoteFallback();
    await checkRuntimeFallback();
    assert.equal(changes.length, changeCount, 'Rendering fallbacks never saves a value');
    console.log('media-fallback: local, remote, override, reset and recipe checks passed');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
