// Wrapping words in a <span> from the formatting bubble.
//
//   node test/renderer/props/richSpan.test.js
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
const { repoPath } = require('../../helpers/sources.js');

// The DOM answers "none" with null. The fakes below that stand in for DOM APIs
// return the platform's own value, read from JSON because our code never writes one.
const PLATFORM_NULL = JSON.parse('null');

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
  const bundle = path.join(buildDirectory, 'rich-span.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/props/RichContent.tsx')],
    outfile: bundle,
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
  // `jsdom` lays nothing out; the bubble positions itself off these.
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
  });
  dom.window.Range.prototype.getClientRects = () => ({
    length: 1,
    item: () => PLATFORM_NULL,
    [Symbol.iterator]: function* () {},
  });
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 200,
    height: 20,
    top: 0,
    left: 0,
    right: 200,
    bottom: 20,
  });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const RichContent = require(bundle).default;

  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  let emitted;
  const START = [{ kind: 'text', value: 'Human-centric strategies to cut through the noise' }];
  await act(async () => {
    root.render(
      React.createElement(RichContent, {
        nodes: START,
        onChange: (nodes) => {
          emitted = nodes;
        },
      }),
    );
  });

  const field = host.querySelector('[contenteditable]');
  check('the field renders', !!field, host.innerHTML.slice(0, 160));
  check('with the text in it', field?.textContent === START[0].value, JSON.stringify(field?.textContent));

  // Select "through the noise" — the tail of the only text node.
  const selectTail = async () => {
    // Merge the text nodes first: a wrap-then-unwrap leaves the run split in
    // three, and reaching for `firstChild` after that selects the wrong piece.
    field.normalize();
    const textNode = [...field.childNodes].find((node) => node.nodeType === 3 && node.textContent.includes('through the noise'));
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
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      field.dispatchEvent(new dom.window.Event('mouseup', { bubbles: true }));
      dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
    });
    return true;
  };
  await selectTail();

  const bubbleButton = (title) => [...host.querySelectorAll('.rich-bubble button')].find((button) => button.getAttribute('title') === title);
  const press = async (button) => {
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  };

  // Every button in the row is the app's own drawing. An emoji is drawn by the
  // system — its own colours, its own weight, its own idea of the baseline — so
  // one in here is the only thing in the bubble nobody designed.
  {
    const buttons = [...host.querySelectorAll('.rich-bubble button')];
    const emoji = buttons.filter((button) => /\p{Extended_Pictographic}/u.test(button.textContent || ''));
    check(
      'no button in the bubble is an emoji',
      emoji.length === 0,
      emoji.map((button) => `${button.getAttribute('title')}: ${button.textContent}`).join(', '),
    );
    const link = bubbleButton('Link');
    check('the link button is there', !!link, buttons.map((button) => button.getAttribute('title')).join(', '));
    check('and it is drawn, not typed', !!link?.querySelector('svg'), link?.innerHTML);
    // The compact bar draws superscript, subscript and code on the icon grid,
    // so none of them is a typed glyph heavier than its neighbours.
    for (const title of ['Superscript', 'Subscript', 'Code']) {
      const button = bubbleButton(title);
      check(`${title} is drawn, not typed`, !!button?.querySelector('svg'), button?.innerHTML);
    }
    // Every function the bar had before the restyle is still in it, in order.
    check(
      'the bar keeps every press, in order',
      JSON.stringify(buttons.map((button) => button.getAttribute('title'))) ===
        JSON.stringify(['Bold', 'Italic', 'Superscript', 'Subscript', 'Code', 'Wrap in a span', 'Link']),
      JSON.stringify(buttons.map((button) => button.getAttribute('title'))),
    );
    // The pressed state is a fill on screen; for a screen reader it is aria-pressed,
    // which must agree with the class that draws the fill, on and off alike.
    const disagree = buttons.filter((button) => (button.getAttribute('aria-pressed') === 'true') !== button.classList.contains('on'));
    check('each button says whether it is pressed', disagree.length === 0, disagree.map((button) => button.getAttribute('title')).join(', '));
    // Space separates the buttons; the only other thing in the row is the one
    // highlight that slides behind them, hidden from assistive technology.
    const row = host.querySelector('.rich-bubble .rich-format-row');
    const strangers = [...(row?.children ?? [])].filter((child) => child.tagName !== 'BUTTON' && !child.classList.contains('rich-format-glide'));
    check('nothing but buttons and the highlight in the row', !!row && strangers.length === 0, strangers.map((child) => child.outerHTML).join(', '));
    const glides = row ? row.querySelectorAll(':scope > .rich-format-glide') : [];
    check('one highlight for the whole row', glides.length === 1, String(glides.length));
    check('and it is not announced', glides[0]?.getAttribute('aria-hidden') === 'true', glides[0]?.outerHTML);
  }

  // The hover highlight is one element that follows the pointer: it lands in
  // place on the first button, slides to the next, and fades where it was when
  // the pointer leaves. JSDOM lays nothing out, so each button is given a place.
  {
    const glide = host.querySelector('.rich-format-glide');
    const row = host.querySelector('.rich-format-row');
    [...row.querySelectorAll('button')].forEach((button, index) => {
      Object.defineProperty(button, 'offsetLeft', { configurable: true, value: 3 + index * 30 });
      Object.defineProperty(button, 'offsetWidth', { configurable: true, value: 28 });
    });
    const hover = async (target) => {
      await act(async () => {
        target.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
      });
    };
    // React derives leave from the pointer going out to something outside the row.
    const leave = async (from) => {
      await act(async () => {
        from.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
      });
    };
    check('the highlight starts hidden', !!glide && !glide.classList.contains('shown'), glide?.className);
    await hover(bubbleButton('Bold'));
    check('first hover shows it under that button', glide.style.transform === 'translateX(3px)' && glide.style.width === '28px', glide.style.cssText);
    check('in place, without sliding in', glide.classList.contains('shown') && !glide.classList.contains('slide'), glide.className);
    await hover(bubbleButton('Italic'));
    check('the next hover moves it to that button', glide.style.transform === 'translateX(33px)', glide.style.cssText);
    check('and the move slides', glide.classList.contains('slide'), glide.className);
    await leave(bubbleButton('Italic'));
    check('leaving the bar hides it', !glide.classList.contains('shown'), glide.className);
    check('where it was', glide.style.transform === 'translateX(33px)', glide.style.cssText);
  }

  const spanButton = bubbleButton('Wrap in a span');
  check(
    'the bubble offers a span',
    !!spanButton,
    [...host.querySelectorAll('.rich-bubble button')].map((button) => button.getAttribute('title')).join(' | ') || 'no bubble',
  );
  // It sits alongside the ones that were already there, not instead of them.
  const titles = [...host.querySelectorAll('.rich-bubble button')].map((button) => button.getAttribute('title'));
  check(
    'beside the existing tools',
    ['Bold', 'Italic', 'Code'].every((title) => titles.includes(title)),
    JSON.stringify(titles),
  );

  if (spanButton) {
    await press(spanButton);
    // The DOM now holds the span:
    const element = field.querySelector('span:not(.expr-chip)');
    check('pressing it wraps the selection', !!element, field.innerHTML);
    check('around exactly the words chosen', element?.textContent === 'through the noise', JSON.stringify(element?.textContent));
    check('and with nothing on it — an empty span is the useful result', element && element.attributes.length === 0, element?.outerHTML);

    // …and so does the model that gets written back.
    const spans = (emitted || []).filter((node) => node.kind === 'element' && node.name === 'span');
    check('the change reaches the model', spans.length === 1, JSON.stringify(emitted));
    check('carrying the words', spans[0]?.children?.[0]?.value === 'through the noise', JSON.stringify(spans[0]));
    check('and the text before it is untouched', (emitted || [])[0]?.value === 'Human-centric strategies to cut ', JSON.stringify((emitted || [])[0]));

    // Pressing again takes it back off — the only way back for an invisible tag.
    const again = bubbleButton('Wrap in a span');
    check('the button is still there to press again', !!again);
    if (again) {
      await press(again);
      check('pressing it again unwraps', !field.querySelector('span:not(.expr-chip)'), field.innerHTML);
      check('and the words survive', field.textContent === START[0].value, JSON.stringify(field.textContent));
      const after = (emitted || []).filter((node) => node.kind === 'element' && node.name === 'span');
      check('with no span left in the model', after.length === 0, JSON.stringify(emitted));
    }
  }

  // Code shares the wrap/unwrap path now, so it has to still do its own job —
  // and it gains the same toggle, which it never had (pressing it twice used to
  // nest one <code> inside another).
  await selectTail();
  const codeButton = bubbleButton('Code');
  check('Code is still wired', !!codeButton);
  if (codeButton) {
    await press(codeButton);
    check('Code still wraps', field.querySelector('code')?.textContent === 'through the noise', field.innerHTML);
    await press(bubbleButton('Code'));
    check('and now unwraps instead of nesting', !field.querySelector('code'), field.innerHTML);
    check('leaving the text whole', field.textContent === START[0].value, JSON.stringify(field.textContent));
  }

  // Twice in the same tick — a double-press, or just a fast one. The toggle
  // used to read the selection it had SAVED, and refreshing that was left to
  // `selectionchange`, which browsers (and jsdom) fire from a queued task. A
  // second press landing before that task ran acted on the range from before
  // the first one, which the wrap had meanwhile dragged out to point at the
  // <code> from the outside — so the toggle saw nothing around it and wrapped
  // again. Pressing in separate ticks let the event land first, which is why
  // this only ever showed up as the odd failed run.
  await selectTail();
  if (bubbleButton('Code')) {
    const fire = () => {
      const button = bubbleButton('Code');
      button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    };
    await act(async () => {
      fire();
      fire();
    });
    check('two presses in one tick still leave no code', field.querySelectorAll('code').length === 0, field.innerHTML);
    check('and the words still whole', field.textContent === START[0].value, JSON.stringify(field.textContent));
  }

  await act(async () => {
    root.unmount();
  });

  if (failures.length) {
    console.error(`rich-span: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`rich-span: ${checked} passed  [wraps, and unwraps]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
