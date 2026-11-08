// Goal: all popup surfaces retain content through exit and dismiss only the active layer.
// Methodology: mount the shared component in jsdom, emulate native dialog focus, and
// exercise gestures, nested layers, keyboard dismissal, reduced motion and interrupted exits.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

test('shared popup motion, dismissal and nested focus', async () => {
  const directory = repoPath('node_modules/.stacki-test/popup');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'popup.cjs');
  await esbuild.build({
    stdin: {
      contents: `export {default} from ${sourceSpecifier('src/ui/Popup.tsx')};`,
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
  const dom = new JSDOM('<button id="trigger">Open</button><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.querySelector('input, button')?.focus();
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.matchMedia = () => ({ matches: false });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Popup = require(outfile).default;
  const root = createRoot(document.getElementById('root'));
  const events = [];
  const render = (extra = {}) =>
    act(async () =>
      root.render(
        React.createElement(
          Popup,
          {
            label: 'Parent',
            onClose: () => events.push('parent'),
            ...extra,
          },
          React.createElement('input', { 'aria-label': 'Name' }),
        ),
      ),
    );
  const tick = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const gesture = (start, end) =>
    act(async () => {
      start.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
      end.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  const escape = () => act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  const trigger = document.getElementById('trigger');
  try {
    trigger.focus();
    await render();
    assert.equal(document.querySelector('.popup-surface').dataset.popupPhase, 'opening');
    await tick(50);
    assert.equal(document.querySelector('.popup-surface').dataset.popupPhase, 'open');
    const input = document.querySelector('input');
    await gesture(input, document.body);
    assert.equal(document.querySelector('.popup-surface').dataset.popupPhase, 'open');
    await gesture(document.body, input);
    assert.equal(events.length, 0);
    await gesture(document.body, document.body);
    assert.equal(document.querySelector('.popup-surface').dataset.popupPhase, 'closing');
    assert.equal(events.length, 0, 'Caller must stay mounted during the exit');
    await tick(180);
    assert.deepEqual(events, ['parent']);
    assert.equal(document.querySelector('dialog') === null, true);
    assert.equal(document.activeElement, trigger);

    await render({ open: false });
    await render({ open: true });
    await tick(50);
    await render({ open: false });
    await render({ open: true });
    await tick(180);
    assert.ok(document.querySelector('dialog[open]'), 'Reopening cancels a pending exit');
    assert.equal(events.length, 1);
    await render({ open: true, dismissible: false });
    await escape();
    await gesture(document.body, document.body);
    assert.equal(events.length, 1, 'Busy dialogs cannot be accidentally dismissed');

    window.matchMedia = () => ({ matches: true });
    await render({ open: false });
    await act(async () =>
      root.render(
        React.createElement(
          Popup,
          {
            label: 'Parent',
            onClose: () => events.push('outer'),
          },
          React.createElement(
            React.Fragment,
            undefined,
            React.createElement('input'),
            React.createElement(
              Popup,
              {
                mode: 'popover',
                label: 'Child',
                role: 'dialog',
                onClose: () => events.push('child'),
              },
              React.createElement('button', undefined, 'Child action'),
            ),
          ),
        ),
      ),
    );
    await escape();
    assert.equal(events.at(-1), 'child');
    assert.equal(events.includes('outer'), false);
    assert.ok(document.querySelector('dialog[open]'));
    await escape();
    assert.equal(events.at(-1), 'outer');
    assert.equal(document.querySelector('dialog') === null, true);

    window.matchMedia = () => ({ matches: false });
    await render({ open: false });
    await render({ open: true });
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await tick(180);
    assert.equal(document.querySelector('dialog') === null, true, 'Opening cannot cancel dismissal');

    // A press during a menu's exit motion belongs to the control it lands on: Escape,
    // then straight to another button, must not lose that button's click.
    const menuContainer = document.createElement('div');
    document.body.append(menuContainer);
    const menuRoot = createRoot(menuContainer);
    await act(async () =>
      menuRoot.render(
        React.createElement(
          Popup,
          { mode: 'popover', portal: false, label: 'Menu', role: 'dialog', onClose: () => events.push('menu') },
          React.createElement('button', undefined, 'Option'),
        ),
      ),
    );
    await tick(50);
    assert.equal(menuContainer.querySelector('.popup-surface')?.dataset.popupPhase, 'open');
    await escape();
    assert.equal(menuContainer.querySelector('.popup-surface')?.dataset.popupPhase, 'closing');
    let clicked = 0;
    trigger.addEventListener('click', () => (clicked += 1));
    const press = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    await act(async () => {
      trigger.dispatchEvent(press);
      trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    assert.equal(press.defaultPrevented, false, 'The closing menu does not take the press');
    assert.equal(clicked, 1, 'The click reaches the control');
    await tick(180);
    assert.equal(events.at(-1), 'menu');
    await act(async () => menuRoot.unmount());
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
