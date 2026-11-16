// Goal: Settings > Breakpoints > Style tags (src/app/settings/StyleTagSettings.tsx) shows the project's `newStyleTag`
// setting, saves a change of the switch at once to `.stacki/styles.json` keeping the rest of the file, shows a live preview
// of the tag that would be created, and is read-only for a role that may not edit breakpoints' settings.
// Method: the real component bundled for jsdom over an in-memory styles file behind a stubbed `window.avb`
// (projectMetadata / writeProjectMetadata, the calls the bridge makes). A legacy file shows the switch off and a plain
// <style> preview; clicking the switch writes `isGlobal: true` with the keep list and locks intact; a file holding a
// layer template shows it in the preview; a disabled switch writes nothing; a failed write is shown as a notice.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let environment;

async function load() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'style-tag-settings.bundle.js');
  await esbuild.build({
    stdin: { contents: `export { StyleTagSettings } from './src/app/settings/StyleTagSettings'`, resolveDir: ROOT, loader: 'tsx' },
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
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: false,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = Observer;
  dom.window.ResizeObserver = Observer;
  dom.window.Element.prototype.scrollIntoView = function () {};
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

async function mount({ source, editable = true, failWrite = false }) {
  const { dom, React, createRoot, StyleTagSettings } = await load();
  const file = { source };
  const writes = [];
  dom.window.avb = {
    projectMetadata: async () => ({ ok: true, value: { source: file.source } }),
    writeProjectMetadata: async (input) => {
      if (failWrite) {
        return { ok: false, error: { code: 'write-failed', message: 'disk full' } };
      }
      writes.push(input.write.source);
      file.source = input.write.source;
      return { ok: true, value: { source: input.write.source } };
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const track = (save) => save;
  root.render(React.createElement(StyleTagSettings, { projectPath: '/p', editable, track }));
  await wait(400);
  return { container, writes, file, unmount: () => (root.unmount(), container.remove()) };
}

const toggle = (container) => container.querySelector('[role="switch"]');

test('a legacy file shows the switch off and a plain <style> preview', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: ['is-*'] }) });
  context.after(view.unmount);
  assert.equal(toggle(view.container).getAttribute('aria-checked'), 'false');
  assert.match(view.container.querySelector('.style-tags-preview').textContent, /^<style>/);
  assert.deepEqual(view.writes, [], 'reading writes nothing');
});

test('the switch saves at once and keeps the keep list and locks', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: ['is-*'], lockedStylesheets: ['src/styles/vendor/'] }) });
  context.after(view.unmount);
  toggle(view.container).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);
  assert.equal(view.writes.length, 1);
  const written = JSON.parse(view.writes[0]);
  assert.deepEqual(written.keep, ['is-*']);
  assert.deepEqual(written.lockedStylesheets, ['src/styles/vendor/']);
  assert.equal(written.newStyleTag.isGlobal, true);
  assert.match(view.container.querySelector('.style-tags-preview').textContent, /^<style is:global>/);
});

test('a saved template shows in the preview, and a disabled switch writes nothing', async (context) => {
  const source = JSON.stringify({ version: 1, keep: [], newStyleTag: { version: 1, isGlobal: true, content: '@layer components {\n  /* stacki:rules */\n}' } });
  const view = await mount({ source, editable: false });
  context.after(view.unmount);
  assert.equal(toggle(view.container).getAttribute('aria-checked'), 'true');
  assert.match(view.container.querySelector('.style-tags-preview').textContent, /@layer components/);
  assert.ok(toggle(view.container).disabled);
  toggle(view.container).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  assert.deepEqual(view.writes, []);
});

test('a failed write is shown beside the control', async (context) => {
  const view = await mount({ source: JSON.stringify({ version: 1, keep: [] }), failWrite: true });
  context.after(view.unmount);
  toggle(view.container).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /disk full/);
});
