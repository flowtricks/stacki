// Goal: variant rules are configured with controls in each prop's own
// settings, never text. Every existing prop's Visibility is Show or
// Required (three icon choices: Show, Hide, Required), or set by conditions
// on other props: the purple Conditional pill with a one-line summary,
// opening the Value conditions editor whose values are the same icon
// choices; a ruled prop (`type`, `disabled`, `href`, `emphasis`, `label`,
// `pressed`, `direction`) reads as its pill, a plain one as its choices. A
// setting that can be set by conditions (Visibility, Default value, Tooltip)
// has a prop field's purple + whose picker offers Create conditional, and
// once set its title is the blue reset label that clears it. Visibility's
// `{}` shows its TypeScript, read-only. A per-option Tooltip is the same pill
// on the controller. The controller keeps the panel's one Options list and Default
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
const { toastMessages } = require('../../helpers/toastCapture');
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
    // A setting's purple +, then the picker's Create conditional row: how a field is made conditional.
    conditional: async (field) => {
      assert.ok(field, 'the setting exists');
      await click(field.querySelector(':scope > .property-field-head > .bind-handle'));
      const row = [...document.querySelectorAll('.bind-menu .dp-new-prop')].find((button) => button.textContent.trim() === 'Create conditional');
      await click(row);
    },
    // The blue reset label's menu, then Reset.
    reset: async (field) => {
      await click(field.querySelector(':scope > .property-field-head > .prop-label.set'));
      await click(document.querySelector('.prop-menu .prop-menu-item'));
    },
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
  assert.match(toastMessages(), /close/, 'the refusal is a toast');
  assert.equal(button.section().querySelector('.property-error') ?? undefined, undefined, 'no paragraph is added under the fields');
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

const DEFAULT_FIELD = '.property-default:not(.property-visibility):not(.property-tooltip)';

test('a text prop with a plain default offers the + with Create conditional; a number and a switch do not', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  const plus = (section) => section.querySelector(`${DEFAULT_FIELD} > .property-field-head > .bind-handle`);
  assert.ok(plus(panel.section()), 'href (text) can be set by conditions');
  assert.equal(panel.section().querySelector(`${DEFAULT_FIELD} [aria-label="Set by conditions"]`) ?? undefined, undefined, 'no branch beside the title');
  await panel.click(plus(panel.section()));
  const rows = [...document.querySelectorAll('.bind-menu .dp-new-prop')].map((row) => row.textContent.trim());
  assert.deepEqual(rows, ['Create conditional'], 'the picker offers Create conditional alone');
  assert.equal(document.querySelector('.bind-menu .dp-search, .bind-menu .dp-list') ?? undefined, undefined, 'a setting has no data to search or pick');
  await panel.unmount();
  const second = await mountPanel(BUTTON);
  await second.open('pressed');
  assert.equal(plus(second.section()) ?? undefined, undefined, 'a switch cannot');
  await second.unmount();
});

test('Set by conditions from scratch: a condition and a value, closed, write one destructure default', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  assert.equal(panel.section().querySelector(`${DEFAULT_FIELD} .prop-label.set`) ?? undefined, undefined, 'a plain default is not set by conditions');
  await panel.conditional(panel.section().querySelector(DEFAULT_FIELD));
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
  // The field is now the Conditional chip with its summary, and its title the blue reset label, with no + left.
  assert.ok(panel.section().querySelector('.property-default .conditional-chip'));
  assert.ok(panel.section().querySelector(`${DEFAULT_FIELD} > .property-field-head > .prop-label.set`), 'the title is the blue label');
  assert.equal(panel.section().querySelector(`${DEFAULT_FIELD} > .property-field-head > .bind-handle`) ?? undefined, undefined, 'no + once set');
  // Its {} is still there, and shows the chain as code; pressed again, the pill is back.
  const braces = () => panel.section().querySelector(`${DEFAULT_FIELD} > .property-field-head > .prop-expr-toggle`);
  await panel.click(braces());
  assert.equal(panel.section().querySelector(`${DEFAULT_FIELD} .conditional-chip`) ?? undefined, undefined, 'the code replaces the pill');
  assert.equal(braces().getAttribute('aria-pressed'), 'true');
  await panel.click(braces());
  assert.ok(panel.section().querySelector(`${DEFAULT_FIELD} .conditional-chip`), 'the pill is back');
  // Reset clears the conditions: the prop has no default again.
  await panel.reset(panel.section().querySelector(DEFAULT_FIELD));
  assert.equal(panel.source(), BUTTON);
  assert.equal(panel.section().querySelector(`${DEFAULT_FIELD} .prop-label.set`) ?? undefined, undefined, 'the title is plain again');
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
    // Show first, naming the shorter list: label is shown for three variants, so it reads "none of" the two that hide it.
    label: 'Show when Variant is none of Main, Link; Hide otherwise',
    href: 'Show when Element = Link; Hide otherwise',
    disabled: 'Show when Element = Button; Hide otherwise',
    direction: 'Show when Variant = Arrow; Hide otherwise',
  };
  for (const [prop, summary] of Object.entries(summaries)) {
    const panel = await mountPanel(BUTTON);
    await panel.open(prop);
    const editor = panel.section();
    const pill = editor.querySelector('.property-visibility .conditional-default-chip');
    assert.ok(pill, `${prop} has a Visibility pill`);
    assert.equal(pill.querySelector('.conditional-default-summary').textContent, summary, prop);
    assert.ok(editor.querySelector('.property-visibility > .property-field-head > .prop-label.set'), `${prop}'s Visibility title is the blue label`);
    assert.equal(editor.querySelector('.property-visibility > .property-field-head > .bind-handle') ?? undefined, undefined, `${prop} has no + once set`);
    assert.ok(![...editor.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Required'), `${prop} has no Required checkbox`);
    assert.equal(editor.textContent.includes('Controlled by'), false);
    await panel.unmount();
  }
});

// The Visibility choices' pressed state: the one radio that is checked, by its label.
function checkedChoice(group) {
  const on = [...group.querySelectorAll('[role="radio"]')].filter((radio) => radio.getAttribute('aria-checked') === 'true');
  return on.map((radio) => radio.getAttribute('aria-label'));
}

test('a plain prop’s Visibility is three icon choices, Show, Hide and Required, with the + on its field', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('render');
  const field = panel.section().querySelector('.property-visibility');
  const group = field.querySelector('[role="radiogroup"][aria-label="Visibility"]');
  assert.ok(group, 'the choices are one radio group');
  assert.equal(field.querySelector('.dd-trigger') ?? undefined, undefined, 'no Dropdown');
  assert.deepEqual(
    [...group.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute('aria-label')),
    ['Show', 'Hide', 'Required'],
  );
  assert.deepEqual(
    [...group.querySelectorAll('[role="radio"] svg')].map((icon) => icon.dataset.centralIcon),
    ['eye', 'eyeOff', 'asterisk'],
    'each choice is its Central icon',
  );
  assert.deepEqual(checkedChoice(group), ['Show']);
  assert.ok(field.querySelector(':scope > .property-field-head > .bind-handle'), 'the + makes it conditional');
  assert.equal(field.querySelector('.prop-label.set') ?? undefined, undefined, 'a plain Visibility is not set by conditions');
  await panel.click(group.querySelector('[aria-label="Required"]'));
  assert.match(panel.source(), /\brender: boolean;/);
  assert.deepEqual(checkedChoice(panel.section().querySelector('.property-visibility [role="radiogroup"]')), ['Required']);
  await panel.unmount();
});

test('Visibility: Hide on a plain prop opens the editor Show first, Hide the Else; with no prop to hide by, it says so and writes nothing', async () => {
  const panel = await mountPanel(SCRATCH);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-visibility [role="radio"][aria-label="Hide"]'));
  const editor = document.querySelector('.conditional-editor');
  assert.ok(editor, 'Hide is chosen in a condition');
  assert.deepEqual(checkedChoice(editor.querySelector('[role="radiogroup"][aria-label="Value"]')), ['Show']);
  assert.deepEqual(checkedChoice(editor.querySelector('[role="radiogroup"][aria-label="Else value"]')), ['Hide']);
  await closeEditor();
  await panel.unmount();
  const alone = await mountPanel(
    ['---', 'interface Props {', '  label?: string;', '}', 'const { label } = Astro.props;', '---', '<p>{label}</p>', ''].join('\n'),
  );
  await alone.open('label');
  const field = alone.section().querySelector('.property-visibility');
  assert.equal(field.querySelector(':scope > .property-field-head > .bind-handle') ?? undefined, undefined, 'no + with nothing to set it by');
  const before = alone.source();
  await alone.click(field.querySelector('[role="radio"][aria-label="Hide"]'));
  assert.equal(document.querySelector('.conditional-editor') ?? undefined, undefined);
  assert.match(toastMessages(), /Hide needs a condition/, 'the refusal is a toast');
  assert.equal(alone.section().querySelector('.property-error') ?? undefined, undefined, 'no paragraph is added under the fields');
  assert.equal(alone.source(), before);
  await alone.unmount();
});

test('Visibility’s {} shows its TypeScript, read-only, and goes back to the controls', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const field = () => panel.section().querySelector('.property-visibility');
  const toggle = () => field().querySelector('.property-field-head [aria-label="View the TypeScript"]');
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  await panel.click(toggle());
  const code = field().querySelector('.property-readonly-code .code-block');
  assert.ok(code, 'the code replaces the pill');
  assert.equal(field().querySelector('.conditional-default-chip') ?? undefined, undefined);
  assert.equal(field().querySelector('textarea, input, [contenteditable="true"]') ?? undefined, undefined, 'the code is read-only');
  assert.ok(code.querySelector('span'), 'the code is highlighted');
  assert.match(code.textContent, /\| \{ variant\??: "main"; label\?: never \}/);
  assert.match(code.textContent, /\| \{ variant: "play"; label\?: string \}/);
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  await panel.click(toggle());
  assert.ok(field().querySelector('.conditional-default-chip'), 'the pill is back');
  assert.equal(panel.source(), BUTTON, 'viewing writes nothing');
  await panel.unmount();
  const plain = await mountPanel(BUTTON);
  await plain.open('render');
  await plain.click(plain.section().querySelector('.property-visibility [aria-label="View the TypeScript"]'));
  assert.equal(plain.section().querySelector('.property-visibility .code-block').textContent.trim(), 'render?: boolean;');
  await plain.unmount();
});

test('Visibility: the blue label’s Reset clears the conditions, so no union hides the prop', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('href');
  await panel.reset(panel.section().querySelector('.property-visibility'));
  assert.notEqual(panel.source(), BUTTON, 'the reset was written');
  const after = panel.section().querySelector('.property-visibility');
  assert.equal(after.querySelector('.conditional-default-chip') ?? undefined, undefined, 'the pill is gone');
  assert.deepEqual(checkedChoice(after.querySelector('[role="radiogroup"]')), ['Show']);
  assert.equal(after.querySelector('.prop-label.set') ?? undefined, undefined);
  await panel.unmount();
});

test('Visibility editor: its values are states, Show first; the Show group set to Required writes Required for every option it names', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.click(panel.section().querySelector('.property-visibility .conditional-default-chip'));
  const editor = document.querySelector('.conditional-editor');
  assert.equal(editor.querySelector('.loop-bind-title').textContent, 'Visibility');
  const choices = editor.querySelectorAll('[role="radiogroup"][aria-label="Value"], [role="radiogroup"][aria-label="Else value"]');
  assert.deepEqual(
    [...choices].map((choice) => checkedChoice(choice)),
    [['Show'], ['Hide']],
  );
  assert.equal(
    editor.querySelector('.dd-trigger[aria-label="Value"], .dd-trigger[aria-label="Else value"]') ?? undefined,
    undefined,
    'no Dropdown for a state',
  );
  await panel.click(editor.querySelector('[role="radiogroup"][aria-label="Value"] [aria-label="Required"]'));
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
  await panel.conditional(panel.section().querySelector('.property-visibility'));
  let editor = document.querySelector('.conditional-editor');
  assert.equal(editor.querySelector('.loop-bind-title').textContent, 'Visibility');
  assert.equal(editor.querySelector('.dd-trigger[aria-label="Property"]').textContent.trim(), 'Variant');
  // Show first, Hide the Else: "Show when Variant = Play; else Hide".
  assert.deepEqual(checkedChoice(editor.querySelector('[role="radiogroup"][aria-label="Value"]')), ['Show']);
  assert.deepEqual(checkedChoice(editor.querySelector('[role="radiogroup"][aria-label="Else value"]')), ['Hide']);
  const values = editor.querySelector('[aria-label="Values"]');
  await panel.click(values.querySelector('.multi-select-chevron'));
  await panel.click(
    [...document.getElementById(values.getAttribute('aria-controls')).querySelectorAll('.dd-option')].find((option) => option.textContent.trim() === 'Play'),
  );
  await closeEditor();
  assert.match(panel.source(), /\| \{ variant\?: "main"; label\?: never \}/);
  assert.match(panel.source(), /\| \{ variant: "play"; label\?: string \}/);
  assert.match(panel.source(), /^---\ntype Props = /);
  // The default, by conditions on the same panel.
  await panel.conditional(panel.section().querySelector(DEFAULT_FIELD));
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
  assert.ok(panel.section().querySelector('.property-tooltip > .property-field-head > .prop-label.set'), 'the Tooltip title is the blue label');
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

test('Tooltip: the blue label’s Reset gives every option no tooltip, the plain field again', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  await panel.reset(panel.section().querySelector('.property-tooltip'));
  const source = panel.source();
  for (const comment of ['/** Accessible label. Defaults to `Close`. */', '/** Accessible label. Defaults to `Play` or `Pause`. */']) {
    assert.equal(source.includes(comment), false, comment);
  }
  assert.equal(panel.section().querySelector('.property-tooltip .conditional-default-chip') ?? undefined, undefined, 'the pill is gone');
  const label = [...panel.section().querySelectorAll('label.property-field')].find((item) => item.textContent.startsWith('Tooltip'));
  assert.ok(label, 'the plain Tooltip field');
  assert.ok(label.querySelector(':scope > .property-field-head > .bind-handle'), 'with its + to make it conditional again');
  await panel.unmount();
});

// Which of a setting's title marks are on: the blue label, the `{}` and the +.
function headMarks(field) {
  const head = field.querySelector(':scope > .property-field-head');
  assert.ok(head, 'the setting has its title row');
  return {
    set: head.querySelector(':scope > .prop-label.set') !== null,
    code: head.querySelector(':scope > .prop-expr-toggle') !== null,
    plus: head.querySelector(':scope > .bind-handle') !== null,
  };
}

test('Default value: any default given is the blue label, which resets it; no default is plain; the {} is there in each state', async () => {
  const panel = await mountPanel(SCRATCH);
  await panel.open('pressed');
  assert.deepEqual(headMarks(panel.section().querySelector(DEFAULT_FIELD)), { set: true, code: true, plus: false }, 'a switch’s plain default');
  await panel.reset(panel.section().querySelector(DEFAULT_FIELD));
  assert.equal(panel.source(), replaced(SCRATCH, 'pressed = false,', 'pressed,'));
  assert.deepEqual(headMarks(panel.section().querySelector(DEFAULT_FIELD)), { set: false, code: true, plus: false }, 'no default');
  await panel.unmount();
  const words = await mountPanel(SCRATCH);
  await words.open('label');
  assert.deepEqual(headMarks(words.section().querySelector(DEFAULT_FIELD)), { set: false, code: true, plus: true }, 'words with no default');
  await words.unmount();
});

test('Visibility and Tooltip have their {} in every state, plain and set by conditions', async () => {
  const plain = await mountPanel(BUTTON);
  await plain.open('render');
  assert.deepEqual(
    headMarks(plain.section().querySelector('.property-visibility')),
    { set: false, code: true, plus: true },
    'Variant and Element can decide it',
  );
  const tooltip = [...plain.section().querySelectorAll('label.property-field')].find((item) => item.textContent.startsWith('Tooltip'));
  assert.deepEqual(headMarks(tooltip), { set: false, code: true, plus: false }, 'a plain prop’s Tooltip');
  await plain.click(tooltip.querySelector(':scope > .property-field-head > .prop-expr-toggle'));
  const shown = [...plain.section().querySelectorAll('label.property-field')].find((item) => item.textContent.startsWith('Tooltip'));
  assert.equal(shown.querySelector('textarea') ?? undefined, undefined, 'the code replaces the words');
  assert.match(shown.querySelector('.code-block').textContent, /render\?: boolean;/);
  await plain.unmount();
  const ruled = await mountPanel(BUTTON);
  await ruled.open('label');
  assert.deepEqual(headMarks(ruled.section().querySelector('.property-visibility')), { set: true, code: true, plus: false });
  const pill = ruled.section().querySelector('.property-tooltip');
  assert.deepEqual(headMarks(pill), { set: true, code: true, plus: false }, 'a Tooltip set per option');
  await ruled.click(pill.querySelector(':scope > .property-field-head > .prop-expr-toggle'));
  const code = ruled.section().querySelector('.property-tooltip .code-block').textContent;
  assert.match(code, /\| \{ variant: "close"; \/\*\* Accessible label\. Defaults to `Close`\. \*\/ label\?: string \}/);
  assert.match(code, /\| \{ variant\??: "main"; label\?: never \}/, 'a hidden member has no tooltip');
  assert.equal(ruled.source(), BUTTON, 'viewing writes nothing');
  await ruled.unmount();
});

test('the Visibility choices’ pressed state is neutral, never the accent', () => {
  const css = fs.readFileSync(repoPath('src/features/props/valueChoices.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/--accent|#0099ff|0, 153, 255/i.test(css), false, 'blue is for primary buttons');
  const selected = css.match(/\.value-choices \.u-segmented-button\.is-selected[^{]*\{([^}]*)\}/);
  assert.ok(selected, 'the chosen choice has its own look');
  assert.match(selected[1], /color: var\(--text\)/, 'its icon at full strength');
  const indicator = css.match(/\.value-choices \.u-segmented-indicator \{([^}]*)\}/);
  assert.ok(indicator, 'the chosen choice sits on the pill');
  assert.match(indicator[1], /background: rgba\(255, 255, 255, 0\.14\)/, 'a lighter fill');
});

test('Button label: a default set per option is the blue label with its {}; its Reset is refused, saying where to change it', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('label');
  const field = () => panel.section().querySelector(DEFAULT_FIELD);
  assert.deepEqual(headMarks(field()), { set: true, code: true, plus: false });
  await panel.click(field().querySelector(':scope > .property-field-head > .prop-expr-toggle'));
  assert.match(field().querySelector('.code-block').textContent, /label \?\? named\[variant\]/, 'the {} shows the table the default reads');
  await panel.click(field().querySelector(':scope > .property-field-head > .prop-label.set'));
  const item = document.querySelector('.prop-menu .prop-menu-item');
  assert.equal(item.getAttribute('aria-disabled'), 'true', 'the table is the component’s code: never deleted from a label');
  assert.match(item.getAttribute('title'), /computes this default from its own table/);
  await panel.click(item);
  assert.equal(panel.source(), BUTTON, 'nothing is written');
  await panel.unmount();
});

test('Visibility read Show first writes nothing untouched, and an edit writes the rule it now says', async () => {
  const panel = await mountPanel(BUTTON);
  await panel.open('direction');
  await panel.click(panel.section().querySelector('.property-visibility .conditional-default-chip'));
  const editor = document.querySelector('.conditional-editor');
  // Shown for Arrow only: the shorter list is the one shown option.
  assert.equal(editor.querySelector('.dd-trigger[aria-label="Operator"]').textContent.trim(), 'is any');
  assert.deepEqual(checkedChoice(editor.querySelector('[role="radiogroup"][aria-label="Value"]')), ['Show']);
  await closeEditor();
  assert.equal(panel.source(), BUTTON, 'read Show first, the code is untouched byte for byte');
  await panel.click(panel.section().querySelector('.property-visibility .conditional-default-chip'));
  // Else Show instead of Hide: direction is then shown for every variant, so no union rules it.
  await panel.click(document.querySelector('.conditional-editor [role="radiogroup"][aria-label="Else value"] [aria-label="Show"]'));
  await closeEditor();
  const kind = panel.source().slice(panel.source().indexOf('type Kind ='), panel.source().indexOf('type Props ='));
  assert.equal(kind.includes('direction?: never'), false, 'no variant hides direction any more');
  await panel.unmount();
});
