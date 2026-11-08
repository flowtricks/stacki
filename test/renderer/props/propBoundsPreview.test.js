// Goal: two promises the instance Settings panel makes about a component's props.
// A number prop with a declared range (`@min 0 @max 1`) never writes a value
// outside it: typing past either end is held in the field and clamped when it is
// committed (blur or Enter), and the steppers and arrow keys stop at the bounds.
// A union prop's dropdown previews each option on the canvas while it is hovered
// and writes nothing; leaving the options or pressing Escape puts the page back;
// a click commits with exactly one source write.
// Method: the real PropsPanel, bundled with esbuild and mounted in jsdom, its
// onSetProp recording every write and re-rendering with it, as the app does. The
// preview is Desktop's own (desktopPropPreview.ts), its canvas messages recorded
// and its debounce run by a fake clock, so each case reads what the canvas was
// told and what the source was given. The pure helpers the number field uses are
// pinned directly, negative space included: a partial number, a value off the
// step, and a draft that is no number at all.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/prop-bounds-preview');
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'entry.js');
fs.writeFileSync(
  entry,
  [
    `export { default as PropsPanel } from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};`,
    `export { PropPreviewContext } from ${JSON.stringify(repoPath('src/features/props/propPreviewContext.ts'))};`,
    `export { numberTyped, numberCommitted, numberStepped } from ${JSON.stringify(repoPath('src/features/props/propFieldModel.ts'))};`,
    `export { createDesktopPropPreview, propPreviewInstance, DESKTOP_PROP_PREVIEW_DEBOUNCE_MS } from ${JSON.stringify(repoPath('src/app/shell/desktopPropPreview.ts'))};`,
  ].join('\n'),
);
const output = path.join(directory, 'bundle.cjs');
buildSync({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window']) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const ux = require(output);
require('../../helpers/popupDom.js').installPopupDOM(dom.window);

const root = createRoot(document.getElementById('root'));
const noop = () => {};
const BASE = {
  slotOptions: [],
  takesSlotText: false,
  tagOptions: [],
  projectClasses: [],
  layouts: [],
  bindContext: {},
  allowAttrs: false,
  onSetProps: noop,
  onRenameProp: noop,
  onSetText: noop,
  onSetContent: noop,
  onSetInline: noop,
  onOpenCode: noop,
  onSetComment: noop,
};

const INTENSITY = { name: 'intensity', type: 'number', optional: true, default: 0.55, min: 0, max: 1, step: 0.05 };
const VARIANTS = ['inherit', 'display', 'h1', 'h2', 'h3', 'large', 'main', 'small'];
const VARIANT = { name: 'variant', type: 'enum', optional: true, options: VARIANTS };

// One mounted panel: its values, the writes it made, and a way to re-render.
function mount(schema, initial = {}, preview = undefined) {
  const panel = { values: { ...initial }, writes: [], render: noop };
  panel.render = () =>
    root.render(
      React.createElement(
        ux.PropPreviewContext.Provider,
        { value: preview },
        React.createElement(ux.PropsPanel, {
          ...BASE,
          schema,
          valuePolicy: 'instance',
          node: { id: 'n0', kind: 'component', name: 'Heading', props: panel.values, children: undefined },
          onSetProp: (name, value, immediate) => {
            panel.writes.push({ name, value, immediate });
            const next = { ...panel.values };
            if (value === undefined) {
              delete next[name];
            } else {
              next[name] = value;
            }
            panel.values = next;
            panel.render();
          },
        }),
      ),
    );
  act(panel.render);
  return panel;
}
const unmount = () => act(() => root.render(React.createElement(React.Fragment)));

function field(name) {
  const found = [...document.querySelectorAll('.prop-label')].find((item) => item.firstChild?.textContent === name || item.textContent === name);
  assert.ok(found, `a label for ${name}`);
  return found.closest('.props-field');
}
function typeInto(input, text) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
const key = (element, name, extra = {}) =>
  act(() => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra })));
const blur = (input) => act(() => input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
const values = (panel, name) => panel.writes.filter((write) => write.name === name).map((write) => write.value?.value);

test('the number helpers hold what the range rejects and clamp it on commit', () => {
  assert.deepEqual(ux.numberTyped(INTENSITY, ''), { kind: 'clear' });
  assert.deepEqual(ux.numberTyped(INTENSITY, '0.5'), { kind: 'write', text: '0.5' });
  assert.deepEqual(ux.numberTyped(INTENSITY, '1.1'), { kind: 'hold', text: '1.1' }, 'past max is held');
  assert.deepEqual(ux.numberTyped(INTENSITY, '-0.2'), { kind: 'hold', text: '-0.2' }, 'past min is held');
  assert.deepEqual(ux.numberTyped(INTENSITY, '-'), { kind: 'hold', text: '-' }, 'a partial number is held');
  assert.deepEqual(ux.numberTyped(INTENSITY, '0.33'), { kind: 'hold', text: '0.33' }, 'off the step is held');
  assert.deepEqual(ux.numberTyped({ name: 'n', type: 'number' }, '1e9'), { kind: 'write', text: '1e9' }, 'an unbounded field writes what is typed');
  assert.equal(ux.numberCommitted(INTENSITY, '1.1'), '1');
  assert.equal(ux.numberCommitted(INTENSITY, '-4'), '0');
  assert.equal(ux.numberCommitted(INTENSITY, '0.33'), '0.35', 'rounded onto the step');
  assert.equal(ux.numberCommitted(INTENSITY, 'abc'), undefined, 'no number: the source value stays');
  assert.equal(ux.numberStepped(INTENSITY, 1, 1, { shiftKey: false, altKey: false }), '1', 'a step stops at max');
  assert.equal(ux.numberStepped(INTENSITY, 0, -1, { shiftKey: true, altKey: false }), '0', 'a big step stops at min');
  assert.equal(ux.numberStepped(INTENSITY, 0.5, 1, { shiftKey: false, altKey: false }), '0.55', 'the field moves by its own step');
  const exclusive = { name: 'n', type: 'number', min: 0, minExclusive: true, max: 10 };
  assert.ok(Number(ux.numberCommitted(exclusive, '0')) > 0, 'an exclusive bound is never reached');
});

test('typing past max or min writes nothing out of range, and commit clamps', () => {
  const panel = mount([INTENSITY], { intensity: { type: 'expr', value: '0.5' } });
  const input = field('intensity').querySelector('input');
  assert.match(input.getAttribute('title'), /Accepts 0–1, steps of 0.05/, 'the range is in the tooltip');
  typeInto(input, '1.1');
  assert.equal(input.value, '1.1', 'what is typed stays visible');
  assert.deepEqual(values(panel, 'intensity'), [], 'nothing past max reaches the source');
  key(input, 'Enter');
  assert.deepEqual(panel.writes.at(-1), { name: 'intensity', value: { type: 'expr', value: '1' }, immediate: true }, 'Enter clamps to max');
  assert.equal(input.value, '1');
  typeInto(input, '-3');
  assert.equal(values(panel, 'intensity').length, 1, 'past min is held too');
  blur(input);
  assert.deepEqual(panel.writes.at(-1)?.value, { type: 'expr', value: '0' }, 'blur clamps to min');
  typeInto(input, '0.25');
  assert.deepEqual(panel.writes.at(-1)?.value, { type: 'expr', value: '0.25' }, 'an accepted number is written as typed');
  typeInto(input, 'oops');
  blur(input);
  assert.deepEqual(panel.values.intensity, { type: 'expr', value: '0.25' }, 'a draft that is no number reverts');
  assert.equal(input.value, '0.25');
  for (const write of panel.writes) {
    const number = Number(write.value?.value);
    assert.ok(number >= 0 && number <= 1, `every write is inside the range (${write.value?.value})`);
  }
  unmount();
});

test('the steppers and arrow keys stop at the bounds', () => {
  const panel = mount([INTENSITY], { intensity: { type: 'expr', value: '0.95' } });
  const input = field('intensity').querySelector('input');
  key(input, 'ArrowUp');
  assert.deepEqual(panel.values.intensity, { type: 'expr', value: '1' });
  key(input, 'ArrowUp', { shiftKey: true });
  assert.deepEqual(panel.values.intensity, { type: 'expr', value: '1' }, 'ArrowUp at max stays at max');
  act(() => field('intensity').querySelector('button[aria-label="Increase"]').click());
  assert.deepEqual(panel.values.intensity, { type: 'expr', value: '1' }, 'the stepper at max stays at max');
  act(() =>
    field('intensity')
      .querySelector('button[aria-label="Decrease"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true })),
  );
  assert.deepEqual(panel.values.intensity, { type: 'expr', value: '0.5' }, 'Shift steps by ten of its steps');
  typeInto(input, '7');
  key(input, 'ArrowDown');
  assert.deepEqual(panel.values.intensity, { type: 'expr', value: '1' }, 'a step from an out-of-range draft lands inside');
  assert.ok(
    panel.writes.every((write) => Number(write.value?.value) <= 1),
    'no step wrote past max',
  );
  unmount();
});

// A fake clock for the preview's debounce: scheduled runs wait until `tick`.
function previewHarness() {
  const sent = [];
  const queue = [];
  const preview = ux.createDesktopPropPreview(
    { component: 'src/components/typography/Heading.astro', target: '3' },
    {
      send: (message) => sent.push(message),
      schedule: (delayMs, run) => {
        assert.equal(delayMs, ux.DESKTOP_PROP_PREVIEW_DEBOUNCE_MS);
        const job = { run, live: true };
        queue.push(job);
        return () => {
          job.live = false;
        };
      },
    },
  );
  const tick = () => {
    for (const job of queue.splice(0)) {
      if (job.live) {
        job.run();
      }
    }
  };
  return { preview, sent, tick };
}
const option = (label) => [...document.querySelectorAll('.dd-option')].find((row) => row.querySelector('.dd-option-label')?.textContent === label);
// React reads enter and leave from mouseover and mouseout, as a browser sends them.
const pointerInto = () => new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body });
const pointerOutOf = () => new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body });
const hover = async (label) => {
  await act(async () => option(label).dispatchEvent(pointerInto()));
  // Dropdown waits one frame before it previews (Dropdown.tsx, useDropdownActions).
  await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve())));
};

test('hovering an option previews it on the canvas, and leaving reverts, with no write', async () => {
  const { preview, sent, tick } = previewHarness();
  const panel = mount([VARIANT], { variant: { type: 'string', value: 'h2' } }, preview);
  const trigger = field('variant').querySelector('.dd-trigger');
  await act(async () => trigger.dispatchEvent(pointerInto()));
  await act(async () => trigger.click());
  await hover('display');
  await hover('h1');
  assert.deepEqual(sent, [], 'debounced: nothing is asked for while the pointer is moving');
  tick();
  assert.deepEqual(sent, [
    { type: 'avb:variant', override: { component: 'src/components/typography/Heading.astro', target: '3', prop: 'variant', value: 'h1' } },
  ]);
  await act(async () => document.querySelector('.dd-list').dispatchEvent(pointerOutOf()));
  assert.deepEqual(sent.at(-1), { type: 'avb:variant-cancel' }, 'moving off the options reverts the canvas');
  await hover('large');
  tick();
  assert.equal(sent.at(-1).override.value, 'large');
  key(trigger, 'Escape');
  assert.deepEqual(sent.at(-1), { type: 'avb:variant-cancel' }, 'Escape reverts the canvas');
  assert.deepEqual(panel.writes, [], 'a preview never writes to the source');
  assert.deepEqual(panel.values.variant, { type: 'string', value: 'h2' });
  unmount();
  preview.dispose();
});

test('clicking a previewed option commits it with exactly one source write', async () => {
  const { preview, sent, tick } = previewHarness();
  const panel = mount([VARIANT], { variant: { type: 'string', value: 'h2' } }, preview);
  const trigger = field('variant').querySelector('.dd-trigger');
  await act(async () => trigger.dispatchEvent(pointerInto()));
  await act(async () => trigger.click());
  await hover('display');
  tick();
  assert.equal(sent.at(-1).override.value, 'display');
  await act(async () => option('display').click());
  tick();
  assert.deepEqual(panel.writes, [{ name: 'variant', value: { type: 'string', value: 'display' }, immediate: true }], 'one write: the pick');
  assert.deepEqual(sent.at(-1), { type: 'avb:variant-commit' }, 'the canvas keeps the preview for the write to replace');
  assert.equal(sent.filter((message) => message.type === 'avb:variant-cancel').length, 0, 'a commit is not undone');
  unmount();
  preview.dispose();
  assert.deepEqual(sent.at(-1), { type: 'avb:variant-commit' }, 'nothing is left to clean up after a commit');
});

test('a preview always cleans up, and an instance outside the project has none', () => {
  const { preview, sent, tick } = previewHarness();
  preview.prepare('variant', VARIANTS);
  preview.hover('h3');
  preview.dispose();
  tick();
  assert.deepEqual(sent, [], 'a pending hover is dropped with its panel');
  preview.hover('h3');
  tick();
  preview.dispose();
  assert.deepEqual(sent.at(-1), { type: 'avb:variant-cancel' }, 'a shown preview is reverted when its panel goes');
  preview.hover('constructor');
  assert.equal(ux.propPreviewInstance('/p/node_modules/x/Card.astro', '/p', '3'), undefined, 'a package component is not marked');
  assert.equal(ux.propPreviewInstance('/p/src/components/Card.astro', '/p', undefined), undefined, 'no marker path, no preview');
  assert.deepEqual(ux.propPreviewInstance('/p/src/components/Card.astro', '/p/', 'src/pages/x.astro|2'), {
    component: 'src/components/Card.astro',
    target: 'src/pages/x.astro|2',
  });
});
