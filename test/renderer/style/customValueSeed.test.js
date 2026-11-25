// Goal: the large value editor (`=` in a style field) opens on the value the field shows, and opening
// it never writes. A field whose selector sets nothing still shows the cascade's winner (`.heading {
// color: var(--text) }`, a colour from `body`, an inline style) as its hint; the editor used to open
// empty there. It must open on that winner as written, with its variables drawn as chips, and close
// without a write unless the text was edited.
//
// Method: the seeding rule (model/customValueSeed.ts) is checked as a table first. Then the real
// VariableConnect is bundled and mounted in jsdom around a plain input, with the page's cascade answer
// stubbed (model/computedStyle.ts useDeclaredValue reads a table this test fills). Each row presses
// `=` in the field and reads the editor's opening text and chip count; the cascaded row then closes the
// editor by Enter, Escape and an edit, counting the writes that reach onPick. The key is pressed in
// fields for several properties, since every style input opens the editor through this one wrapper.
// Run it alone with `node test/renderer/style/customValueSeed.test.js`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const connectBundle = path.join(buildDirectory, 'custom-value-seed-connect.bundle.js');
  const modelBundle = path.join(buildDirectory, 'custom-value-seed-model.bundle.js');
  const common = {
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  };
  await esbuild.build({ ...common, entryPoints: [repoPath('src/features/style/model/customValueSeed.ts')], outfile: modelBundle });
  await esbuild.build({
    ...common,
    entryPoints: [repoPath('src/features/style/VariableConnect.tsx')],
    outfile: connectBundle,
    plugins: [
      stubSources('custom-value-seed-stubs', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            export async function streamProjectVariables(onAdd) {
              onAdd({ name: 'text', collection: 'Colors', group: '', value: '#111111', binding: 'var(--text)', type: 'Color' });
              return [];
            }
            export const __stub = true;
          `,
          loader: 'js',
        }),
        // The page's cascade: the declared winner per property, as this test sets it.
        'src/features/style/model/computedStyle.ts': () => ({
          contents: `
            export function useDeclaredValue(prop) {
              const table = globalThis.__declaredValues || {};
              return prop === '' ? '' : (table[prop] || '');
            }
          `,
          loader: 'js',
        }),
      }),
    ],
  });

  // ---- The rule, as a table. ----
  const { customValueSeed, customValueWrites } = require(modelBundle);
  const seedRows = [
    { name: 'own declaration', own: 'var(--text)', declared: 'var(--ink)', text: 'var(--text)', source: 'own' },
    { name: 'cascaded variable', own: '', declared: 'var(--text)', text: 'var(--text)', source: 'declared' },
    { name: 'inherited from an ancestor', own: '', declared: '#222222', text: '#222222', source: 'declared' },
    { name: 'inline style', own: '', declared: 'rgb(1, 2, 3)', text: 'rgb(1, 2, 3)', source: 'declared' },
    { name: 'browser default only', own: '', declared: '', text: '', source: 'none' },
    { name: 'variable with a fallback', own: '', declared: 'var(--text, #000)', text: 'var(--text, #000)', source: 'declared' },
    { name: 'blank own text', own: '  ', declared: 'var(--text)', text: 'var(--text)', source: 'declared' },
  ];
  for (const row of seedRows) {
    const seed = customValueSeed({ own: row.own, declared: row.declared });
    assert.equal(seed.text, row.text, `${row.name}: seeded text`);
    assert.equal(seed.source, row.source, `${row.name}: seed source`);
  }
  const inheritedSeed = customValueSeed({ own: '', declared: 'var(--text)' });
  assert.equal(customValueWrites(inheritedSeed, '', 'var(--text)'), false, 'an unchanged inherited seed is not a write');
  assert.equal(customValueWrites(inheritedSeed, '', ' var(--text) '), false, 'whitespace around an inherited seed is not a write');
  assert.equal(customValueWrites(inheritedSeed, '', ''), false, 'an emptied inherited seed is not a write');
  assert.equal(customValueWrites(inheritedSeed, '', 'var(--text) !important'), true, 'an edited inherited seed is a write');
  const ownSeed = customValueSeed({ own: '2rem', declared: '' });
  assert.equal(customValueWrites(ownSeed, '2rem', '2rem'), false, 'the own value unchanged is not a write');
  assert.equal(customValueWrites(ownSeed, '2rem', '3rem'), true, 'the own value changed is a write');
  const noSeed = customValueSeed({ own: '', declared: '' });
  assert.equal(customValueWrites(noSeed, '', '1rem'), true, 'typing into an empty editor is a write');
  assert.throws(() => customValueWrites({ text: '', source: 'declared' }, '', 'x'), /a declared seed carries its text/);

  // ---- The real field. ----
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.InputEvent = dom.window.InputEvent;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const VariableConnect = require(connectBundle).default;

  const mount = async ({ value, prop, declared }) => {
    globalThis.__declaredValues = { [prop]: declared };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const writes = [];
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { code: true, prop, canvasProperty: prop, ariaLabel: prop, onPick: (next) => writes.push(next) },
          React.createElement('input', { className: 'u-input', value, placeholder: declared, onChange() {} }),
        ),
      );
    });
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, writes, done };
  };
  const pressEquals = async (host) => {
    const field = host.querySelector('.embed-editor_varconnect-editor');
    assert.ok(field, 'the field has its token editor');
    await act(async () => {
      field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
    });
  };
  const editorBox = () => document.querySelector('.var-custom') ?? undefined;
  const openingText = () => editorBox()?.querySelector('textarea')?.value;
  const chipCount = () => editorBox()?.querySelectorAll('.embed-editor_varconnect-editor .embed-editor_varconnect-token').length ?? 0;
  const keyInEditor = async (key) => {
    const rich = editorBox()?.querySelector('.embed-editor_varconnect-editor');
    assert.ok(rich, 'the editor has its token field');
    await act(async () => {
      rich.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  };

  const fieldRows = [
    { name: 'own declaration', value: 'var(--text)', declared: '', text: 'var(--text)', chips: 1 },
    { name: 'cascaded variable', value: '', declared: 'var(--text)', text: 'var(--text)', chips: 1 },
    { name: 'inherited from an ancestor', value: '', declared: '#222222', text: '#222222', chips: 0 },
    { name: 'inline style', value: '', declared: 'rgb(1, 2, 3)', text: 'rgb(1, 2, 3)', chips: 0 },
    { name: 'browser default only', value: '', declared: '', text: '', chips: 0 },
    { name: 'variable with a fallback', value: '', declared: 'var(--text, #000)', text: 'var(--text, #000)', chips: 1 },
  ];
  for (const row of fieldRows) {
    const { host, writes, done } = await mount({ value: row.value, prop: 'color', declared: row.declared });
    await pressEquals(host);
    assert.ok(editorBox(), `${row.name}: = opens the editor`);
    assert.equal(openingText(), row.text, `${row.name}: the editor opens on the shown value`);
    assert.equal(chipCount(), row.chips, `${row.name}: the editor draws the value's variables as chips`);
    await keyInEditor('Enter');
    assert.equal(editorBox(), undefined, `${row.name}: Enter closes the editor`);
    assert.equal(writes.length, 0, `${row.name}: Enter on the unchanged value writes nothing`);
    await done();
  }

  // Escape on the inherited seed writes nothing.
  {
    const { host, writes, done } = await mount({ value: '', prop: 'color', declared: 'var(--text)' });
    await pressEquals(host);
    assert.equal(openingText(), 'var(--text)', 'escape row: opens on the inherited value');
    await act(async () => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.equal(editorBox(), undefined, 'Escape closes the editor');
    assert.equal(writes.length, 0, 'Escape writes nothing');
    await done();
  }

  // An edited inherited seed writes once, the edited text, to this field's selector only.
  {
    const { host, writes, done } = await mount({ value: '', prop: 'color', declared: 'var(--text)' });
    await pressEquals(host);
    const rich = editorBox()?.querySelector('.embed-editor_varconnect-editor');
    assert.ok(rich, 'edit row: the editor has its token field');
    await act(async () => {
      rich.appendChild(document.createTextNode(' !important'));
      rich.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    });
    await keyInEditor('Enter');
    assert.equal(writes.length, 1, 'an edit writes once');
    assert.equal(writes[0], 'var(--text) !important', 'the write is the edited text');
    await done();
  }

  // Every property's field opens the editor on its inherited value through the same wrapper.
  for (const prop of ['color', 'height', 'gap', 'font-family', 'box-shadow', 'transition', 'background-color', 'border-width']) {
    const { host, writes, done } = await mount({ value: '', prop, declared: 'var(--text)' });
    await pressEquals(host);
    assert.equal(openingText(), 'var(--text)', `${prop}: = opens on the inherited value`);
    await keyInEditor('Enter');
    assert.equal(writes.length, 0, `${prop}: closing unchanged writes nothing`);
    await done();
  }

  // A field that is one part of a value (no canvasProperty) has no cascade answer to open on.
  {
    globalThis.__declaredValues = { color: 'var(--text)' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(VariableConnect, { code: true, prop: 'color', onPick() {} }, React.createElement('input', { value: '', onChange() {} })));
    });
    await pressEquals(host);
    assert.equal(openingText(), '', 'a part-of-a-value field opens empty');
    await act(async () => root.unmount());
    host.remove();
  }

  console.log('custom-value-seed: passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
