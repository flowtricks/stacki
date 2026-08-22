// Wrapping words in a <span> from the formatting bubble.
//
//   node test/rich-span.js
//
// The bubble does bold, italic, super/subscript, code and links — all of which
// mean something on their own. A <span> means nothing on its own, and that is
// the point of it: it is the hook. Wrap some words, and now there is a node in
// the tree to give a class to and style like any other, which is the only way
// to reach part of a heading rather than all of it.
//
// Which makes the toggle load-bearing in a way the others aren't. A span with
// nothing on it yet is invisible in the canvas AND in the field — so one added
// by mistake, or added and then thought better of, could only be removed by
// going and editing the file, if the button did not take it back off.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'rich-span.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'RichContent.jsx')],
    outfile: bundle, bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lays nothing out; the bubble positions itself off these.
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 });
  dom.window.Range.prototype.getClientRects = () => ({ length: 1, item: () => null, [Symbol.iterator]: function* () {} });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 20, top: 0, left: 0, right: 200, bottom: 20 });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const RichContent = require(bundle).default;

  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  let emitted = null;
  const START = [{ kind: 'text', value: 'Human-centric strategies to cut through the noise' }];
  await act(async () => {
    root.render(React.createElement(RichContent, { nodes: START, onChange: (n) => { emitted = n } }));
  });

  const field = host.querySelector('[contenteditable]');
  check('the field renders', !!field, host.innerHTML.slice(0, 160));
  check('with the text in it', field?.textContent === START[0].value, JSON.stringify(field?.textContent));

  // Select "through the noise" — the tail of the only text node.
  const selectTail = async () => {
    // Merge the text nodes first: a wrap-then-unwrap leaves the run split in
    // three, and reaching for `firstChild` after that selects the wrong piece.
    field.normalize();
    const textNode = [...field.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('through the noise'));
    // Guarded: when a regression leaves the words buried inside a tag, there is
    // no top-level text node to select — a FAILURE to report, not a stack trace
    // that hides which case broke.
    if (!textNode) {
      check('the words are selectable at the top level', false, field.innerHTML);
      return false;
    }
    const at = textNode.textContent.indexOf('through the noise');
    const range = dom.window.document.createRange();
    range.setStart(textNode, at);
    range.setEnd(textNode, at + 'through the noise'.length);
    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await act(async () => {
      field.dispatchEvent(new dom.window.Event('mouseup', { bubbles: true }));
      dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
    });
    return true;
  };
  await selectTail();

  const bubbleBtn = (title) => [...host.querySelectorAll('.rich-bubble button')].find((b) => b.getAttribute('title') === title);
  const press = async (btn) => {
    await act(async () => {
      btn.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  };

  // Every button in the row is the app's own drawing. An emoji is drawn by the
  // system — its own colours, its own weight, its own idea of the baseline — so
  // one in here is the only thing in the bubble nobody designed.
  {
    const buttons = [...host.querySelectorAll('.rich-bubble button')];
    const emoji = buttons.filter((b) => /\p{Extended_Pictographic}/u.test(b.textContent || ''));
    check(
      'no button in the bubble is an emoji',
      emoji.length === 0,
      emoji.map((b) => `${b.getAttribute('title')}: ${b.textContent}`).join(', ')
    );
    const link = bubbleBtn('Link');
    check('the link button is there', !!link, buttons.map((b) => b.getAttribute('title')).join(', '));
    check('and it is drawn, not typed', !!link?.querySelector('svg'), link?.innerHTML);
  }

  const spanBtn = bubbleBtn('Wrap in a span');
  check('the bubble offers a span', !!spanBtn, [...host.querySelectorAll('.rich-bubble button')].map((b) => b.getAttribute('title')).join(' | ') || 'no bubble');
  // It sits alongside the ones that were already there, not instead of them.
  const titles = [...host.querySelectorAll('.rich-bubble button')].map((b) => b.getAttribute('title'));
  check('beside the existing tools', ['Bold', 'Italic', 'Code'].every((t) => titles.includes(t)), JSON.stringify(titles));

  if (spanBtn) {
    await press(spanBtn);
    // The DOM now holds the span…
    const el = field.querySelector('span:not(.expr-chip)');
    check('pressing it wraps the selection', !!el, field.innerHTML);
    check('around exactly the words chosen', el?.textContent === 'through the noise', JSON.stringify(el?.textContent));
    check('and with nothing on it — an empty span is the useful result', el && el.attributes.length === 0, el?.outerHTML);

    // …and so does the model that gets written back.
    const spans = (emitted || []).filter((n) => n.kind === 'element' && n.name === 'span');
    check('the change reaches the model', spans.length === 1, JSON.stringify(emitted));
    check('carrying the words', spans[0]?.children?.[0]?.value === 'through the noise', JSON.stringify(spans[0]));
    check('and the text before it is untouched', (emitted || [])[0]?.value === 'Human-centric strategies to cut ', JSON.stringify((emitted || [])[0]));

    // Pressing again takes it back off — the only way back for an invisible tag.
    const again = bubbleBtn('Wrap in a span');
    check('the button is still there to press again', !!again);
    if (again) {
      await press(again);
      check('pressing it again unwraps', !field.querySelector('span:not(.expr-chip)'), field.innerHTML);
      check('and the words survive', field.textContent === START[0].value, JSON.stringify(field.textContent));
      const after = (emitted || []).filter((n) => n.kind === 'element' && n.name === 'span');
      check('with no span left in the model', after.length === 0, JSON.stringify(emitted));
    }
  }

  // Code shares the wrap/unwrap path now, so it has to still do its own job —
  // and it gains the same toggle, which it never had (pressing it twice used to
  // nest one <code> inside another).
  await selectTail();
  const codeBtn = bubbleBtn('Code');
  check('Code is still wired', !!codeBtn);
  if (codeBtn) {
    await press(codeBtn);
    check('Code still wraps', field.querySelector('code')?.textContent === 'through the noise', field.innerHTML);
    await press(bubbleBtn('Code'));
    check('and now unwraps instead of nesting', !field.querySelector('code'), field.innerHTML);
    check('leaving the text whole', field.textContent === START[0].value, JSON.stringify(field.textContent));
  }

  await act(async () => { root.unmount() });

  if (failures.length) {
    console.error(`rich-span: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`rich-span: ${checked} passed  [wraps, and unwraps]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
