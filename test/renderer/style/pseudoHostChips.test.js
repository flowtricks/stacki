// Goal: the Style panel offers a pseudo-element only where the selected node can
// draw one. A chip for `.card::before` on an `img`, or `.card::placeholder` on a
// `div`, names a box the element never has; a ::before pick held for a loop or a
// component instance would style a box the node does not own.
// Method: real stylesheets through the panel's own parser (parseRegion,
// collectRules), matcher (computeRuleModel) and chip model (chipsFor), over a
// one-element tree whose tag each case sets. The pick is read through the host
// (setHost, readPanelLayer) for an element, a loop and an instance. The negative
// space: a pseudo-element the element's display could still reach keeps its
// chip, and so does an unknown tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'pseudo-host-chips.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { chipsFor, pseudoChipApplies, readPanelLayer } from './src/features/style/embed/editorModel';",
      "export { setHost, getHost } from './src/features/style/model/host';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);

const CSS = `
.card { color: red; }
.card::before { content: ""; }
.card::after { content: ""; }
.card::placeholder { color: gray; }
.card::marker { color: blue; }
`;
const BASE = { key: '', label: 'Base', breakpoint: undefined, embedAtContext: '' };

async function chipTexts(tag) {
  const view = {
    truncated: false,
    parentKey: () => undefined,
    childKeys: () => [],
    elementChildKeys: () => [],
    snapshot: async () => ({ tag, id: undefined, classes: ['card'], classList: ['card'], attributes: {} }),
  };
  const region = model.parseRegion({ start: 0, end: CSS.length, css: CSS, root: undefined });
  const rules = model.collectRules(region, {
    embedKey: 'file:/site.css',
    embedLabel: 'site.css',
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: 'site',
    order: { n: 0 },
  });
  const ruleModel = await model.computeRuleModel(rules, { rootKey: 'card', view });
  return model
    .chipsFor({
      model: ruleModel,
      nativeModel: undefined,
      currentContext: BASE,
      activeSelector: '',
      selectedSelectorText: undefined,
      tokens: [],
      classList: [],
      removedClasses: new Set(),
      pseudo: 'every',
      elementTag: tag,
    })
    .map((chip) => chip.text)
    .sort();
}

test('an img lists no ::before, ::after, ::marker or ::placeholder chip', async () => {
  assert.deepEqual(await chipTexts('img'), ['.card']);
});

test('an input keeps its ::placeholder and loses the boxes it cannot draw', async () => {
  assert.deepEqual(await chipTexts('input'), ['.card', '.card::placeholder']);
});

test('a div keeps ::before, ::after and the display-dependent ::marker, not ::placeholder', async () => {
  assert.deepEqual(await chipTexts('div'), ['.card', '.card::after', '.card::before', '.card::marker']);
});

test('an unknown tag hides nothing', async () => {
  assert.deepEqual(await chipTexts(undefined), ['.card', '.card::after', '.card::before', '.card::marker', '.card::placeholder']);
});

test('a selector list keeps its chip while any member applies', () => {
  assert.equal(model.pseudoChipApplies('.card::before, .card::placeholder', 'input'), true);
  assert.equal(model.pseudoChipApplies('.card::before, .card::after', 'img'), false);
  assert.equal(model.pseudoChipApplies('.card::selection', 'img'), true, 'a pseudo-element the table does not judge stays');
});

test('a ::before pick reaches the panel only for an HTML element', () => {
  const host = model.getHost();
  const pick = (node) =>
    model.setHost({ ...host, nodes: [node], selectedId: node.id, pseudoRows: true, pseudoRequest: { nodeId: node.id, pseudo: 'before', serial: 1 } });
  pick({ id: 'n0', kind: 'element', name: 'li' });
  assert.equal(model.readPanelLayer(), '::before', 'an li owns its ::before');
  pick({ id: 'n1', kind: 'map', children: [] });
  assert.equal(model.readPanelLayer(), '', 'a loop owns none: the panel shows the node');
  pick({ id: 'n2', kind: 'component', name: 'Button' });
  assert.equal(model.readPanelLayer(), '', 'an instance owns none');
  pick({ id: 'n3', kind: 'element', name: 'img' });
  assert.equal(model.readPanelLayer(), '', 'an img draws none');
  model.setHost(host);
});
