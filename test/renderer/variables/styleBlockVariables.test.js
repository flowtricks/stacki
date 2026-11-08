// Goal: the renderer's half of `<style>` variables. The wire carries a block's scope
// through the parser and refuses a corrupt one, the badge states each reach in words,
// and the pickers offer what the panel reads, follow changes, and keep the open page's
// own value first.
// Method: a real project is read by the real main-process reader, and that wire
// answers a stub bridge under the real picker model, so the only stand-in is IPC.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readVariables } = require('#dist/electron/project/cssVars.js');
const { buildSync } = require('esbuild');
const rendererModule = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

// One bundle, so the picker model and the test share the same host and the same list.
function loadPickerModules() {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-picker-')), 'picker.cjs');
  buildSync({
    stdin: {
      contents: [
        "export { ensureSharedVars, sharedVars, sharedDone } from './src/features/style/sharedVars';",
        "export { getHost, setHost } from './src/features/style/model/host';",
        "export { streamProjectVariables } from './src/features/style/model/projectResources';",
      ].join('\n'),
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
  });
  try {
    return require(output);
  } finally {
    fs.rmSync(path.dirname(output), { recursive: true, force: true });
  }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-block-picker-'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  fs.writeFileSync(path.join(directory, file), text);
};

let changed = () => {};
globalThis.window = {
  avb: {
    cssVariables: async (project) => readVariables(project),
    listStyleFiles: async () => ({
      files: [{ rel: 'src/styles/tokens.css', name: 'tokens.css', path: path.join(directory, 'src/styles/tokens.css'), size: 1 }],
    }),
    listAstroStyleFiles: async () => ({ files: [] }),
    readStyleFile: async (file) => ({ css: fs.readFileSync(file, 'utf8') }),
    onCssChanged: (callback) => {
      changed = callback;
      return () => {};
    },
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

(async () => {
  try {
    write('src/styles/tokens.css', ':root { --shared: blue; }\n');
    write(
      'src/pages/index.astro',
      '<!-- <style is:global>:root { --commented: 1 }</style> -->\n<style is:inline>:root { --inline-size: 2rem; --shared: red; }</style>\n',
    );
    write('src/components/Card.astro', '<style>.card { --card-color: #123456; }</style>\n<p>{true && <style>:root { --conditional: 1 }</style>}</p>\n');

    const { parseCSSVariables } = rendererModule('src/ipc/variablesBridge.ts');
    const wire = readVariables(directory);
    const parsed = parseCSSVariables(JSON.parse(JSON.stringify(wire)));
    assert.equal(parsed.ok, true);
    const page = parsed.value.files.find((file) => file.rel === 'src/pages/index.astro');
    assert.deepEqual(page.groups[0].scope, { reach: 'page', written: 'inline' });
    const corrupt = (change) => {
      const copy = structuredClone(wire);
      change(copy.files.find((file) => file.rel === 'src/pages/index.astro').groups[0]);
      return () => parseCSSVariables(copy);
    };
    assert.throws(
      corrupt((group) => {
        group.scope.reach = 'everywhere';
      }),
      /invalid scope reach/,
    );
    assert.throws(
      corrupt((group) => {
        group.scope.written = 'loud';
      }),
      /invalid style block kind/,
    );

    const { variableScopeLabel, variableScopeDetail } = rendererModule('src/features/variables/VariableScopeBadge.tsx');
    assert.equal(variableScopeLabel({ reach: 'page', written: 'global' }), 'This page');
    assert.equal(variableScopeLabel({ reach: 'rendered', written: 'global' }), 'Where rendered');
    assert.equal(variableScopeLabel({ reach: 'scoped', written: 'scoped' }), 'This file only');
    assert.match(variableScopeDetail({ reach: 'page', written: 'inline' }), /exactly as written/);

    const shared = loadPickerModules();
    const { setHost, getHost, streamProjectVariables } = shared;
    setHost({ ...getHost(), projectPath: directory });
    const offered = await streamProjectVariables(() => {});
    // One entry per name in each file: the page's `--shared` is kept beside the stylesheet's,
    // and the place a picker opens in decides which one it offers (variablePlace.test.js).
    assert.deepEqual(offered.map((variable) => variable.name).sort(), ['card-color', 'inline-size', 'shared', 'shared']);
    assert.equal(offered.find((variable) => variable.name === 'inline-size').file, 'src/pages/index.astro');
    assert.equal(offered.find((variable) => variable.name === 'shared').file, undefined, 'a stylesheet variable names no file');
    const card = offered.find((variable) => variable.name === 'card-color');
    assert.equal(card.collection, 'components/Card.astro');
    assert.equal(card.group, '.card');
    assert.equal(card.value, '#123456');
    assert.equal(card.binding, 'var(--card-color)');
    assert.equal(card.type, 'Color');
    assert.equal(offered.find((variable) => variable.name === 'inline-size').type, 'Size');
    assert.equal(offered.find((variable) => variable.name === 'shared').value, 'blue', 'the stylesheet answers for a name in another file');

    setHost({ ...getHost(), nodes: [{ id: 'style', kind: 'raw', name: 'style', inner: ':root { --shared: red; }' }] });
    const onPage = await streamProjectVariables(() => {});
    assert.equal(onPage.find((variable) => variable.name === 'shared').value, 'red', 'the open page answers for itself');
    setHost({ ...getHost(), nodes: [] });

    shared.ensureSharedVars();
    await settle();
    assert.equal(shared.sharedDone, true);
    write('src/pages/index.astro', '<style is:inline>:root { --renamed: 2rem; }</style>\n');
    changed();
    await settle();
    assert.deepEqual(shared.sharedVars.map((variable) => variable.name).sort(), ['card-color', 'renamed', 'shared'], 'a change reaches the picker');
    write('src/pages/index.astro', '<style is:inline>:root { --renamed-again: 2rem; }</style>\n');
    changed();
    await settle();
    assert.ok(
      shared.sharedVars.some((variable) => variable.name === 'renamed-again'),
      'the next change is heard too',
    );
    console.log('style block variables: ok');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
