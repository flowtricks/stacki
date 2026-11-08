// Goal: verify stable loading geometry, first-publish configuration and shared state.
// Method: two real browser clients, source-backed metadata and a real Astro build failure.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repositoryState } from '../vendor/stacki/electron/project/publishRepositories';
import { parseDiscoveryRequest } from '../vendor/stacki/shared/properties/publishDiscovery';
import { sharedPublishingFixture } from './sharedPublishingFixture';

const fixture = await sharedPublishingFixture();
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const first = await browser.newPage();
  const second = await browser.newPage();
  const pages = [first, second];
  await first.route('**/studio/api/publish/site-url', async (route) => {
    await route.fulfill({ json: { url: 'https://example.com' } });
  });
  let releaseSettings = () => {};
  const settingsGate = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  let releaseLinked = () => {};
  const linkedGate = new Promise<void>((resolve) => {
    releaseLinked = resolve;
  });
  await first.route('**/studio/api/publish/discover', async (route) => {
    await settingsGate;
    const request: unknown = route.request().postDataJSON();
    if (parseDiscoveryRequest(request).provider === 'linked') {
      await linkedGate;
    }
    await route.continue();
  });
  // The menu also discovers hosting on load; intercept before navigation to test pending discovery.
  await first.goto(fixture.url);
  await second.goto(fixture.url + '?file=src/pages/other.astro');
  for (const page of pages) {
    await page.getByTestId('ready').filter({ hasText: 'Ready' }).waitFor();
  }
  // Explicit settings remains usable while automatic hosting discovery is still pending.
  await first.getByRole('button', { name: 'More publish options', exact: true }).click();
  await first.getByRole('link', { name: 'Open published site', exact: true }).waitFor();
  assert.equal(await first.getByRole('link', { name: 'Open published site', exact: true }).getAttribute('href'), 'https://example.com');
  await first.getByRole('button', { name: 'Publish settings…', exact: true }).click();
  await first.getByRole('dialog', { name: 'Publish settings' }).waitFor();
  const loadingPanel = first.locator('.publish-settings[data-popup-phase="open"]');
  await loadingPanel.waitFor();
  await loadingPanel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const loadingFields = loadingPanel.locator('.publish-fields .dd-trigger');
  assert.equal(await loadingFields.count(), 5);
  assert.equal(await loadingPanel.getByRole('button', { name: 'Hosting provider', exact: true }).isEnabled(), true);
  assert.equal(await loadingPanel.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  assert.equal(await loadingFields.nth(1).evaluate((element) => getComputedStyle(element, '::after').animationName), 'publish-skeleton');
  const loadingBounds = await loadingPanel.boundingBox();
  const loadingInputBounds = await loadingFields.nth(1).boundingBox();
  if (process.env['PUBLISH_SCREENSHOT']) {
    await loadingPanel.screenshot({ path: process.env['PUBLISH_SCREENSHOT'] + '.loading.png' });
  }
  releaseSettings();
  assert.equal(await first.getByLabel('GitHub username', { exact: true }).isVisible(), false);
  assert.equal(await first.locator('.publish-settings select').count(), 0);
  const firstAccount = first.getByRole('button', { name: 'GitHub account', exact: true });
  await firstAccount.locator('.dd-label').filter({ hasText: 'flowtricks' }).waitFor();
  const repositoryChoice = first.getByRole('button', { name: 'GitHub repository', exact: true });
  await repositoryChoice.locator('.dd-label').filter({ hasText: 'flowtricks/site' }).waitFor();
  assert.equal(
    await loadingPanel.getByRole('button', { name: 'Hosting provider', exact: true }).innerText(),
    'Checking hosting…',
    'GitHub finishes while linked hosting is still pending',
  );
  releaseLinked();
  await first.locator('.publish-settings-loading').waitFor({ state: 'hidden' });
  await first.locator('.publish-settings[data-popup-phase="open"]').waitFor();
  const panel = first.getByRole('dialog', { name: 'Publish settings' });
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const beforeLoading = await panel.boundingBox();
  assert.deepEqual(await first.locator('.publish-settings').boundingBox(), loadingBounds, 'Initial metadata and connection loading preserve panel bounds');
  assert.deepEqual(await firstAccount.boundingBox(), loadingInputBounds, 'Skeleton inputs occupy the final field positions');
  await first.unroute('**/studio/api/publish/discover');
  let releaseLoading = () => {};
  const loadingGate = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await first.route('**/studio/api/publish/repository', async (route) => {
    await loadingGate;
    await route.continue();
  });
  await first.getByRole('button', { name: 'Refresh repos', exact: true }).click();
  await first.locator('.publish-settings-loading').waitFor({ state: 'visible' });
  assert.deepEqual(await panel.boundingBox(), beforeLoading, 'Loading preserves panel bounds');
  releaseLoading();
  await first.locator('.publish-settings-loading').waitFor({ state: 'hidden' });
  await first.unroute('**/studio/api/publish/repository');
  await firstAccount.click();
  const accountMenu = first.locator('.publish-dropdown');
  assert.equal(await accountMenu.getByText('Default account', { exact: true }).count(), 0);
  const selectedAccount = accountMenu.locator('.dd-option').filter({ hasText: 'flowtricks' });
  const check = await selectedAccount.locator('.dd-check').boundingBox();
  const label = await selectedAccount.locator('.dd-option-label').boundingBox();
  assert.ok(check && label);
  assert.ok(check.x > label.x + label.width, 'Selection check appears after the account name');
  await accountMenu.locator('.dd-option').filter({ hasText: 'tricksinc' }).click();
  await accountMenu.waitFor({ state: 'hidden' });
  await first.getByRole('button', { name: 'Refresh github account', exact: true }).click();
  await first.locator('.publish-connections[aria-busy="true"]').waitFor({ state: 'hidden' });
  assert.equal(await firstAccount.locator('.dd-label').innerText(), 'tricksinc');
  await repositoryChoice.click();
  const repositoryMenu = first.locator('.publish-dropdown');
  const menuBounds = await repositoryMenu.boundingBox();
  const searchBounds = await repositoryMenu.locator('.dd-search').boundingBox();
  assert.ok(menuBounds && searchBounds);
  assert.ok(searchBounds.x >= menuBounds.x + 8);
  assert.ok(Math.abs(searchBounds.y - menuBounds.y - (searchBounds.x - menuBounds.x)) < 1);
  assert.ok(searchBounds.x + searchBounds.width <= menuBounds.x + menuBounds.width - 8);
  await repositoryMenu.locator('.dd-search').fill('tricksinc/next');
  await first.locator('.publish-dropdown .dd-option').filter({ hasText: 'tricksinc/next' }).click();
  await first.locator('.publish-dropdown').waitFor({ state: 'hidden' });
  assert.equal((await repositoryState(fixture.root)).connected, 'flowtricks/site');
  await first.getByRole('button', { name: 'Hosting provider', exact: true }).click();
  assert.equal(await first.locator('.publish-dropdown .publish-provider-icon').count(), 3);
  await first.locator('.publish-dropdown .dd-option').filter({ hasText: 'Cloudflare' }).click();
  await first.locator('.publish-dropdown').waitFor({ state: 'hidden' });
  await first.getByText('Advanced', { exact: true }).click();
  assert.equal(await first.getByLabel('Cloudflare account ID', { exact: true }).count(), 0);
  await first.getByLabel('Pages project name', { exact: true }).fill('website');
  await first.getByRole('button', { name: 'Hosting provider', exact: true }).click();
  await first.locator('.publish-dropdown .dd-option').filter({ hasText: 'Vercel' }).click();
  await first.locator('.publish-dropdown').waitFor({ state: 'hidden' });
  await first.locator('.publish-connections[aria-busy="true"]').waitFor({ state: 'hidden' });
  assert.equal(await first.getByRole('button', { name: 'Hosting account', exact: true }).count(), 0);
  await first.getByRole('button', { name: 'Hosting project', exact: true }).click();
  assert.deepEqual(await first.locator('.publish-dropdown .dd-group-label').allTextContents(), ['Personal', 'Work']);
  await first.locator('.publish-dropdown .dd-search').fill('Work');
  assert.equal(await first.locator('.publish-dropdown .dd-option').count(), 1);
  await first.locator('.publish-dropdown .dd-option').filter({ hasText: 'Linked Vercel project' }).click();
  assert.equal(await first.getByLabel('Vercel project ID', { exact: true }).inputValue(), 'prj_123');
  await first.locator('.publish-dropdown').waitFor({ state: 'hidden' });
  await first.getByRole('button', { name: 'Save', exact: true }).click();
  await first.getByRole('dialog', { name: 'Publish settings' }).waitFor({ state: 'hidden' });
  assert.equal((await repositoryState(fixture.root)).connected, 'tricksinc/next');
  await second.getByRole('button', { name: 'More publish options', exact: true }).click();
  await second.getByRole('button', { name: 'Publish settings…', exact: true }).click();
  const provider = second.getByRole('button', { name: 'Hosting provider', exact: true });
  await provider.locator('.dd-label').filter({ hasText: 'Vercel' }).waitFor();
  await second.getByRole('button', { name: 'Hosting project', exact: true }).locator('.dd-label').filter({ hasText: 'Linked Vercel project' }).waitFor();
  assert.equal(await provider.innerText(), 'Vercel');
  assert.equal(await provider.locator('svg[data-provider="vercel"]').count(), 1);
  assert.equal(await second.getByRole('button', { name: 'GitHub account', exact: true }).locator('.dd-label').innerText(), 'tricksinc');
  assert.equal(await second.getByLabel('GitHub username', { exact: true }).isVisible(), false);
  assert.equal(await second.getByRole('button', { name: 'Hosting project', exact: true }).innerText(), 'Linked Vercel project');
  assert.equal(await second.getByLabel('Vercel project ID', { exact: true }).inputValue(), 'prj_123');
  const account = second.getByRole('button', { name: 'GitHub account', exact: true });
  assert.equal(await account.locator('.publish-avatar').count(), 1);
  await account.click();
  const accountOption = second.locator('.publish-dropdown .dd-option').filter({ hasText: 'tricksinc' });
  assert.equal(await accountOption.locator('.publish-avatar').count(), 1);
  // Moving through accounts must not change the project's saved selection.
  await account.press('Home');
  assert.equal(await account.locator('.dd-label').innerText(), 'tricksinc');
  await account.press('Escape');
  await second.locator('.publish-dropdown').waitFor({ state: 'hidden' });
  await second.locator('.stacki-publish-menu').waitFor({ state: 'hidden' });
  await second.getByRole('dialog', { name: 'Publish settings' }).evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  await second.locator('.publish-settings[data-popup-phase="open"]').waitFor();
  if (process.env['PUBLISH_SCREENSHOT']) {
    await second.screenshot({ path: process.env['PUBLISH_SCREENSHOT'], animations: 'disabled' });
    await provider.click();
    await second.locator('.publish-dropdown[data-popup-phase="open"]').waitFor();
    await second.screenshot({
      path: process.env['PUBLISH_SCREENSHOT'] + '.providers.png',
      animations: 'disabled',
    });
    await provider.press('Escape');
    await second.locator('.publish-dropdown').waitFor({ state: 'hidden' });
  }
  await second.getByRole('button', { name: 'Cancel', exact: true }).click();
  fixture.update({
    sha: 'b'.repeat(40),
    files: [{ file: 'src/pages/index.astro', before: '<h1>Original</h1>', after: '<h1>From GitHub</h1>' }],
  });
  await first.getByTestId('source').filter({ hasText: 'From GitHub' }).waitFor();
  for (const page of pages) {
    await page.getByTestId('revision').filter({ hasText: '1' }).waitFor();
  }
  await writeFile(path.join(fixture.root, 'src/pages/broken.astro'), '---\nconst = ;\n---\n<h1>Broken</h1>');
  await first.evaluate(() => {
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = '/original.png';
    icon.type = 'image/png';
    document.head.append(icon);
  });
  await first.getByRole('button', { name: 'Publish', exact: true }).click();
  for (const page of pages) {
    await page.getByText('Building website…', { exact: true }).waitFor();
    assert.match(decodeURIComponent((await page.locator('link[rel="icon"]').getAttribute('href')) ?? ''), /circle cx="72" cy="386"/);
    // Studio shows the popup Desktop shows: the shared modal, not a panel under the button.
    assert.equal(await page.getByRole('dialog', { name: 'Publishing' }).locator('.publish-status-body').count(), 1);
    assert.match(await page.locator('.publish-status-body small').innerText(), /^Step 2 of [45]$/);
    assert.equal(await page.getByRole('button', { name: 'Publishing…', exact: true }).isDisabled(), true);
  }
  assert.equal(await first.locator('.publish-status-running progress').count(), 1);
  if (process.env['PUBLISH_SCREENSHOT']) {
    await first.locator('.publish-status').screenshot({
      path: process.env['PUBLISH_SCREENSHOT'] + '.progress.png',
      animations: 'disabled',
    });
  }
  await second.reload();
  await second.getByText('Building website…', { exact: true }).waitFor();
  assert.equal(await second.getByRole('button', { name: 'Publishing…', exact: true }).isDisabled(), true);
  const checks = fixture.checks();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fixture.checks(), checks, 'Automatic sync pauses during a publish');
  fixture.release();
  for (const page of pages) {
    const failure = page.getByRole('dialog', { name: 'Publish needs attention' });
    await failure.getByRole('alert').waitFor();
    await failure.getByRole('button', { name: 'Close', exact: true }).click();
    await failure.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Publish', exact: true }).waitFor();
    if (page === first) {
      assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), '/original.png');
      assert.equal(await page.locator('link[rel="icon"]').getAttribute('type'), 'image/png');
    } else {
      assert.equal(await page.locator('link[rel="icon"]').count(), 0);
    }
    assert.equal(await page.getByRole('button', { name: 'Publish', exact: true }).isEnabled(), true);
  }
  assert.equal(fixture.publisher.state.kind, 'failed');
  console.log('Real WebSocket sharing across pages and reconnects, automatic GitHub source refresh, and real Astro build-failure recovery passed.');
} catch (error) {
  console.error(fixture.publisher.state);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      console.error(await page.locator('body').innerText());
    }
  }
  throw error;
} finally {
  await browser.close();
  await fixture.close();
}
