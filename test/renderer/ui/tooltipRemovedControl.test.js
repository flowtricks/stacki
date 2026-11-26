// Goal: a tooltip never outlives the control it names. A removed element sends no mouseleave and no blur, so a tip whose
// state belongs to a component that stays mounted (the comment pins' bar, whose Send button goes away once the pins are
// sent) stayed on screen for good. Both shared hooks (delayedTooltip.ts) are held to it: the tip closes when its control
// leaves the document, a tip still waiting never opens, and a tip whose control stays is left alone.
// Method: bundle the real hooks, mount a component that keeps the tip's state while its button comes and goes in jsdom,
// and drive hover, focus and removal. The wait is the hooks' own timer on a mocked clock the test moves past it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'tooltip-removed-control.cjs');
buildSync({
  stdin: {
    contents: "export { useDelayedTooltip, useDelayedPlacement, TOOLTIP_DELAY_MS } from './src/ui/delayedTooltip';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
});
const hooks = require(output);

const HOOKS = {
  useDelayedTooltip: () => {
    const tip = hooks.useDelayedTooltip();
    return { open: tip.value !== undefined, handlers: { onMouseEnter: tip.show, onMouseLeave: tip.hide } };
  },
  useDelayedPlacement: () => {
    const tip = hooks.useDelayedPlacement((element) => element.textContent);
    return {
      open: tip.value !== undefined,
      handlers: { onMouseEnter: (event) => tip.show(event.currentTarget), onFocus: (event) => tip.showNow(event.currentTarget), onMouseLeave: tip.hide },
    };
  },
};

async function mount(context, useTip) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const container = document.getElementById('root');
  const root = createRoot(container);
  // The owner of the tip's state stays; only the button and a neighbour come and go.
  const Owner = ({ button, neighbour }) => {
    const tip = useTip();
    return React.createElement(
      'div',
      {},
      button ? React.createElement('div', {}, React.createElement('button', { type: 'button', ...tip.handlers }, 'Send')) : undefined,
      neighbour ? React.createElement('span', {}, 'neighbour') : undefined,
      tip.open ? React.createElement('p', { role: 'tooltip' }, 'Why') : undefined,
    );
  };
  const render = async (props) => {
    await React.act(async () => root.render(React.createElement(Owner, props)));
    await React.act(async () => {}); // The removal is told in a microtask.
  };
  await render({ button: true, neighbour: false });
  return {
    render,
    tip: () => container.querySelector('[role="tooltip"]')?.textContent,
    hover: () => React.act(async () => Simulate.mouseEnter(container.querySelector('button'))),
    focus: () => React.act(async () => Simulate.focus(container.querySelector('button'))),
    rest: () => React.act(async () => context.mock.timers.tick(hooks.TOOLTIP_DELAY_MS)),
    async unmount() {
      await React.act(async () => root.unmount());
      dom.window.close();
    },
  };
}

for (const [name, useTip] of Object.entries(HOOKS)) {
  test(`${name}: an open tip closes when its control is removed, and does not come back with a new one`, async (context) => {
    const view = await mount(context, useTip);
    try {
      await view.hover();
      await view.rest();
      assert.notEqual(view.tip(), undefined, 'the tip opened');
      await view.render({ button: true, neighbour: true });
      assert.notEqual(view.tip(), undefined, 'a change elsewhere leaves it open');
      // The button's wrapper goes, as when a whole branch is removed.
      await view.render({ button: false, neighbour: true });
      assert.equal(view.tip(), undefined, 'the tip went with its control');
      await view.render({ button: true, neighbour: true });
      assert.equal(view.tip(), undefined, 'the control coming back does not bring the tip back');
    } finally {
      await view.unmount();
    }
  });

  test(`${name}: a tip still waiting never opens once its control is removed`, async (context) => {
    const view = await mount(context, useTip);
    try {
      await view.hover();
      await view.render({ button: false, neighbour: false });
      await view.rest();
      assert.equal(view.tip(), undefined);
    } finally {
      await view.unmount();
    }
  });
}

test('useDelayedPlacement: a tip opened at once by keyboard focus closes with its control too', async (context) => {
  const view = await mount(context, HOOKS.useDelayedPlacement);
  try {
    await view.focus();
    assert.notEqual(view.tip(), undefined, 'focus shows it at once');
    await view.render({ button: false, neighbour: false });
    assert.equal(view.tip(), undefined);
  } finally {
    await view.unmount();
  }
});
