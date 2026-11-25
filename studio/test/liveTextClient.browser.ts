// Goal: run literal-preview reconciliation against real browser DOM semantics.
// Method: bundle the production client and bounded regression cases into Chromium.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const bundle = await build({
  stdin: {
    contents: 'import { checkLiveText } from "./test/liveTextClientHarness"; checkLiveText();',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const output = bundle.outputFiles[0];
assert.ok(output, 'Browser regression bundle exists');
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: output.text });
  assert.deepEqual(errors, []);
  console.log('Live text confirmation, delayed render, rapid edits and ambiguity checks passed.');
} finally {
  await browser.close();
}
