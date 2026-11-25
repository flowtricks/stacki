// Pointing at the gap field lights the gaps.
//
//   node test/renderer/style/gapHover.test.js
//
// test/electron/preload/gapBands.test.js checks where the bands go; this checks that they are asked
// for at all. Hovering the field tells the canvas which spaces that number
// holds open, the same way hovering a padding side does — and it stopped
// working the moment the field grew a syntax-highlighted editor: that editor
// stands in front of the input, so the pointer reached it and never the input
// whose handlers do the reporting. Focus still worked, because the editor hands
// focus and blur over by hand — so the bands appeared on click and not on
// hover, which is exactly backwards from how you find out what a number does.
//
// The rest is the part that was already easy to get wrong: hover and focus both
// hold the bands up, and they go out only when neither does.

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

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'gap-hover.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as GapControl } from './src/features/style/GapControl'
        export { setHost } from './src/features/style/model/host'
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
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // A value holding a var() asks for the project's variables, which starts by
  // listening for changes to them. No variables arrive here: the chip is drawn
  // from the var() in the value itself, which is all this test needs.
  dom.window.avb = { onCssChanged: () => () => {} };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { GapControl, setHost } = require(bundlePath);

  // What the canvas is told to draw. undefined = take the bands down.
  let hover;
  const seen = [];
  setHost({
    nodes: [],
    selectedId: undefined,
    files: [],
    astroFiles: [],
    onSpacingHover: (spacingHover) => {
      hover = spacingHover;
      seen.push(spacingHover);
    },
  });

  // `gap: 2rem`, set by the rule the panel is editing — the screenshot's case.
  const resolved = {
    source: 'selected',
    selectedValue: { value: '2rem', important: false },
    winner: { value: '2rem', important: false },
    contributors: [],
  };
  const props = {
    show: true,
    read: (prop) => (prop === 'gap' ? resolved : undefined),
    busy: false,
    setProp: () => {},
    clearProp: () => {},
    liveSetProp: () => {},
    onProvenance: () => {},
    onSelectSelector: () => {},
  };

  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(GapControl, props));
  });

  const field = document.querySelector('input.embed-editor_size-input');
  check('the gap field is there', field !== null);
  check('and it reads the value that is set', field?.value === '2rem', field?.value);

  // The syntax-highlighted editor is what the pointer actually meets.
  const wrap = field?.closest('.embed-editor_varconnect');
  check('the field wears the code editor', wrap?.className.includes('is-token') === true, wrap?.className);

  // React synthesises enter/leave from mouseover/mouseout, so that is what a
  // pointer arriving is.
  const point = async (type, node, related) => {
    await act(async () => {
      node.dispatchEvent(
        new dom.window.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          relatedTarget: related,
        }),
      );
    });
  };
  const editor = wrap?.querySelector('[contenteditable]') ?? wrap;

  await point('mouseover', editor, document.body);
  check('pointing at it asks for the bands', hover !== undefined, JSON.stringify(hover));
  check('on both axes, since one field owns both', hover?.sides?.join(',') === 'row,column', JSON.stringify(hover?.sides));
  check('labelled with the value it holds', hover?.labels?.row === '2rem', JSON.stringify(hover?.labels));
  check('and named as a gap, not a padding', hover?.kind === 'gap', hover?.kind);

  await point('mouseout', editor, document.body);
  check('taking the pointer away takes them down', hover === undefined, JSON.stringify(hover));

  // Hover and focus are two hands on the same thing: whichever is left holds it.
  await point('mouseover', editor, document.body);
  await act(async () => {
    field.focus();
  });
  check('clicking in while hovering keeps them up', hover !== undefined);
  await point('mouseout', editor, document.body);
  check('and the pointer leaving does not take them from the caret', hover !== undefined, JSON.stringify(hover));
  await act(async () => {
    field.blur();
  });
  check('only letting go of both does', hover === undefined, JSON.stringify(hover));

  // Typing relabels the bands that are already up, rather than showing the value
  // that was there when the pointer arrived.
  await point('mouseover', editor, document.body);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, '3rem');
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  check('typing relabels them as it goes', hover?.labels?.row === '3rem', JSON.stringify(hover?.labels));
  await point('mouseout', editor, document.body);
  await act(async () => {
    root.unmount();
  });

  // A gap connected to a variable, or written as a calc(), lights its bands
  // exactly as `2rem` does. The field shows a chip instead of the text, and the
  // pointer lands on the chip; the hover must still reach the field's handlers.
  // (Where the bands go for such a value is the canvas's half of the same fix:
  // test/electron/preload/gapBands.test.js, "a gap the computed style leaves unresolved".)
  for (const { authored, pointAt } of [
    { authored: 'var(--site-gutter)', pointAt: '[data-chip]' },
    { authored: 'calc(var(--space-8) * 2)', pointAt: '[data-chip]' },
    { authored: 'calc(2% + 4px)', pointAt: '[contenteditable]' },
  ]) {
    const held = { source: 'selected', selectedValue: { value: authored, important: false }, winner: { value: authored, important: false }, contributors: [] };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const valueRoot = createRoot(container);
    await act(async () => {
      valueRoot.render(React.createElement(GapControl, { ...props, read: (prop) => (prop === 'gap' ? held : undefined) }));
    });
    const target = container.querySelector(`.embed-editor_varconnect ${pointAt}`);
    check(`${authored}: the field shows it as ${pointAt === '[data-chip]' ? 'a chip' : 'code'}`, target !== null, container.innerHTML.slice(0, 200));
    hover = undefined;
    await point('mouseover', target ?? container, document.body);
    check(`${authored}: pointing at it asks for the bands`, hover?.kind === 'gap', JSON.stringify(hover));
    check(`${authored}: on both axes`, hover?.sides?.join(',') === 'row,column', JSON.stringify(hover?.sides));
    check(`${authored}: labelled with what is written`, hover?.labels?.row === authored, JSON.stringify(hover?.labels));
    await point('mouseout', target ?? container, document.body);
    check(`${authored}: and leaving takes them down`, hover === undefined, JSON.stringify(hover));
    await act(async () => {
      valueRoot.unmount();
    });
  }

  if (failures.length) {
    console.error(`gap-hover: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`gap-hover: ${checked} passed  [hover through the code editor, hover + focus]`);
  process.exit(0);
})();
