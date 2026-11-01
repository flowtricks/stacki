// Goal: unset controls show the selected node's computed styles without turning
// inherited values into authored declarations or overwriting explicit values.
// Method: mount real typography and size controls, answer the real canvas query
// protocol with parent styles, then change selection and provide explicit CSS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT } = require('../../helpers/sources.js');

test('computed inheritance fills style controls without authoring CSS', async () => {
  const outfile = path.join(ROOT, 'node_modules/.stacki-test/inherited-styles.bundle.js');
  await require('esbuild').build({
    stdin: {
      contents: `
          export { default as TypographySection } from './src/features/style/TypographySection';
          export { LivePropField } from './src/features/style/SizeKit';
          export { setHost } from './src/features/style/model/host';
          export { setCanvasFrame, receiveCanvasReply } from './src/editor/canvasQuery';`,
      loader: 'tsx',
      resolveDir: ROOT,
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  }
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { TypographySection, LivePropField, setHost, setCanvasFrame, receiveCanvasReply } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const computed = {
    color: 'rgb(12, 34, 56)',
    'font-size': '48px',
    'line-height': '60px',
    'font-family': 'Georgia, serif',
    'font-weight': '600',
    'text-align': 'center',
    'letter-spacing': '2px',
    'text-indent': '8px',
    'white-space': 'pre-wrap',
    'text-transform': 'uppercase',
    'font-style': 'italic',
    'text-shadow': 'rgb(12, 34, 56) 1px 2px 3px',
    '-webkit-text-stroke-color': 'rgb(12, 34, 56)',
    width: '640px',
  };
  let inherited = {};
  let inheritedSources = {};
  const selections = [];
  const writes = [];
  const requests = [];
  let authored = {};
  const props = {
    read: (prop) => authored[prop],
    busy: false,
    setProp: (...args) => writes.push(args),
    liveSetProp: (...args) => writes.push(args),
    clearProp: () => {},
    onProvenance: () => {},
    onSelectSelector: () => {},
  };
  const render = async () => {
    await React.act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          {},
          React.createElement(TypographySection, props),
          React.createElement(LivePropField, {
            ...props,
            prop: 'width',
            label: 'Width',
            placeholder: 'Auto',
          }),
        ),
      ),
    );
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const input = (label) => document.querySelector(`input[aria-label="${label}"]`);
  const wrapper = (label) => input(label).closest('.embed-editor_varconnect');
  const hint = (label) => wrapper(label).querySelector('.embed-editor_varconnect-hint');
  const control = (label) => document.querySelector(`[aria-label="${label}"]`);
  try {
    setHost({
      projectPath: '/project',
      openFilePath: '/project/page.astro',
      selectedId: 'text',
      selectNode: (id) => selections.push(id),
      nodes: [
        {
          id: 'heading',
          kind: 'component',
          name: 'Heading',
          children: [
            { id: 'text', kind: 'text', value: 'Heading' },
            { id: 'other', kind: 'element', name: 'strong', children: [] },
          ],
        },
      ],
      pathOf: (id) => ({ heading: '0', text: '0.0', other: '0.1' })[id],
    });
    setCanvasFrame({
      postMessage: (message) => {
        requests.push(message);
        queueMicrotask(() =>
          receiveCanvasReply({
            id: message.id,
            // Inline text has no markers; its explicit parent context is required.
            found: message.path === '0.1' || message.textParentPath === '0',
            ready: true,
            computedProps: Object.fromEntries(message.props.map((prop) => [prop, computed[prop]])),
            authoredProps: inherited,
            inheritedSources,
            computed: Object.fromEntries(message.compute.map((value) => [value, computed.color])),
          }),
        );
      },
    });
    await render();
    for (const [label, value] of [
      ['Size', '48px'],
      ['Height', '60px'],
      ['Color', 'rgb(12, 34, 56)'],
    ]) {
      assert.equal(input(label).placeholder, value, `${label} shows the computed value`);
      assert.equal(input(label).value, '', `${label} does not become an authored draft`);
    }
    assert.equal(input('Width').placeholder, 'auto', 'width hides computed dimensions');
    assert.equal(input('Width').value, '');
    assert.match(control('Font family').textContent, /Georgia/);
    assert.match(control('Font weight').textContent, /600/);
    assert.equal(control('Text color').querySelector('span').style.background, 'rgb(12, 34, 56)');
    assert.equal(control('Center').getAttribute('aria-checked'), 'true');
    assert.match(control('Text shadows').textContent, /1px/);
    assert.equal(document.querySelectorAll('.u-field-label.is-active').length, 0);
    assert.deepEqual(writes, [], 'reading computed styles never writes CSS');

    inherited = {
      'font-size': 'clamp(2rem, 4vw, 4rem)',
      'line-height': '1.1',
      'font-family': 'var(--font-heading)',
      color: 'var(--heading-accent)',
      width: '40rem',
    };
    inheritedSources = Object.fromEntries(['font-family', 'font-size', 'line-height', 'color'].map((prop) => [prop, { label: '.heading', path: '0' }]));
    await React.act(async () => setHost({ historyTick: 1 }));
    await render();
    assert.equal(input('Size').placeholder, 'clamp(2rem, 4vw, 4rem)');
    assert.ok(requests.every((request) => request.textParentPath === '0'));
    await React.act(async () => setHost({ selectedId: 'other' }));
    await render();
    assert.equal(input('Size').placeholder, 'clamp(2rem, 4vw, 4rem)', 'both siblings agree');
    assert.equal(input('Font family').placeholder, 'var(--font-heading)');
    assert.equal(requests.at(-1).textParentPath, undefined, 'elements keep their own target');
    await React.act(async () => setHost({ selectedId: 'text' }));
    await render();
    assert.equal(input('Height').placeholder, '1.1');
    assert.equal(input('Font family').placeholder, 'var(--font-heading)');
    assert.equal(input('Color').placeholder, 'var(--heading-accent)');
    assert.equal(input('Width').placeholder, 'auto');
    assert.equal(input('Size').value, '', 'inherited declarations remain hints');
    const orange = Array.from(document.querySelectorAll('.embed-editor_prop-orange'));
    for (const label of ['Font', 'Size', 'Height', 'Color']) {
      assert.ok(
        orange.some((element) => element.textContent === label),
        `${label} is orange`,
      );
    }
    const colorLabel = orange.find((element) => element.textContent === 'Color');
    await React.act(async () => colorLabel.click());
    const provenance = document.querySelector('[aria-label="Inherited color"]');
    assert.ok(provenance);
    assert.match(provenance.textContent, /Value comes from:/);
    assert.match(provenance.textContent, /Heading \(.heading\)/);
    assert.equal(provenance.textContent.includes('Clear'), false, 'inherited values cannot reset');
    await React.act(async () => provenance.querySelector('[title^="Select "]').click());
    assert.deepEqual(selections, ['heading'], 'the source link selects the parent element');
    assert.equal(control('Text color').querySelector('span').style.background, 'rgb(12, 34, 56)');
    assert.deepEqual(writes, [], 'displaying the parent declaration never writes an override');

    inherited = {
      ...inherited,
      'font-size': 'var(--h1)',
      'line-height': 'var(--h1-line-height)',
      width: 'calc(var(--space) + var(--gutter))',
    };
    await React.act(async () => setHost({ historyTick: 2 }));
    await render();
    for (const [label, names] of [
      ['Font family', ['font-heading']],
      ['Size', ['h1']],
      ['Height', ['h1-line-height']],
      ['Color', ['heading-accent']],
    ]) {
      const chips = hint(label).querySelectorAll('.embed-editor_varconnect-token-name');
      assert.deepEqual(
        Array.from(chips, (chip) => chip.textContent),
        names,
      );
      assert.equal(input(label).value, '', `${label} chips never become an authored draft`);
      const editor = wrapper(label).querySelector('.embed-editor_varconnect-editor');
      assert.equal(editor.textContent, '', 'inheritance is outside the serialized editor');
    }
    assert.equal(input('Width').placeholder, 'auto');
    assert.ok(hint('Width') === null, 'width does not replace auto with inherited variable chips');
    assert.equal(document.querySelectorAll('.u-field-label.is-active').length, 0);
    assert.deepEqual(writes, [], 'showing inherited chips never writes an override');

    authored = {
      'font-size': {
        source: 'selected',
        overridden: false,
        contributors: [],
        selectedValue: { value: '3rem', important: false },
        winner: { value: '3rem', important: false, selectorText: '.heading' },
      },
    };
    await render();
    assert.equal(input('Size').value, '3rem', 'authored units stay intact');
    assert.ok(hint('Size') === null, 'an explicit value hides the inherited chip');
    assert.deepEqual(writes, []);

    inherited = {};
    inheritedSources = {};
    computed['font-size'] = '24px';
    computed.color = 'rgb(80, 90, 100)';
    computed['text-align'] = 'start';
    computed.direction = 'rtl';
    computed['font-family'] = 'Unlisted Font, serif';
    computed['font-weight'] = '650';
    authored = {};
    await React.act(async () => setHost({ selectedId: 'other' }));
    await render();
    assert.equal(input('Size').placeholder, '24px', 'a new selection reads fresh values');
    assert.equal(document.querySelectorAll('.embed-editor_prop-orange').length, 0);
    assert.equal(input('Color').placeholder, 'rgb(80, 90, 100)');
    assert.ok(document.querySelector('.embed-editor_varconnect-hint') === null);
    assert.equal(input('Font family').placeholder, 'Unlisted Font, serif');
    assert.equal(input('Font weight').placeholder, '650');
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(control('Right').getAttribute('aria-checked'), 'true', 'RTL start aligns right');
  } finally {
    await React.act(async () => root.unmount());
    setCanvasFrame(undefined);
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(global, key, descriptor);
      } else {
        delete global[key];
      }
    }
  }
});
