// Goal: toast gestures stay horizontal and dismiss at the threshold before release.
// Methodology: mount the real stack in jsdom, dispatch pointer sequences with capture loss,
// and check offsets, cancellation, button isolation, hover expansion, overflow, and timer pauses.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

test('horizontal toast dismissal, expanded stack layout, and overflow', async () => {
  const directory = repoPath('node_modules/.stacki-test/toast-drag');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'toast.cjs');
  await esbuild.build({
    stdin: {
      contents: `export { ToastStack } from ${sourceSpecifier('src/features/notifications/ToastStack.tsx')};`,
      resolveDir: repoPath('src'),
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { ToastStack } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const dismissed = [];
  let sequence = 0;
  const pointer = (element, type, x, y, properties = {}) => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: properties.pointerId ?? 1 },
      isPrimary: { value: properties.isPrimary ?? true },
    });
    element.dispatchEvent(event);
  };
  const send = (element, type, x, y, properties) => act(() => pointer(element, type, x, y, properties));
  const render = async () => {
    sequence += 1;
    await act(() =>
      root.render(
        React.createElement(ToastStack, {
          notices: [{ id: String(sequence), kind: 'info', message: 'Drag this toast' }],
          dismiss: (id) => dismissed.push(id),
        }),
      ),
    );
    const card = document.querySelector('.toast');
    let captured;
    card.setPointerCapture = (id) => {
      captured = id;
    };
    card.hasPointerCapture = (id) => captured === id;
    card.releasePointerCapture = (id) => {
      assert.equal(id, captured);
      captured = undefined;
      pointer(card, 'lostpointercapture', 0, 0);
    };
    return card;
  };
  const offset = (card, x, y) => {
    assert.equal(card.parentElement.style.getPropertyValue('--toast-drag-x'), `${x}px`);
    assert.equal(card.parentElement.style.getPropertyValue('--toast-drag-y'), `${y}px`);
  };
  try {
    for (const direction of [-1, 1]) {
      const card = await render();
      await send(card, 'pointerdown', 200, 200);
      await send(card, 'pointermove', 203, 198);
      offset(card, 0, 0);
      await send(card, 'pointermove', 200 + direction * 10, 196);
      offset(card, direction * 10, 0);
      await send(card, 'pointermove', 200 + direction * 60, 80);
      offset(card, direction * 60, 0);
      assert.equal(card.dataset.leaving, 'false', 'Perpendicular movement cannot dismiss');
      await send(card, 'pointermove', 200 + direction * 72, 80);
      offset(card, direction * 72, 0);
      assert.equal(card.dataset.leaving, 'true', 'Threshold dismisses without pointerup');
      assert.equal(card.dataset.dragging, 'false', 'Exit animation is enabled');
      await send(card, 'pointermove', 200, 200);
      await send(card, 'pointerup', 200, 200);
      offset(card, direction * 72, 0);
      const before = dismissed.length;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
      assert.equal(dismissed.length, before + 1, 'Exactly one dismissal');
    }
    const vertical = await render();
    await send(vertical, 'pointerdown', 200, 200);
    await send(vertical, 'pointermove', 200, 80);
    offset(vertical, 0, 0);
    assert.equal(vertical.dataset.leaving, 'false', 'Upward movement cannot dismiss');
    await send(vertical, 'pointermove', 200, 400);
    offset(vertical, 0, 0);
    assert.equal(vertical.dataset.leaving, 'false', 'Downward movement cannot dismiss');
    await send(vertical, 'pointerup', 200, 400);

    const card = await render();
    await send(card, 'pointerdown', 200, 200);
    await send(card, 'pointermove', 200, 400);
    offset(card, 0, 0);
    assert.equal(card.dataset.leaving, 'false', 'Downward dragging never dismisses');
    await send(card, 'pointermove', 210, 190, { pointerId: 2 });
    offset(card, 0, 0);
    await send(card, 'pointermove', 225, 200);
    offset(card, 25, 0);
    await send(card, 'pointerup', 225, 200);
    offset(card, 0, 0);
    assert.equal(card.dataset.leaving, 'false', 'Short drags snap back');

    for (const cancellation of ['pointercancel', 'lostpointercapture']) {
      await send(card, 'pointerdown', 200, 200);
      await send(card, 'pointermove', 220, 180);
      offset(card, 20, 0);
      await send(card, cancellation, 200, 180);
      offset(card, 0, 0);
      assert.equal(card.dataset.dragging, 'false');
      assert.equal(card.dataset.leaving, 'false');
    }
    await send(card.querySelector('button'), 'pointerdown', 200, 200);
    await send(card, 'pointermove', 300, 200);
    assert.equal(card.dataset.dragging, 'false', 'Buttons do not start a drag');
    assert.equal(card.dataset.leaving, 'false');
    await send(card, 'pointerdown', 200, 200, { isPrimary: false });
    assert.equal(card.dataset.dragging, 'false', 'Secondary touches cannot start a drag');
    await send(card, 'pointerdown', 200, 200);
    await send(card, 'pointerup', 128, 150);
    offset(card, -72, 0);
    assert.equal(card.dataset.leaving, 'true', 'Release also checks the final position');

    function StackFixture() {
      const [notices, setNotices] = React.useState(
        Array.from({ length: 5 }, (_, index) => ({
          id: `stack-${index}`,
          kind: 'info',
          message: `Notice ${index}`,
        })),
      );
      return React.createElement(ToastStack, {
        notices,
        dismiss: (id) => setNotices((current) => current.filter((notice) => notice.id !== id)),
      });
    }
    await act(() => root.render(React.createElement(StackFixture)));
    const stack = document.querySelector('.toast-stack');
    assert.equal(stack.dataset.expanded, 'false');
    await send(document.querySelector('.toast'), 'mouseover', 200, 200);
    assert.equal(stack.dataset.expanded, 'true', 'Hover expands the entire stack');
    assert.equal(document.querySelectorAll('.toast-more').length, 0);
    const slots = Array.from(document.querySelectorAll('.toast-slot'));
    for (const [index, slot] of slots.entries()) {
      assert.equal(slot.style.getPropertyValue('--toast-stack-offset'), `${index * 68}px`);
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5200)));
    assert.equal(document.querySelectorAll('.toast').length, 5, 'Reading pauses every timer');
    await act(() => document.querySelector('.toast-close').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    assert.equal(document.querySelectorAll('.toast').length, 4);
    assert.equal(slots[1].style.getPropertyValue('--toast-stack-offset'), '0px');
    assert.equal(slots[2].style.getPropertyValue('--toast-stack-offset'), '68px');
    assert.equal(stack.dataset.expanded, 'true', 'Dismissing a card keeps the list open');

    await act(() => {
      Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
      window.dispatchEvent(new window.Event('resize'));
    });
    assert.equal(document.querySelector('.toast-more').textContent, 'Load more (3)');
    assert.equal(document.querySelectorAll('.toast-slot[data-hidden="true"]').length, 3);
    await act(() => document.querySelector('.toast-more').click());
    assert.equal(stack.dataset.scrollable, 'true');
    assert.equal(document.querySelectorAll('.toast-slot[data-hidden="true"]').length, 0);
    assert.equal(document.querySelector('.toast-more').textContent, 'Show fewer');
    await act(() => document.querySelector('.toast-more').click());
    assert.equal(document.querySelectorAll('.toast-slot[data-hidden="true"]').length, 3);
    await act(() => document.querySelector('.toast-close').focus());
    await send(stack, 'mouseout', 0, 0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.equal(stack.dataset.expanded, 'true', 'Keyboard focus keeps the list expanded');
    await act(() => document.querySelector('.toast-close').blur());
    assert.equal(stack.dataset.expanded, 'false', 'Leaving the stack restores the overlap');
    await act(() => document.querySelector('.toast-close').focus());
    await act(() => document.querySelector('.toast-close').click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    assert.equal(stack.dataset.expanded, 'false', 'Removing the focused card clears stale focus');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});
