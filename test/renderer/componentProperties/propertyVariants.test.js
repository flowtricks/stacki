// Goal: a prop with variant rules is configured with controls, never text: the
// controller (`variant`, `element`) shows its options (rename, Default, add,
// delete) and the grid of every prop against every option; a ruled prop
// (`label`, `href`) shows one Allowed / Required / Not allowed switch per
// option; each control writes exactly the TypeScript edit it stands for; a
// read-only group is drawn disabled with its one-word reason.
// Method: the real Properties panel is mounted in jsdom over the Lumos Button
// fixture, with main's real reader and writer (`readComponentProperties`,
// `editPropertyDefinition`) behind a stub bridge. Each test drives the controls
// as a person would (clicks, typing, keys) and compares the bytes written
// with the fixture plus the expected replacement.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');

const BUTTON = fs.readFileSync(repoPath('test/fixtures/variantRules/Button.astro'), 'utf8');
const UNDO = '00000000-0000-4000-8000-000000000000';

async function bundle() {
  const directory = repoPath('node_modules/.stacki-test/properties');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'variants.js');
  await esbuild.build({
    stdin: {
      contents: `export {default as Panel} from './src/features/componentProperties/ComponentPropertiesPanel';
       export { NEXT_STATE, newOptionValue } from './src/features/componentProperties/PropertyVariants';`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return outfile;
}

let modules;
test.before(async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Window', 'DOMRect']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => [];
  modules = require(await bundle());
});

function replaced(source, from, to) {
  assert.equal(source.split(from).length, 2, `expected exactly one ${JSON.stringify(from)}`);
  return source.replace(from, () => to);
}

async function mountPanel(source) {
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  let data = readComponentProperties(source);
  window.avb = {
    onFsChanged: () => () => {},
    componentProperties: async () => ({ ok: true, value: data }),
    editComponentProperties: async (request) => {
      const result = editPropertyDefinition(request.source, request.change);
      if (!result.ok) {
        return result;
      }
      data = readComponentProperties(result.value);
      return { ok: true, value: { ...data, undo: UNDO } };
    },
    revertComponentProperties: async () => ({ ok: true, value: { undo: UNDO } }),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.Panel, {
        projectPath: '/site',
        file: '/site/src/components/Button.astro',
        name: 'Button',
        flushSave: async () => {},
        onSavePhase: () => {},
        onSaved: async () => {},
      }),
    ),
  );
  const click = async (element) => {
    assert.ok(element, 'the control exists');
    await act(async () => element.click());
  };
  const section = () => container.querySelector('.property-variants');
  return {
    source: () => data.source,
    section,
    click,
    open: async (name) => {
      const row = [...container.querySelectorAll('.property-row-main')].find((button) => button.textContent.startsWith(name));
      await click(row);
    },
    labelled: (label) => container.querySelector(`[aria-label="${label}"]`),
    type: async (input, value) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      }),
    key: async (element, key) => act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('helpers: a cell turns Not allowed, Allowed, Required, round again; new options take a free name', () => {
  assert.deepEqual(modules.NEXT_STATE, { forbidden: 'optional', optional: 'required', required: 'forbidden' });
  const options = (values) => ({ options: values.map((value) => ({ value, fallback: false, rules: [] })) });
  assert.equal(modules.newOptionValue(options(['main']), 'option'), 'option');
  assert.equal(modules.newOptionValue(options(['option', 'option 2']), 'option'), 'option 3');
  assert.equal(modules.newOptionValue(options([]), 'bad"word'), 'option');
});

test('the controller shows its options and the grid, with no text rules', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  const section = panel.section();
  assert.ok(section, 'the Variants section is drawn');
  assert.equal(document.querySelector('.property-conditions') ?? undefined, undefined);
  assert.deepEqual(
    [...section.querySelectorAll('.variant-option input')].map((input) => input.value),
    ['main', 'link', 'play', 'close', 'arrow'],
  );
  assert.deepEqual(
    [...section.querySelectorAll('.variant-default')].map((button) => button.getAttribute('aria-pressed')),
    ['true', 'false', 'false', 'false', 'false'],
  );
  assert.deepEqual(
    [...section.querySelectorAll('.variant-matrix-prop')].map((cell) => cell.textContent),
    ['emphasis', 'label', 'pressed', 'direction'],
  );
  assert.equal(section.querySelectorAll('.variant-cell[aria-label]').length, 20);
  // The fallback cannot be deleted.
  assert.equal(panel.labelled('Delete main').disabled, true);
  assert.equal(panel.labelled('Delete link').disabled, false);
  await panel.unmount();
});

test('a grid cell writes its next state', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  const cell = panel.labelled('label when variant is main: Not allowed');
  await panel.click(cell);
  assert.equal(
    panel.source(),
    replaced(
      BUTTON,
      '      label?: never;\n      pressed?: never;\n      direction?: never;\n    }\n  | {\n      variant: "link";',
      '      label?: string;\n      pressed?: never;\n      direction?: never;\n    }\n  | {\n      variant: "link";',
    ),
  );
  assert.ok(panel.labelled('label when variant is main: Allowed'), 'the cell reads back as Allowed');
  await panel.unmount();
});

test('arrow keys move between grid cells', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  const first = panel.labelled('emphasis when variant is main: Allowed');
  first.focus();
  await panel.key(first, 'ArrowRight');
  assert.equal(document.activeElement.getAttribute('aria-label'), 'emphasis when variant is link: Not allowed');
  await panel.key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement.getAttribute('aria-label'), 'label when variant is link: Not allowed');
  await panel.unmount();
});

test('a ruled prop shows one switch per option, and a pick writes it', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const section = panel.section();
  assert.ok(section);
  assert.equal(document.querySelector('.property-conditions') ?? undefined, undefined);
  assert.equal(section.querySelector('.variant-chip').textContent, 'variant');
  const groups = [...section.querySelectorAll('[role="radiogroup"]')];
  assert.deepEqual(
    groups.map((group) => [group.getAttribute('aria-label'), group.querySelector('[aria-checked="true"]').textContent]),
    [
      ['label when variant is main', 'Not allowed'],
      ['label when variant is link', 'Not allowed'],
      ['label when variant is play', 'Allowed'],
      ['label when variant is close', 'Allowed'],
      ['label when variant is arrow', 'Allowed'],
    ],
  );
  const play = groups[2];
  await panel.click([...play.querySelectorAll('button')].find((button) => button.textContent === 'Required'));
  assert.equal(
    panel.source(),
    replaced(BUTTON, 'Defaults to `Play` or `Pause`. */\n      label?: string;', 'Defaults to `Play` or `Pause`. */\n      label: string;'),
  );
  await panel.unmount();
});

test('the element group: href is ruled by element, element shows its two options', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  assert.equal(panel.section().querySelector('.variant-chip').textContent, 'element');
  await panel.unmount();
  const again = await mountPanel(BUTTON);
  await again.open('element');
  assert.deepEqual(
    [...again.section().querySelectorAll('.variant-option input')].map((input) => input.value),
    ['button', 'link'],
  );
  // Two options are the fewest a controller can have.
  assert.equal(again.labelled('Delete link').disabled, true);
  await again.unmount();
});

test('options: add, rename, Default and delete each write their edit', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  await panel.click(panel.section().querySelector('.variant-add'));
  assert.match(panel.source(), /variant: "option";/);
  assert.match(panel.source(), /variant\?: "main" \| "link" \| "play" \| "close" \| "arrow" \| "option";/);
  const input = panel.labelled('Option 1');
  await panel.type(input, 'primary');
  await panel.key(input, 'Enter');
  assert.match(panel.source(), /variant\?: "primary";/);
  assert.match(panel.source(), / {2}variant = "primary",/);
  await panel.click(panel.labelled('Make play the default'));
  assert.match(panel.source(), /variant\?: "play";/);
  assert.match(panel.source(), / {2}variant = "play",/);
  await panel.click(panel.labelled('Delete option'));
  assert.doesNotMatch(panel.source(), /"option"/);
  await panel.unmount();
});

test('a refused rename says why and puts the name back', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  const input = panel.labelled('Option 3');
  await panel.type(input, 'start');
  await panel.key(input, 'Enter');
  assert.equal(panel.source(), BUTTON);
  assert.match(panel.section().querySelector('[role="alert"]').textContent, /play/);
  assert.equal(panel.labelled('Option 3').value, 'play');
  await panel.type(panel.labelled('Option 3'), 'pl"ay');
  await panel.key(panel.labelled('Option 3'), 'Enter');
  assert.match(panel.section().querySelector('[role="alert"]').textContent, /quotes/);
  await panel.unmount();
});

test('a new prop is added to every option, and a ruled prop deleted from all', async () => {
  const small = [
    '---',
    'type Props =',
    '  | { tone?: "calm"; icon?: never }',
    '  | { tone: "loud"; icon?: string };',
    'const { tone = "calm", icon } = Astro.props;',
    '---',
    '<i>{tone}</i>',
    '',
  ].join('\n');
  const panel = await mountPanel(small);
  await panel.open('tone');
  await panel.type(panel.labelled('New property name'), 'size');
  await panel.key(panel.labelled('New property name'), 'Enter');
  assert.equal(
    panel.source(),
    small
      .replace('{ tone?: "calm"; icon?: never }', '{ tone?: "calm"; icon?: never; size?: string }')
      .replace('{ tone: "loud"; icon?: string }', '{ tone: "loud"; icon?: string; size?: string }')
      .replace('const { tone = "calm", icon }', 'const { tone = "calm", icon, size }'),
  );
  await panel.click(panel.labelled('Delete icon'));
  assert.doesNotMatch(panel.source(), /icon/);
  await panel.unmount();
});

test('a read-only group is drawn disabled with its reason; a plain prop has no section', async () => {
  const exported = [
    '---',
    'type Props = Kind;',
    'export type Kind =',
    '  | { variant?: "a"; label?: never }',
    '  | { variant: "b"; label?: string };',
    'const { variant, label } = Astro.props;',
    '---',
    '<i>{variant}{label}</i>',
    '',
  ].join('\n');
  const panel = await mountPanel(exported);
  await panel.open('variant');
  const section = panel.section();
  assert.equal(section.querySelector('.variant-reason').textContent, 'Shared');
  assert.ok([...section.querySelectorAll('button')].every((button) => button.disabled));
  await panel.unmount();
  const plain = await mountPanel(BUTTON);
  await plain.open('render');
  assert.equal(plain.section() ?? undefined, undefined);
  await plain.unmount();
});
