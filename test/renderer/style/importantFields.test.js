// `!important` in the style panel's fields.
//
//   node test/renderer/style/importantFields.test.js
//
// Goal: a property written `!important` shows the flag in every control that
// holds its value — after the value in a text, token or number field, at rest
// and not only while typed into; as the `!` mark on a control with no text to
// put it in — and editing keeps it until the person deletes it from the text.
//
// Methodology: the shared helpers (model/styleDisplay.ts) and the tokeniser
// that colours the flag are checked as pure functions first, including the
// assertion that guards an impossible display. Then real sections are mounted
// in jsdom against a hand-built resolved model, the same shape the panel's
// resolver produces, and driven the way a person would: read the field at
// rest, type, delete, step with the arrow key, drag a swatch, pick a segment.
// Writes are recorded rather than applied, so each check sees exactly what a
// control asked the writer to do.

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

// The DOM here lays nothing out, and the colour picker divides by its track width.
const SIZE = 240;

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'important-fields.bundle.js');
  await esbuild.build({
    stdin: {
      contents: [
        `export { withImportant, displayText, keepImportant, parseImportant } from './src/features/style/model/styleDisplay'`,
        `export { cssTokens, highlightCss } from './src/features/style/model/cssCode'`,
        `export { default as BordersSection } from './src/features/style/BordersSection'`,
        `export { default as SizeSection } from './src/features/style/SizeSection'`,
        `export { OpacityRow } from './src/features/style/OpacityRow'`,
        `export { TruncateRow } from './src/features/style/TextWrapRows'`,
        `export { default as ColorSwatch } from './src/features/style/components/ColorSwatch'`,
      ].join('\n'),
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
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  // The picker reads a canvas context it can do without in jsdom.
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.addEventListener('error', (event) => {
    check('events complete without throwing', false, event.message);
  });
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE };
  };
  dom.window.avb = { listAssets: async () => ({ entries: [] }) };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const bundle = require(bundlePath);

  // --- the shared helpers ------------------------------------------------------
  {
    const { withImportant, displayText, keepImportant, parseImportant, cssTokens } = bundle;
    check('withImportant puts the flag after the value', withImportant({ value: '#ceff08', important: true }) === '#ceff08 !important');
    check('withImportant leaves a plain value alone', withImportant({ value: '#ceff08', important: false }) === '#ceff08');
    check('displayText is empty for an absent property', displayText({ present: false, value: '', important: false }) === '');
    check('displayText shows the flag', displayText({ present: true, value: '10px', important: true }) === '10px !important');
    let message = '';
    try {
      displayText({ present: false, value: '', important: true });
    } catch (error) {
      message = String(error.message);
    }
    check('an absent but flagged display is a programmer error', message === 'Assertion failed: displayText: an absent property is not important', message);
    const kept = keepImportant('var(--accent)', { important: true });
    check('a pick keeps the flag the property has', kept.value === 'var(--accent)' && kept.important === true, JSON.stringify(kept));
    const named = keepImportant('var(--accent) !important', { important: false });
    check('a pick that names the flag keeps it', named.value === 'var(--accent)' && named.important === true, JSON.stringify(named));
    const plain = keepImportant('red', { important: false });
    check('a pick on a plain property stays plain', plain.value === 'red' && plain.important === false, JSON.stringify(plain));
    check('parseImportant round-trips the join', parseImportant(withImportant({ value: '1px solid red', important: true })).value === '1px solid red');
    const tokens = cssTokens('#ceff08 !important').map((token) => `${token.kind}:${token.text}`);
    check('the tokeniser gives the flag its own run', tokens.join('|') === 'hex:#ceff08|plain: |important:!important', tokens.join('|'));
    check(
      'a lone `!` is still plain',
      cssTokens('a ! b').some((token) => token.kind === 'plain' && token.text.includes('!')),
    );
  }

  // --- a model and a recorder ---------------------------------------------------
  // The resolver's shape for one property the picked selector sets.
  const declared = (prop, value, important) => ({
    prop,
    source: 'selected',
    selectedValue: { value, important },
    winner: { selectorText: '.card', value, important },
    overridden: false,
    contributors: [],
  });
  const mount = async (component, model) => {
    const writes = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const props = {
      read: (prop) => model[prop],
      busy: false,
      setProp: (prop, value, important) => writes.push({ kind: 'set', prop, value, important }),
      clearProp: (prop) => writes.push({ kind: 'clear', prop }),
      liveSetProp: (prop, value, important) => writes.push({ kind: 'live', prop, value, important }),
      onProvenance: () => {},
      onSelectSelector: () => {},
    };
    await act(async () => {
      root.render(React.createElement(component, props));
    });
    return { host, writes, unmount: () => act(async () => root.unmount()) };
  };
  // Type into a React-controlled input the way the browser does.
  const typeInto = async (input, text) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      input.focus();
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const blur = async (input) => {
    await act(async () => {
      input.blur();
    });
  };
  const lastSet = (writes, prop) => writes.filter((write) => write.kind === 'set' && write.prop === prop).pop();

  // --- a token field: the border colour from the report --------------------------
  {
    const { host, writes, unmount } = await mount(bundle.BordersSection, { 'border-color': declared('border-color', '#ceff08', true) });
    const input = host.querySelector('input[aria-label="all border color"]');
    check('the colour field shows the flag at rest', input?.value === '#ceff08 !important', input?.value);
    const editor = input?.parentElement?.querySelector('[contenteditable]');
    check('the token field draws the flag as its own run', !!editor?.querySelector('.cx-important'), editor?.innerHTML);
    check('the token field reads the full text', (editor?.textContent ?? '').includes('#ceff08 !important'), editor?.textContent);

    const fillOf = () => host.querySelector('.u-color-swatch-fill')?.getAttribute('style') || '';
    check('the swatch still paints the colour', /206,\s*255,\s*8|#ceff08/i.test(fillOf()), fillOf());

    // Dragging in the swatch's picker keeps the flag on what it writes.
    const swatch = host.querySelector('.u-color-swatch');
    await act(async () => {
      swatch.click();
    });
    const square = document.querySelector('.u-color-sb');
    check('the swatch opens its picker', !!square);
    if (square) {
      const event = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clientX', { value: 0.5 * SIZE });
      Object.defineProperty(event, 'clientY', { value: 0.5 * SIZE });
      await act(async () => {
        square.dispatchEvent(event);
      });
      const live = writes.filter((write) => write.kind === 'live' && write.prop === 'border-color').pop();
      check('a swatch drag keeps the flag', live?.important === true, JSON.stringify(live));
      check('and writes the colour without it', !!live && !/important/i.test(live.value), JSON.stringify(live));
      check('the field beside it keeps showing the flag through the drag', /!important$/.test(input?.value ?? ''), input?.value);
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
      });
    }
    await unmount();
  }

  // --- a number + unit field: width ---------------------------------------------
  {
    const { host, writes, unmount } = await mount(bundle.SizeSection, { width: declared('width', '100px', true) });
    const input = () => host.querySelector('input[data-prop="width"]');
    check('the width field shows the flag at rest', input()?.value === '100px !important', input()?.value);

    // Editing the number keeps the flag, because the text still says it.
    await typeInto(input(), '120px !important');
    await blur(input());
    const edited = lastSet(writes, 'width');
    check('editing the value keeps the flag', edited?.value === '120px' && edited?.important === true, JSON.stringify(edited));

    // The arrow key steps the number and leaves the flag where it is. The model
    // here never answers a write, so the field still holds the 120px typed above.
    await act(async () => {
      input().focus();
      input().setSelectionRange(1, 1);
      input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    check('stepping keeps the flag in the text', input()?.value === '121px !important', input()?.value);
    await blur(input());
    const stepped = lastSet(writes, 'width');
    check('and writes the stepped value flagged', stepped?.value === '121px' && stepped?.important === true, JSON.stringify(stepped));

    // Deleting the flag from the text removes it.
    await typeInto(input(), '120px');
    await blur(input());
    const deleted = lastSet(writes, 'width');
    check('deleting the flag removes it', deleted?.value === '120px' && deleted?.important === false, JSON.stringify(deleted));

    // Typing the flag adds it.
    await typeInto(input(), '90px !important');
    await blur(input());
    const added = lastSet(writes, 'width');
    check('typing the flag adds it', added?.value === '90px' && added?.important === true, JSON.stringify(added));
    await unmount();
  }

  // --- a number field with a slider: opacity ------------------------------------
  {
    const { host, writes, unmount } = await mount(({ ...props }) => React.createElement(bundle.OpacityRow, { props }), {
      opacity: declared('opacity', '0.5', true),
    });
    const input = () => host.querySelector('input[aria-label="Opacity"][inputmode="decimal"]');
    check('the opacity field shows the flag at rest', input()?.value === '0.5 !important', input()?.value);
    await typeInto(input(), '0.4 !important');
    await blur(input());
    const edited = lastSet(writes, 'opacity');
    check('editing opacity keeps the flag', edited?.value === '0.4' && edited?.important === true, JSON.stringify(edited));
    await typeInto(input(), '0.4');
    await blur(input());
    const deleted = lastSet(writes, 'opacity');
    check('deleting it from the opacity text removes it', deleted?.value === '0.4' && deleted?.important === false, JSON.stringify(deleted));
    await unmount();
  }

  // --- a segmented bar with a custom field: border style -------------------------
  {
    const { host, unmount } = await mount(bundle.BordersSection, { 'border-style': declared('border-style', 'solid', true) });
    const input = host.querySelector('input[aria-label="Border style value"]');
    check('a flagged style opens the custom field of the bar', !!input);
    check('which shows the flag', input?.value === 'solid !important', input?.value);
    await unmount();
  }

  // --- a segmented control with no text: truncate --------------------------------
  {
    const { host, writes, unmount } = await mount(bundle.TruncateRow, { 'text-overflow': declared('text-overflow', 'ellipsis', true) });
    const badge = host.querySelector('.embed-editor_important-badge');
    check('a flagged bar carries the ! mark', badge?.textContent === '!', host.innerHTML);
    check('the mark names the flag for assistive tech', badge?.getAttribute('aria-label') === '!important');
    const clip = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Clip');
    await act(async () => {
      clip.click();
    });
    const picked = lastSet(writes, 'text-overflow');
    check('a pick keeps the flag', picked?.value === 'clip' && picked?.important === true, JSON.stringify(picked));
    await unmount();

    const plain = await mount(bundle.TruncateRow, { 'text-overflow': declared('text-overflow', 'ellipsis', false) });
    check('a plain bar has no mark', plain.host.querySelector('.embed-editor_important-badge') === null);
    await plain.unmount();
  }

  // --- the swatch on its own ----------------------------------------------------
  {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(bundle.ColorSwatch, { value: '#ceff08 !important', ariaLabel: 'Color', onChange: () => {} }));
    });
    const style = host.querySelector('.u-color-swatch-fill')?.getAttribute('style') || '';
    check('a swatch handed a flagged colour paints the colour', /206,\s*255,\s*8|#ceff08/i.test(style), style);
    await act(async () => root.unmount());
  }

  if (failures.length) {
    console.error(`important-fields: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`important-fields: ${checked} passed  [helpers, token, number, opacity, bars, swatch]`);
  process.exit(0);
})();
