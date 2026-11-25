// Goal: exercise real style popovers and modifier forwarding without timing races.
// Method: wait for the closing context menu before opening the next control; its
// outside-click layer intentionally consumes clicks during the closing animation.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

export async function checkStyleControls(page: Page) {
  await page.getByRole('button', { name: 'Style context', exact: true }).click();
  await page.getByText('Add query', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Add query', { exact: true }).waitFor({ state: 'hidden' });
  for (const name of ['Flex settings', 'Grid settings', 'Inline settings']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    await button.click();
  }
  await page.getByRole('list', { name: 'Background layers' }).getByText('pattern.svg', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Background layer' });
  await dialog.waitFor();
  await dialog.getByText('32 × 32', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Replace image…', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await checkModifiers(page);
}
async function checkModifiers(page: Page) {
  await page.evaluate(() => {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        event.source !== document.querySelector('iframe')?.contentWindow ||
        !data ||
        typeof data !== 'object' ||
        !('type' in data) ||
        data.type !== 'avb:modifiers'
      ) {
        return;
      }
      document.documentElement.dataset['styleModifiers'] = JSON.stringify(data);
    });
  });
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator('#target')
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.down('Shift');
  await page.waitForFunction(() => document.documentElement.dataset['styleModifiers']?.includes('"shiftKey":true'));
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => document.documentElement.dataset['styleModifiers']?.includes('"shiftKey":false'));
  await page.keyboard.down('Alt');
  await page.waitForFunction(() => document.documentElement.dataset['styleModifiers']?.includes('"altKey":true'));
  await page.keyboard.up('Alt');
  await page.waitForFunction(() => document.documentElement.dataset['styleModifiers']?.includes('"altKey":false'));
}
