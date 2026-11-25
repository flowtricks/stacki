import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Page } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio');
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await prompt(page).waitFor();
  await verifyDrafts(page);
  await verifyList(page);
  await verifyMention(page);
  await verifyPanelColor(page);
  await verifyImages(page);
  await page.reload();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await prompt(page).waitFor();
  assert.equal(await promptText(page), 'First draft');
  assert.equal(await page.getByRole('img', { name: 'reference.png', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Remove reference.png', exact: true }).click();
  assert.equal(await page.getByRole('img', { name: 'reference.png', exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await prompt(page).waitFor();
  const composer = await page.locator('.ai-composer').boundingBox();
  assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= 390);
  assert.ok(await page.getByRole('button', { name: 'Voice input', exact: true }).isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await verifySingleTranscript(page);
  assert.deepEqual(errors, []);
  console.log(
    'Chat drafts, switching, image preparation/removal, reload persistence, single transcript across renders, legacy history migration, pin/rename from the chat list, @ file chips, the proposal diff card, the rail-matching panel colour, and mobile composer passed. Live AI and microphone recognition require a configured provider and an interactive microphone.',
  );
} finally {
  await browser.close();
}

// The prompt is a CodeMirror editor (chips need one document), so it is a textbox, not an input with a value.
function prompt(page: Page) {
  return page.getByRole('textbox', { name: 'AI prompt', exact: true });
}
async function promptText(page: Page) {
  // The placeholder is drawn inside the first line; it is not the draft.
  return page.locator('.ai-composer .cm-content').evaluate((content) =>
    [...content.querySelectorAll('.cm-line')]
      .map((line) =>
        [...line.childNodes]
          .filter((node) => !(node instanceof Element && node.classList.contains('cm-placeholder')))
          .map((node) => node.textContent)
          .join(''),
      )
      .join('\n'),
  );
}
async function openChats(page: Page) {
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  await page.locator('.chat-sessions .ai-list-row').first().waitFor();
}
async function verifyDrafts(page: Page) {
  await prompt(page).click();
  await page.keyboard.type('First draft');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.equal(await promptText(page), '');
  await page.keyboard.type('Second draft');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.locator('.ai-composer .cm-line').count(), 2);
  // The newest chat leads the list; the first is the second row.
  await openChats(page);
  assert.equal(await page.locator('.chat-sessions .ai-list-row').count(), 2);
  await page.locator('.chat-sessions .ai-list-open').nth(1).click();
  assert.equal(await promptText(page), 'First draft');
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  assert.equal(await promptText(page), 'First draft');
  if (await page.getByText('No model connected', { exact: true }).count()) {
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await prompt(page).press('Enter');
    assert.equal(await promptText(page), 'First draft');
  }
}
// Pin, rename and reorder from the list; the order and the pin survive a reload.
async function verifyList(page: Page) {
  await openChats(page);
  const rows = page.locator('.chat-sessions .ai-list-row');
  await page
    .getByRole('button', { name: /^Actions for/ })
    .nth(1)
    .click();
  await page.getByRole('menuitem', { name: /^Pin/ }).click();
  await page.locator('.chat-sessions .ai-section-name', { hasText: 'Pinned' }).waitFor();
  assert.equal(await rows.first().locator('.ai-list-open').getAttribute('title'), 'First draft');
  assert.equal(
    await rows
      .first()
      .getAttribute('class')
      .then((value) => value?.includes('is-pinned')),
    true,
  );
  await page
    .getByRole('button', { name: /^Actions for/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  await page.getByLabel('Chat name', { exact: true }).fill('Hero work');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Actions for Hero work', exact: true }).waitFor();
  await page.waitForTimeout(250); // IndexedDB persistence is debounced by 150 ms.
  await page.reload();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await page.getByRole('button', { name: 'Chat history', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Hero work', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.chat-sessions .ai-list-row')
      .first()
      .getAttribute('class')
      .then((value) => value?.includes('is-pinned')),
    true,
  );
  await page.locator('.chat-sessions .ai-list-open').first().click();
  await prompt(page).waitFor();
}
// Typing @ opens the project's files; choosing one makes a chip, and Backspace takes the whole chip away.
async function verifyMention(page: Page) {
  await prompt(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Change @');
  await page.getByRole('listbox', { name: 'Mention a project file' }).waitFor();
  await page.getByRole('option').first().click();
  assert.equal(await page.locator('.ai-composer .chip-editor-chip').count(), 1);
  assert.match(await promptText(page), /^Change /);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('.ai-composer .chip-editor-chip').count(), 0);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('First draft');
}
// The panel is the rail's dark colour, as Desktop's is.
async function verifyPanelColor(page: Page) {
  const colors = await page.evaluate(() => ({
    panel: getComputedStyle(document.querySelector('.chat-panel') as Element).backgroundColor,
    rail: getComputedStyle(document.querySelector('.studio-rail') as Element).backgroundColor,
  }));
  assert.equal(colors.panel, colors.rail);
}
// The transcript and the composer once shared a React key. React then left one orphaned
// transcript in the page per render, so a chat with history filled with stale copies.
// Typing renders the panel once per keystroke, which reproduced the fault without a provider.
async function verifySingleTranscript(page: Page) {
  const keystrokeCount = 6;
  await page.evaluate(async () => {
    const thread = {
      id: 'single-transcript',
      title: 'Saved chat',
      draft: '',
      images: [],
      model: '',
      messages: [
        { id: 'question', role: 'user', content: 'Saved question', images: [] },
        {
          id: 'answer',
          role: 'assistant',
          content: 'Saved answer',
          images: [],
          durationMs: 4200,
          proposal: { id: 'proposal', summary: 'Saved answer', changes: [{ file: 'src/pages/index.astro', before: '<h1>Old</h1>', after: '<h1>New</h1>' }] },
        },
      ],
      status: 'idle',
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('studio-ai-chats', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('Could not open the chat database'));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('chats', 'readwrite');
      transaction.objectStore('chats').put({ threads: [thread], active: thread.id }, 'session');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Could not save the chat'));
    });
    database.close();
  });
  await page.reload();
  await page.getByRole('button', { name: 'AI chat', exact: true }).click();
  await page.getByText('Saved answer', { exact: true }).waitFor();
  await prompt(page).pressSequentially('x'.repeat(keystrokeCount));
  assert.equal(await promptText(page), 'x'.repeat(keystrokeCount));
  assert.equal(await page.locator('.chat-transcript').count(), 1);
  assert.equal(await page.getByText('Saved answer', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Worked for 4.2s', { exact: true }).count(), 1);
  // The proposal is a card of files; a file opens to Desktop's diff view.
  assert.equal(await page.getByText('1 file to change', { exact: true }).count(), 1);
  await page.getByRole('button', { name: /index\.astro/ }).click();
  await page.locator('.ai-diffview').waitFor();
  assert.ok((await page.locator('.ai-diffview .history-diff-line').count()) > 0);
}
async function verifyImages(page: Page) {
  const image = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } });
  await page.getByLabel('Attach image files', { exact: true }).setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('img', { name: 'reference.png', exact: true }).waitFor();
  await page.getByLabel('Attach image files', { exact: true }).setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image'),
  });
  await page.locator('.toast-message').filter({ hasText: 'Choose PNG' }).waitFor();
  await page.getByLabel('Attach image files', { exact: true }).setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('img', { name: 'second.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove second.png', exact: true }).click();
  await page.waitForTimeout(250); // IndexedDB persistence is debounced by 150 ms.
}
