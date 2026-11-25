import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { record, string } from '../src/shared/validation';
import { HEADING_TEXT, PARAGRAPH_TEXT } from '../src/features/source/instanceDefaults';
import { flatten, nodesOf } from '../src/features/source/source';

const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4360/studio';
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const file = 'src/pages/index.astro';
const files = [
  'typography/Heading',
  'typography/Paragraph',
  'Button',
  'wrapper/ButtonWrapper',
  'wrapper/ContentWrapper',
  'wrapper/Grid',
  'interactive/Slider',
  'item/Card',
];
let original: string | undefined;
try {
  await page.goto(url);
  await saved();
  original = await source(file);
  const components = await Promise.all(files.map((name) => source(`src/components/${name}.astro`)));
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  for (const name of ['Heading', 'Paragraph', 'Button', 'ButtonWrapper', 'ContentWrapper', 'Grid', 'Slider', 'Card']) {
    await page
      .locator('.structure-node')
      .filter({ has: page.locator('.label', { hasText: /^ContentWrapper$/ }) })
      .first()
      .click();
    await page.keyboard.press('Meta+f');
    const palette = page.locator('.insert-palette');
    await palette.getByPlaceholder('Search components, elements…').fill(name);
    await palette
      .locator('.insert-item')
      .filter({ has: page.locator('.insert-item-label', { hasText: new RegExp(`^${name}$`) }) })
      .click();
    await saved();
    const next = await source(file);
    const inserted = flatten(nodesOf(next))
      .filter((node) => node.name === name)
      .at(-1);
    assert.ok(inserted);
    const canvas = page.frameLocator('iframe[title="Site preview"]');
    const text = name === 'Paragraph' ? PARAGRAPH_TEXT : name.startsWith('Button') ? 'Button Text' : HEADING_TEXT;
    await canvas.getByText(text, { exact: true }).first().waitFor({ state: 'attached' });
    if (name === 'Grid' || name === 'Slider') {
      assert.deepEqual(inserted.props?.['small'], {
        type: 'expr',
        value: name === 'Grid' ? '2' : '1.4',
      });
      assert.equal(inserted.children?.filter((node) => node.name === 'Card').length, name === 'Grid' ? 3 : 2);
    }
    await page.keyboard.press('Meta+z');
    await saved();
    assert.equal(await source(file), original);
  }
  assert.deepEqual(await Promise.all(files.map((name) => source(`src/components/${name}.astro`))), components);
  console.log(
    'All eight insertion recipes render their default content; nested instances and numeric props pass; component files remain byte-for-byte unchanged.',
  );
} finally {
  if (original !== undefined) {
    const base = await source(file);
    if (base !== original) {
      const response = await page.request.post(new URL('/studio/api/source', url).href, {
        headers: { Origin: new URL(url).origin },
        data: { file, source: original, base },
      });
      assert.ok(response.ok());
    }
  }
  await browser.close();
}
async function source(file: string) {
  const response = await page.request.get(new URL('/studio/api/file?file=' + encodeURIComponent(file), url).href);
  assert.ok(response.ok());
  return string(record(await response.json())['source']);
}
async function saved() {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}
