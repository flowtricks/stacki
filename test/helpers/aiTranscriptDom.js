// Goal: let the transcript's component tests (changes, permissions, messages) mount real components
// without the whole panel.
// Method: bundle the named exports with esbuild (css and svg files empty, React left external), install
// a jsdom window with the popup shims, and hand back React's act and createRoot. Each test file runs in
// its own process, so the globals set here belong to that file alone.
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('./sources.js');

/** Bundles `exportLines` (ES `export ... from './src/...'` lines) and returns the module with the DOM installed. */
exports.loadTranscript = (name, exportLines) => {
  const output = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  esbuild.buildSync({
    stdin: { contents: exportLines.join('\n'), resolveDir: repoPath('package.json').replace(/package\.json$/, ''), loader: 'tsx' },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('./popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  for (const key of [
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'getComputedStyle',
    'localStorage',
  ]) {
    Object.defineProperty(global, key, { value: dom.window[key], configurable: true, writable: true });
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  global.requestAnimationFrame = dom.window.requestAnimationFrame;
  global.cancelAnimationFrame = (handle) => clearTimeout(handle);
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  return { modules: require(output), React, act: React.act, createRoot, window: dom.window };
};
