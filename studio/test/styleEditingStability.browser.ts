import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { record, string } from '../src/shared/validation';

export async function checkEditingStability(page: Page) {
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[data-prop="font-size"]')?.placeholder === '22px');
  await page.evaluate(() => {
    const input = document.querySelector('input[data-prop="font-size"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Missing font-size field');
    }
    let flashes = 0;
    document.documentElement.dataset['styleHintFlashes'] = '0';
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue === '1rem' || input.placeholder === '1rem') {
          flashes++;
        }
      }
      document.documentElement.dataset['styleHintFlashes'] = String(flashes);
    }).observe(input, {
      attributes: true,
      attributeFilter: ['placeholder'],
      attributeOldValue: true,
    });
  });
  const opacity = page.locator('input[aria-label="Opacity"]');
  await opacity.hover();
  for (const value of ['0.65', '0.7', '0.75']) {
    await opacity.fill(value);
    await opacity.press('Enter');
    await page.waitForFunction((value) => {
      const el = document.querySelector('iframe')?.contentDocument?.querySelector('#target');
      return el && getComputedStyle(el).opacity === value;
    }, value);
  }
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('html').getAttribute('data-style-hint-flashes'), '0', 'Editing must not flash inherited font size back to the default');
  await checkNewHint(page);
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator('.card')
    .click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[data-prop="font-size"]')?.placeholder === '16px');
}

async function checkNewHint(page: Page) {
  const file = 'src/pages/index.astro';
  const response = await page.request.get(new URL('/studio/api/file?file=' + encodeURIComponent(file), page.url()).href);
  assert.ok(response.ok());
  const base = string(record(await response.json())['source']);
  const responseWrite = await page.request.post(new URL('/studio/api/source', page.url()).href, {
    data: { file, base, source: base.replace('font-size: 22px', 'font-size: 26px') },
  });
  assert.ok(responseWrite.ok());
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[data-prop="font-size"]')?.placeholder === '26px');
}
