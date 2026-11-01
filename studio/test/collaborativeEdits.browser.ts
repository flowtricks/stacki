// Goal: test page edits with independent collaboration sessions on one real server.
// Method: create a disposable Astro fixture before startup, drive both browser
// contexts, and clean up after success or failure. Local names do not test OAuth.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';
import { checkCollaborativeEdits } from './collaborativeEditChecks';
import { delayPreviewRenders } from './delayedPreview.browser';

const fixture = await startStyleFixture({
  page: `---
import Card from '../components/Card.astro';
---
<main>
<Card variant="primary">Choose a campus</Card>
<Card variant="secondary">Plan your visit</Card>
<h1>Hello <strong>nested</strong> world</h1>
<p>Other editor text</p>
</main>`,
  component: `---
interface Props { variant: 'primary' | 'secondary' }
const { variant } = Astro.props;
---
<button class={variant}><slot /></button>
<style>button { padding: 20px; margin: 10px; font: 24px sans-serif; }
.primary { background: blue; color: white; } .secondary { background: white; color: black; }
</style>`,
});
try {
  await runEditors();
} finally {
  await fixture.stop();
}

async function runEditors() {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const first = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
    const second = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
    const delayed = await delayPreviewRenders(first);
    const errors: string[] = [];
    for (const [index, page] of [first, second].entries()) {
      page.setDefaultTimeout(20_000);
      page.on('pageerror', (error) => {
        assert.ok(errors.length < 20, 'Bound browser diagnostics');
        errors.push(error.message);
      });
      await page.addInitScript(
        (name) => {
          Reflect.set(window, '__name', (value: unknown) => value);
          sessionStorage.setItem('studio-name', name);
        },
        index === 0 ? 'First' : 'Second',
      );
      await page.goto(fixture.url);
      await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
      await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
      await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    }
    delayed.enable();
    await checkCollaborativeEdits(first, second);
    await delayed.drain();
    for (const page of [first, second]) {
      const body = page.frameLocator('iframe[title="Site preview"]').locator('body');
      assert.equal(await body.getAttribute('data-text-regression'), null, 'Delayed authoritative HTML must never erase newer typed text');
    }
    delayed.assertDelivered();
    assert.deepEqual(errors, []);
    console.log('Two independent sessions: reorder, duplicate, delete, insertion and typing passed.');
  } finally {
    await browser.close();
  }
}
