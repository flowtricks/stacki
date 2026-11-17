// Goal: variant rules are configured with controls in each prop's own
// settings, never text. Every existing prop shows "Controlled by": a ruled
// prop (`type`, `disabled`, `href`, `emphasis`, `label`, `pressed`,
// `direction`) in place of Required, with one Allowed / Required / Not allowed
// state per option and None to give it back to every option; a prop with no
// rules (a fresh one too) picks a controller, or with none yet a prop of
// string options, and the option to allow it for. The controller keeps the
// panel's one Options list and Default value dropdown, which write the
// union's option edits. A read-only group is disabled with its one-word reason.
// Row overflow is held by the stylesheet's fixed state column and ellipsized
// names; jsdom lays nothing out, so widths are not measured here.
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
    // An option row's state, by its radio group's label and the state's own label.
    state: async (label, text) => {
      await click(container.querySelector(`[role="radiogroup"][aria-label="${label}"] [aria-label="${text}"]`));
    },
    checked: (label) => {
      const on = [...container.querySelectorAll(`[role="radiogroup"][aria-label="${label}"] [role="radio"]`)].filter(
        (button) => button.getAttribute('aria-checked') === 'true',
      );
      assert.equal(on.length, 1, `${label} has one state on`);
      return on[0].dataset.state;
    },
    // A Dropdown, by its label, opened and set to the option that reads `text`.
    pick: async (label, text) => {
      await click(container.querySelector(`.dd-trigger[aria-label="${label}"]`));
      const option = [...document.querySelectorAll('.dd-option')].find((item) => item.textContent.trim() === text);
      assert.ok(option, `${label} offers ${text}`);
      await click(option);
    },
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

test('every ruled prop shows Controlled by and one state per option, in place of Required', async () => {
  for (const [controller, props] of Object.entries(RULED)) {
    for (const prop of props) {
      const panel = await mountPanel(BUTTON);
      await panel.open(prop);
      const editor = panel.section();
      assert.equal(editor.querySelector('.variant-controller-choice')?.textContent.trim(), controller, prop);
      assert.deepEqual(
        [...editor.querySelectorAll('.variant-rule-row [role="radiogroup"]')].map((group) => group.getAttribute('aria-label')),
        OPTIONS[controller].map((value) => `${prop} when ${controller} is ${value}`),
        prop,
      );
      assert.ok(![...editor.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Required'), `${prop} has no Required checkbox`);
      assert.equal(editor.querySelector('.property-conditions') ?? undefined, undefined);
      await panel.unmount();
    }
  }
});

test('a state pick writes its rule, and a Not allowed row is dimmed', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  assert.ok(panel.labelled('label when variant is main').closest('.variant-rule-row').classList.contains('is-forbidden'));
  assert.equal(panel.checked('label when variant is play'), 'optional');
  await panel.state('label when variant is play', 'Required');
  assert.equal(
    panel.source(),
    replaced(BUTTON, 'Defaults to `Play` or `Pause`. */\n      label?: string;', 'Defaults to `Play` or `Pause`. */\n      label: string;'),
  );
  assert.equal(panel.checked('label when variant is play'), 'required');
  await panel.state('label when variant is main', 'Allowed');
  assert.match(panel.source(), /variant\?: "main";\n {6}\/\*\* Visual emphasis\. \*\/\n {6}emphasis\?: Emphasis;\n {6}label\?: string;/);
  await panel.unmount();
});

test('removing the only condition gives a ruled prop back to every option, as one shared declaration', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('direction');
  await panel.click(panel.labelled('Remove variant'));
  assert.match(panel.source(), /render\?: boolean;\n {2}\/\*\* Arrow direction\. \*\/\n {2}direction\?: "forward" \| "back";\n\} & Tag &/);
  assert.doesNotMatch(panel.source().slice(panel.source().indexOf('type Kind'), panel.source().indexOf('type Props')), /direction/);
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

test('any prop with no rules yet picks a controller from every prop that could be one', async () => {
  // `badge` stands for a prop just created in the prop list: declared in the shared object type.
  const fresh = BUTTON.replace('  render?: boolean;\n} & Tag &', '  render?: boolean;\n  badge?: string;\n} & Tag &').replace(
    '  render = true,\n',
    '  render = true,\n  badge,\n',
  );
  const panel = await mountPanel(fresh);
  await panel.open('badge');
  const editor = panel.section();
  assert.equal(editor.querySelector('.variant-controller-choice').textContent.trim(), 'None');
  assert.ok(
    [...editor.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Required'),
    'an unruled prop keeps Required',
  );
  await panel.click(editor.querySelector('.variant-controller-choice'));
  assert.deepEqual(
    [...document.querySelectorAll('.dd-option')].map((item) => item.textContent.trim()),
    ['None', 'element', 'variant', 'render', 'type', 'disabled', 'emphasis', 'pressed', 'direction'],
  );
  await panel.click([...document.querySelectorAll('.dd-option')].find((item) => item.textContent.trim() === 'variant'));
  const kind = panel.source().slice(panel.source().indexOf('type Kind'), panel.source().indexOf('type Props'));
  assert.equal(kind.split('badge?: string;').length, 6);
  await panel.state('badge when variant is link', 'Not allowed');
  assert.match(panel.source(), /variant: "link";[^}]*badge\?: never;/s);
  await panel.unmount();
});

test('with no controller yet, a prop of string options or a boolean becomes one', async () => {
  const plain = [
    '---',
    'type Props = {',
    '  size?: "s" | "l";',
    '  /** Icon name. */',
    '  icon?: string;',
    '};',
    'const { size = "s", icon } = Astro.props;',
    '---',
    '<i>{size}{icon}</i>',
    '',
  ].join('\n');
  const panel = await mountPanel(plain);
  await panel.open('icon');
  await panel.pick('Controlled by', 'size');
  await panel.state('icon when size is s', 'Not allowed');
  assert.equal(
    panel.source(),
    plain.replace(
      'type Props = {\n  size?: "s" | "l";\n  /** Icon name. */\n  icon?: string;\n};',
      'type Props = {\n} & (\n  | { size?: "s"; /** Icon name. */ icon?: never }\n  | { size: "l"; /** Icon name. */ icon?: string }\n);',
    ),
  );
  await panel.unmount();
});

test('two controllers: Add condition, a state under the second, and its own remove', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('disabled');
  await panel.pick('Add condition', 'variant');
  const editor = panel.section();
  assert.equal(editor.querySelectorAll('.variant-block').length, 2);
  assert.equal(editor.querySelector('.variant-and').textContent, 'and');
  await panel.state('disabled when variant is link', 'Not allowed');
  const kind = panel.source().slice(panel.source().indexOf('type Kind'), panel.source().indexOf('type Props'));
  assert.equal(kind.split('disabled?: never;').length, 2);
  assert.equal(panel.source().slice(0, panel.source().indexOf('type Kind')), BUTTON.slice(0, BUTTON.indexOf('type Kind')));
  await panel.click(panel.labelled('Remove variant'));
  assert.equal(panel.source(), BUTTON);
  await panel.unmount();
});

test('switching the controller moves the rules in one edit', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  await panel.pick('Controlled by', 'variant');
  const source = panel.source();
  assert.doesNotMatch(source.slice(source.indexOf('type Tag'), source.indexOf('type Kind')), /href/);
  assert.equal(source.slice(source.indexOf('type Kind'), source.indexOf('type Props')).split('href?: string;').length, 6);
  assert.equal(panel.section().querySelector('.variant-controller-choice').textContent.trim(), 'variant');
  await panel.unmount();
});

test('the prop list marks conditional props with the options that allow them', async () => {
  const panel = await mountPanel(BUTTON);
  const mark = (name) =>
    [...document.querySelectorAll('.property-row')]
      .find((row) => row.querySelector('.property-row-main')?.textContent.startsWith(name))
      ?.querySelector('.variant-condition-mark');
  assert.equal(mark('href').getAttribute('aria-label'), 'Conditional: element: link');
  assert.equal(mark('label').getAttribute('aria-label'), 'Conditional: variant: play, close, arrow');
  for (const name of ['type', 'disabled', 'emphasis', 'pressed', 'direction']) {
    assert.ok(mark(name), `${name} is marked`);
  }
  for (const name of ['render', 'element', 'variant']) {
    assert.equal(mark(name) ?? undefined, undefined, `${name} is not marked`);
  }
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
  assert.ok([...rules.querySelectorAll('.dd-trigger')].every((button) => button.disabled));
  await panel.unmount();
  const plain = await mountPanel(['---', 'interface Props { title?: string }', 'const { title } = Astro.props;', '---', '<h1>{title}</h1>', ''].join('\n'));
  await plain.open('title');
  assert.equal(plain.section().querySelector('.variant-rules') ?? undefined, undefined);
  await plain.unmount();
});

test('each state is an icon button: named, tipped, one on at a time, arrow keys move it', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const group = panel.labelled('label when variant is play');
  const buttons = [...group.querySelectorAll('[role="radio"]')];
  assert.deepEqual(
    buttons.map((button) => [button.getAttribute('aria-label'), button.textContent.trim(), Boolean(button.querySelector('svg'))]),
    [
      ['Allowed', '', true],
      ['Required', '', true],
      ['Not allowed', '', true],
    ],
  );
  assert.deepEqual(
    buttons.map((button) => button.tabIndex),
    [0, -1, -1],
  );
  // The tip names the state after a resting pointer's wait.
  const React = require('react');
  await React.act(async () => {
    buttons[1].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  assert.equal(document.querySelector('.rail-tooltip')?.textContent, 'Required');
  await React.act(async () => buttons[1].dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })));
  await panel.key(buttons[0], 'ArrowRight');
  assert.equal(panel.checked('label when variant is play'), 'required');
  assert.match(panel.source(), /Defaults to `Play` or `Pause`\. \*\/\n {6}label: string;/);
  await panel.key(panel.labelled('label when variant is play').querySelector('[aria-checked="true"]'), 'ArrowRight');
  assert.equal(panel.checked('label when variant is play'), 'forbidden');
  await panel.unmount();
});

test('every controller choice shows the icon its prop kind has in the prop list', async () => {
  const panel = await mountPanel(BUTTON);
  // The list's own icon for each prop, by its row.
  const listIcon = (name) =>
    [...document.querySelectorAll('.property-row')]
      .find((row) => row.querySelector('.property-row-main')?.textContent.startsWith(name))
      ?.querySelector('.list-field-icon svg')?.innerHTML;
  const names = ['element', 'variant', 'render', 'type', 'disabled', 'emphasis', 'pressed', 'direction'];
  const icons = new Map(names.map((name) => [name, listIcon(name)]));
  assert.ok(
    [...icons.values()].every((icon) => icon !== undefined),
    'every list row has an icon',
  );
  await panel.open('href');
  await panel.click(panel.section().querySelector('.variant-controller-choice'));
  const rows = [...document.querySelectorAll('.dd-option')];
  assert.deepEqual(
    rows.map((row) => row.textContent.trim()),
    names,
  );
  for (const row of rows) {
    const icon = row.querySelector('.dd-icon svg');
    assert.ok(icon, `${row.textContent.trim()} has an icon`);
    assert.equal(icon.innerHTML, icons.get(row.textContent.trim()), `${row.textContent.trim()} has its list icon`);
  }
  // The closed trigger shows the chosen controller's icon too.
  await panel.key(document.activeElement ?? document.body, 'Escape');
  assert.ok(panel.section().querySelector('.variant-controller-choice .dd-icon svg'));
  await panel.unmount();
});

test('Button label: its per-variant default reads as the Conditional chip with its conditions, no plain control', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const editor = panel.section();
  const field = editor.querySelector('.property-default');
  assert.ok(field.querySelector('.conditional-chip'), 'the default is conditional');
  const lines = [...field.querySelectorAll('.conditional-line')].map((line) => line.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(lines, [
    'If all are trueVariant = PlayPressed is truePause',
    'If Variant = PlayPlay',
    'If Variant = CloseClose',
    'If all are trueVariant = ArrowDirection = BackPrevious',
    'If Variant = ArrowNext',
    'Else(left out)',
  ]);
  assert.equal(field.querySelector('input') ?? undefined, undefined, 'no plain default input beside the conditions');
  // Every option documents label differently: the one Tooltip reads Varies.
  assert.ok([...editor.querySelectorAll('input')].some((input) => input.placeholder === 'Varies'));
  await panel.unmount();
});

test('an allowing option opens to its own Kind and Tooltip; a typed tooltip is written to that option only', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  assert.equal(panel.labelled('main settings') ?? undefined, undefined, 'a Not allowed option has no settings');
  await panel.click(panel.labelled('close settings'));
  const tip = panel.labelled('Tooltip for close');
  assert.equal(tip.value, 'Accessible label. Defaults to `Close`.');
  await panel.type(tip, 'Closes the dialog.');
  await panel.key(tip, 'Enter');
  assert.equal(
    panel.source(),
    replaced(BUTTON, '/** Accessible label. Defaults to `Close`. */\n      label?: string;', '/** Closes the dialog. */\n      label?: string;'),
  );
  await panel.unmount();
});

test('the controller’s Kind cannot be changed: its options are the union', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('variant');
  const kind = panel.section().querySelector('.property-type .dd-trigger');
  assert.equal(kind.disabled, true);
  assert.equal(panel.section().querySelector('.property-type .prop-expr-toggle') ?? undefined, undefined);
  await panel.unmount();
});

test('a text prop with a plain default offers Set by conditions; a number and a switch do not', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  assert.ok(panel.labelled('Set by conditions'), 'href (text) can be set by conditions');
  await panel.unmount();
  const second = await mountPanel(BUTTON);
  await second.open('pressed');
  assert.equal(second.labelled('Set by conditions') ?? undefined, undefined, 'a switch cannot');
  await second.unmount();
});

test('Set by conditions from scratch: a condition and a value, closed, write one destructure default', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  await panel.click(panel.labelled('Set by conditions'));
  const editor = () => document.querySelector('.conditional-editor');
  assert.ok(editor(), 'the Value conditions editor opens');
  // It starts on the first prop of options, Variant, comparing with any of its values.
  assert.equal(editor().querySelector('.dd-trigger[aria-label="Property"]').textContent.trim(), 'Variant');
  assert.equal(editor().querySelector('.dd-trigger[aria-label="Operator"]').textContent.trim(), 'is any');
  const values = editor().querySelector('[aria-label="Values"]');
  await panel.click(values.querySelector('.multi-select-chevron'));
  const menu = document.getElementById(values.getAttribute('aria-controls'));
  await panel.click([...menu.querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Play'));
  const box = editor().querySelector('[aria-label="Value"] .bind-input');
  const React = require('react');
  await React.act(async () => {
    box.textContent = '/play';
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  for (let round = 0; round < 3 && editor() !== null; round += 1) {
    await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  assert.equal(editor() ?? undefined, undefined, 'the editor closed');
  assert.equal(panel.source(), replaced(BUTTON, '  href,\n', '  href = variant === "play" ? "/play" : undefined,\n'));
  // The field is now the Conditional chip with its summary.
  assert.ok(panel.section().querySelector('.property-default .conditional-chip'));
  await panel.unmount();
});

// The from-scratch flow a designer walks, on a component whose three props
// were just made in the panel (Kinds Choice, Switch and Text): label is given
// to variant, taken away from main, and its default set by conditions. Every
// step is a click, a pick or typed words; the counts are pinned so a step
// added later is a decision, not an accident.
const SCRATCH = [
  '---',
  'interface Props {',
  '  variant?: "main" | "play";',
  '  pressed?: boolean;',
  '  label?: string;',
  '}',
  'const { variant = "main", pressed = false, label } = Astro.props;',
  '---',
  '<button aria-label={label}>Go</button>',
  '',
].join('\n');

test('from scratch: Controlled by variant, Not allowed for main, default Pause / Play by conditions', async () => {
  const React = require('react');
  const panel = await mountPanel(SCRATCH);
  let actions = 0;
  const act = async (step) => {
    actions += 1;
    await step();
  };
  await panel.open('label');
  await act(() => panel.pick('Controlled by', 'variant')); // 2 clicks: open, pick
  await act(() => panel.state('label when variant is main', 'Not allowed'));
  assert.equal(panel.checked('label when variant is main'), 'forbidden');
  assert.equal(panel.checked('label when variant is play'), 'optional');
  await act(() => panel.click(panel.labelled('Set by conditions')));
  const editor = () => document.querySelector('.conditional-editor');
  const pickValue = async (field, name) => {
    await panel.click(field.querySelector('.multi-select-chevron'));
    const menu = document.getElementById(field.getAttribute('aria-controls'));
    await panel.click([...menu.querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === name));
  };
  const typeValue = (box, text) =>
    React.act(async () => {
      box.textContent = text;
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  // Group 1: Variant is Play and Pressed is true ↳ Pause.
  await act(() => pickValue(editor().querySelectorAll('[aria-label="Values"]')[0], 'Play'));
  await act(() => panel.click([...editor().querySelectorAll('.conditional-add')][0]));
  const second = editor().querySelectorAll('.dd-trigger[aria-label="Property"]')[1];
  await act(async () => {
    await panel.click(second);
    await panel.click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Pressed'));
  });
  await act(() => typeValue(editor().querySelectorAll('[aria-label="Value"] .bind-input')[0], 'Pause'));
  // Group 2: Variant is Play ↳ Play.
  await act(() => panel.click(editor().querySelector('.conditional-add-group')));
  await act(() => pickValue(editor().querySelectorAll('.conditional-group[role="group"]')[1].querySelector('[aria-label="Values"]'), 'Play'));
  await act(() => typeValue(editor().querySelectorAll('.conditional-group[role="group"]')[1].querySelector('[aria-label="Value"] .bind-input'), 'Play'));
  for (let round = 0; round < 3 && editor() !== null; round += 1) {
    await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  actions += 1; // Escape (or a click away) closes and writes.
  const source = panel.source();
  assert.match(source, /^---\ntype Props = \{\n/, 'the interface became a type for its first group');
  assert.match(source, /\| \{ variant\?: "main"; label\?: never \}/);
  assert.match(source, /\| \{ variant: "play"; label\?: string \}/);
  assert.ok(
    source.includes('label = variant === "play" && pressed ? "Pause" : variant === "play" ? "Play" : undefined'),
    source.slice(0, source.indexOf('---', 4)),
  );
  assert.equal(actions, 11, 'the flow takes eleven actions');
  await panel.unmount();
});

test('Button label: a value changed in the editor is written into its table entry alone', async () => {
  const React = require('react');
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-default .conditional-chip'));
  const editor = () => document.querySelector('.conditional-editor');
  const groups = editor().querySelectorAll('.conditional-group[role="group"]');
  assert.equal(groups.length, 5, 'one group per option and condition');
  const box = groups[2].querySelector('[aria-label="Value"] .bind-input');
  assert.equal(box.textContent, 'Close');
  await React.act(async () => {
    box.textContent = 'Dismiss';
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  for (let round = 0; round < 3 && editor() !== null; round += 1) {
    await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  assert.equal(panel.source(), replaced(BUTTON, '  close: "Close",', '  close: "Dismiss",'));
  await panel.unmount();
});

test('Button label: opening and closing the editor without a change writes nothing', async () => {
  const React = require('react');
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-default .conditional-chip'));
  for (let round = 0; round < 3 && document.querySelector('.conditional-editor') !== null; round += 1) {
    await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  assert.equal(panel.source(), BUTTON);
  await panel.unmount();
});

test('the prop list marks no controller with a fallback as required, and marks every ruled prop as conditional', async () => {
  const panel = await mountPanel(BUTTON);
  const rows = [...document.querySelectorAll('.property-row')];
  const row = (name) => rows.find((item) => item.querySelector('.property-row-main').textContent.trim().startsWith(name));
  for (const name of ['element', 'variant']) {
    assert.equal(row(name).querySelector('.property-required') ?? undefined, undefined, `${name} may be left out`);
  }
  for (const name of [...RULED.element, ...RULED.variant]) {
    assert.ok(row(name).querySelector('.variant-condition-mark'), `${name} is marked conditional`);
  }
  await panel.unmount();
});
