// Goal: variant rules are configured with controls in each prop's own
// settings, never text. A ruled prop (`type`, `disabled`, `href`, `emphasis`,
// `label`, `pressed`, `direction`) shows "Controlled by" with one Allowed /
// Required / Not allowed switch per option in place of Required. The
// controller (`variant`, `element`) keeps the panel's one Options list and
// Default value dropdown, which write the union's option edits. A prop every
// option shares offers "Only for". A read-only group is drawn disabled with
// its one-word reason. Each control writes exactly the edit it stands for.
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
       export { optionListEdit, fallbackEdit, optionValueOf } from './src/features/componentProperties/PropertyVariants';`,
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
  const section = () => container.querySelector('.property-editor');
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

const RULED = { element: ['type', 'disabled', 'href'], variant: ['emphasis', 'label', 'pressed', 'direction'] };
const OPTIONS = { element: ['button', 'link'], variant: ['main', 'link', 'play', 'close', 'arrow'] };

test('helpers: each Options list change is one option edit, and a Default pick moves the fallback', () => {
  const { optionListEdit, fallbackEdit, optionValueOf } = modules;
  const options = ['"main"', '"link"', '"play"'];
  assert.equal(optionValueOf('"main"'), 'main');
  assert.equal(optionValueOf("'main'"), 'main');
  assert.deepEqual(optionListEdit('variant', options, [...options, '"ghost"'], { kind: 'add' }, 'immediate'), {
    kind: 'addOption',
    controller: 'variant',
    value: 'ghost',
  });
  assert.deepEqual(optionListEdit('variant', options, ['"main"', '"play"'], { kind: 'remove', index: 1 }, 'immediate'), {
    kind: 'removeOption',
    controller: 'variant',
    value: 'link',
  });
  assert.deepEqual(optionListEdit('variant', options, ['"play"', '"main"', '"link"'], { kind: 'move', index: 2, gap: 0 }, 'immediate'), {
    kind: 'moveOption',
    controller: 'variant',
    value: 'play',
    index: 0,
  });
  assert.equal(optionListEdit('variant', options, options, { kind: 'move', index: 0, gap: 0 }, 'immediate'), undefined);
  // A name being typed is no edit yet; the commit is the rename.
  assert.equal(optionListEdit('variant', options, ['"pri"', '"link"', '"play"'], { kind: 'edit', index: 0 }, 'draft'), undefined);
  assert.deepEqual(optionListEdit('variant', options, ['"primary"', '"link"', '"play"'], { kind: 'edit', index: 0 }, 'immediate'), {
    kind: 'renameOption',
    controller: 'variant',
    from: 'main',
    to: 'primary',
  });
  assert.equal(optionListEdit('variant', options, options, { kind: 'edit', index: 0 }, 'immediate'), undefined);
  const group = {
    controller: 'variant',
    options: [
      { value: 'main', fallback: true },
      { value: 'play', fallback: false },
    ],
  };
  assert.deepEqual(fallbackEdit(group, '"play"'), { kind: 'setFallback', controller: 'variant', value: 'play' });
  assert.equal(fallbackEdit(group, '"main"'), undefined);
  assert.equal(fallbackEdit(group, 'someExpression'), undefined);
});

test('every ruled prop shows Controlled by and one switch per option, in place of Required', async () => {
  for (const [controller, props] of Object.entries(RULED)) {
    for (const prop of props) {
      const panel = await mountPanel(BUTTON);
      await panel.open(prop);
      const editor = panel.section();
      assert.equal(editor.querySelector('.variant-chip')?.textContent, controller, prop);
      assert.deepEqual(
        [...editor.querySelectorAll('[role="radiogroup"]')].map((group) => group.getAttribute('aria-label')),
        OPTIONS[controller].map((value) => `${prop} when ${controller} is ${value}`),
        prop,
      );
      assert.ok(![...editor.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Required'), `${prop} has no Required checkbox`);
      assert.equal(editor.querySelector('.property-conditions') ?? undefined, undefined);
      await panel.unmount();
    }
  }
});

test('a switch pick writes its rule', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const play = panel.labelled('label when variant is play');
  await panel.click([...play.querySelectorAll('button')].find((button) => button.textContent === 'Required'));
  assert.equal(
    panel.source(),
    replaced(BUTTON, 'Defaults to `Play` or `Pause`. */\n      label?: string;', 'Defaults to `Play` or `Pause`. */\n      label: string;'),
  );
  await panel.click([...panel.labelled('label when variant is main').querySelectorAll('button')].find((button) => button.textContent === 'Allowed'));
  assert.match(panel.source(), /variant\?: "main";\n {6}\/\*\* Visual emphasis\. \*\/\n {6}emphasis\?: Emphasis;\n {6}label\?: string;/);
  await panel.unmount();
});

test('the controller has one Options list and its Default value, no rules, no Required', async () => {
  for (const [controller, values] of Object.entries(OPTIONS)) {
    const panel = await mountPanel(BUTTON);
    await panel.open(controller);
    const editor = panel.section();
    assert.equal(editor.querySelectorAll('.property-options').length, 1);
    assert.equal(editor.querySelectorAll('.variant-rules').length, 0);
    assert.equal(editor.querySelectorAll('.property-options .prop-code-toggle, .property-options [aria-pressed]').length, 0);
    for (const value of values) {
      assert.ok(panel.labelled(`Remove ${value}`), `${controller} lists ${value}`);
    }
    assert.ok(![...editor.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Required'));
    assert.ok(editor.querySelector('.property-default'));
    await panel.unmount();
  }
});

test('removing an option from the Options list writes the union edit, refusals show under the fields', async () => {
  const small = [
    '---',
    'type Props =',
    '  | { tone?: "calm"; icon?: never }',
    '  | { tone: "loud"; icon?: string }',
    '  | { tone: "quiet"; icon?: never };',
    'const { tone = "calm", icon } = Astro.props;',
    '---',
    '<i>{tone}</i>',
    '',
  ].join('\n');
  const panel = await mountPanel(small);
  await panel.open('tone');
  await panel.click(panel.labelled('Remove quiet'));
  assert.equal(panel.source(), small.replace('\n  | { tone: "quiet"; icon?: never }', ''));
  await panel.unmount();
  const button = await mountPanel(BUTTON);
  await button.open('variant');
  await button.click(button.labelled('Remove close'));
  assert.equal(button.source(), BUTTON);
  assert.match(button.section().querySelector('.property-error').textContent, /close/);
  await button.unmount();
});

test('the Default value pick moves the fallback and the destructure default', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  await panel.click(panel.section().querySelector('.property-default .dd-trigger'));
  const option = [...document.querySelectorAll('.dd-option')].find((item) => item.textContent.includes('play'));
  await panel.click(option);
  assert.equal(
    panel.source(),
    BUTTON.replace('variant?: "main";', 'variant: "main";')
      .replace('variant: "play";', 'variant?: "play";')
      .replace('  variant = "main",', '  variant = "play",'),
  );
  await panel.unmount();
});

test('a shared prop offers Only for; a pick gives it rules there', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('render');
  const editor = panel.section();
  const only = editor.querySelector('[aria-label="Only for"]');
  assert.ok(only, 'render offers Only for');
  assert.deepEqual(
    [...only.querySelectorAll('.variant-only-option')].map((button) => button.textContent),
    ['button', 'link'],
  );
  await panel.click(panel.labelled('render when element is link'));
  assert.match(panel.source(), /type Props = \{\n\} & Tag &/);
  assert.match(panel.source(), /href\?: never;\n {6}render\?: never;\n {4}\}\)/);
  assert.match(panel.source(), /disabled\?: never;\n {6}\/\*\* Set to `false` to omit the component\. \*\/\n {6}render\?: boolean;\n {4}\}\);/);
  await panel.unmount();
});

test('a read-only group is drawn disabled with its reason; a plain prop has no rules', async () => {
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
  await panel.open('label');
  const rules = panel.section().querySelector('.variant-rules');
  assert.equal(rules.querySelector('.variant-reason').textContent, 'Shared');
  assert.ok([...rules.querySelectorAll('[role="radio"]')].every((button) => button.disabled));
  await panel.unmount();
  const plain = await mountPanel(['---', 'interface Props { title?: string }', 'const { title } = Astro.props;', '---', '<h1>{title}</h1>', ''].join('\n'));
  await plain.open('title');
  assert.equal(plain.section().querySelector('.variant-rules') ?? undefined, undefined);
  await plain.unmount();
});
