// Goal: the frame measures all four menu connections plus the column fallback.
// Run the real frame module against a DOM, parse its replies through the renderer
// boundary, and resolve the guide while variables change. Oversized and malformed
// requests must still be rejected. Animation frames are flushed explicitly.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const loadRenderer = require('../../helpers/rendererModule');
const { GUIDE_DEFAULTS, guideVariableNames, resolveGuide } = loadRenderer('src/features/preview/guideModel.ts');
const { parsePreviewMessage } = loadRenderer('src/features/preview/previewMessages.ts');

function guideFrame() {
  const dom = new JSDOM('<!doctype html><html style="font-size:16px"><body></body></html>');
  let queued;
  let message;
  const context = {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback) => {
      queued = callback;
    },
    MutationObserver: class {
      observe() {}
    },
    ResizeObserver: class {
      observe() {}
    },
  };
  const build = buildSync({
    entryPoints: [repoPath('electron/preload/frameGuide.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'GuideFrameModule',
    write: false,
    logLevel: 'silent',
  });
  vm.runInNewContext(build.outputFiles[0].text, context);
  const frame = context.GuideFrameModule.startGuide((value) => {
    message = value;
  });
  return {
    style: dom.window.document.documentElement.style,
    close: () => dom.window.close(),
    measure: (names) => {
      frame.receive({ type: 'avb:guide-variables', names });
      const callback = queued;
      queued = undefined;
      assert.equal(typeof callback, 'function');
      callback();
      const parsed = parsePreviewMessage(message);
      assert.equal(parsed.kind, 'guide');
      return parsed.metrics;
    },
  };
}

test('five requested variables reach the guide and its fallback follows page changes', () => {
  const frame = guideFrame();
  try {
    const variable = (name) => ({ kind: 'variable', name });
    const settings = {
      ...GUIDE_DEFAULTS,
      margin: variable('--pad'),
      gutter: variable('--gap'),
      widthMax: variable('--max'),
      columns: variable('--cols'),
    };
    const names = guideVariableNames(settings);
    assert.equal(names.length, 5);
    frame.style.setProperty('--cols', '33');
    for (const count of [2, 8, 32]) {
      frame.style.setProperty('--site-columns', String(count));
      const metrics = frame.measure(names);
      assert.deepEqual(Object.keys(metrics.variableCounts), names);
      assert.equal(metrics.variableCounts['--cols'], 33);
      assert.equal(resolveGuide(metrics, settings).columnCount, count);
    }
    for (const count of [2, 3, 32]) {
      frame.style.setProperty('--cols', String(count));
      assert.equal(resolveGuide(frame.measure(names), settings).columnCount, count);
    }
    frame.style.setProperty('--cols', '2.5');
    frame.style.removeProperty('--site-columns');
    assert.equal(resolveGuide(frame.measure(names), settings).columnCount, 12);
    for (const invalid of [[...names, '--sixth'], ['--bad name']]) {
      const metrics = frame.measure(invalid);
      assert.deepEqual(metrics.variableCounts, {});
      assert.deepEqual(metrics.variablesPx, {});
    }
  } finally {
    frame.close();
  }
});
