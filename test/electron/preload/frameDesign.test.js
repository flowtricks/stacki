// Exercise the real design-frame listener with DOM keyboard events. Escape must
// reach the parent editor from the canvas, while typing and modified keys stay local.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
test('design canvas forwards Escape to the editor', () => {
  const dom = new JSDOM('<!doctype html><input />', {
    url: 'http://localhost/#avb-design',
  });
  const messages = [];
  dom.window.postMessage = (message) => messages.push(message);
  const context = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Element: dom.window.Element,
  };
  const bundle = buildSync({
    entryPoints: [repoPath('electron/preload/frameDesign.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'DesignFrame',
    write: false,
    logLevel: 'silent',
  });
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  context.DesignFrame.listenForDesign();
  const press = (target, options = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...options,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    assert.equal(press(dom.window.document.body), true);
    const shortcuts = () => messages.filter((message) => message.type === 'avb:shortcut');
    assert.equal(shortcuts().length, 1);
    assert.equal(shortcuts()[0].key, 'Escape');
    assert.equal(shortcuts()[0].name, 'key');
    assert.equal(press(dom.window.document.body, { metaKey: true }), false);
    assert.equal(press(dom.window.document.querySelector('input')), false);
    assert.equal(shortcuts().length, 1);
  } finally {
    dom.window.close();
  }
});

test('design canvas forwards the pull chord from the page, never from a field or on key repeat', () => {
  const dom = new JSDOM('<!doctype html><input />', { url: 'http://localhost/#avb-design' });
  const messages = [];
  dom.window.postMessage = (message) => messages.push(message);
  const context = { window: dom.window, document: dom.window.document, location: dom.window.location, Element: dom.window.Element };
  const bundle = buildSync({
    entryPoints: [repoPath('electron/preload/frameDesign.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'DesignFrame',
    write: false,
    logLevel: 'silent',
  });
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  context.DesignFrame.listenForDesign();
  const press = (target, options = {}) => {
    const chord = { key: '˝', code: 'KeyG', altKey: true, shiftKey: true, bubbles: true, cancelable: true };
    const event = new dom.window.KeyboardEvent('keydown', { ...chord, ...options });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const pulls = () => messages.filter((message) => message.type === 'avb:shortcut' && message.name === 'pull').length;
  try {
    assert.equal(press(dom.window.document.body), true);
    assert.equal(pulls(), 1);
    assert.equal(press(dom.window.document.body, { repeat: true }), true);
    assert.equal(press(dom.window.document.querySelector('input')), false);
    press(dom.window.document.body, { ctrlKey: true });
    press(dom.window.document.body, { shiftKey: false });
    assert.equal(pulls(), 1);
  } finally {
    dom.window.close();
  }
});
