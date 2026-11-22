// Exercise attribute literal parsing, real paste events, and expanded value editing.
// The object field must preserve rows and reject bounds; the value editor must open
// from a press and provide enough width to read a JavaScript expression. An app's
// `data-stacki-key` is never a row, and every edit to the rows around it (value,
// rename, delete, bulk paste) leaves it on the node with its value. An element
// connected to the component's attributes prop shows the prop's chip in the
// header and its spread as the last row, "+ items in {} rest"; one that is not
// shows the purple + right after the label (or none for an instance, a
// page or a component tag), which spreads an existing rest binding when the
// component has one; Disconnect releases the prop and
// takes out the spread alone; an instance names the tag it is checked against.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'prop-attributes.cjs');
buildSync({
  entryPoints: [repoPath('src/features/props/propAttributes.tsx')],
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
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window']) {
  global[name] = dom.window[name];
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const { AttributesSection, ObjectAttrsField, parseObjectLiteral, serializeObjectLiteral, parseAttrPaste } = require(output);
assert.deepEqual(parseAttrPaste('id="hero" tabindex={2} disabled'), [
  { name: 'id', value: 'hero' },
  { name: 'tabindex', value: '{2}' },
  { name: 'disabled', value: '' },
]);
assert.deepEqual(parseObjectLiteral('{ id: "hero", tabindex: 2, disabled: true }'), [
  { key: 'id', raw: '"hero"' },
  { key: 'tabindex', raw: '2' },
  { key: 'disabled', raw: 'true' },
]);
assert.equal(parseObjectLiteral('{ nested: { key: 1 } }'), undefined);
assert.equal(parseObjectLiteral('{ ...defaults }'), undefined);
assert.equal(parseObjectLiteral('named'), undefined);
// No size limit: a long name is still not an object literal, and more entries than the old cap are all read.
assert.equal(parseObjectLiteral('x'.repeat(100_000)), undefined);
assert.equal(parseObjectLiteral(`{ ${Array(5000).fill('a: 1').join(', ')} }`)?.length, 5000);
assert.equal(parseAttrPaste('x'.repeat(100_000)).length, 1);
assert.equal(parseAttrPaste(Array(5000).fill('x="y"').join(' ')).length, 5000);
assert.equal(serializeObjectLiteral([{ key: 'data-id', raw: '"hero"' }]), '{ "data-id": "hero" }');
assert.ok(serializeObjectLiteral(Array(5000).fill({ key: 'a', raw: '1' })).length > 5000, 'more entries than the old cap are written');
assert.ok(serializeObjectLiteral([{ key: 'a', raw: 'x'.repeat(100_000) }]).length > 100_000, 'a value longer than the old cap is written whole');
const root = createRoot(document.getElementById('root'));
let entries = Object.freeze([
  { key: 'id', raw: '"old"' },
  { key: 'title', raw: '"Title"' },
]);
let writes = 0;
const render = () =>
  act(async () =>
    root.render(
      React.createElement(ObjectAttrsField, {
        entries,
        pill: 'Attributes',
        menu: undefined,
        bindContext: {},
        projectPath: '/project',
        onCommit: (next) => {
          entries = next;
          writes++;
        },
      }),
    ),
  );
const press = async (element) => {
  assert.ok(element);
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await render();
};
const paste = async (text) => {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  const input = document.querySelector('.attr-editor input');
  assert.ok(input);
  await act(async () => input.dispatchEvent(event));
  await render();
};
// The Attributes list over a node that carries an app's node key: the props
// live here and every callback writes into them, as the page model would.
const internalAttributeKept = async () => {
  const key = { type: 'string', value: 'k1kkgbiyvxd6l' };
  let props = { id: { type: 'string', value: 'hero' }, 'data-stacki-key': key, title: { type: 'string', value: 'Title' } };
  const renderKeyed = () =>
    act(async () =>
      root.render(
        React.createElement(AttributesSection, {
          node: { id: 'keyed', props },
          names: Object.keys(props),
          onSetProp: (name, value) => {
            const next = { ...props };
            if (value === undefined) {
              delete next[name];
            } else {
              next[name] = value;
            }
            props = next;
          },
          onSetProps: (_nodeId, patch) => {
            props = { ...props, ...patch };
          },
          onRenameProp: (previous, next) => {
            props = Object.fromEntries(Object.entries(props).map(([name, value]) => [name === previous ? next : name, value]));
          },
        }),
      ),
    );
  const pasteKeyed = async (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    const input = document.querySelector('.attr-editor input');
    assert.ok(input);
    await act(async () => input.dispatchEvent(event));
    await renderKeyed();
  };
  const rowNames = () => [...document.querySelectorAll('.attr-row .attr-name')].map((element) => element.textContent);
  await renderKeyed();
  assert.deepEqual(rowNames(), ['id', 'title'], 'the node key is not an attribute row');
  assert.doesNotMatch(document.body.textContent, /data-stacki-key|k1kkgbiyvxd6l/, 'neither its name nor its value shows');
  // Delete one attribute from its row.
  await act(async () => document.querySelectorAll('.attr-row .row-action')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await renderKeyed();
  assert.deepEqual(Object.keys(props), ['id', 'data-stacki-key'], 'deleting another attribute keeps the key');
  // Rename and re-value the other through the editor's paste.
  await act(async () => document.querySelector('.attr-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await renderKeyed();
  await pasteKeyed('data-id="lead"');
  assert.deepEqual(props['data-stacki-key'], key, 'renaming another attribute keeps the key and its value');
  assert.deepEqual(props['data-id'], { type: 'string', value: 'lead' });
  // Several pairs pasted at once write one patch beside the key.
  await act(async () => document.querySelector('button[title="Add attribute"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await renderKeyed();
  await pasteKeyed('role="button" tabindex={0}');
  assert.deepEqual(props['data-stacki-key'], key, 'a bulk paste keeps the key and its value');
  assert.deepEqual(
    rowNames(),
    Object.keys(props).filter((name) => name !== 'data-stacki-key'),
    'the rows are every other attribute',
  );
};
const connectedRest = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const section = createRoot(host);
  const released = [];
  const replaced = [];
  const newProp = (restLocal) => ({
    componentName: 'Card.astro',
    propKeys: [],
    restLocal,
    create: () => ({ ok: true, value: 'rest' }),
    releaseRest: (local) => released.push(local),
  });
  const props = {
    alt: { type: 'string', value: 'Photo' },
    'data-plain': { type: 'string', value: 'text' },
    '...rest': { type: 'spread', value: 'rest' },
  };
  const draw = (restLocal, extra = {}) =>
    act(async () =>
      section.render(
        React.createElement(AttributesSection, {
          node: { id: 'image', props },
          names: Object.keys(props),
          tag: 'img',
          bindContext: { newProp: newProp(restLocal), frontmatter: '' },
          onSetProp: () => undefined,
          onRenameProp: () => undefined,
          onReplaceProps: (next) => replaced.push(next),
          ...extra,
        }),
      ),
    );
  await draw('rest');
  const header = host.querySelector('.attrs-label-row');
  assert.ok(header.querySelector('.attrs-bound-chip'), 'connected: the chip names the prop');
  assert.match(header.querySelector('.attrs-bound-chip').textContent, /rest/);
  assert.ok(header.querySelector('.attrs-connect') === null, 'connected: no purple +, so it is never offered twice');
  const rows = [...host.querySelectorAll('.attrs-list > .attr-row')];
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.querySelector('.attr-name').textContent),
    ['alt', 'data-plain'],
    'the attributes before the spread are rows an instance overrides',
  );
  const items = rows.at(-1);
  assert.ok(items.classList.contains('attrs-items-row'), 'the spread is the last row');
  assert.match(items.textContent, /items in\s*rest/);
  assert.equal(items.querySelector('[role="img"]').getAttribute('aria-label'), 'Attributes passed to this component are added here');
  await act(async () => header.querySelector('.attrs-bound-chip').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const disconnect = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes('Disconnect'));
  assert.ok(disconnect, 'the chip’s menu offers Disconnect');
  await act(async () => disconnect.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(released, ['rest'], 'the prop’s removal is held first, for the same undo step');
  assert.deepEqual(Object.keys(replaced.at(-1)), ['alt', 'data-plain'], 'only the spread is taken out');
  await draw(undefined);
  const unbound = host.querySelector('.attrs-label-row');
  const order = [...unbound.children].map((child) => child.className);
  assert.ok(order[0].includes('prop-label'), 'the label first');
  assert.ok(order[1].includes('attrs-connect'), 'not connected: the purple + right after the label');
  assert.equal(unbound.querySelector('.attrs-connect').getAttribute('aria-label'), 'Connect attributes to a prop');
  assert.ok(unbound.querySelector('.attrs-connect').classList.contains('bind-handle'), 'the shared bind handle, as every field’s connect dot');
  assert.ok(unbound.querySelector('.attrs-connect > .bind-dot'), 'a small dot at rest');
  assert.ok(unbound.querySelector('.attrs-connect > .bind-plus'), 'the + it grows into on hover');
  // A jsdom document applies no stylesheet, so the reveal is read from the CSS: the field rule (`> label > .bind-handle`) cannot reach this header row.
  const css = fs.readFileSync(repoPath('src/features/props/loopSettings.css'), 'utf8');
  const rest = /\.attrs-label-row > \.bind-handle\.attrs-connect \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rest, /opacity: 1;/, 'the header dot is shown at rest');
  assert.match(rest, /pointer-events: auto;/, 'and can be pressed');
  assert.match(css, /\.attrs-label-row > \.bind-handle\.attrs-connect:focus-visible \{[^}]*width: 18px;/, 'keyboard focus grows it as hover does');
  assert.ok(unbound.lastElementChild.hasAttribute('data-attribute-editor-trigger'), 'the grey + last');
  assert.ok(host.querySelector('.attrs-items-row') === null, 'not connected: the spread is a plain spread row');
  // The component already passes attributes on elsewhere: the + spreads that binding here, declaring nothing.
  const plain = { alt: { type: 'string', value: 'Photo' }, class: { type: 'string', value: 'card' } };
  await draw('rest', { node: { id: 'image', props: plain }, names: Object.keys(plain) });
  const spreadOffer = host.querySelector('.attrs-label-row .attrs-connect');
  assert.equal(spreadOffer.getAttribute('aria-label'), 'Connect attributes to rest');
  await act(async () => spreadOffer.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(Object.keys(replaced.at(-1)), ['alt', '...rest', 'class'], 'the spread after the defaults, the class after it');
  // Not offered where nothing can be typed by a tag: an instance, a page, a custom component name.
  await draw(undefined, { tag: undefined });
  assert.equal(host.querySelector('.attrs-connect') ?? undefined, undefined, 'an instance gets no +');
  await draw(undefined, { bindContext: { frontmatter: '' } });
  assert.equal(host.querySelector('.attrs-connect') ?? undefined, undefined, 'a page gets no +');
  await draw(undefined, { tag: 'Card' });
  assert.equal(host.querySelector('.attrs-connect') ?? undefined, undefined, 'a capitalised tag is a component, not an element');
  await draw(undefined, { tag: undefined, onReplaceProps: undefined, passedTo: 'img', bindContext: {} });
  assert.equal(host.querySelector('.attrs-tag-type').textContent, 'img attributes', 'an instance names the tag it is checked against');
  await act(async () => section.unmount());
  host.remove();
};
(async () => {
  await connectedRest();
  await render();
  await press(document.querySelector('.attr-row'));
  await paste('data-id="hero"');
  assert.deepEqual(entries, [
    { key: 'data-id', raw: '"hero"' },
    { key: 'title', raw: '"Title"' },
  ]);
  assert.equal(writes, 1);
  await paste('title="Updated" tabindex={2} disabled');
  assert.deepEqual(entries, [
    { key: 'data-id', raw: '"hero"' },
    { key: 'title', raw: '"Updated"' },
    { key: 'tabindex', raw: '2' },
    { key: 'disabled', raw: 'true' },
  ]);
  assert.ok(document.querySelector('.attr-editor') === null);
  assert.equal(writes, 2);
  await press(document.querySelector('button[title="Add attribute"]'));
  await paste('role="button"');
  assert.deepEqual(entries.at(-1), { key: 'role', raw: '"button"' });
  const before = writes;
  // No size limit: a value longer than the old cap is pasted whole, as one more write.
  await paste(`id="${'x'.repeat(8193)}"`);
  assert.equal(writes, before + 1);
  assert.equal(entries.find((entry) => entry.key === 'id')?.raw.length, 8193 + 2);
  await act(async () =>
    root.render(
      React.createElement(AttributesSection, {
        node: {
          id: 'section',
          props: {
            // Code in an attribute is edited as code. (class:list is not used here: its own editor draws every
            // part of a list, an object too, since c8092bee.)
            'data-items': { type: 'expr', value: '["icon", { [variant]: true }]' },
            '...rest': { type: 'spread', value: 'rest' },
          },
        },
        names: ['data-items', '...rest'],
        bindContext: { frontmatter: 'const variant = "medium";' },
        onSetProp: () => {},
        onRenameProp: () => {},
      }),
    ),
  );
  await act(async () => document.querySelector('.attr-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const activeRow = document.querySelector('.attr-row');
  await act(async () => {
    activeRow.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    activeRow.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    activeRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.ok(document.querySelector('.attr-editor') === null, 'clicking the active attribute row closes its editor without reopening it');
  await act(async () => activeRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const valueField = document.querySelector('.attr-value-field');
  assert.ok(valueField);
  valueField.getBoundingClientRect = () => new dom.window.DOMRect(600, 300, 280, 40);
  await act(async () => valueField.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  assert.ok(document.querySelector('.attr-editor.var-src') === null);
  assert.ok(valueField.querySelector('.cm-lineWrapping'));
  await act(async () => document.querySelector('button[title="Expand value"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const expanded = document.querySelector('.attr-editor.var-src');
  assert.ok(expanded);
  assert.equal(expanded.style.width, '760px');
  const spreadRow = document.querySelectorAll('.attr-row')[1];
  assert.equal(spreadRow.querySelector('.attr-name').textContent, '{...rest}');
  assert.ok(spreadRow.querySelector('.attr-eq') === null);
  assert.ok(spreadRow.querySelector('.attr-value') === null);
  // A spread is code, never a name and a value: its row opens the editor on that code.
  assert.ok(spreadRow.querySelector('.attr-name code'), 'the spread is drawn as code');
  await act(async () => spreadRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const spreadEditor = document.querySelector('.attr-editor:not(.var-src)');
  assert.equal(spreadEditor.querySelector('input').value, '{...rest}', 'its Name is the spread');
  assert.doesNotMatch(spreadEditor.textContent, /Value/, 'with no value');
  assert.match(spreadEditor.textContent, /Spread: passes every property of rest/);
  await internalAttributeKept();
  await act(async () => root.unmount());
  dom.window.close();
  console.log('prop-attributes: parse bounds, single/bulk object pastes and row preservation passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
