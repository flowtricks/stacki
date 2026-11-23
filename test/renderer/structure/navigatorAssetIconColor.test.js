// Goal: an Astro asset row (Image, Picture) in the Navigator has a green icon matching its green label, in every
// row state, while other kinds keep their colours. The icon used to carry Astro's brand orange as an inline style,
// which beat the row's own icon colour.
// Method: bundle the real describeNode with esbuild and render the icons on the server: an asset component icon
// must carry no inline colour (so it follows the row's CSS); other icons are unchanged. Then read styles.css and
// check the component row sets label and icon to the same token in the plain, hover and selected states, and
// that no rule recolours an asset icon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

async function load() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath('src/ui/navigatorLabel.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    external: ['react', 'react/jsx-runtime', 'react-dom/server'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const filename = repoPath('node_modules/.stacki-test/navigator-asset-icon.cjs');
  const bundleModule = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(filename), bundleModule, bundleModule.exports);
  return { describeNode: bundleModule.exports.describeNode, render: createRequire(filename)('react-dom/server').renderToStaticMarkup };
}

const component = (name, astroAsset) => ({ id: name, kind: 'component', name, astroAsset, dynamicTag: false, props: [], children: [] });

test('an Astro asset row icon carries no inline colour, so the row paints it green', async () => {
  const { describeNode, render } = await load();
  for (const name of ['Image', 'Picture']) {
    const markup = render(describeNode(component(name, true), undefined).icon);
    assert.doesNotMatch(markup, /#ff5d01/i);
    assert.doesNotMatch(markup, /color:/);
    assert.match(markup, /currentColor/);
  }
});

test('other component and element icons are unchanged', async () => {
  const { describeNode, render } = await load();
  const plain = render(describeNode(component('Card', false), undefined).icon);
  assert.doesNotMatch(plain, /color:/);
  const element = render(describeNode({ id: 'e', kind: 'element', name: 'div', props: [], children: [] }, undefined).icon);
  assert.doesNotMatch(element, /color:/);
});

test('a component row sets label and icon to one green in plain, hover and selected states', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rule = (selectors) => {
    const at = css.indexOf(`${selectors} {`);
    assert.ok(at >= 0, `rule for ${selectors}`);
    return css.slice(at, css.indexOf('}', at));
  };
  const labelRule = rule('.structure-node.is-component,\n.structure-node.is-component:hover,\n.structure-node.is-component.selected');
  const iconRule = rule('.structure-node.is-component .icon,\n.structure-node.is-component:hover .icon,\n.structure-node.is-component.selected .icon');
  assert.match(labelRule, /color: var\(--component-green\)/);
  assert.match(iconRule, /color: var\(--component-green\)/);
});
