// Goal: verify interactive preview and return to the page actually visited.
// Method: navigate the real iframe and wait for destination content before exiting.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

export async function checkInteractivePreview(page: Page) {
  const button = page.locator('.studio-titlebar').getByRole('button', { name: 'Preview the site', exact: true });
  assert.equal(await button.innerText(), '', 'Preview is an icon-only titlebar action');
  assert.equal(await button.locator('svg').count(), 1);
  assert.equal(await page.locator('.studio-preview-toggle').count(), 0);
  const designer = page.frameLocator('iframe[title="Site preview"]');
  const initial = await designer.locator('h1').innerText();
  await button.click();
  const exit = page.getByRole('button', { name: 'Exit preview (Esc)', exact: true });
  assert.equal(await exit.getAttribute('aria-pressed'), 'true');
  assert.ok((await exit.getAttribute('class'))?.includes('on'));
  const preview = page.frameLocator('iframe[title="Site preview (interactive)"]');
  await preview.locator('h1').waitFor();
  assert.notEqual(
    await preview.locator('html').evaluate((node) => getComputedStyle(node).overflowX),
    'clip',
    "Interactive preview restores the fixture site's own overflow behavior",
  );
  assert.equal(await preview.locator('h1').evaluate((node) => getComputedStyle(node).cursor), 'auto');
  const canvas = await page.locator('.preview-mode').boundingBox();
  const workspace = await page.locator('.studio-workspace').boundingBox();
  assert.deepEqual(canvas, workspace, 'Interactive preview covers the entire workspace');
  assert.equal(await page.locator('.studio-workspace-panels').evaluate((node) => node instanceof HTMLElement && node.inert), true);
  await exit.focus();
  await page.keyboard.press('Backspace');
  await preview.locator('h1').click();
  await page.keyboard.press('Escape');
  await page.locator('.preview-mode').waitFor({ state: 'detached' });
  assert.equal(await designer.locator('h1').innerText(), initial);
  assert.equal(await designer.locator('h1').evaluate((node) => getComputedStyle(node).cursor), 'default');
  await button.click();
  await preview.locator('h1').waitFor();
  await exit.click();
  await page.locator('.preview-mode').waitFor({ state: 'detached' });
}

// Oversized page content must not pan the editing viewport; vertical reading still works.
export async function checkPreviewOverflow(page: Page) {
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.locator('h1').waitFor();
  const scroll = await preview.locator('body').evaluate(async (body) => {
    const content = document.createElement('div');
    content.style.cssText = 'width:4000px;height:4000px;';
    body.append(content);
    try {
      window.scrollTo(100, 100);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { horizontal: window.scrollX, vertical: window.scrollY };
    } finally {
      content.remove();
      window.scrollTo(0, 0);
    }
  });
  assert.equal(scroll.horizontal, 0, 'Editing cannot scroll past the simulated viewport width');
  assert.equal(scroll.vertical, 100, 'Editing preserves vertical scrolling');
}

export async function checkPreviewNavigation(page: Page) {
  await page.getByRole('button', { name: 'Preview the site', exact: true }).click();
  const preview = page.frameLocator('iframe[title="Site preview (interactive)"]');
  await preview.locator('h1').waitFor();
  const homeHeading = await preview.locator('h1').innerText();
  // Exercise a real same-site navigation without changing the site's source.
  await preview.locator('body').evaluate((body) => {
    const link = document.createElement('a');
    link.href = '/404';
    link.textContent = 'Preview navigation check';
    body.prepend(link);
  });
  await preview.getByRole('link', { name: 'Preview navigation check' }).click();
  await preview.getByRole('link', { name: 'Back to home', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Exit preview (Esc)', exact: true }).click();
  // Navigation uses the page's authored title in the editor, rather than its filename.
  await page.locator('.page-switch-label').filter({ hasText: 'Page not found' }).waitFor();
  await page.getByRole('button', { name: 'Preview the site', exact: true }).click();
  await preview.getByRole('link', { name: 'Back to home', exact: true }).click();
  // Astro keeps the outgoing heading visible during navigation. Waiting for any
  // h1 could press Escape on the 404 page before the home page replaces it.
  const destination = preview.getByRole('heading', { name: homeHeading, exact: true });
  await destination.waitFor();
  await destination.click();
  await page.keyboard.press('Escape');
  await page.locator('.page-switch-label').filter({ hasText: 'Home' }).waitFor();
}
