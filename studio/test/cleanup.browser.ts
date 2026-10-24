// Goal: deleting assets also releases durable upload storage without a cleanup menu.
// Method: upload and delete through the real editor, then inspect remaining draft storage.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { parseReport } from '../src/features/storage/cleanupTypes';
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ...(process.env['STUDIO_STORAGE_STATE']
    ? { storageState: process.env['STUDIO_STORAGE_STATE'] }
    : {}),
});
const page = await context.newPage();
const name = `studio-cleanup-test-${Date.now()}.png`;
const file = 'public/' + name;
let uploaded = false;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page
    .locator('.asset-crumbs .crumb')
    .filter({ hasText: /^Assets$/ })
    .click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .click();
  const upload = page.waitForResponse((response) => response.url().includes('/studio/api/upload?'));
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload assets', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  assert.equal((await upload).status(), 201);
  uploaded = true;
  await page.locator('.asset-name').filter({ hasText: name }).waitFor();
  await page.getByLabel('Stacki account menu', { exact: true }).click();
  await page.locator('.account-popover[data-popup-phase="open"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Storage & cleanup' }).count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('.account-popover').waitFor({ state: 'detached' });
  await page.locator('.asset-tile').filter({ hasText: name }).hover();
  await page.getByRole('button', { name: `Options for ${name}`, exact: true }).click();
  await page.getByText('Delete', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.asset-name').filter({ hasText: name }).waitFor({ state: 'detached' });
  const response = await page.request.get(new URL('/studio/api/storage', page.url()).href);
  assert.equal(response.status(), 200);
  const report = parseReport(await response.json());
  assert.ok(report.draftBytes > 0);
  assert.equal(
    report.candidates.some((candidate) => candidate.file === file),
    false,
  );
  uploaded = false;
  assert.deepEqual(errors, []);
  console.log(
    `Asset deletion, automatic ${report.location} upload cleanup and retained drafts passed.`,
  );
} finally {
  // Remove only this test's upload through the same checked cleanup endpoint.
  if (uploaded) {
    const response = await page.request.get(new URL('/studio/api/storage', page.url()).href);
    if (response.ok()) {
      const report = parseReport(await response.json());
      const candidates = report.candidates.filter((candidate) => candidate.file === file);
      if (candidates.length) {
        await page.evaluate(async (candidates) => {
          await fetch('/studio/api/storage/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidates }),
          });
        }, candidates);
      }
    }
  }
  await browser.close();
}
