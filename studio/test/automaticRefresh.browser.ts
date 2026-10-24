// Goal: new and removed files appear without refresh controls or browser navigation.
// Method: write Markdown and assets into an explicitly selected disposable draft while
// the real browser panels stay open, then wait for the server's change notifications.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { parseReport } from '../src/features/storage/cleanupTypes';

const workspace = process.env['STUDIO_WORKSPACE'];
assert.ok(workspace, 'STUDIO_WORKSPACE must name the running disposable test draft');
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const suffix = `automatic-refresh-${Date.now()}`;
const markdown = `src/pages/${suffix}.md`;
const asset = `src/assets/${suffix}.svg`;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio', {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /refresh|rescan|reload/i }).count(), 0);
  await writeFile(
    path.join(workspace, markdown),
    '---\ntitle: Automatic update\n---\n# New page\n',
  );
  await page.locator(`[data-file="${markdown}"]`).waitFor();
  await rm(path.join(workspace, markdown));
  await page.locator(`[data-file="${markdown}"]`).waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await mkdir(path.join(workspace, 'src/assets'), { recursive: true });
  await writeFile(
    path.join(workspace, asset),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<rect width="10" height="10"/></svg>',
  );
  await page
    .locator('.asset-name')
    .filter({ hasText: `${suffix}.svg` })
    .waitFor();
  await rm(path.join(workspace, asset));
  await page
    .locator('.asset-name')
    .filter({ hasText: `${suffix}.svg` })
    .waitFor({ state: 'detached' });
  await checkStorageUpdates(page, suffix);
  assert.deepEqual(errors, []);
  console.log('Markdown, assets and storage update automatically after external changes.');
} finally {
  await rm(path.join(workspace, markdown), { force: true });
  await rm(path.join(workspace, asset), { force: true });
  await browser.close();
}

async function checkStorageUpdates(page: Page, suffix: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const file = `public/${suffix}.png`;
  await page
    .locator('.asset-crumbs .crumb')
    .filter({ hasText: /^Assets$/ })
    .click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .click();
  assert.equal(await page.getByRole('button', { name: /refresh/i }).count(), 0);
  try {
    const upload = await page.request.post(
      `${origin}/studio/api/upload?file=${encodeURIComponent(file)}`,
      {
        data: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
          'base64',
        ),
      },
    );
    assert.equal(upload.status(), 201);
    const candidate = page.locator('.asset-name').filter({ hasText: `${suffix}.png` });
    await candidate.waitFor();
    await cleanTestUpload(page, origin, file);
    await candidate.waitFor({ state: 'detached' });
  } finally {
    await cleanTestUpload(page, origin, file);
  }
}

async function cleanTestUpload(page: Page, origin: string, file: string): Promise<void> {
  const response = await page.request.get(`${origin}/studio/api/storage`);
  assert.equal(response.status(), 200);
  const report = parseReport(await response.json());
  const candidates = report.candidates.filter((candidate) => candidate.file === file);
  if (candidates.length > 0) {
    const cleanup = await page.request.post(`${origin}/studio/api/assets`, {
      data: { kind: 'delete', rel: file },
    });
    assert.equal(cleanup.status(), 200);
  }
}
