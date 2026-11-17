// Goal: variant rules are configured with controls in each prop's own
// settings, never text. Every existing prop's Visibility is Allowed or
// Required, or set by conditions on other props: the purple Conditional pill
// with a one-line summary, opening the Value conditions editor whose values
// are states; a ruled prop (`type`, `disabled`, `href`, `emphasis`, `label`,
// `pressed`, `direction`) reads as its pill, a plain one as its Dropdown with
// the branch beside it. A per-option Tooltip is the same pill on the
// controller. The controller keeps the panel's one Options list and Default
// value dropdown, which write the union's option edits, and its Kind is
// locked. jsdom lays nothing out, so widths are measured in the harness
// (docs/props-conditional-values.md, the audits).
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
  const branch = (section) => section.querySelector('.property-default:not(.property-visibility):not(.property-tooltip) [aria-label="Set by conditions"]');
  assert.ok(branch(panel.section()), 'href (text) can be set by conditions');
  await panel.unmount();
  const second = await mountPanel(BUTTON);
  await second.open('pressed');
  assert.equal(branch(second.section()) === null, true, 'a switch cannot');
  await second.unmount();
});

test('Set by conditions from scratch: a condition and a value, closed, write one destructure default', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  await panel.click(panel.section().querySelector('.property-default:not(.property-visibility):not(.property-tooltip) [aria-label="Set by conditions"]'));
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

test('Button label: a value changed in the editor is written into its table entry alone', async () => {
  const React = require('react');
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-default:not(.property-visibility):not(.property-tooltip) .conditional-chip'));
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
  await panel.click(panel.section().querySelector('.property-default:not(.property-visibility):not(.property-tooltip) .conditional-chip'));
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

// Escape as a person presses it to leave: once for each open values menu, then for the editor.
async function closeEditor() {
  const React = require('react');
  for (let round = 0; round < 4 && document.querySelector('.conditional-editor') !== null; round += 1) {
    await React.act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
}

test('every ruled prop’s Visibility is the Conditional pill with its summary; no Controlled by, no Required checkbox', async () => {
  const summaries = {
    label: 'Not allowed when Variant is any of Main, Link; Allowed otherwise',
    href: 'Not allowed when Element = Button; Allowed otherwise',
    disabled: 'Not allowed when Element = Link; Allowed otherwise',
    direction: 'Not allowed when Variant is any of Main, Link, Play, Close; Allowed otherwise',
  };
  for (const [prop, summary] of Object.entries(summaries)) {
    const panel = await mountPanel(BUTTON);
    await panel.open(prop);
    const editor = panel.section();
    const pill = editor.querySelector('.property-visibility .conditional-default-chip');
    assert.ok(pill, `${prop} has a Visibility pill`);
    assert.equal(pill.querySelector('.conditional-default-summary').textContent, summary, prop);
    assert.ok(![...editor.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Required'), `${prop} has no Required checkbox`);
    assert.equal(editor.textContent.includes('Controlled by'), false);
    await panel.unmount();
  }
});

test('a plain prop’s Visibility is Allowed or Required, a Dropdown, with the branch beside its title', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('render');
  const field = panel.section().querySelector('.property-visibility');
  assert.equal(field.querySelector('.dd-trigger').textContent.trim(), 'Allowed');
  assert.ok(field.querySelector('[aria-label="Set by conditions"]'));
  await panel.pick('Visibility', 'Required');
  assert.match(panel.source(), /\brender: boolean;/);
  await panel.unmount();
});

test('Visibility editor: its values are states; the Else set to Required writes Required for every option that allows the prop', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-visibility .conditional-default-chip'));
  const editor = document.querySelector('.conditional-editor');
  assert.equal(editor.querySelector('.loop-bind-title').textContent, 'Visibility');
  const choices = editor.querySelectorAll('.dd-trigger[aria-label="Value"], .dd-trigger[aria-label="Else value"]');
  assert.deepEqual(
    [...choices].map((choice) => choice.textContent.trim()),
    ['Not allowed', 'Allowed'],
  );
  await panel.click(document.querySelector('.conditional-editor .dd-trigger[aria-label="Else value"]'));
  await panel.click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Required'));
  await closeEditor();
  const source = panel.source();
  for (const variant of ['play', 'close', 'arrow']) {
    assert.match(source, new RegExp(`variant: "${variant}";[\\s\\S]*?label: string;`), variant);
  }
  const kind = source.slice(source.indexOf('type Kind ='), source.indexOf('type Props ='));
  assert.equal(kind.split('label?: string;').length, 1, 'no option leaves label optional');
  assert.equal(kind.split('label?: never;').length, 3, 'main and link still forbid it');
  await panel.unmount();
});

test('Visibility: opening and closing the editor without a change writes nothing', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('disabled');
  await panel.click(panel.section().querySelector('.property-visibility .conditional-default-chip'));
  await closeEditor();
  assert.equal(panel.source(), BUTTON);
  await panel.unmount();
});

test('Visibility: a condition TypeScript cannot say is refused with one line, and nothing is written', async () => {
  const React = require('react');
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-visibility .conditional-default-chip'));
  const editor = document.querySelector('.conditional-editor');
  await panel.click(editor.querySelector('.conditional-add'));
  await closeEditor();
  // The new condition starts on a prop and is finished or dropped; a second finished condition on another prop is refused.
  assert.equal(panel.source(), BUTTON);
  void React;
  await panel.unmount();
});

test('from scratch: Visibility by conditions on variant, then a default Pause / Play by conditions', async () => {
  const React = require('react');
  const panel = await mountPanel(SCRATCH);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-visibility [aria-label="Set by conditions"]'));
  let editor = document.querySelector('.conditional-editor');
  assert.equal(editor.querySelector('.loop-bind-title').textContent, 'Visibility');
  assert.equal(editor.querySelector('.dd-trigger[aria-label="Property"]').textContent.trim(), 'Variant');
  assert.equal(editor.querySelector('.dd-trigger[aria-label="Value"]').textContent.trim(), 'Not allowed');
  const values = editor.querySelector('[aria-label="Values"]');
  await panel.click(values.querySelector('.multi-select-chevron'));
  await panel.click(
    [...document.getElementById(values.getAttribute('aria-controls')).querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Main'),
  );
  await closeEditor();
  assert.match(panel.source(), /\| \{ variant\?: "main"; label\?: never \}/);
  assert.match(panel.source(), /\| \{ variant: "play"; label\?: string \}/);
  assert.match(panel.source(), /^---\ntype Props = /);
  // The default, by conditions on the same panel.
  await panel.click(panel.section().querySelector('.property-default:not(.property-visibility):not(.property-tooltip) [aria-label="Set by conditions"]'));
  editor = document.querySelector('.conditional-editor');
  const pick = async (field, name) => {
    await panel.click(field.querySelector('.multi-select-chevron'));
    await panel.click(
      [...document.getElementById(field.getAttribute('aria-controls')).querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === name),
    );
  };
  const typeValue = (box, text) =>
    React.act(async () => {
      box.textContent = text;
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await pick(editor.querySelector('[aria-label="Values"]'), 'Play');
  await panel.click(editor.querySelector('.conditional-add'));
  await panel.click(editor.querySelectorAll('.dd-trigger[aria-label="Property"]')[1]);
  await panel.click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Pressed'));
  await typeValue(editor.querySelectorAll('[aria-label="Value"] .bind-input')[0], 'Pause');
  await panel.click(editor.querySelector('.conditional-add-group'));
  const second = editor.querySelectorAll('.conditional-group[role="group"]')[1];
  await pick(second.querySelector('[aria-label="Values"]'), 'Play');
  await typeValue(second.querySelector('[aria-label="Value"] .bind-input'), 'Play');
  await closeEditor();
  assert.ok(panel.source().includes('label = variant === "play" && pressed ? "Pause" : variant === "play" ? "Play" : undefined'));
  await panel.unmount();
});

test('Tooltip: options that document the prop differently read as the Conditional pill on the controller', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const pill = panel.section().querySelector('.property-tooltip .conditional-default-chip');
  assert.ok(pill);
  assert.equal(
    pill.querySelector('.conditional-default-summary').textContent,
    'Accessible label. Defaults to `Play` or `Pause`., Accessible label. Defaults to `Close`., Accessible label. Defaults to `Next` or `Previous`.',
  );
  await panel.click(pill);
  const editor = document.querySelector('.conditional-editor');
  const groups = editor.querySelectorAll('.conditional-group[role="group"]');
  assert.equal(groups.length, 3);
  const box = groups[1].querySelector('[aria-label="Value"] .bind-input');
  const React = require('react');
  await React.act(async () => {
    box.textContent = 'Closes the dialog.';
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await closeEditor();
  assert.equal(
    panel.source(),
    replaced(BUTTON, '/** Accessible label. Defaults to `Close`. */\n      label?: string;', '/** Closes the dialog. */\n      label?: string;'),
  );
  await panel.unmount();
});
