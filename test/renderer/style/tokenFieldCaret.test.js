// Goal: a press in the token field puts the caret at the nearest gap between its
// text and chips, the way a text field does. The reported case: a colour field
// holding one variable chip, caret in front of it; a press in the empty space to
// the right of the chip left the caret in front of it, so what was typed next
// landed before the variable. The field is a flex row, and the empty space past
// its last item is resolved by the browser's flex hit test, not by line layout.
//
// Method: the field is drawn the way the app draws it (buildTokenHtml), and the
// layout jsdom cannot do is stubbed: each chip and each text node is given a box
// on one 26px row. Presses go through tokenFieldPress, the field's own mousedown
// path. Each case checks where the caret went, that typing there lands on that
// side of the chip, and that the written value carries no caret-slot characters.
// The negative space: presses over text and modified or double presses are left
// to the browser, and a chip with no text beside it is given a slot rather than
// an element-level caret a browser cannot type at. Arrowing across a chip (jumpCaretPastChip)
// is checked for a chip-only value, a chip in the middle and at the end, adjacent chips, and
// the zero-width caret slot at the far left. Run it alone with
// `node test/renderer/style/tokenFieldCaret.test.js`.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'token-field-caret.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { bracketEdit, buildTokenHtml, jumpCaretPastChip, serializeTokens, tokenFieldPress } from ${JSON.stringify(repoPath('src/features/style/TokenField.tsx'))};\n` +
      `export { caretPlacementAt, CARET_SLOT } from ${JSON.stringify(repoPath('src/features/style/tokenFieldCaret.ts'))};\n`,
  );
  const out = path.join(buildDirectory, 'token-field-caret.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root" contenteditable="true" tabindex="-1"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.HTMLElement = dom.window.HTMLElement;
  const { bracketEdit, buildTokenHtml, jumpCaretPastChip, serializeTokens, tokenFieldPress, caretPlacementAt, CARET_SLOT } = require(out);

  // --- the opening bracket ----------------------------------------------------
  //
  // Typed before a number it wraps the number and its unit; anywhere else it pairs.
  assert.deepEqual(bracketEdit('calc32px', 4, '('), { text: 'calc(32px)', caret: 5 });
  assert.deepEqual(bracketEdit('calc32px)', 4, '('), { text: 'calc(32px))', caret: 5 });
  assert.deepEqual(bracketEdit('calc-1.5rem 4px', 4, '('), { text: 'calc(-1.5rem) 4px', caret: 5 });
  assert.deepEqual(bracketEdit('calc50%', 4, '('), { text: 'calc(50%)', caret: 5 });
  assert.deepEqual(bracketEdit('calc', 4, '('), { text: 'calc()', caret: 5 });
  assert.deepEqual(bracketEdit('calc var(--a)', 4, '('), { text: 'calc() var(--a)', caret: 5 });

  // --- layout -----------------------------------------------------------------
  //
  // One row, 26px tall. Items are laid out left to right from x = 4: a chip is
  // 75px wide with 1px margins, a character of text 7px, a zero-width space 0px.
  const ROW = { top: 0, bottom: 26 };
  const boxes = new Map();
  const rect = (left, right) => ({ left, right, top: ROW.top, bottom: ROW.bottom, width: right - left, height: ROW.bottom - ROW.top, x: left, y: ROW.top });
  const layout = (field) => {
    boxes.clear();
    let x = 4;
    // A tree walk rather than recursion: chips are skipped whole, text is boxed in reading order.
    const walker = document.createTreeWalker(field, dom.window.NodeFilter.SHOW_ELEMENT | dom.window.NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement && node.parentElement.closest('[data-chip]') ? dom.window.NodeFilter.FILTER_REJECT : dom.window.NodeFilter.FILTER_ACCEPT,
    });
    for (let child = walker.nextNode(); child !== null; child = walker.nextNode()) {
      if (child.nodeType === 3) {
        const width = [...child.data].filter((character) => character !== CARET_SLOT).length * 7;
        boxes.set(child, rect(x, x + width));
        x += width;
      } else if (child.dataset && child.dataset.chip !== undefined) {
        boxes.set(child, rect(x + 1, x + 76));
        x += 77;
      }
    }
  };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function boundingRect() {
    return boxes.get(this) ?? rect(0, 0);
  };
  dom.window.Range.prototype.getBoundingClientRect = function rangeRect() {
    return boxes.get(this.startContainer) ?? rect(0, 0);
  };

  const field = document.getElementById('root');
  const binding = 'var(--dark-900)';
  const chips = [{ text: binding, name: 'dark-900', type: 'Color' }];
  const draw = (value) => {
    field.innerHTML = buildTokenHtml(value, chips);
    layout(field);
  };
  // A press as React hands it over: what the handler reads, and whether it was prevented.
  const press = (x, extra = {}) => {
    const event = { button: 0, detail: 1, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, clientX: x, clientY: 13, prevented: false, ...extra };
    event.preventDefault = () => {
      event.prevented = true;
    };
    tokenFieldPress(field, event);
    return event;
  };
  // Typing at the caret, the way the browser inserts a character into the text node it is in.
  const type = (text) => {
    const range = document.getSelection().getRangeAt(0);
    if (range.startContainer.nodeType !== 3) {
      throw new Error(`type: the caret is not in a text node (${range.startContainer.nodeName})`);
    }
    range.startContainer.insertData(range.startOffset, text);
  };
  const caret = () => {
    const range = document.getSelection().getRangeAt(0);
    return { node: range.startContainer, offset: range.startOffset };
  };
  const chip = () => field.querySelector('[data-chip]');
  // Where the caret sits relative to the chip, read off document order.
  const side = () => {
    const at = document.createRange();
    at.setStart(caret().node, caret().offset);
    return at.comparePoint(chip(), 0) === 1 ? 'before' : 'after';
  };
  const written = () => serializeTokens(field, binding, binding);

  // --- a press past a trailing chip -------------------------------------------
  draw(binding);
  // The field starts with the caret in front of the chip, as reported.
  document.getSelection().collapse(field.firstChild, 0);
  let event = press(150);
  check('a press in the empty space past the chip is placed by the field', event.prevented);
  check('and the field has focus', document.activeElement === field);
  check('the caret goes after the chip', side() === 'after', `caret in ${caret().node.nodeName} at ${caret().offset}`);
  type('x');
  check('typing there lands after the chip', written() === `${binding}x`, JSON.stringify(written()));
  check('with no caret slot in the written value', !written().includes(CARET_SLOT));

  // --- a press before a leading chip ------------------------------------------
  draw(binding);
  document.getSelection().collapse(field.lastChild, 1);
  event = press(1);
  check('a press in the padding left of the chip is placed by the field', event.prevented);
  check('the caret goes before the chip', side() === 'before', `caret in ${caret().node.nodeName} at ${caret().offset}`);
  type('x');
  check('typing there lands before the chip', written() === `x${binding}`, JSON.stringify(written()));

  // --- the nearest gap, either side of the chip's middle ----------------------
  draw(binding);
  press(30);
  check('a press nearer the left edge goes before', side() === 'before');
  draw(binding);
  press(70);
  check('a press nearer the right edge goes after', side() === 'after');

  // --- a chip with no text beside it ------------------------------------------
  //
  // Backspacing away the trailing slot leaves the chip last in the field. The
  // caret must still land in a text node after it, and the slot it is given must
  // not be written.
  draw(binding);
  field.lastChild.remove();
  layout(field);
  check('the chip is last in the field', field.lastChild === chip());
  press(150);
  check('a press past it still puts the caret after it', side() === 'after');
  check('in a text node, where typing works', caret().node.nodeType === 3);
  check('the value is unchanged by the slot', written() === binding, JSON.stringify(written()));
  type('x');
  check('and typing lands after the chip', written() === `${binding}x`, JSON.stringify(written()));

  // --- text either side: past the end, and over the text ----------------------
  const wrapped = `calc(${binding} + 1px)`;
  draw(wrapped);
  event = press(190);
  check('a press past the last text is placed by the field', event.prevented);
  check('at the very end of the text', caret().node === field.lastChild && caret().offset === field.lastChild.length);
  type('x');
  check('typing there appends', written() === `${wrapped}x`, JSON.stringify(written()));

  draw(wrapped);
  event = press(10);
  check('a press over text is the browser’s, which finds the character', !event.prevented);
  check('caretPlacementAt says so too', caretPlacementAt(field, { x: 10, y: 13 }).kind === 'browser');

  // --- presses that mean something else ---------------------------------------
  draw(binding);
  check('a double press is left to select a word', !press(150, { detail: 2 }).prevented);
  check('a shift press is left to extend the selection', !press(150, { shiftKey: true }).prevented);
  check('a right press is left alone', !press(150, { button: 2 }).prevented);

  // --- an empty field ----------------------------------------------------------
  field.innerHTML = '';
  layout(field);
  check('an empty field is the browser’s to focus', !press(50).prevented);

  // --- arrowing across a chip with a coloured gap beside it --------------------
  //
  // In a code field a space is drawn in an element of its own (`.cx-space`), so the
  // caret beside the chip sits in that element's text, never in the element.
  field.innerHTML = buildTokenHtml(`${binding} !important`, chips, true);
  const space = chip().nextSibling;
  check('the gap after the chip is its own element', space.nodeType === 1, space.nodeName);
  document.getSelection().collapse(space.firstChild, 0);
  check('← from just after the chip is handled', jumpCaretPastChip(field, 'left') === true);
  check('and lands in front of it', side() === 'before', `caret in ${caret().node.nodeName} at ${caret().offset}`);
  check('→ from just before the chip is handled', jumpCaretPastChip(field, 'right') === true);
  check(
    'and lands behind it, in the gap’s own text',
    caret().node === space.firstChild && caret().offset === 0,
    `caret in ${caret().node.nodeName} at ${caret().offset}`,
  );

  // --- arrowing across a chip next to a caret slot -----------------------------
  //
  // The reported case: a field that is only a chip, caret at its far left. The caret
  // there is in front of the zero-width slot buildTokenHtml leaves, so the first
  // ArrowRight used to be a silent step over the slot and the chip was not passed.
  // One press must land against the chip's far side (where Backspace removes it).
  const fieldSelection = document.getSelection();
  const chipAt = (index) => field.querySelectorAll('[data-chip]')[index];
  const atEdgeOf = (target, side) => {
    const { node, offset } = caret();
    const neighbour = side === 'before' ? target.previousSibling : target.nextSibling;
    return node === neighbour && offset === (side === 'before' ? neighbour.length : 0);
  };
  field.innerHTML = buildTokenHtml(binding, chips);
  fieldSelection.collapse(field.firstChild, 0);
  check('a chip-only value: → from the far left is handled', jumpCaretPastChip(field, 'right') === true);
  check('and lands after the chip in one press', atEdgeOf(chipAt(0), 'after'), `caret in ${caret().node.nodeName} at ${caret().offset}`);
  check('← from there is handled', jumpCaretPastChip(field, 'left') === true);
  check('and lands before the chip, against it', atEdgeOf(chipAt(0), 'before'), `caret in ${caret().node.nodeName} at ${caret().offset}`);
  fieldSelection.collapse(field, 0);
  check('the same from the field element itself', jumpCaretPastChip(field, 'right') === true && atEdgeOf(chipAt(0), 'after'));
  fieldSelection.collapse(field, field.childNodes.length);
  check('and ← from the far right', jumpCaretPastChip(field, 'left') === true && atEdgeOf(chipAt(0), 'before'));
  check('it never rewrites the value', written() === binding, written());

  // Chip in the middle, in the end, and typed text beside it.
  field.innerHTML = buildTokenHtml(`calc(${binding} + 1px)`, chips);
  fieldSelection.collapse(field.firstChild, 5);
  check('a chip in the middle: → steps over it', jumpCaretPastChip(field, 'right') === true && atEdgeOf(chipAt(0), 'after'));
  check('← steps back', jumpCaretPastChip(field, 'left') === true && atEdgeOf(chipAt(0), 'before'));
  fieldSelection.collapse(field.firstChild, 2);
  check('a caret away from the chip is the browser’s', jumpCaretPastChip(field, 'right') === false);
  field.innerHTML = buildTokenHtml(`a ${binding}`, chips);
  fieldSelection.collapse(field.firstChild, 2);
  check('a chip at the end: → steps over it', jumpCaretPastChip(field, 'right') === true && atEdgeOf(chipAt(0), 'after'));

  // Two chips: the second has edges too (only the first used to).
  const two = [chips[0], { text: 'var(--dark-800)', name: 'dark-800', type: 'Color' }];
  field.innerHTML = buildTokenHtml(`${two[0].text}${two[1].text}`, two);
  fieldSelection.collapse(field.firstChild, 0);
  check('adjacent chips: → passes the first', jumpCaretPastChip(field, 'right') === true && atEdgeOf(chipAt(0), 'after'));
  check('adjacent chips: → passes the second', jumpCaretPastChip(field, 'right') === true && atEdgeOf(chipAt(1), 'after'), `caret in ${caret().node.nodeName}`);
  check('adjacent chips: ← passes the second back', jumpCaretPastChip(field, 'left') === true && atEdgeOf(chipAt(1), 'before'));
  field.innerHTML = buildTokenHtml(`${two[0].text} ${two[1].text}`, two);
  fieldSelection.collapse(field.querySelectorAll('[data-chip]')[1].previousSibling.firstChild, 1);
  check('chips with a space: the caret after the space passes the second', jumpCaretPastChip(field, 'right') === true && atEdgeOf(chipAt(1), 'after'));

  // The negative space: a selection, or no chip, leaves the key to the browser.
  field.innerHTML = buildTokenHtml('12px', []);
  fieldSelection.collapse(field.firstChild, 0);
  check('no chip: nothing to step over', jumpCaretPastChip(field, 'right') === false);
  field.innerHTML = buildTokenHtml(binding, chips);
  fieldSelection.setBaseAndExtent(field.firstChild, 0, field.lastChild, 1);
  check('a selection is the browser’s (Shift+Arrow, Home, End stay native)', jumpCaretPastChip(field, 'right') === false);

  // --- the assertions that pin the inputs -------------------------------------
  let message = '';
  try {
    caretPlacementAt(field, { x: Number.NaN, y: 0 });
  } catch (error) {
    message = String(error);
  }
  check('a press without coordinates is a programmer error', /caretPlacementAt: the press has an x/.test(message), message);

  if (failures.length) {
    console.error(`\ntoken-field-caret: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`token-field-caret: ${checked} passed  [a press goes to the nearest gap]`);
  process.exit(0);
})();
