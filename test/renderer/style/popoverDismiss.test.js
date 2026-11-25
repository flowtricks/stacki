// The press that closes a popover.
//
//   node test/renderer/style/popoverDismiss.test.js
//
// A layer editor (transform, transition, shadow, filter) closes when you press
// outside it. It also used to let that press through: aiming at the nearest
// empty-looking control to get rid of the editor pressed the control as well,
// so closing the transform editor by clicking "Events: Auto" set pointer-events
// on the element. One press, one thing — the press that dismisses is spent.
//
// Pressing the row the editor belongs to is the exception: that press is meant
// for the row, whose own handler toggles the editor shut.
//
// A scroll closes it only when the row it sits on moved on screen; a scroll that
// moves nothing (scroll anchoring, another panel) leaves it open.

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
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'popover.bundle.js');
  await esbuild.build({
    stdin: {
      contents:
        `export { default as LayerPopover } from './src/features/style/LayerPopover';` + `export { registerPopupLayer } from './src/ui/popupOwnership';`,
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
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  // The popover measures the panel it should span, and falls back to CSS
  // variables on the root when the anchor has no panel around it (as here).
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = RO;
  dom.window.ResizeObserver = RO;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const { LayerPopover, registerPopupLayer } = require(bundlePath);

  // The panel behind it: the row the editor belongs to, and an unrelated control
  // — the "Events: Auto" of the report.
  const container = dom.window.document.getElementById('root');
  container.innerHTML = '<button id="row">Rotate: 0deg</button><button id="events">Auto</button>';
  const row = dom.window.document.getElementById('row');
  const events = dom.window.document.getElementById('events');
  const pressed = [];
  events.addEventListener('click', () => pressed.push('events'));
  row.addEventListener('click', () => pressed.push('row'));

  // Closing really removes it, the way the panel's own state does — a popover
  // left mounted would eat the next press as well, which is the bug this is
  // supposed to be checking for.
  let closes = 0;
  let showing = false;
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  // `paint` runs again from the popover's onClose event, never from its own stack.
  // eslint-disable-next-line stacki/bounded-recursion -- onClose re-enters it as an event.
  const paint = () =>
    root.render(
      showing
        ? React.createElement(
            LayerPopover,
            {
              anchorEl: row,
              ariaLabel: 'Transform',
              onClose: () => {
                closes += 1;
                showing = false;
                paint();
              },
            },
            React.createElement('input', { id: 'inside', defaultValue: '0deg' }),
          )
        : undefined,
    );
  const open = async () =>
    act(async () => {
      showing = true;
      paint();
      await settle(10);
    });

  // A press somewhere, and the click it becomes.
  const pressAndClick = async (element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      await settle(0);
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle(0);
    });
  };

  await open();
  check('the editor is open', !!dom.window.document.querySelector('#inside'), 'no popover');

  // --- the press that dismisses ------------------------------------------------
  pressed.length = 0;
  await pressAndClick(events);
  check('pressing a control outside closes the editor', closes === 1, `${closes} closes`);
  check('and does not also press that control', pressed.length === 0, `pressed: ${pressed.join(', ')}`);

  // --- the next press is a normal one ------------------------------------------
  // Dismissing swallows ONE click. The press after it belongs to whatever it
  // lands on, or nothing would work after closing a popover.
  pressed.length = 0;
  await pressAndClick(events);
  check('the press after that presses the control', pressed.join(',') === 'events', pressed.join(','));

  // --- the row the editor belongs to -------------------------------------------
  // Its own click handler is what toggles the editor shut, so that press has to
  // reach it.
  closes = 0;
  await open();
  pressed.length = 0;
  await pressAndClick(row);
  check('pressing the row it belongs to reaches the row', pressed.join(',') === 'row', pressed.join(','));

  // --- a press inside changes nothing ------------------------------------------
  closes = 0;
  await open();
  const inside = dom.window.document.querySelector('#inside');
  await act(async () => {
    inside.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    await settle(0);
  });
  check('a press inside the editor leaves it open', closes === 0, `${closes} closes`);

  // --- a nested popup scrolling is still inside --------------------------------
  // A variable picker is portaled to <body>. When opened from an existing chip,
  // it scrolls the selected variable into view immediately; that scroll belongs
  // to the editor even though DOM containment alone cannot see the relationship.
  const picker = dom.window.document.createElement('div');
  const pickerList = dom.window.document.createElement('div');
  picker.appendChild(pickerList);
  dom.window.document.body.appendChild(picker);
  const unregisterPicker = registerPopupLayer(picker, inside);
  await act(async () => {
    pickerList.dispatchEvent(new dom.window.Event('scroll'));
    await settle(0);
  });
  check('scrolling an owned popup leaves the editor open', closes === 0, `${closes} closes`);
  unregisterPicker();
  picker.remove();

  // A scroll that leaves the row where it was (scroll anchoring after the panel's data
  // lands, another panel scrolling) is no reason to close: nothing it sits on moved.
  await act(async () => {
    events.dispatchEvent(new dom.window.Event('scroll'));
    await settle(0);
  });
  check('a scroll that moves nothing leaves the editor open', closes === 0, `${closes} closes`);

  // A person scrolling the panel carries the row away from the editor: that closes it.
  const rowBox = row.getBoundingClientRect();
  row.getBoundingClientRect = () => ({ ...rowBox, top: rowBox.top - 40, bottom: rowBox.bottom - 40, y: rowBox.y - 40 });
  await act(async () => {
    events.dispatchEvent(new dom.window.Event('scroll'));
    await settle(0);
  });
  check('scrolling outside still closes the editor', closes === 1, `${closes} closes`);
  delete row.getBoundingClientRect;

  // --- a press that never becomes a click --------------------------------------
  // Dragging away from a press, or a context menu: the swallow must not be left
  // armed for whatever gets clicked later.
  closes = 0;
  await open();
  await act(async () => {
    events.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    await settle(450);
  });
  pressed.length = 0;
  await act(async () => {
    events.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(0);
  });
  check('a press with no click does not swallow a later one', pressed.join(',') === 'events', `pressed: ${pressed.join(', ')}`);

  if (failures.length) {
    console.error(`\npopover-dismiss: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`popover-dismiss: ${checked} passed`);
  process.exit(0);
})();
