import assert from 'node:assert/strict';
import { chromium, type Locator } from 'playwright';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 600 } });
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4373/studio';
const endpoint = new URL('/studio/api/file?file=src%2Fpages%2Findex.astro', url).href;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const original = string(record(await (await page.request.get(endpoint)).json())['source']);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await page.locator('.props-group-head').filter({ hasText: 'Settings' }).click();
  const input = page.locator('.class-input-field');
  await input.fill('margin');
  await moveFieldToBottom(input);
  const popup = page.locator('.class-suggest');
  await popup.waitFor();
  await page.waitForFunction(() => {
    const popup = document.querySelector('.class-suggest')?.getBoundingClientRect();
    const field = document.querySelector('.class-input')?.getBoundingClientRect();
    return !!popup && !!field && popup.bottom <= field.top && popup.top >= 8;
  });
  assert.equal(await popup.evaluate((node) => node.parentElement === document.body), true);
  await insideViewport(popup);
  await page.screenshot({ path: 'test-results/class-popup-above.png' });
  for (let index = 0; index < 11; index++) {
    await input.press('ArrowDown');
  }
  const highlighted = popup.locator('.highlight');
  const choice = await highlighted.innerText();
  await highlighted.waitFor();
  const menuBox = await popup.boundingBox();
  const optionBox = await highlighted.boundingBox();
  assert.ok(menuBox && optionBox && optionBox.y >= menuBox.y && optionBox.y + optionBox.height <= menuBox.y + menuBox.height);
  await page.setViewportSize({ width: 1200, height: 460 });
  await insideViewport(popup);
  await input.press('Enter');
  await page
    .locator('.class-tag')
    .filter({ hasText: new RegExp(`^${choice}$`) })
    .waitFor();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(
    async ({ endpoint, original }) => {
      const data: unknown = await (await fetch(endpoint)).json();
      return !!data && typeof data === 'object' && 'source' in data && data.source === original;
    },
    { endpoint, original },
  );
  const familyTag = page.locator('.class-tag').filter({ hasText: /^margin-block-8$/ });
  await familyTag.click();
  const family = page.locator('.class-family');
  await family.waitFor();
  await insideViewport(family);
  await input.press('Escape');
  await family.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(
    'Class suggestions open above, escape panel clipping, keep keyboard choices visible, resize safely, commit/undo, and constrain related-class menus.',
  );
} catch (error) {
  await page.screenshot({ path: 'test-results/class-popup-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

async function moveFieldToBottom(input: Locator) {
  await input.evaluate((element) => {
    let scroller = element.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement;
    }
    if (!scroller) {
      throw new Error('Missing scrolling settings panel');
    }
    scroller.scrollTop += element.getBoundingClientRect().bottom - (window.innerHeight - 30);
  });
}
async function insideViewport(popup: Locator) {
  await page.waitForFunction(
    (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return !!rect && rect.top >= 7 && rect.left >= 7 && rect.bottom <= innerHeight - 7 && rect.right <= innerWidth - 7;
    },
    await popup.evaluate((node) => (node.classList.contains('class-family') ? '.class-family' : '.class-suggest')),
  );
}
