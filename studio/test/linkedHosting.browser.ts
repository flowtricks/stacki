// Goal: a detected Cloudflare destination publishes directly without a settings dialog.
// Method: real browser, local Wrangler discovery, witnessed metadata writes and publisher startup.
// A deliberately broken build stops the job before it can contact the hosting provider.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { linkedPublishProject } from '../vendor/stacki/electron/project/publishLinkedProject';
import { parsePublishSource } from '../vendor/stacki/shared/properties/publishConfig';
import { readMetadataSource } from '../src/features/settings/projectMetadata';
import { sharedPublishingFixture } from './sharedPublishingFixture';

const fixture = await sharedPublishingFixture();
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  await writeFile(path.join(fixture.root, 'wrangler.json'), JSON.stringify({ name: 'website', account_id: 'account' }));
  await writeFile(path.join(fixture.root, 'src/pages/broken.astro'), '---\nconst = ;\n---');
  const page = await browser.newPage();
  await page.route('**/studio/api/publish/discover', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'ready',
        accounts: [],
        projects: await linkedPublishProject(fixture.root, 'linked'),
      }),
    });
  });
  await page.goto(fixture.url);
  await page.getByTestId('ready').filter({ hasText: 'Ready' }).waitFor();
  await page.getByRole('button', { name: 'More publish options', exact: true }).click();
  const deploy = page.getByRole('button', { name: 'Deploy to hosting Changes to deploy' });
  await deploy.waitFor();
  assert.equal(await page.locator('.publish-settings').count(), 0);
  await deploy.click();
  await page.getByText('Building website…', { exact: true }).waitFor();
  assert.equal(await page.locator('.publish-settings').count(), 0);
  assert.equal(fixture.publisher.state.kind, 'building');
  const config = parsePublishSource((await readMetadataSource(fixture.root, 'publish')).source);
  assert.deepEqual(config.hosting, {
    provider: 'cloudflare-workers',
    accountId: 'account',
    project: 'website',
  });
  fixture.release();
  for (let attempt = 0; attempt < 200 && fixture.publisher.state.kind === 'building'; attempt++) {
    await delay(50);
  }
  assert.equal(fixture.publisher.state.kind, 'failed');
  console.log('Linked Cloudflare hosting starts publishing directly with persisted settings.');
} finally {
  await browser.close();
  await fixture.close();
}
