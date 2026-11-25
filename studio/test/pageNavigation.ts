import type { Page } from 'playwright';

export async function switchPage(page: Page, file: string) {
  await page.getByLabel('Current page', { exact: true }).click();
  await page.getByLabel('Search pages', { exact: true }).fill(file.replace(/^src\/pages\//, ''));
  // Match the complete path: nested index pages share the same basename as Home.
  const options = page.locator('.page-menu-item');
  const paths = await options.evaluateAll((items) => items.map((item) => item.getAttribute('data-file')));
  const index = paths.indexOf(file);
  if (index < 0) {
    throw new Error(`Page switcher does not contain ${file}`);
  }
  await options.nth(index).click();
}
