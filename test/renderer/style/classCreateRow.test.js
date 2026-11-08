// The create row the two class fields lead with.
//
//   node test/renderer/style/classCreateRow.test.js
//
// Goal: a name that fuzzily matches other classes can still be added. Both the
// Settings panel's class field and the Style panel's selector box used to take
// the first match on Enter (or show a list that hid the way to the typed name),
// so `content` could not be created beside `dev_content`. A new valid name now
// leads the list with `Create <name>`, selected; ↓ and ↑ walk the rows; Enter takes
// the selected one. An exact class leads instead, a class on the element is never
// written twice, an invalid name is refused, and everything the selector box
// accepts that is not one class (tags, states, compounds, nesting) stays as it was.
//
// Method: three layers, cheapest first. (1) The pure list, classRows and friends,
// with the negative space spelled out. (2) typedDraft, the selector box's reading
// of its text, over a table of every kind of token, including half-typed ones,
// because it now runs on each keystroke. (3) The real ClassInput and SelectorPicker
// mounted in JSDOM, driven by the same script of keys, reading the rows from the
// DOM and the writes from their callbacks.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'class-create-row.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as ClassInput } from './src/features/props/ClassInput'
        export { SelectorPicker, typedDraft } from './src/features/style/embed/SelectorPicker'
        export { setHost } from './src/features/style/model/host'
        export { literalClasses } from './src/features/style/model/webflowElement'
        export { classRowMatch, classRows, classRowStep, isClassName } from './src/lib/fuzzyRank'
      `,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  global.window = window;
  global.Window = window.Window;
  global.document = window.document;
  global.navigator = window.navigator;
  global.HTMLElement = window.HTMLElement;
  global.Element = window.Element;
  global.Node = window.Node;
  global.getComputedStyle = window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const stored = new Map();
  global.localStorage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, String(value)), removeItem: (key) => stored.delete(key) };
  global.MutationObserver = window.MutationObserver;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  window.Element.prototype.scrollIntoView = () => {};

  const bundle = require(bundlePath);
  const { classRows, classRowStep, classRowMatch, isClassName, typedDraft } = bundle;

  // 1. The list.
  for (const name of ['content', 'hero_content', '_x', '-x', 'a1', 'block--mod', 'über', 'café-card', '日本']) {
    check(`${name} is a class name`, isClassName(name));
  }
  for (const name of ['', '-', '-1', '1col', 'a b', '.a', 'a.b', 'md:flex', 'w-1/2', 'foo$']) {
    check(`"${name}" is not a class name`, !isClassName(name));
  }
  const list = (name, matches, options = {}) => classRows({ name, matches, nameOf: (item) => item, carried: false, restPlain: 0, ...options });
  const created = list('content', ['dev_content', 'faq_content']);
  check('a new name leads with its create row', same(created.rows[0], { kind: 'create', name: 'content' }));
  check(
    'above the matches, in order',
    same(
      created.rows.slice(1).map((row) => row.item),
      ['dev_content', 'faq_content'],
    ),
  );
  check('and rests on it', created.rest === 0);
  check('a new name with no matches is still a row', list('content', []).rows.length === 1);
  const exact = list('content', ['Content', 'content_a', 'content']);
  check('an exact class is pulled to the front', exact.rows[0].item === 'content', JSON.stringify(exact.rows));
  check('with no create row', exact.rows.every((row) => row.kind === 'match') && exact.rows.length === 3);
  check('case matters: `Content` does not exist yet', list('Content', ['content']).rows[0].kind === 'create');
  const carried = list('content', ['dev_content'], { carried: true });
  check(
    'a class on the element offers no create row',
    carried.rows.every((row) => row.kind === 'match'),
  );
  check('and selects nothing, so Enter cannot pick another class', carried.rest === -1);
  const invalid = list('foo$', ['foo_a']);
  check(
    'an invalid name offers no create row',
    invalid.rows.every((row) => row.kind === 'match'),
  );
  check('and rests where the field rests', invalid.rest === 0 && list('foo$', [], { restPlain: -1 }).rest === -1);
  check('no name, no create row', list(undefined, ['a']).rows.length === 1);
  check('a step stops at the last row', classRowStep(9, created) === 2);
  check('and at the resting row', classRowStep(-1, created) === 0);
  check('an empty list has no selection', classRowStep(0, list(undefined, [])) === -1);
  check('Tab on a create row takes the first match', classRowMatch(created, 0) === 'dev_content');
  check('Tab on a match takes that match', classRowMatch(created, 2) === 'faq_content');
  check('Tab with no matches takes nothing', classRowMatch(list('content', []), 0) === undefined);
  let thrown = '';
  try {
    classRowStep(0, { rows: [], rest: 1 });
  } catch (error) {
    thrown = String(error);
  }
  check('a list cannot rest below its top', thrown.includes('classRowStep: the list rests at its top'), thrown);
  check(
    'expression literals keep their class-shaped words',
    same(bundle.literalClasses({ props: { c: { type: 'expr', value: `["a-b", "w-1/2", "-1"]` } } }, 'c'), ['a-b']),
  );

  // 2. What the selector box's text means.
  const reads = {
    class: ['content', '.content', ' content ', 'my-card', '.section', '._x'],
    invalid: ['1abc', '.1abc', 'foo$', '.foo$', 'foo/bar', '-', '.-', '.', '--x'],
    selector: [
      '',
      'section',
      'h1',
      ':hover',
      '.a:hover',
      'a:hover',
      '.a.b',
      '.a .b',
      '.a > .b',
      '.a,.b',
      '.a,',
      '#id',
      '[data-x]',
      '*',
      '.hero { .title }',
      '.hero{}',
      '.a{',
      '.a::before',
      '.foo\\:bar',
      'md:flex',
      ':is(',
      '.a[',
      '[',
      '(',
      '..',
    ],
  };
  for (const [kind, texts] of Object.entries(reads)) {
    for (const text of texts) {
      check(`"${text}" reads as ${kind}`, typedDraft(text, undefined).kind === kind, JSON.stringify(typedDraft(text, undefined)));
    }
  }
  check('the class is named without its dot', typedDraft('.content', undefined).name === 'content');
  check('the selected element’s own tag is a tag', typedDraft('my-card', 'my-card').kind === 'selector');

  // 3. The fields.
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const typeInto = (input, text) =>
    act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const press = (input, name) =>
    act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  const SUGGESTIONS = ['dev_content', 'faq_content', 'hero_content', 'card'];

  // 3a. The Settings panel's class field.
  const written = [];
  function ClassHarness() {
    const [value, setValue] = React.useState('hero_content');
    return React.createElement(ClassInput, {
      value,
      suggestions: SUGGESTIONS,
      onChange: (next) => {
        written.push(next);
        setValue(next);
      },
    });
  }
  const { ClassInput } = bundle;
  const classHost = document.getElementById('root');
  const classRoot = createRoot(classHost);
  await act(async () => classRoot.render(React.createElement(ClassHarness)));
  const classField = () => document.querySelector('.class-input-field');
  const classLabels = () => [...document.querySelectorAll('.class-suggest .dd-option')].map((row) => row.textContent);
  const classSelected = () => document.querySelector('.class-suggest .dd-option.highlight')?.textContent;
  const classType = (text) => typeInto(classField(), text);
  const classKey = (name) => press(classField(), name);
  await act(async () => classField().focus());
  await classType('');
  check('Settings: an empty field shows no list', classLabels().length === 0);
  await classKey('Enter');
  check('Settings: Enter on an empty field writes nothing', written.length === 0, JSON.stringify(written));

  await classType('content');
  check('Settings: the create row comes first', same(classLabels(), ['Create content', 'dev_content', 'faq_content']), JSON.stringify(classLabels()));
  check('Settings: selected by default', classSelected() === 'Create content', classSelected());
  await classKey('ArrowDown');
  check('Settings: ↓ moves to the first suggestion', classSelected() === 'dev_content', classSelected());
  await classKey('ArrowDown');
  await classKey('ArrowDown');
  check('Settings: ↓ stops at the last row', classSelected() === 'faq_content', classSelected());
  await classKey('ArrowUp');
  await classKey('ArrowUp');
  check('Settings: ↑ comes back to the create row', classSelected() === 'Create content', classSelected());
  await classKey('ArrowUp');
  check('Settings: and stops there', classSelected() === 'Create content', classSelected());
  await classKey('Enter');
  check('Settings: Enter creates the typed class', written.at(-1) === 'hero_content content', JSON.stringify(written));
  check('Settings: and clears the field', classField().value === '');

  await classType('zzz');
  check('Settings: a name nothing matches is a create row alone', same(classLabels(), ['Create zzz']), JSON.stringify(classLabels()));
  await classType('faq');
  await classKey('ArrowDown');
  await classKey('Enter');
  check('Settings: ↓ then Enter picks the suggestion', written.at(-1) === 'hero_content content faq_content', JSON.stringify(written));

  await classType('dev_content');
  check('Settings: an exact class comes first with no create row', same(classLabels(), ['dev_content']), JSON.stringify(classLabels()));
  check('Settings: selected', classSelected() === 'dev_content', classSelected());
  await classKey('Enter');
  check('Settings: Enter applies it', written.at(-1) === 'hero_content content faq_content dev_content', JSON.stringify(written));

  const before = written.length;
  await classType('hero_conten');
  await classType('hero_content');
  check('Settings: a class on the element offers no create row', !classLabels().some((label) => label.startsWith('Create')), JSON.stringify(classLabels()));
  await classKey('Enter');
  check('Settings: Enter writes no duplicate', written.length === before, JSON.stringify(written.slice(before)));
  check('Settings: and clears the field', classField().value === '');

  await classType('1col');
  check('Settings: an invalid name has no create row', classLabels().length === 0, JSON.stringify(classLabels()));
  await classKey('Enter');
  check('Settings: Enter does not write it', written.length === before, JSON.stringify(written.slice(before)));
  check('Settings: the text stays to be corrected', classField().value === '1col');
  check('Settings: and the field says why', document.querySelector('.class-suggest .dd-empty')?.textContent === 'Check the class name and retry.');
  await classType('1cols');
  check('Settings: the message goes when the text changes', document.querySelector('.class-suggest .dd-empty') === null);

  await classType('content2');
  await act(async () => document.querySelector('.class-suggest .dd-option').click());
  check('Settings: clicking the create row creates the class', written.at(-1)?.split(' ').includes('content2'), JSON.stringify(written.at(-1)));
  await classType('card');
  await classType('car');
  const rows = () => [...document.querySelectorAll('.class-suggest .dd-option')];
  await act(async () => rows()[1].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
  check('Settings: hover selects a row', classSelected() === 'card', classSelected());
  await classType('ca');
  check('Settings: `ca` leads with its create row', classSelected() === 'Create ca', classSelected());
  await classKey('Tab');
  check('Settings: Tab still takes the first suggestion', written.at(-1)?.split(' ').includes('card'), JSON.stringify(written.at(-1)));
  await act(async () => classRoot.unmount());

  // 3b. The Style panel's selector box.
  bundle.setHost({ projectClasses: SUGGESTIONS });
  const added = [];
  const chip = (text) => ({ key: text, text, specificity: [0, 1, 0], state: '', simple: true, fromComponent: false });
  const pickerRoot = createRoot(classHost);
  await act(async () =>
    pickerRoot.render(
      React.createElement(bundle.SelectorPicker, {
        selectors: [chip('.hero_content')],
        suggestions: [
          { selector: 'section', kind: 'tag' },
          { selector: '.hero_content', kind: 'class' },
          { selector: '.content-own', kind: 'class' },
        ],
        activeSelector: '',
        activePicked: false,
        busy: false,
        loading: false,
        onSelect: () => {},
        onDeselect: () => {},
        onAdd: (selector) => added.push(selector),
      }),
    ),
  );
  await act(async () => {
    document.querySelector('.embed-editor_selector-well').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 2 }));
  });
  const field = () => document.querySelector('.embed-editor_selector-add');
  const labels = () => [...document.querySelectorAll('.embed-editor_suggest-sel')].map((row) => row.textContent);
  const selected = () => document.querySelector('.embed-editor_suggest-item.is-active .embed-editor_suggest-sel')?.textContent;
  const type = (text) => typeInto(field(), text);
  const key = (name) => press(field(), name);
  check('Style: the field opened', field() !== null);
  check('Style: an empty box lists the element’s tokens', same(labels(), ['section', '.content-own']), JSON.stringify(labels()));
  check('Style: with nothing selected', selected() === undefined, selected());
  await key('Enter');
  check('Style: Enter on an empty box adds nothing', added.length === 0, JSON.stringify(added));

  await type('content');
  check('Style: the create row comes first', same(labels(), ['Create content', '.content-own', '.dev_content', '.faq_content']), JSON.stringify(labels()));
  check('Style: selected by default', selected() === 'Create content', selected());
  await key('ArrowDown');
  check('Style: ↓ moves to the first suggestion', selected() === '.content-own', selected());
  await key('ArrowUp');
  check('Style: ↑ comes back to the create row', selected() === 'Create content', selected());
  await key('ArrowUp');
  check('Style: and stops there', selected() === 'Create content', selected());
  await key('Enter');
  check('Style: Enter creates what Enter always made of the text', added.at(-1) === '.content', JSON.stringify(added));

  await type('.content');
  check('Style: a leading dot names the same class', labels()[0] === 'Create content', JSON.stringify(labels()));
  await key('ArrowDown');
  await key('Enter');
  check('Style: ↓ then Enter picks the suggestion', added.at(-1) === '.content-own', JSON.stringify(added));

  await type('zzz');
  check('Style: with no matches the list is just the create row', same(labels(), ['Create zzz']), JSON.stringify(labels()));
  await act(async () => document.querySelector('.embed-editor_suggest-item').click());
  check('Style: clicking it creates the class', added.at(-1) === '.zzz', JSON.stringify(added));

  await type('faq_content');
  check('Style: an exact class comes first with no create row', same(labels(), ['.faq_content']), JSON.stringify(labels()));
  check('Style: selected', selected() === '.faq_content', selected());
  await key('Enter');
  check('Style: Enter applies it', added.at(-1) === '.faq_content', JSON.stringify(added));
  await type('content-own');
  check('Style: the element’s own exact class leads', labels()[0] === '.content-own', JSON.stringify(labels()));

  await type('hero_content');
  check('Style: a class in the well offers no create row', !labels().some((label) => label.startsWith('Create')), JSON.stringify(labels()));
  check('Style: and selects nothing', selected() === undefined, selected());
  await key('Enter');
  check('Style: Enter goes to the existing chip by its selector, as before', added.at(-1) === '.hero_content', JSON.stringify(added));

  const count = added.length;
  await type('.1col');
  check('Style: an invalid name has no create row', !labels().some((label) => label.startsWith('Create')), JSON.stringify(labels()));
  await key('Enter');
  check('Style: Enter does not add it', added.length === count, JSON.stringify(added.slice(count)));
  check('Style: the text stays to be corrected', field().value === '.1col');
  check('Style: and the box says why', document.querySelector('.embed-editor_suggest-note')?.textContent === 'Check the class name and retry.');
  await type('1col');
  await key('Enter');
  check('Style: bare, too', added.length === count, JSON.stringify(added.slice(count)));

  for (const [text, selector] of [
    ['section', 'section'],
    [':hover', ':hover'],
    ['.card:hover', '.card:hover'],
    ['card:hover', '.card:hover'],
    ['.a.b', '.a.b'],
    ['.a > .b', '.a > .b'],
    ['#id', '#id'],
    ['[data-x]', '[data-x]'],
  ]) {
    await type(text);
    check(`Style: ${text} offers no create row`, !labels().some((label) => label.startsWith('Create')), JSON.stringify(labels()));
    check(`Style: ${text} selects no row`, selected() === undefined, selected());
    await key('Enter');
    check(`Style: Enter adds ${selector} as it did`, added.at(-1) === selector, JSON.stringify(added.at(-1)));
  }

  await type('content');
  await key('Tab');
  check('Style: Tab still fills the first suggestion in', field().value === '.content-own', field().value);
  await act(async () => pickerRoot.unmount());

  if (failures.length) {
    console.error(`classCreateRow: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`classCreateRow: ${checked} checks passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
