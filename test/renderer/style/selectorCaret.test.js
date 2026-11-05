// The selector field's caret, chip removal and fuzzy class suggestions.
//
//   node test/renderer/style/selectorCaret.test.js
//
// Goal: the Style panel's selector field behaves like a tag input whose caret
// stays after the last chip. A click anywhere in the field's empty space —
// a gap between two chips included — opens the add field at its normal place,
// on its own row after the chips, never between them; a class typed there goes
// last among the element's classes; ← and → do not move a caret among chips;
// Backspace with nothing typed takes off the last chip; Delete on a selected
// chip takes off the class or attribute it names, but only when that name is
// written literally on the element. Typed text finds classes fuzzily. A name
// typed without a dot is a class, unless it is a tag, so it lands on the element.
// (The Settings panel's class field does put its caret between chips, from the
// same gap arithmetic: test/renderer/props/classInputCaret.test.js.)
//
// Method, in three layers:
//   1. The pure helpers, case by case: gap arithmetic over chip boxes
//      (chipCaret.ts, selectorCaret.ts), class placement in each class shape (classAttr.ts),
//      safe removal and every refusal (selectorRemoval.ts), and the fuzzy ranker
//      (fuzzyRank.ts) with its tier order and its misses.
//   2. The suggestion list's pure ranking (rankedSuggestions).
//   3. The real SelectorPicker mounted in JSDOM over a stub host, with chip boxes
//      faked (JSDOM has no layout), driven by mouse and keyboard events.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const throws = (run, pattern) => {
  try {
    run();
    return false;
  } catch (error) {
    return pattern.test(String(error));
  }
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'selector-caret.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { SelectorPicker, rankedSuggestions } from './src/features/style/embed/SelectorPicker'
        export * from './src/features/style/model/selectorCaret'
        export * from './src/lib/chipCaret'
        export { setHost } from './src/features/style/model/host'
        export { withClass, PLACEMENT_END } from './src/editor/classAttr'
        export { classRemoval, attributeRemoval } from './src/editor/selectorRemoval'
        export { fuzzyMatch, rankFuzzy, fuzzySegments } from './src/lib/fuzzyRank'
        export { typedSelectorText } from './src/features/style/model/typedSelector'
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
  global.window = dom.window;
  global.Window = dom.window.Window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const stored = new Map();
  global.localStorage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, String(value)), removeItem: (key) => stored.delete(key) };
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  const bundle = require(bundlePath);
  const { caretAtPoint, caretStep, clampCaret, chipAtCaret, chipPart, attributeChipName } = bundle;

  // 1a. Gaps from a click. Two rows: chips 0–2 on the first (y 0–20), 3–4 on the second (y 30–50).
  const box = (left, right, top) => ({ left, right, top, bottom: top + 20 });
  const rows = [box(0, 40, 0), box(50, 90, 0), box(100, 140, 0), box(0, 40, 30), box(50, 90, 30)];
  check('a click before the first chip is gap 0', caretAtPoint(rows, { x: 2, y: 10 }) === 0);
  check('a click on the left half of a chip is the gap before it', caretAtPoint(rows, { x: 55, y: 10 }) === 1);
  check('a click between two chips is the gap between them', caretAtPoint(rows, { x: 95, y: 10 }) === 2);
  check('a click past the end of a row is the gap after its last chip', caretAtPoint(rows, { x: 200, y: 10 }) === 3);
  check('a click on the second row lands among its chips', caretAtPoint(rows, { x: 45, y: 40 }) === 4);
  check('a click between rows belongs to the nearer row', caretAtPoint(rows, { x: 45, y: 27 }) === 4);
  check('a click below every row is the end', caretAtPoint(rows, { x: 0, y: 90 }) === 5);
  check('with no chips, every click is gap 0', caretAtPoint([], { x: 10, y: 10 }) === 0);

  // 1a'. A dotless name is a class unless it names a tag.
  const { typedSelectorText } = bundle;
  check('a bare name is a class', typedSelectorText('developer_wrap', 'section') === '.developer_wrap');
  check('a hyphenated bare name is a class', typedSelectorText('button-wrapper', 'div') === '.button-wrapper');
  check('surrounding space is dropped', typedSelectorText('  hero_wrap ', undefined) === '.hero_wrap');
  check('a bare name keeps its state', typedSelectorText('hero_wrap:hover', 'div') === '.hero_wrap:hover');
  check('a bare name keeps its combo class', typedSelectorText('hero_wrap.is-dark', 'div') === '.hero_wrap.is-dark');
  check('a bare name keeps its descendant', typedSelectorText('hero_wrap .title', 'div') === '.hero_wrap .title');
  check('an HTML tag stays a tag', typedSelectorText('section', 'div') === 'section');
  check('a tag is matched in any case', typedSelectorText('SECTION', 'div') === 'SECTION');
  check('a tag with a state stays a tag', typedSelectorText('a:hover', 'div') === 'a:hover');
  check('a tag before a descendant stays a tag', typedSelectorText('section .title', 'div') === 'section .title');
  check('an SVG tag stays a tag', typedSelectorText('svg', 'div') === 'svg');
  check('a document tag stays a tag', typedSelectorText('body', 'div') === 'body');
  check("the element's own custom tag stays a tag", typedSelectorText('my-card', 'my-card') === 'my-card');
  check('another custom-looking name is a class', typedSelectorText('my-card', 'div') === '.my-card');
  check('a dotted class is kept', typedSelectorText('.hero', 'div') === '.hero');
  check('an id is kept', typedSelectorText('#hero', 'div') === '#hero');
  check('an attribute is kept', typedSelectorText('[data-x]', 'div') === '[data-x]');
  check('a pseudo-class alone is kept', typedSelectorText(':root', 'div') === ':root');
  check('a universal selector is kept', typedSelectorText('*', 'div') === '*');
  check('a name starting with a digit is not an identifier, and is kept', typedSelectorText('2col', 'div') === '2col');
  check('nesting is kept', typedSelectorText('.hero { .title }', 'div') === '.hero { .title }');
  check('empty stays empty', typedSelectorText('   ', 'div') === '');

  // 1b. Steps and clamps.
  check('← from gap 2 is gap 1', caretStep(2, 5, -1) === 1);
  check('← from gap 0 stays at 0', caretStep(0, 5, -1) === 0);
  check('→ at the end stays at the end', caretStep(5, 5, 1) === 5);
  check('a caret past a shrunken chip list clamps to its end', clampCaret(7, 3) === 3);
  check(
    'a fractional caret is a bug, and says so',
    throws(() => caretStep(1.5, 3, 1), /integer gap/),
  );

  // 1c. Backspace / Delete targets.
  check('Backspace takes the chip before the caret', chipAtCaret(2, 4, 'Backspace') === 1);
  check('Delete takes the chip after the caret', chipAtCaret(2, 4, 'Delete') === 2);
  check('Backspace at gap 0 takes nothing', chipAtCaret(0, 4, 'Backspace') === undefined);
  check('Delete at the end takes nothing', chipAtCaret(4, 4, 'Delete') === undefined);

  // 1d. What a chip stands for.
  check('a lone class chip is a class', same(chipPart('.hero_title', 'hero_title'), { kind: 'class', name: 'hero_title' }));
  check('a presence attribute chip is an attribute', attributeChipName('[data-foo]') === 'data-foo');
  check('a valued attribute chip is an attribute', attributeChipName('[data-state="open"]') === 'data-state');
  check('a substring attribute match is not', attributeChipName('[class*="text-style-"]') === undefined);
  check('a prefix attribute match is not', attributeChipName('[data-x^="a"]') === undefined);
  check('a tag chip is part of a selector', same(chipPart('h1', undefined), { kind: 'other' }));
  check('a compound is part of a selector', same(chipPart('h1.hero_title', undefined), { kind: 'other' }));

  // 1f. Writing the class in that order, in each class shape.
  const { withClass } = bundle;
  const plainClass = (value) => ({ class: { type: 'string', value } });
  check(
    'a plain class gets the new name before its anchor',
    withClass(plainClass('hero_title text-style-h1'), 'new', { kind: 'before', className: 'text-style-h1' })?.value.value === 'hero_title new text-style-h1',
  );
  check('and after its anchor', withClass(plainClass('a b c'), 'new', { kind: 'after', className: 'a' })?.value.value === 'a new b c');
  check('an anchor that is not there appends', withClass(plainClass('a b'), 'new', { kind: 'before', className: 'zzz' })?.value.value === 'a b new');
  check('no placement appends, as before', withClass(plainClass('a b'), 'new')?.value.value === 'a b new');
  const list = (value) => ({ 'class:list': { type: 'expr', value } });
  check(
    'a one-line class:list gets the entry before a standalone anchor',
    withClass(list('["a", "b"]'), 'new', { kind: 'before', className: 'b' })?.value.value === '["a", "new", "b"]',
  );
  check(
    'a guarded anchor is not a place to insert, so it appends',
    withClass(list('[cond && "b", "c"]'), 'new', { kind: 'before', className: 'b' })?.value.value === '[cond && "b", "c", "new"]',
  );

  // 1g. Removal: what is safe, and every refusal.
  const { classRemoval, attributeRemoval } = bundle;
  const removed = classRemoval(plainClass('hero_title text-style-h1'), 'text-style-h1');
  check('a literal class is removed from class="…"', removed.tag === 'edit' && removed.value?.value === 'hero_title', JSON.stringify(removed));
  const last = classRemoval(plainClass('only'), 'only');
  check('the last literal class drops the attribute', last.tag === 'edit' && last.key === 'class' && last.value === undefined, JSON.stringify(last));
  check('a class from class={className} is refused', classRemoval({ class: { type: 'expr', value: 'className' } }, 'hero').tag === 'refused');
  check('a class inside class:list is refused', classRemoval(list('["hero", cond && "x"]'), 'hero').tag === 'refused');
  check('a class not written on the element is refused', classRemoval(plainClass('a'), 'b').tag === 'refused');
  const spread = classRemoval({ '...rest': { type: 'spread', value: 'rest' } }, 'b');
  check('and the refusal mentions a spread when there is one', spread.tag === 'refused' && /spread/.test(spread.reason), JSON.stringify(spread));
  check(
    'an empty class name is a bug',
    throws(() => classRemoval(plainClass('a'), ''), /class name is given/),
  );
  const attribute = attributeRemoval({ 'data-foo': { type: 'string', value: '1' } }, 'data-foo');
  check('a literal attribute is removed', attribute.tag === 'edit' && attribute.key === 'data-foo' && attribute.value === undefined);
  check('a bare attribute is removed', attributeRemoval({ hidden: { type: 'bare' } }, 'hidden').tag === 'edit');
  check('a bound attribute is refused', attributeRemoval({ 'data-foo': { type: 'expr', value: 'x' } }, 'data-foo').tag === 'refused');
  check('a missing attribute is refused', attributeRemoval({}, 'data-foo').tag === 'refused');
  check('the class attribute is not removed as an attribute', attributeRemoval(plainClass('a'), 'class').tag === 'refused');

  // 1h. Fuzzy ranking.
  const { fuzzyMatch, rankFuzzy, fuzzySegments } = bundle;
  check('btnprim finds button-primary', fuzzyMatch('btnprim', 'button-primary')?.tier === 'subsequence');
  check('hrtit finds hero_title', fuzzyMatch('hrtit', 'hero_title')?.tier === 'subsequence');
  check('case does not matter', fuzzyMatch('BTN', 'btnPrimary')?.tier === 'prefix');
  check('out-of-order letters miss', fuzzyMatch('tib', 'button') === undefined);
  check('a letter the name lacks misses', fuzzyMatch('btnx', 'button-primary') === undefined);
  check('an empty query matches nothing', fuzzyMatch('', 'button') === undefined);
  check('a camel hump is a word start', fuzzyMatch('style', 'textStyleH1')?.tier === 'boundary');
  check('after a dash is a word start', fuzzyMatch('prim', 'button-primary')?.tier === 'boundary');
  check('mid-word is a substring', fuzzyMatch('tto', 'button')?.tier === 'substring');
  const order = rankFuzzy('title', ['subtitle-x', 'hero_title', 'title-large', 'title', 'tixtle', 'xtitlex'], { limit: 10 }, (name) => name).map(
    ({ item }) => item,
  );
  check(
    'exact > prefix > boundary > substring > subsequence, shorter first within a tier',
    same(order, ['title', 'title-large', 'hero_title', 'xtitlex', 'subtitle-x', 'tixtle']),
    order.join(', '),
  );
  check('a word start outranks a substring', order.indexOf('hero_title') < order.indexOf('subtitle-x'), order.join(', '));
  check('a subsequence comes last', order.at(-1) === 'tixtle', order.join(', '));
  const ties = rankFuzzy('a', ['abc', 'ab', 'abd'], { limit: 10 }, (name) => name).map(({ item }) => item);
  check('ties go to the shorter, then alphabetical', same(ties, ['ab', 'abc', 'abd']), ties.join(', '));
  check('the limit holds', rankFuzzy('a', ['a1', 'a2', 'a3'], { limit: 2 }, (name) => name).length === 2);
  check(
    'an unbounded candidate list is a bug',
    throws(() => rankFuzzy('a', { length: 200_000, [Symbol.iterator]: [][Symbol.iterator] }, { limit: 1 }, String), /bounded/),
  );
  const segments = fuzzySegments('hero_title', fuzzyMatch('hrtit', 'hero_title').indexes);
  check('segments spell the name', segments.map((segment) => segment.text).join('') === 'hero_title');
  check(
    'and mark the matched letters',
    segments
      .filter((segment) => segment.hit)
      .map((segment) => segment.text)
      .join('') === 'hrtit',
    JSON.stringify(segments),
  );

  // 2. The suggestion list.
  const ranked = bundle.rankedSuggestions({
    query: 'btnprim',
    own: [{ selector: 'h1', kind: 'tag' }],
    projectClasses: ['hero_title', 'button-primary', 'button-secondary'],
    chipKeys: new Set(),
  });
  check('the field finds .button-primary from btnprim', ranked.length === 1 && ranked[0].selector === '.button-primary', JSON.stringify(ranked));
  check('with hits shifted past the dot', ranked[0]?.hits[0] === 1, JSON.stringify(ranked[0]?.hits));
  const dotted = bundle.rankedSuggestions({ query: '.hrtit', own: [], projectClasses: ['hero_title'], chipKeys: new Set() });
  check('a typed dot is optional', dotted[0]?.selector === '.hero_title');
  const empty = bundle.rankedSuggestions({ query: '', own: [{ selector: '.a', kind: 'class' }], projectClasses: ['zzz'], chipKeys: new Set() });
  check('an empty box shows only the element’s own tokens', empty.length === 1 && empty[0].selector === '.a');

  // 3. The mounted field.
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const removedClasses = [];
  const removedAttributes = [];
  const added = [];
  bundle.setHost({
    removeClass: async (name) => {
      removedClasses.push(name);
      return { tag: 'applied' };
    },
    removeAttribute: async (name) => {
      removedAttributes.push(name);
      return { tag: 'applied' };
    },
  });
  const chip = (text) => ({ key: text, text, specificity: [0, 1, 0], state: '', simple: true, fromComponent: false });
  const CHIPS = [chip('h1'), chip('.hero_title'), chip('.text-style-h1'), chip('[data-foo]')];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(SelectorPickerHarness, {
        React,
        SelectorPicker: bundle.SelectorPicker,
        selectors: CHIPS,
        onAdd: (selector, placement) => added.push({ selector, placement }),
      }),
    );
  });
  const chipElements = () => [...document.querySelectorAll('.embed-editor_selector-chip')];
  // JSDOM has no layout: give each chip a box on one row, 50px apart.
  chipElements().forEach((element, index) => {
    element.getBoundingClientRect = () => ({ left: index * 50, right: index * 50 + 40, top: 0, bottom: 20, width: 40, height: 20 });
  });
  const well = document.querySelector('.embed-editor_selector-well');
  const slot = () => document.querySelector('.embed-editor_selector-caret-slot');
  // The add field is at the end when its slot follows every chip in the DOM and
  // nothing reorders it: no CSS order on the slot or on any chip.
  const fieldAtEnd = () => {
    const element = slot();
    if (element === null) {
      return false;
    }
    if (element.style.order !== '') {
      return false;
    }
    if (chipElements().some((chipElement) => chipElement.style.order !== '')) {
      return false;
    }
    return element.parentElement?.lastElementChild === element;
  };
  await act(async () => {
    well.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 95, clientY: 10 }));
  });
  const input = () => document.querySelector('.embed-editor_selector-add');
  check('a click between .hero_title and .text-style-h1 opens the field', input() !== null);
  check('with the field after the last chip, not in that gap', fieldAtEnd(), slot()?.outerHTML);
  check('and not the narrow, between-chips kind', document.querySelector('.embed-editor_selector-field')?.classList.contains('is-between') === false);
  check('with its normal placeholder', input()?.getAttribute('placeholder') === 'Add a selector (e.g. .card:hover)');
  check('and the input focused', document.activeElement === input());
  await act(async () => {
    well.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 2, clientY: 10 }));
  });
  check('a click before the first chip also leaves the field at the end', fieldAtEnd(), slot()?.outerHTML);
  const key = async (target, name) =>
    act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  await key(input(), 'ArrowLeft');
  check('← with nothing typed does not walk a caret in among the chips', fieldAtEnd(), slot()?.outerHTML);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input(), '.new');
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await key(input(), 'Enter');
  check('a class typed after a gap click goes last', same(added.at(-1), { selector: '.new', placement: { kind: 'end' } }), JSON.stringify(added));
  check('and the field stays at the end', fieldAtEnd(), slot()?.outerHTML);
  await act(async () => {
    setter.call(input(), 'developer_wrap');
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await key(input(), 'Enter');
  check('a name typed without a dot is added as a class', added.at(-1)?.selector === '.developer_wrap', JSON.stringify(added));
  await key(input(), 'Backspace');
  check('Backspace with nothing typed takes off the last chip', same(removedAttributes, ['data-foo']), JSON.stringify(removedAttributes));
  // The host took [data-foo] off: the chips follow, and Backspace reaches the class before it.
  const remaining = CHIPS.filter((entry) => entry.text !== '[data-foo]');
  await act(async () => {
    root.render(React.createElement(SelectorPickerHarness, { React, SelectorPicker: bundle.SelectorPicker, selectors: remaining, onAdd: () => {} }));
  });
  await key(input(), 'Backspace');
  check('Backspace again takes off the class that is now last', same(removedClasses, ['text-style-h1']), JSON.stringify(removedClasses));
  await key(input(), 'Delete');
  check('Delete in the field takes nothing: nothing is after the caret', same(removedClasses, ['text-style-h1']), JSON.stringify(removedClasses));
  await key(chipElements()[1], 'Delete');
  check('Delete on a class chip takes the class off', same(removedClasses, ['text-style-h1', 'hero_title']), JSON.stringify(removedClasses));
  const before = removedClasses.length + removedAttributes.length;
  await key(chipElements()[0], 'Delete');
  check('Delete on a tag chip removes nothing', removedClasses.length + removedAttributes.length === before);
  await act(async () => {
    well.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 60 }));
  });
  check('a click below the chips puts the field at the end', fieldAtEnd(), slot()?.outerHTML);
  await act(async () => root.unmount());

  if (failures.length) {
    console.error(`selectorCaret: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selectorCaret: ${checked} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

// The picker with the props a test does not vary.
function SelectorPickerHarness({ React, SelectorPicker, selectors, onAdd }) {
  return React.createElement(SelectorPicker, {
    selectors,
    suggestions: [],
    activeSelector: '',
    activePicked: false,
    busy: false,
    loading: false,
    onSelect: () => {},
    onDeselect: () => {},
    onAdd,
  });
}
