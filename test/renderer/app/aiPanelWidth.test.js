// Goal: the docked AI chat opens wider than the shared left panel, a stored width wins, and a
// small window still gets a width the panel can draw.
// Methodology: bundle the width module with esbuild, drive it against a stubbed localStorage, and
// pin the default, the fit to a narrow window, the stored override, and invalid stored values.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test/ai-panel-width');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'width.cjs');
buildSync({
  stdin: { contents: "export * from './src/app/shell/aiPanelWidth';", resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react'],
});
const { AI_PANEL_WIDTH_PX_DEFAULT, aiPanelWidthPx, parseStoredAiPanelWidth } = require(output);

function stubStorage(entries) {
  globalThis.localStorage = { getItem: (key) => entries[key], setItem: () => undefined };
}

test('the chat opens at 440px on a roomy window', () => {
  stubStorage({});
  assert.equal(AI_PANEL_WIDTH_PX_DEFAULT, 440);
  assert.equal(aiPanelWidthPx(1600), 440);
});

test('a narrow window shrinks the default but never below the panel minimum', () => {
  stubStorage({});
  assert.equal(aiPanelWidthPx(1000), 400);
  assert.equal(aiPanelWidthPx(700), 260);
});

test('a stored width wins over the default', () => {
  stubStorage({ 'stacki.panel.width.ai': '520' });
  assert.equal(aiPanelWidthPx(1600), 520);
  assert.equal(aiPanelWidthPx(800), 520);
});

test('invalid stored widths fall back to the default', () => {
  for (const bad of ['', 'abc', '259', '601', '1e2', '440.5', '-300', '0440']) {
    stubStorage({ 'stacki.panel.width.ai': bad });
    assert.equal(aiPanelWidthPx(1600), 440, bad);
  }
  assert.equal(parseStoredAiPanelWidth(undefined), undefined);
});

test('unavailable storage still yields the default', () => {
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(aiPanelWidthPx(1600), 440);
});
