// The dropdown, and the entry picker built on it.
//
//   node test/renderer/ui/dropdown.test.js
//
// A dynamic route's picker lists one option per entry of a collection, so it
// grows with the content: sixty posts is a scroll unless it can be filtered,
// and every option in it is a page the collection generates, which the rest of
// the app draws in purple with a page glyph. This checks the parts of that
// which are easy to break by accident — the filter box narrowing the list, the
// keyboard still landing on the right option once it has, and the classes the
// colour hangs off.

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
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'dynamic-picker.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/app/DynamicPicker.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // `jsdom` has no layout, so it has no scrollIntoView; the popup calls it to
  // keep the highlighted option visible.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const DynamicPicker = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const body = dom.window.document.body;
  const all = (selector) => [...body.querySelectorAll(selector)];
  const find = (selector) => body.querySelector(selector);

  const ids = [
    '2025/editorial-calendar-notes',
    '2025/the-cost-of-a-thousand-images',
    '2026/spring/an-mdx-post-with-components',
    '2026/spring/loaders-from-scratch',
    '2026/spring/translating-a-site-without-losing-your-mind',
    'schema-design-for-editors',
    'what-changed-in-the-content-layer',
  ];
  let picked;

  const render = (entries) =>
    act(async () => {
      reactRoot.render(
        React.createElement(DynamicPicker, {
          entries: entries.map((label) => ({ label })),
          index: 0,
          onPick: (i) => {
            picked = i;
          },
        }),
      );
      await settle(20);
    });

  await render(ids);
  check('the trigger reads as a generated route', !!find('.dd-trigger.collection'));
  check('and carries a page glyph', !!find('.dd-trigger .dd-icon svg'));
  check('showing the current entry', /editorial-calendar-notes/.test(find('.dd-label')?.textContent || ''));

  await act(async () => {
    find('.dd-trigger').click();
    await settle(20);
  });
  check('the popup opens', !!find('.dd-popup'));
  check('purple carries into the list', !!find('.dd-popup.collection'));
  check('every option has a glyph', all('.dd-option .dd-icon svg').length === ids.length, `${all('.dd-option .dd-icon svg').length}`);
  check('the current one is ticked', !!find('.dd-option.selected .dd-check svg'));
  check('the list has a filter box', !!find('.dd-search'));

  // Typing narrows it.
  await act(async () => {
    const input = find('.dd-search');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'spring');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
  });
  check('the filter narrows the list', all('.dd-option').length === 3, `${all('.dd-option').length} shown`);
  check(
    'to the options that match',
    all('.dd-option').every((node) => /spring/.test(node.textContent)),
  );

  // And Enter picks what the filtered list is highlighting, not what the
  // unfiltered one would have.
  await act(async () => {
    find('.dd-search').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(20);
  });
  check('Enter picks from the filtered list', picked === 2, `picked index ${picked}`);
  check('and the popup closes', !find('.dd-popup'));

  // However few entries a collection has. A box that appears at some number of
  // posts is a box nobody can rely on.
  await render(ids.slice(0, 3));
  await act(async () => {
    find('.dd-trigger').click();
    await settle(20);
  });
  check('a short list has one too', !!find('.dd-search'));
  check('and still has its glyphs', all('.dd-option .dd-icon svg').length === 3);

  // A searchable popup owns the scrolling list inside it. Simulate the
  // browser's constrained measurement: the outer popup reports its cap while
  // capped and its full content height otherwise. The position calculation
  // must not feed that changing measurement back into the cap and render
  // forever when a real collection has hundreds of entries.
  const scrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (this.classList?.contains('dd-popup')) {
        return this.style.maxHeight ? Number.parseFloat(this.style.maxHeight) : 9000;
      }
      return 0;
    },
  });
  const largeIds = Array.from({ length: 296 }, (_, index) => `sermon-${index}`);
  function ControlledPicker() {
    const [index, setIndex] = React.useState(0);
    return React.createElement(DynamicPicker, {
      entries: largeIds.map((label) => ({ label })),
      index,
      onPick: setIndex,
      pattern: '/sermons/[slug]',
    });
  }
  await act(async () => {
    reactRoot.render(React.createElement(ControlledPicker));
    await settle(20);
  });
  await act(async () => {
    find('.dd-trigger').click();
    await settle(20);
  });
  check('a large collection opens without a render loop', all('.dd-option').length === 296);
  await act(async () => {
    all('.dd-option')[295].click();
    await settle(20);
  });
  check('a large controlled picker switches entries', find('.dd-label')?.textContent === 'sermon-295');
  check('and closes after switching', !find('.dd-popup'));
  if (scrollHeight) {
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', scrollHeight);
  } else {
    Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollHeight');
  }

  await act(async () => reactRoot.unmount());

  // --- What a hover costs -------------------------------------------------------
  //
  // Hovering an option applies it, so the canvas shows the variant you are
  // pointing at. Applying is not free: the app writes the page, the dev server
  // renders it, the canvas fetches the rendering. On a big page that is most of
  // a second — so the one thing this must not do is ask for the same value
  // twice, which is exactly what picking the option you had just hovered did.
  {
    const Dropdown = require(
      await (async () => {
        const out = path.join(buildDirectory, 'dropdown.bundle.js');
        await esbuild.build({
          entryPoints: [repoPath('src/ui/Dropdown.tsx')],
          outfile: out,
          bundle: true,
          format: 'cjs',
          platform: 'node',
          jsx: 'automatic',
          external: ['react', 'react-dom', 'react/jsx-runtime'],
          logLevel: 'silent',
        });
        return out;
      })(),
    ).default;

    const applied = [];
    const root2 = createRoot(container);
    const OPTIONS = [
      { value: 'main', label: 'main' },
      { value: 'play', label: 'play' },
      { value: 'pause', label: 'pause' },
    ];
    const show = (value) =>
      act(async () => {
        root2.render(
          React.createElement(Dropdown, {
            value,
            options: OPTIONS,
            onChange: (value) => applied.push(value),
          }),
        );
        await settle(20);
      });
    await show('main');
    await act(async () => {
      find('.dd-trigger').click();
      await settle(20);
    });
    const option = (label) => all('.dd-option').find((option) => option.textContent.trim() === label);
    // React synthesises mouseenter from a bubbling mouseover, so that is what
    // a pointer arriving on an option looks like from here.
    const hover = (label) =>
      act(async () => {
        option(label)?.dispatchEvent(
          new dom.window.MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: dom.window.document.body,
          }),
        );
        await settle(70);
      });

    await hover('play');
    check('hovering an option applies it, so the canvas can show it', applied.join() === 'play', applied.join());

    await act(async () => {
      option('play')?.click();
      await settle(20);
    });
    check('and picking the option you hovered does not ask for it again', applied.join() === 'play', applied.join());
    check('the popup closes on the pick', !find('.dd-popup'), 'still open');

    // A pick that was never hovered — the keyboard, or a click straight onto an
    // option — still has to be applied.
    await act(async () => {
      find('.dd-trigger').click();
      await settle(20);
    });
    await act(async () => {
      option('pause')?.click();
      await settle(20);
    });
    check('a pick nobody hovered is applied', applied.join() === 'play,pause', applied.join());

    // Pointer entry and press can happen before the hover preview starts. The
    // press must commit once, and the canceled preview must not write afterward.
    await show('main');
    await act(async () => {
      find('.dd-trigger').click();
      await settle(20);
    });
    await act(async () => {
      const row = option('play');
      row.dispatchEvent(
        new dom.window.MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: dom.window.document.body,
        }),
      );
      const down = new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 });
      Object.defineProperty(down, 'pointerType', { value: 'mouse' });
      row.dispatchEvent(down);
      await settle(150);
    });
    check('a quick press commits the option', applied.join() === 'play,pause,play');
    check('and the quick press closes the popup', !find('.dd-popup'));

    await show('main');
    await act(async () => {
      find('.dd-trigger').click();
      await settle(20);
    });
    await act(async () => {
      for (const label of ['play', 'pause']) {
        option(label)?.dispatchEvent(
          new dom.window.MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: dom.window.document.body,
          }),
        );
      }
      await settle(70);
    });
    check('moving across options previews only the latest one within a frame', applied.join() === 'play,pause,play,pause', applied.join());
    await act(async () => {
      body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      await settle(20);
    });

    // The canvas is an iframe, so clicking it blurs the parent window without
    // delivering a mousedown to the dropdown's document listener.
    const previewChanges = [];
    function ControlledDropdown() {
      const [value, setValue] = React.useState('main');
      return React.createElement(Dropdown, {
        value,
        options: OPTIONS,
        onChange: (next) => {
          previewChanges.push(next);
          setValue(next);
        },
      });
    }
    await act(async () => {
      root2.render(React.createElement(ControlledDropdown));
      await settle(20);
    });
    await act(async () => {
      find('.dd-trigger').click();
      await settle(20);
    });
    await hover('play');
    check('hover temporarily shows the preview', find('.dd-label')?.textContent === 'play');
    check('the original option stays committed', !!find('.dd-option.selected .dd-check svg'));
    await act(async () => {
      const canvas = document.createElement('iframe');
      document.body.append(canvas);
      canvas.focus();
      dom.window.dispatchEvent(new dom.window.Event('blur'));
      await settle(20);
    });
    check('canvas focus closes the popup', !find('.dd-popup'));
    check('canvas focus restores the committed option', find('.dd-label')?.textContent === 'main');
    check('the preview is reverted once', previewChanges.join() === 'play,main');

    await act(async () => {
      find('.dd-trigger').click();
      await settle(20);
    });
    await hover('pause');
    await act(async () => {
      body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      await settle(20);
    });
    check('outside click restores the committed option', find('.dd-label')?.textContent === 'main');
    check('outside click reverts once', previewChanges.join() === 'play,main,pause,main');
    await act(async () => root2.unmount());
  }

  if (failures.length) {
    console.error(`\ndropdown: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`dropdown: ${checked} passed`);
})();
