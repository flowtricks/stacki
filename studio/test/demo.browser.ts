// Goal: the demo opens from static files with no server behind it, and the real Studio
// client edits the finished page: text, style and plain structure update, survive a
// reload and reset, and what needs Astro is visibly disabled rather than faked.
// Method: bake a disposable project, serve it from a file-only host, and drive the
// unmodified client through Chrome with real pointer and keyboard input. Run it with
// `npm run build && npx tsx scripts/buildDemoAssets.ts && npx tsx test/demo.browser.ts`.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type FrameLocator, type Page } from 'playwright';
import { bakeFixture, makeProject, serveDemo } from './demoFixture';

const project = await makeProject();
const out = await mkdtemp(path.join(os.tmpdir(), 'stacki-demo-out-'));
await bakeFixture(project.root, out);
const host = await serveDemo(out);
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
const failures: string[] = [];

// The demo opens in preview, on the finished site; the editing checks leave it for the
// designer view first, as a visitor does with the preview button.
async function openDemo(page: Page, view: 'designer' | 'preview' = 'designer'): Promise<FrameLocator> {
  await page.goto(host.url);
  const exit = page.getByRole('button', { name: 'Exit preview (Esc)' });
  await exit.waitFor();
  await page.frameLocator('iframe[title="Site preview (interactive)"]').locator('h1').waitFor();
  if (view === 'designer') {
    await exit.click();
  }
  const frame = page.frameLocator('iframe[title="Site preview"]');
  await frame.locator('h1').waitFor();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  return frame;
}

// A reload opens in preview again; the editing checks go back to the designer view.
async function reloadDemo(page: Page): Promise<void> {
  await page.reload();
  const exit = page.getByRole('button', { name: 'Exit preview (Esc)' });
  await exit.waitFor();
  await exit.click();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').first().waitFor();
}

async function select(frame: FrameLocator, selector: string): Promise<void> {
  await frame.locator(selector).click();
}

// Text editing opens once the rendering of the current source has landed, so a
// double click straight after an edit may meet the wait notice; it is tried again.
async function editText(page: Page, frame: FrameLocator, selector: string, text: string): Promise<void> {
  const editor = frame.locator('[data-avb-text-editor]');
  for (let attempt = 0; attempt < 20 && (await editor.count()) === 0; attempt++) {
    await frame.locator(selector).dblclick();
    await editor.waitFor({ timeout: 500 }).catch(() => undefined);
  }
  await editor.waitFor();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
  await editor.press('Enter');
  await frame.locator(selector).filter({ hasText: text }).waitFor();
}

async function checkStyle(page: Page, frame: FrameLocator): Promise<void> {
  await select(frame, 'h1');
  await page.locator('.right-tabs button').filter({ hasText: 'Style' }).click();
  await page
    .locator('.embed-editor_selector-chip')
    .filter({ hasText: /^\.headline$/ })
    .click();
  const opacity = page.getByRole('textbox', { name: 'Opacity', exact: true });
  await opacity.fill('0.5');
  await opacity.press('Enter');
  await waitForOpacity(page, frame, '0.5');
  await checkStyleSequence(page, frame);
}

// A run of style changes to one rule restyles the page in place: no rendering is
// patched into the body, and no stylesheet is removed and put back.
async function checkStyleSequence(page: Page, frame: FrameLocator): Promise<void> {
  await frame.locator('body').evaluate((body) => {
    const log: string[] = [];
    Reflect.set(window, '__styleMutations', log);
    new MutationObserver((records) => {
      for (const record of records) {
        // Marker comments are re-synced after every patch and never paint.
        const nodes = [...record.addedNodes, ...record.removedNodes].map((node) => node.nodeName).filter((name) => name !== '#comment');
        // A stylesheet's own text changing in place is the update itself.
        const inPlace = record.target.nodeName === 'STYLE';
        if (!inPlace && nodes.length > 0 && (record.target === document.head || body.contains(record.target))) {
          log.push(`${record.target.nodeName}:${nodes.join(',')}`);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const opacity = page.getByRole('textbox', { name: 'Opacity', exact: true });
  for (const value of ['0.6', '0.7', '0.5']) {
    await opacity.fill(value);
    await opacity.press('Enter');
    await waitForOpacity(page, frame, value);
  }
  await page.waitForTimeout(500);
  const mutations = await frame.locator('body').evaluate(() => Reflect.get(window, '__styleMutations') as string[]);
  assert.deepEqual(mutations, [], 'Style changes neither re-render the page nor swap a stylesheet');
}

async function waitForOpacity(page: Page, frame: FrameLocator, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await frame.locator('h1').evaluate((element) => getComputedStyle(element).opacity)) === expected) {
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`The heading never reached opacity ${expected}`);
}

async function checkMove(page: Page, frame: FrameLocator): Promise<void> {
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  const grip = page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^div$/ }) })
    .first();
  const gap = page.locator('.nav-gap[data-drop-parent="n0.1.0"][data-drop-index="4"]');
  const gripBox = await grip.boundingBox();
  const gapBox = await gap.boundingBox();
  assert.ok(gripBox);
  assert.ok(gapBox);
  await page.mouse.move(gripBox.x + 5, gripBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(gapBox.x + 5, gapBox.y + gapBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await frame.locator('#second + #first').waitFor();
  assert.equal(await frame.locator('#second').getAttribute('data-avb-p'), '0.1.0.2', 'Paths follow the new order');
  assert.equal(await frame.locator('#first').getAttribute('data-avb-p'), '0.1.0.3', 'Paths follow the new order');
}

async function checkInsert(page: Page, frame: FrameLocator): Promise<void> {
  await select(frame, '#first');
  await page.keyboard.press('ControlOrMeta+E');
  await page.getByPlaceholder('Search components, elements…').fill('aside');
  await page.keyboard.press('Enter');
  await frame.locator('main aside').waitFor({ state: 'attached' });
  assert.notEqual(await frame.locator('main aside').getAttribute('data-avb-p'), null, 'A new element can be selected');
}

async function checkDelete(page: Page, frame: FrameLocator): Promise<void> {
  await select(frame, '#second');
  await frame.locator('#second').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  await frame.locator('#second').waitFor({ state: 'detached' });
  assert.equal(await frame.locator('#first').count(), 1, 'Deleting one box leaves its sibling');
}

async function checkDisabled(page: Page, frame: FrameLocator): Promise<void> {
  assert.equal(await page.locator('.rail-btn[aria-label="Git"]').isVisible(), false, 'Git is hidden');
  assert.equal(await page.locator('.rail-btn.ai-icon').isVisible(), false, 'AI is hidden');
  assert.equal(await page.getByRole('button', { name: 'Stacki account menu' }).isVisible(), true, 'The Stacki menu holds the sound switch');
  for (const name of ['Assets', 'Variables']) {
    assert.equal(await page.locator(`.rail-btn[aria-label="${name}"]`).getAttribute('aria-disabled'), null, `${name} works in the demo`);
  }
  assert.equal(await page.locator('.rail-btn[aria-label="Collections"]').getAttribute('aria-disabled'), null, 'Collections read from the bake');
  assert.equal(await page.locator('.rail-btn[aria-label="Components"]').getAttribute('aria-disabled'), null, 'Components insert from the bake');
  await checkComponentOpen(page, frame);
}

// A double click beside any text asks the editor to open the component; the demo lets
// it, and the component is edited where it sits on the page, as in Studio.
async function checkComponentOpen(page: Page, frame: FrameLocator): Promise<void> {
  await select(frame, 'article.card');
  await frame.locator('article.card').evaluate(() => window.parent.postMessage({ type: 'studio:open', id: '0.1.0.4', occurrence: 0 }, '*'));
  await page.locator('.titlebar.component-open').waitFor();
  assert.match((await page.locator('.titlebar').textContent()) ?? '', /Card\.astro/, 'The Card component is open');
  assert.equal(await page.locator('.toast').filter({ hasText: 'full Stacki app' }).count(), 0, 'Nothing says it needs the full app');
  await page
    .locator('.titlebar')
    .getByRole('button', { name: /Card\.astro/ })
    .click();
  await page.locator('.titlebar.component-open').waitFor({ state: 'detached' });
}

// Moving a component whose inner element also carries the instance's path (it forwards
// its caller's attributes) moves the instance whole: its content stays inside it.
async function checkForwardingMove(page: Page, frame: FrameLocator): Promise<void> {
  const grip = page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Box/ }) })
    .first();
  const gap = page.locator('.nav-gap[data-drop-parent="n0.1.0"][data-drop-index="0"]');
  const gripBox = await grip.boundingBox();
  const gapBox = await gap.boundingBox();
  assert.ok(gripBox);
  assert.ok(gapBox);
  await page.mouse.move(gripBox.x + 5, gripBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(gapBox.x + 5, gapBox.y + gapBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await frame.locator('main > section.box:first-child').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('main > section.box > div.box_inner > p.boxed').textContent(), 'Boxed text', 'The moved instance keeps its content');
  assert.ok((await frame.locator('section.box').boundingBox())?.height ?? 0 > 0, 'And still shows it');
  assert.equal(await page.locator('.structure-node .label', { hasText: /^Box/ }).count(), 1, 'The Navigator still lists it by name');
}

// A loop over literal items is limited from the copies the bake rendered: the loop's
// own settings are open, and the page shows the items the new head keeps.
async function checkLoop(page: Page, frame: FrameLocator): Promise<void> {
  // The Navigator was expanded by the move check.
  await page
    .locator('.structure-node .label', { hasText: /^items\.map$/ })
    .first()
    .click();
  await page.locator('.right-tabs button').filter({ hasText: 'Settings' }).click();
  assert.equal(await page.locator('[data-demo-lock]').count(), 0, 'The loop over literal items is not locked');
  const code = page.locator('.studio-right .cm-content').first();
  await code.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('items.slice(1, 2).map((item) => (');
  await page.keyboard.press('Enter');
  await frame.locator('li.item').filter({ hasText: 'one' }).waitFor({ state: 'detached' });
  assert.deepEqual(await frame.locator('li.item').allTextContents(), ['two'], 'Only the kept item shows');
}

// A content collection's entry is browsed and edited in the Collections panel, saved
// to its file, and patched onto the page where its title shows as written.
async function checkCollections(page: Page, frame: FrameLocator): Promise<void> {
  await page.locator('.rail-btn[aria-label="Collections"]').click();
  await page.locator('.cms-collection').filter({ hasText: 'Content Collections' }).click();
  await page.locator('.cms-collection.is-counted').filter({ hasText: /notes/i }).click();
  await page.getByText('First note', { exact: true }).first().dblclick();
  const title = page.locator('.studio-left, .cms-view, main').getByRole('textbox').filter({ hasText: '' }).first();
  await title.waitFor();
  await page.locator('input[value="First note"], textarea').first().fill('Edited note');
  await page.keyboard.press('Tab');
  await frame.locator('p.note').filter({ hasText: 'Edited note' }).waitFor();
  const source = await page.evaluate(async () => {
    const response = await fetch('/studio/api/file?file=src/content/notes/first.md');
    const data: unknown = await response.json();
    return typeof data === 'object' && data !== null && 'source' in data ? String(data.source) : '';
  });
  assert.match(source, /^title: Edited note$/m, 'The entry file holds the edit');
  assert.match(source, /^summary: A short summary$/m, 'The rest of the file is as it was');
  // The collection view covers the canvas; the Navigator brings the canvas back.
  await page.locator('.rail-btn[aria-label="Navigator"]').click();
}

// A component's props render from the bake's templates: the settings panel is open
// for the instance, and a title change shows on the canvas with its slot kept.
async function checkComponentProps(page: Page, frame: FrameLocator): Promise<void> {
  await select(frame, 'article.card');
  await page.locator('.right-tabs button').filter({ hasText: 'Settings' }).click();
  assert.equal(await page.locator('[data-demo-lock]').count(), 0, 'A templated instance is not locked');
  const title = page.locator('.studio-right').getByRole('textbox').first();
  await title.fill('Edited card');
  await title.press('Enter');
  await frame.locator('article.card h3').filter({ hasText: 'Edited card' }).waitFor();
  assert.match((await frame.locator('article.card').textContent()) ?? '', /Card body/, 'The slot content stays');
}

// A component inserted from the quick-insert list renders from its recipe template,
// styled by its own section even where the page had no copy of it.
async function checkComponentInsert(page: Page, frame: FrameLocator): Promise<void> {
  await select(frame, '#first');
  await page.keyboard.press('ControlOrMeta+E');
  await page.getByPlaceholder('Search components, elements…').fill('Card');
  await page.keyboard.press('Enter');
  await frame.locator('article.card').nth(1).waitFor({ state: 'attached' });
  assert.notEqual(await frame.locator('article.card').nth(1).getAttribute('data-avb-p'), null, 'A new component can be selected');
}

// Publish runs Studio's real progress panel against the demo's script and reaches the
// live state; only demo and site files may be requested while it runs.
async function checkPublish(page: Page): Promise<void> {
  const before = host.requests.length;
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('dialog', { name: 'Published successfully' }).waitFor({ timeout: 20_000 });
  const body = page.locator('.publish-status-body[data-demo-note]');
  await body.waitFor();
  assert.match((await body.getAttribute('data-demo-note')) ?? '', /nothing is really published/, 'The popup says it is a demo');
  const outside = host.requests.slice(before).filter((request) => !request.startsWith('/demo/'));
  assert.deepEqual(outside, [], 'Publishing makes no request outside the demo');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}

// The Publish menu looks connected: 3 commits for GitHub and changes for Cloudflare. A
// push empties and disables the GitHub row until an edit adds a commit again.
async function checkPublishMenu(page: Page, frame: FrameLocator): Promise<void> {
  const menu = page.locator('.stacki-publish-menu');
  const github = menu.locator('.stacki-publish-github button');
  const openMenu = async () => {
    await page.getByRole('button', { name: 'More publish options' }).click();
    await github.waitFor();
  };
  await openMenu();
  await github.filter({ hasText: '3 commits to push' }).waitFor();
  await menu.locator('.stacki-publish-hosting button').filter({ hasText: 'Changes to deploy' }).waitFor();
  await github.click();
  await page.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 20_000 });
  await openMenu();
  await github.filter({ hasText: 'No changes to push' }).waitFor();
  assert.equal(await github.isDisabled(), true, 'Push is disabled once everything is pushed');
  await page.keyboard.press('Escape');
  await editText(page, frame, 'p.lede', 'Edited before a push');
  await page.waitForTimeout(3_000); // Studio re-reads availability 2.5s after an edit.
  await openMenu();
  await github.filter({ hasText: '1 commit to push' }).waitFor();
  assert.equal(await github.isDisabled(), false, 'An edit enables Push again');
  await page.keyboard.press('Escape');
}

// The column guide is project settings in `.stacki/guide.json`: the toggle saves it in
// the browser with no error, and the caller checks it after a reload and a reset.
async function toggleGuide(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Column guide' }).click();
  await page.getByRole('button', { name: 'Guide', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.getByText('Project settings will retry').count(), 0, 'The guide saves without an error');
  await page.keyboard.press('Escape');
}

async function guideVisible(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const response = await fetch('/studio/api/metadata?kind=guide');
    const body: unknown = await response.json();
    const source = typeof body === 'object' && body !== null && 'source' in body && typeof body.source === 'string' ? body.source : '';
    return /"visible":\s*true/.test(source);
  });
}

// The demo opens in preview, the visitor's site: a root link loads the page under the
// demo's base and the switcher follows it, a pick in the switcher loads that page in
// the preview, a download route opens a new tab, and a button runs its script. The
// designer view it leaves for starts in select mode, so a click selects.
async function checkModesAndPreview(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await openDemo(page, 'preview');
  const frameElement = page.locator('iframe[title="Site preview (interactive)"]');
  assert.match((await frameElement.getAttribute('src')) ?? '', /#avb-preview$/, 'The preview is never a design frame');
  const preview = page.frameLocator('iframe[title="Site preview (interactive)"]');
  await preview.locator('#to-about').click();
  await preview.locator('h1').filter({ hasText: 'About page' }).waitFor();
  await page.locator('.page-switch-label').filter({ hasText: /about/i }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Exit preview (Esc)' }).count(), 1, 'Following a link keeps preview mode on');
  await preview.locator('#ping').click();
  await preview.locator('body[data-pinged="yes"]').waitFor();
  const opened = context.waitForEvent('page');
  await preview.locator('#download').click();
  assert.match((await opened).url(), /\/download\/mac$/, 'A download route opens in a new tab');
  await page.getByRole('button', { name: 'Current page' }).click();
  await page
    .getByRole('option')
    .filter({ hasText: /home|index/i })
    .first()
    .click();
  await preview.locator('h1').filter({ hasText: 'Original heading' }).waitFor();
  // Escape leaves preview on the page it shows, and more presses change nothing.
  await preview.locator('h1').click();
  for (let press = 0; press < 3; press++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').filter({ hasText: 'Original heading' }).waitFor();
  assert.match((await page.locator('.page-switch-label').textContent()) ?? '', /home|index/i, 'Leaving preview keeps the page');
  const hand = page.locator('button[aria-label="Interact with canvas"]');
  assert.equal(await hand.getAttribute('aria-pressed'), 'false', 'The designer view starts in select mode');
  // Reordering after preview patches the canvas once, in the frame it already had.
  const canvas = page.frames().find((frame) => frame.url().includes('#avb-design'));
  assert.ok(canvas);
  await canvas.evaluate(() => {
    Reflect.set(window, 'morphsSeen', 0);
    document.addEventListener('avb:morphed', () => Reflect.set(window, 'morphsSeen', Number(Reflect.get(window, 'morphsSeen')) + 1));
  });
  await checkMove(page, page.frameLocator('iframe[title="Site preview"]'));
  await page.waitForTimeout(1_000);
  assert.ok(page.frames().includes(canvas), 'The canvas was not reloaded by the reorder');
  const morphs = await canvas.evaluate(() => Number(Reflect.get(window, 'morphsSeen')));
  assert.equal(morphs, 1, 'One patch for one reorder');
  assert.equal(await page.locator('iframe[title="Site preview (interactive)"]').count(), 0, 'No preview frame is left behind');
  await context.close();
}

// Studio pauses an idle editor after five minutes to stop a hosted server; the demo has
// none, so it never pauses. Time is fast-forwarded past the window on a fake clock.
async function checkNeverPauses(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.clock.install();
  const frame = await openDemo(page);
  await page.clock.runFor(6 * 60_000);
  assert.equal(await page.getByText('Studio paused').count(), 0, 'The demo never shows the idle pause');
  await editText(page, frame, 'p.lede', 'Edited after idling');
  await context.close();
}

// Every page is baked, so switching pages from the Pages panel shows the new page at
// once: the frame announces it is ready well under a second after the click. The
// visitor's own presence badge is hidden, since nobody else is ever there.
async function checkPageSwitch(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await openDemo(page);
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  const row = page.getByText('/about', { exact: true });
  await row.waitFor();
  await page.locator('.page-presence').first().waitFor({ state: 'hidden' }); // No badge for the only visitor.
  const started = Date.now();
  await row.click();
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Site preview"]');
    const shown = frame?.contentWindow?.location.pathname.endsWith('/about/') === true;
    return shown && document.querySelector('.studio-preview-loading') === null;
  });
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 1_000, `The page switch shows the new page in ${elapsedMs}ms`);
  await context.close();
}

// Sound effects are on from the first visit, Studio's own default, and can be switched
// off in the Stacki menu, which a reload remembers. Nothing makes a sound, or even opens
// an audio context, before the visitor's first click: browsers allow audio only then.
async function audioOpened(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'audioContextsOpened');
    if (typeof read !== 'function') {
      return 'not installed';
    }
    const opened: unknown = Reflect.apply(read, undefined, []);
    return opened;
  });
}

async function checkSound(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const Native = window.AudioContext;
    let opened = 0;
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        opened++;
      }
    };
    Reflect.set(window, 'audioContextsOpened', () => opened);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => failures.push(`sound: ${error.message}`));
  const frame = await openDemo(page);
  assert.equal(await audioOpened(page), 0, 'No audio before the first click');
  await select(frame, 'h1');
  await page.locator('.right-tabs button').filter({ hasText: 'Style' }).click();
  await page.getByRole('button', { name: 'Style context' }).click();
  assert.equal(await audioOpened(page), 1, 'A click in the Style panel plays a note');
  await page.keyboard.press('Escape');
  const menu = page.getByRole('button', { name: 'Stacki account menu' });
  const toggle = page.getByRole('switch', { name: 'Sound effects' });
  await menu.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'Sound effects start on');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await page.reload();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await menu.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'The visitor turning sound off survives a reload');
  await context.close();
}

// A phone gets the editor too, in Studio's own mobile layout. The demo's bar and notes
// must fit beside it: nothing on the page may be wider than the screen.
async function checkPhone(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(host.url);
  await page.locator('.demo-bar').waitFor({ state: 'attached' });
  await page.locator('#root > *').first().waitFor();
  assert.equal(await page.getByText('Open this on a larger screen').count(), 0, 'There is no larger-screen gate');
  await page.evaluate(() => {
    // The bar shows once there is an edit; shown here to measure it as it would be.
    const bar = document.querySelector<HTMLElement>('.demo-bar');
    if (bar !== null) {
      bar.hidden = false;
    }
  });
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    bar: document.querySelector('.demo-bar')?.getBoundingClientRect().right ?? 0,
  }));
  assert.ok(widths.page <= 375, `The page never scrolls sideways (${widths.page}px)`);
  assert.ok(widths.bar <= 375, `The storage bar fits a phone (${widths.bar}px)`);
  await context.close();
}

async function checkBlockedStorage(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => failures.push(`blocked storage: ${error.message}`));
  const frame = await openDemo(page);
  await editText(page, frame, 'p.lede', 'Works without storage');
  await page.locator('.demo-storage').filter({ hasText: 'blocks storage' }).waitFor();
  await context.close();
}

async function checkFullStorage(): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('Full', 'QuotaExceededError');
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const frame = await openDemo(page);
  await editText(page, frame, 'p.lede', 'Works with a full disk');
  await page.locator('.demo-storage').filter({ hasText: 'storage is full' }).waitFor();
  await context.close();
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The editing checks below work the canvas in select mode, its default.
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => failures.push(error.message));
  const frame = await openDemo(page);
  assert.equal(host.requests.filter((request) => request.startsWith('/studio')).length, 0, 'Studio never touches the network for its own routes');
  // The storage note and Reset show only while there are edits to reset.
  await page.locator('.demo-bar').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.demo-bar').isVisible(), false, 'No storage pill before an edit');
  await checkDisabled(page, frame);
  await checkPublishMenu(page, frame);
  await checkPublish(page);
  assert.equal(await guideVisible(page), false, 'The guide starts hidden');
  await toggleGuide(page);
  assert.equal(await guideVisible(page), true, 'The guide change reads back');
  await select(frame, 'h1');
  await editText(page, frame, 'h1', 'Edited heading');
  await page.locator('.demo-storage').filter({ hasText: 'stay in this browser' }).waitFor();
  // The rendering after an edit names the edited source, so the canvas takes a second text edit.
  await editText(page, frame, 'p.lede', 'Edited lede');
  await checkStyle(page, frame);
  await checkMove(page, frame);
  await checkInsert(page, frame);
  await checkComponentProps(page, frame);
  await checkComponentInsert(page, frame);
  await checkLoop(page, frame);
  await checkCollections(page, frame);
  await checkDelete(page, frame);
  await page.waitForTimeout(500);
  await reloadDemo(page);
  await frame.locator('h1').filter({ hasText: 'Edited heading' }).waitFor();
  await page.locator('.demo-storage').filter({ hasText: 'stay in this browser' }).waitFor();
  assert.equal(await frame.locator('#second').count(), 0, 'A deleted box stays deleted after a reload');
  assert.equal(await frame.locator('main aside').count(), 1, 'An inserted element survives a reload');
  assert.equal(await frame.locator('h1').evaluate((element) => getComputedStyle(element).opacity), '0.5', 'A style edit survives a reload');
  assert.equal(await guideVisible(page), true, 'The guide change survives a reload');
  await editText(page, frame, 'p.lede', 'Edited after a reload');
  await checkForwardingMove(page, frame);
  await page.locator('.demo-reset').click();
  await frame.locator('h1').filter({ hasText: 'Original heading' }).waitFor();
  await frame.locator('#second').waitFor();
  await page.locator('.demo-bar').waitFor({ state: 'hidden' });
  await reloadDemo(page);
  await frame.locator('h1').filter({ hasText: 'Original heading' }).waitFor();
  assert.equal(await page.locator('.demo-bar').isVisible(), false, 'No storage pill after Reset');
  assert.equal(await guideVisible(page), false, 'Reset clears the guide change');
  await context.close();
  await checkModesAndPreview();
  await checkNeverPauses();
  await checkPageSwitch();
  await checkSound();
  await checkPhone();
  await checkBlockedStorage();
  await checkFullStorage();
  assert.deepEqual(failures, []);
  console.log(
    'Static demo: open, publish, guide, select, text, style, move, insert, delete, reload, reset, disabled actions, phone, blocked storage and full storage passed.',
  );
} finally {
  await browser.close();
  await host.stop();
  await project.stop();
  await rm(out, { recursive: true, force: true });
}
