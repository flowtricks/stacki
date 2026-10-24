// Verify the real editor in two isolated browser contexts, including source-backed
// settings, collaborator updates, preview morphing without navigation, and mobile layout.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { checkInteractivePreview, checkPreviewNavigation } from './interactivePreview.browser';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : chromium.executablePath()),
  headless: true,
});
const auth = process.env['STUDIO_STORAGE_STATE'];
const storage = auth ? { storageState: auth } : {};
const firstContext = await browser.newContext({
  ...storage,
  viewport: { width: 1440, height: 1000 },
});
const secondContext = await browser.newContext({
  ...storage,
  viewport: { width: 1440, height: 1000 },
});
const first = await firstContext.newPage();
const second = await secondContext.newPage();
const errors: string[] = [];
first.setDefaultTimeout(20000);
second.setDefaultTimeout(20000);
for (const page of [first, second]) {
  page.on('pageerror', (error) => errors.push(error.message));
}
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio';
let original: string | undefined;
let releaseMorph: () => void = () => {};
const morphGate = new Promise<void>((resolve) => {
  releaseMorph = resolve;
});
// Simulate a slow preview script: edits can precede morph initialization.
await first.route('**/studio/morph.js', async (route) => {
  await morphGate;
  await route.continue();
});
try {
  await Promise.all([
    first.goto(url, { waitUntil: 'domcontentloaded' }),
    second.goto(url, { waitUntil: 'domcontentloaded' }),
  ]);
  await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await second.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const accountMenu = first.getByLabel('Stacki account menu', { exact: true });
  await accountMenu.waitFor();
  assert.equal(await first.locator('.account-menu img').count(), 0);
  await accountMenu.click();
  if (auth) {
    await first.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await first.waitForFunction(() => {
      const images = [...document.querySelectorAll<HTMLImageElement>('.collaborators img')];
      return (
        images.length > 0 &&
        new Set(images.map((image) => image.src)).size === images.length &&
        images.every((image) => image.complete && image.naturalWidth > 0)
      );
    });
  } else {
    await first.getByText('Local development · no sign-in required', { exact: true }).waitFor();
  }
  await accountMenu.click();
  // The shared popup consumes outside clicks until its closing animation finishes.
  await first.locator('.account-popover').waitFor({ state: 'detached' });

  await first.getByRole('button', { name: 'Expand all', exact: true }).click();
  await second.getByRole('button', { name: 'Expand all', exact: true }).click();
  await first
    .locator('.structure-node')
    .filter({ has: first.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await second
    .locator('.structure-node')
    .filter({ has: second.locator('.label', { hasText: /^Eyebrow$/ }) })
    .click();
  original = await first.locator('.rich-content').innerText();
  const preview = first.frameLocator('iframe');
  await preview.locator('h1').waitFor();
  await preview.locator('#studio-render-baseline').waitFor({ state: 'attached' });
  let navigations = 0;
  first.on('framenavigated', (frame) => {
    if (frame.parentFrame()) {
      navigations++;
    }
  });
  await first.locator('.rich-content').fill('Collaborative studio');
  await second
    .frameLocator('iframe')
    .getByRole('heading', { name: 'Collaborative studio', exact: true })
    .waitFor();
  releaseMorph();
  await preview
    .getByRole('heading', { name: 'Collaborative studio', exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(navigations, 0, 'Text updates should morph without reloading the page');
  assert.equal(
    await preview.locator('h1').evaluate((node) => getComputedStyle(node).cursor),
    'default',
  );
  await checkInteractivePreview(first);
  // Exercise actual pointer sorting and the originating editor's structural undo.
  const headingGrip = first
    .locator('.structure-node')
    .filter({ has: first.locator('.label', { hasText: /^Heading$/ }) });
  const eyebrowGrip = first.locator('.nav-gap[data-drop-parent="n0.0.0"][data-drop-index="3"]');
  const headingBox = await headingGrip.boundingBox();
  const eyebrowBox = await eyebrowGrip.boundingBox();
  assert.ok(headingBox && eyebrowBox);
  const beforeOrder = await first.locator('.structure-node .label').allTextContents();
  await first.mouse.move(headingBox.x + 5, headingBox.y + 5);
  await first.mouse.down();
  await first.mouse.move(eyebrowBox.x + 5, eyebrowBox.y + eyebrowBox.height / 2, { steps: 12 });
  await first.mouse.up();
  await first.waitForFunction(() => {
    const labels = [...document.querySelectorAll('.structure-node .label')].map(
      (node) => node.textContent,
    );
    return labels.indexOf('Heading') > labels.indexOf('Eyebrow');
  });
  await first.keyboard.press('ControlOrMeta+z');
  await first.waitForFunction(
    (expected) =>
      JSON.stringify(
        [...document.querySelectorAll('.structure-node .label')].map((node) => node.textContent),
      ) === JSON.stringify(expected),
    beforeOrder,
  );
  await first
    .locator('.structure-node')
    .filter({ has: first.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await first.locator('.props-group-head').filter({ hasText: 'Settings' }).click();
  await first.locator('.class-input-field').fill('margin');
  await first.locator('.class-suggest').waitFor();
  await mkdir('test-results', { recursive: true });
  await first.screenshot({ path: 'test-results/desktop.png' });
  await first.locator('.class-input-field').fill('');
  await first.keyboard.press('Escape');
  await first.locator('.rich-content').fill(original);
  await preview.getByRole('heading', { name: original, exact: true }).waitFor();
  assert.equal(
    await preview.locator('h1').evaluate((node) => getComputedStyle(node).cursor),
    'default',
  );
  await first
    .locator('.structure-node')
    .filter({ has: first.locator('.label', { hasText: /^Img$/ }) })
    .click();
  const mobile = await browser.newContext({
    ...storage,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  await phone.goto(url);
  phone.setDefaultTimeout(20000);
  await phone.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({ state: 'attached' });
  await phone.getByRole('button', { name: 'Navigator', exact: true }).click();
  await phone.getByRole('button', { name: 'Expand all', exact: true }).click();
  const from = await phone
    .locator('.structure-node')
    .filter({ has: phone.locator('.label', { hasText: /^Heading$/ }) })
    .locator('.drag-handle')
    .boundingBox();
  const to = await phone
    .locator('.nav-gap[data-drop-parent="n0.0.0"][data-drop-index="3"]')
    .boundingBox();
  assert.ok(from && to);
  const touch = await mobile.newCDPSession(phone);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x + 8, y: from.y + 8 }],
  });
  await phone.waitForTimeout(220);
  for (let step = 1; step <= 12; step++) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + 8 + ((to.x - from.x) * step) / 12,
          y: from.y + 8 + ((to.y + to.height / 2 - from.y - 8) * step) / 12,
        },
      ],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await phone.waitForFunction(() => {
    const labels = [...document.querySelectorAll('.structure-node .label')].map(
      (node) => node.textContent,
    );
    return labels.indexOf('Heading') > labels.indexOf('Eyebrow');
  });
  await phone.getByRole('button', { name: 'History', exact: true }).click();
  await phone.getByRole('button', { name: 'Undo', exact: true }).click();
  await phone.getByRole('button', { name: 'Navigator', exact: true }).click();
  await phone.getByRole('button', { name: 'Expand all', exact: true }).click();
  await phone.waitForFunction(() => {
    const labels = [...document.querySelectorAll('.structure-node .label')].map(
      (node) => node.textContent,
    );
    return labels.indexOf('Heading') < labels.indexOf('Eyebrow');
  });
  await phone.getByLabel('Close panel').click();
  await phone
    .locator('.preview-toolbar')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await phone.locator('.studio-right.mobile-open').waitFor();
  await phone.screenshot({ path: 'test-results/mobile.png' });
  assert.equal(
    await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  original = undefined; // The restored draft is saved before preview navigation changes pages.
  await checkPreviewNavigation(first);
  await first.clock.install();
  await first.clock.fastForward('05:20');
  await first.getByRole('button', { name: 'Resume editing' }).waitFor();
  assert.equal(
    await first.locator('iframe').count(),
    0,
    'Idle preview must release its connection',
  );
  await first.getByRole('button', { name: 'Resume editing' }).click();
  await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await first.frameLocator('iframe').locator('h1').waitFor();
  assert.deepEqual(errors, []);
  if (auth) {
    await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    original = undefined; // The draft was restored and saved before signing out.
    await first.locator('.account-menu summary').click();
    await first.getByRole('button', { name: 'Sign out', exact: true }).click();
    await first.getByRole('link', { name: 'Sign in with GitHub', exact: true }).waitFor();
    await first.reload();
    await first.getByRole('link', { name: 'Sign in with GitHub', exact: true }).waitFor();
  }
  console.log(
    'Two-browser collaboration, source edits, preview without reload, class suggestions, touch dragging, mobile layout, and idle pause/resume passed.',
  );
} catch (error) {
  await first.screenshot({ path: 'test-results/browser-failure.png' }).catch(() => {});
  console.error(
    'Inspector at failure:',
    await first
      .locator('.studio-right')
      .innerText()
      .catch(() => 'unavailable'),
  );
  throw error;
} finally {
  releaseMorph();
  if (original !== undefined && !first.isClosed()) {
    try {
      await first
        .locator('.structure-node')
        .filter({ has: first.locator('.label', { hasText: /^Heading$/ }) })
        .click({ timeout: 2000 });
      const input = first.locator('.rich-content');
      if ((await input.innerText({ timeout: 2000 })) === 'Collaborative studio') {
        await input.fill(original);
        await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({ timeout: 3000 });
      }
    } catch {
      console.error('Test cleanup could not restore the text; inspect the draft.');
    }
  }
  await browser.close();
}
