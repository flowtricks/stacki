// Goal: Design mode never writes to the project. In the real app, every design gesture runs on a copy of the
// fixture site (entering from the AI composer's canvas modes menu; click, deep and double-click selection; reorder
// by drag; Cmd-drag free placement; arrow nudges; duplicate, hide, delete; menu Undo and Redo; a style typed in the
// inspector; a resize handle; typing text; a prop switched through a real dev server render; unlink; reset element;
// the text and box tools; a component inserted from the palette; copy and paste across frames; duplicate frame,
// width, rename and reset frame; the Original peek; Send to AI; Copy as image; Export PNG; exit and the draft
// restored on entering again; Start over) and afterwards the project folder (everything but node_modules and
// Astro's own .astro cache, .stacki included) is byte-identical to before. Each gesture is also checked to have
// done what it says on the frame's copy, so the no-write result is not the trivial one of gestures that did nothing.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) runs the real desktop app hidden, with its own user
// data folder, on a copy of the Lumos fixture site whose home page the scenario replaces first. Pointer and key
// input are real input events at window coordinates (soakDriver.js); menu commands go through the application
// menu. No step sleeps: each waits on the state it expects (test/helpers/waitFor.js). The clipboard is saved before
// "Copy as image" and restored after; the exported PNG is saved inside the run's own folder. Screenshots go to
// STACKI_SCREENSHOT_DIR (default node_modules/.stacki-test/design-mode). The suite skips where the fixture's Astro
// install or the built main process is missing. Run it by hand with `node test/renderer/app/designMode/designModeSoak.test.js`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PAGE = `---
import Layout from "@/layouts/BaseLayout.astro";
import Section from "@/components/wrapper/Section.astro";
import ContentWrapper from "@/components/wrapper/ContentWrapper.astro";
import Grid from "@/components/wrapper/Grid.astro";
import ButtonWrapper from "@/components/wrapper/ButtonWrapper.astro";
import Heading from "@/components/typography/Heading.astro";
import Eyebrow from "@/components/typography/Eyebrow.astro";
import Paragraph from "@/components/typography/Paragraph.astro";
import Button from "@/components/Button.astro";
import Card from "@/components/item/Card.astro";
---
<Layout theme="dark">
  <Section>
    <ContentWrapper>
      <Eyebrow>Design mode</Eyebrow>
      <Heading tag="h1">Try layouts without saving</Heading>
      <Paragraph>Drag, restyle and switch props on a copy of the page, then hand it to the AI.</Paragraph>
      <ButtonWrapper>
        <Button>Get started</Button>
        <Button emphasis="secondary">Learn more</Button>
      </ButtonWrapper>
    </ContentWrapper>
  </Section>
  <Section>
    <Grid>
      <Card heading="Fast" text="Frames render the real page with its own CSS and fonts." buttonLabel="Read more" buttonHref="/" />
      <Card heading="Free" text="Drag anything anywhere, in the flow or placed freely." buttonLabel="Read more" buttonHref="/" />
      <Card heading="Safe" text="Nothing in Design mode is ever saved to the project." buttonLabel="Read more" buttonHref="/" />
    </Grid>
  </Section>
</Layout>
`;
const WAIT_MS_MAX = 30_000;
const POLL_MS = 100;
const TREE_FILES_MAX = 50_000;

// --- Node side: start the app and read its verdict -----------------------------------------

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../../helpers/e2e/soakLaunch.js');
  const unavailable = soakUnavailableReason();
  if (unavailable !== undefined) {
    console.log(`# skip designModeSoak: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/design-mode');
  fs.mkdirSync(outDirectory, { recursive: true });
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory }, keepDirectory: false });
  if (leftovers.length > 0) {
    console.error(`not ok - processes outlived the run: ${leftovers.join(', ')}`);
    process.exitCode = 1;
  }
  if (fs.existsSync(directory)) {
    console.error(`not ok - the run directory ${directory} was not removed`);
    process.exitCode = 1;
  }
  const reportFile = path.join(outDirectory, 'report.json');
  if (code !== 0 || !fs.existsSync(reportFile)) {
    console.error(`not ok - the run did not finish (exit ${code})`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  for (const failure of report.failures) {
    console.error(`not ok - ${failure}`);
    process.exitCode = 1;
  }
  if (report.checked < 20) {
    console.error(`not ok - only ${report.checked} checks ran`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(`ok - ${report.checked} checks: every Design mode gesture left the project byte-identical`);
  }
}

// --- Electron side: act, and compare the project's bytes -----------------------------------

/** Every file of the project but node_modules and Astro's own .astro cache, as one digest. */
function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  const pending = [root];
  let files = 0;
  while (pending.length > 0 && files < TREE_FILES_MAX) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules' || entry.name === '.astro') {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        hash.update(path.relative(root, full));
        hash.update(fs.readFileSync(full));
        files += 1;
      }
    }
  }
  return `${files} files ${hash.digest('hex')}`;
}

/** The expression for a window point inside frame `index`'s document, found by `finder(doc)`. */
const framePoint = (index, finder) => `(() => {
  const frame = [...document.querySelectorAll('.dm-frame-iframe:not(.dm-frame-peek)')][${index}];
  const element = frame && (${finder})(frame.contentDocument);
  if (!element) return undefined;
  const outer = frame.getBoundingClientRect();
  const scale = outer.width / frame.offsetWidth;
  const rect = element.getBoundingClientRect();
  return { x: Math.round(outer.left + (rect.left + rect.width / 2) * scale), y: Math.round(outer.top + (rect.top + Math.min(rect.height / 2, 12)) * scale) };
})()`;
const byText = (text, tag = '*') =>
  `(doc) => [...doc.querySelectorAll(${JSON.stringify(tag)})].find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)})`;
const frameDocument = (index) => `[...document.querySelectorAll('.dm-frame-iframe:not(.dm-frame-peek)')][${index}].contentDocument`;
const centre = (selector) =>
  `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return undefined; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;

async function runInElectron({ window, project, options }) {
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor } = require('../../../helpers/waitFor.js');
  const { clipboard, nativeImage, ClipboardItem } = require('electron');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [] };
  const check = (what, condition, detail) => {
    report.checked += 1;
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${String(detail)})`}`);
    }
  };
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`));
  const until = (what, expression, test = Boolean) =>
    waitFor({
      what,
      read: () => driver.evaluate(expression).catch(() => undefined),
      until: test,
      pollIntervalMs: POLL_MS,
      pollCountMax: WAIT_MS_MAX / POLL_MS,
    });
  const point = async (what, expression) => until(what, expression, (value) => value !== undefined && value !== null);
  const count = (expression) => driver.evaluate(expression);
  const run = async (what, act) => {
    try {
      await act();
    } catch (error) {
      report.failures.push(`${what}: ${String(error && error.message ? error.message : error)}`);
      await shot('failed-' + what.replace(/\W+/g, '-')).catch(() => undefined);
    }
    // Each step starts from a known state: no text being typed and the move tool; it selects what it acts on itself.
    await driver.evaluate(
      `document.activeElement?.blur?.(); [...document.querySelectorAll('.dm-tool')].find((b) => b.getAttribute('aria-label') === 'Move')?.click(); 0`,
    );
  };
  /** Cmd-clicks the deepest element at `at`, then climbs with Escape until the inspector names `tag`. */
  const selectAt = async (at, tag) => {
    await driver.pointerPress(at, { modifiers: ['meta'] });
    for (let climb = 0; climb < 4; climb += 1) {
      if ((await count(`document.querySelector('.dm-selection-count')?.textContent`)) === tag) {
        return;
      }
      await driver.key('Escape');
      await driver.settle();
    }
    throw new Error(`could not select a ${tag}`);
  };

  // The fixture's home page, replaced before anything is copied.
  fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), PAGE);
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  await waitFor({
    what: 'the canvas shows the new page',
    read: () => driver.canvasEvaluate(`document.body.innerText.includes('Nothing in Design mode is ever saved')`).catch(() => false),
    until: Boolean,
    pollIntervalMs: POLL_MS,
    pollCountMax: WAIT_MS_MAX / POLL_MS,
  });
  await driver.settle();
  const before = treeDigest(project);
  // The person's clipboard, whatever it holds, put back at the end (Electron's clipboard is the asynchronous one).
  const savedClipboard = await Promise.all(
    (await clipboard.read()).map(async (item) => Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])))),
  );
  const exportDirectory = path.join(path.dirname(project), 'exports');
  fs.mkdirSync(exportDirectory, { recursive: true });
  window.webContents.session.on('will-download', (_event, item) => item.setSavePath(path.join(exportDirectory, item.getFilename())));
  // Design mode's own console warnings ride along in the report, so a failure names its cause.
  report.console = [];
  window.webContents.on('console-message', (event) => {
    if (/design mode/i.test(event.message ?? '') && report.console.length < 20) {
      report.console.push(event.message);
    }
  });

  try {
    await run('enter from the canvas modes menu', async () => {
      const ai = await driver.evaluate(
        `[...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || '')) ? true : false`,
      );
      check('the rail has the AI chat button', ai);
      await driver.evaluate(
        `document.querySelector('.ai-status-line') || [...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || '')).click()`,
      );
      await until('the composer status line', `!!document.querySelector('.ai-status-line')`);
      await driver.evaluate(`[...document.querySelectorAll('.ai-chip')].find((c) => /canvas/i.test(c.textContent || '')).click()`);
      await until(
        'the canvas modes menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((r) => /design mode/i.test(r.textContent || ''))`,
      );
      await shot('01-modes-menu');
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((r) => /design mode/i.test(r.textContent || '')).click()`,
      );
      await until('the first frame loaded', `${frameDocument(0)}?.querySelectorAll('[data-dm-id]').length > 20`);
      check('the page copy carries component instances', (await count(`${frameDocument(0)}.querySelectorAll('[data-dm-instance]').length`)) > 5);
      check('no script runs in a frame copy', (await count(`${frameDocument(0)}.querySelectorAll('script').length`)) === 0);
      await driver.settle();
      await shot('02-entered');
    });

    await run('select', async () => {
      const heading = await point('the heading', framePoint(0, byText('Try layouts without saving', 'h1')));
      await driver.pointerPress(heading);
      await until('a level selection', `document.querySelectorAll('.dm-mark-selection').length === 1`);
      await driver.pointerPress(heading, { modifiers: ['meta'] });
      await until('the deepest element selected', `document.querySelector('.dm-selection-count')?.textContent === 'h1'`);
      check('Cmd-click selects the heading', (await count(`document.querySelector('.dm-selection-count')?.textContent`)) === 'h1');
    });

    await run('reorder by dragging', async () => {
      const eyebrow = await point('the eyebrow', framePoint(0, byText('Design mode', 'div')));
      // Dropped at the top of the paragraph: before it, so after the heading.
      const paragraph = await point(
        'the paragraph',
        framePoint(0, `(doc) => [...doc.querySelectorAll('p')].find((e) => e.textContent.includes('Drag, restyle'))`),
      );
      await selectAt(eyebrow, 'div');
      await driver.drag(eyebrow, { x: paragraph.x, y: paragraph.y - 4 }, { steps: 10 });
      const order = `(() => { const d = ${frameDocument(0)}; const all = [...d.querySelectorAll('*')]; const e = all.findIndex((x) => x.childElementCount === 0 && x.textContent.trim() === 'Design mode'); const h = all.findIndex((x) => x.tagName === 'H1'); return e > h; })()`;
      await until('the eyebrow after the heading', order);
      check('the eyebrow moved after the heading', await count(order));
      await shot('03-reordered');
    });

    await run('free placement with Cmd held, snapping, nudge', async () => {
      const paragraph = await point(
        'the paragraph',
        framePoint(0, `(doc) => [...doc.querySelectorAll('p')].find((e) => e.textContent.includes('Drag, restyle'))`),
      );
      await driver.pointerPress(paragraph, { modifiers: ['meta'] });
      await driver.drag(paragraph, { x: paragraph.x + 70, y: paragraph.y + 50 }, { steps: 12, modifiers: ['meta'] });
      const style = `[...${frameDocument(0)}.querySelectorAll('p')].find((e) => e.textContent.includes('Drag, restyle'))?.getAttribute('style') || ''`;
      await until('the paragraph placed freely', `(${style}).includes('position: absolute')`);
      const left = (await count(style)).match(/left: (\d+)px/)?.[1];
      await driver.key('Right', { modifiers: ['shift'] });
      await until('the nudge applied', `(${style}).includes('left: ${Number(left) + 10}px')`);
      check('Shift-arrow nudges ten pixels', (await count(style)).includes(`left: ${Number(left) + 10}px`));
      await shot('04-free');
    });

    await run('duplicate, hide, delete, undo, redo', async () => {
      const copies = `[...${frameDocument(0)}.querySelectorAll('p')].filter((e) => e.textContent.includes('Drag, restyle')).length`;
      await selectAt(
        await point('the free paragraph', framePoint(0, `(doc) => [...doc.querySelectorAll('p')].find((e) => e.textContent.includes('Drag, restyle'))`)),
        'p',
      );
      await driver.key('D', { modifiers: ['meta'] });
      await until('a duplicate', `${copies} === 2`);
      await driver.key('H', { modifiers: ['meta', 'shift'] });
      await until('the copy hidden', `[...${frameDocument(0)}.querySelectorAll('p')].some((e) => e.style.display === 'none')`);
      await driver.key('Backspace');
      await until('the copy deleted', `${copies} === 1`);
      await driver.menu('CmdOrCtrl+Z', 'undo');
      await until('undo brings it back', `${copies} === 2`);
      await driver.menu('Shift+CmdOrCtrl+Z', 'redo');
      await until('redo deletes it again', `${copies} === 1`);
      check('undo and redo walk the history', (await count(copies)) === 1);
    });

    await run('a style typed in the inspector', async () => {
      const heading = await point('the heading', framePoint(0, byText('Try layouts without saving', 'h1')));
      await driver.pointerPress(heading, { modifiers: ['meta'] });
      await until('the text section', `[...document.querySelectorAll('.dm-field-label')].some((l) => l.textContent === 'Size')`);
      await driver.evaluate(
        `[...document.querySelectorAll('.dm-field')].find((f) => f.querySelector('.dm-field-label')?.textContent === 'Size').querySelector('input').focus()`,
      );
      await driver.key('A', { modifiers: ['meta'] });
      await driver.typeText('80px');
      await driver.key('Enter');
      await until('the heading is 80px', `${frameDocument(0)}.querySelector('h1').style.fontSize === '80px'`);
      check('the inspector writes an inline style', (await count(`${frameDocument(0)}.querySelector('h1').style.fontSize`)) === '80px');
      await shot('05-styled');
    });

    await run('resize by a handle', async () => {
      await selectAt(await point('the heading', framePoint(0, byText('Try layouts without saving', 'h1'))), 'h1');
      const handle = await point('the east handle', centre('.dm-handle-e'));
      await driver.drag(handle, { x: handle.x - 60, y: handle.y }, { steps: 8 });
      await until('a width set', `${frameDocument(0)}.querySelector('h1').style.width !== ''`);
      check('the handle sets a width', (await count(`${frameDocument(0)}.querySelector('h1').style.width`)) !== '');
    });

    await run('type text', async () => {
      const heading = await point('the heading', framePoint(0, byText('Try layouts without saving', 'h1')));
      await selectAt(heading, 'h1');
      await driver.pointerPress(heading, { clickCount: 2 });
      await until(
        'editing, its words selected',
        `!!${frameDocument(0)}.querySelector('[contenteditable]') && ${frameDocument(0)}.getSelection().toString().length > 0`,
      );
      await driver.typeText('Design freely');
      await driver.key('Escape');
      await until('the new words', `${frameDocument(0)}.querySelector('h1').textContent.trim() === 'Design freely'`);
      check('typing replaces the heading words', (await count(`${frameDocument(0)}.querySelector('h1').textContent.trim()`)) === 'Design freely');
    });

    await run('switch a prop through a real render, then unlink', async () => {
      const button = await point(
        'the button',
        framePoint(0, `(doc) => [...doc.querySelectorAll('[data-dm-instance]')].find((e) => e.textContent.trim() === 'Get started')`),
      );
      await driver.pointerPress(button, { modifiers: ['meta'] });
      for (let climb = 0; climb < 4; climb += 1) {
        if ((await count(`document.querySelector('.dm-component-name')?.textContent || ''`)).startsWith('Button')) {
          break;
        }
        await driver.key('Escape');
        await driver.settle();
      }
      await driver.evaluate(
        `[...[...document.querySelectorAll('.dm-props .dm-row')].find((r) => r.querySelector('.dm-row-label')?.textContent === 'emphasis').querySelectorAll('button')].find((b) => b.textContent.trim() === 'secondary').click()`,
      );
      const switched = `[...${frameDocument(0)}.querySelectorAll('[data-dm-props]')].some((e) => e.className.includes('secondary') && e.textContent.trim() === 'Get started')`;
      await until('the button rendered secondary, its words kept', switched);
      check('a prop switch renders through the dev server and keeps the slot', await count(switched));
      await shot('06-props');
      await driver.evaluate(`document.querySelector('.dm-component .dm-icon-button').click()`);
      await until('unlinked', `${frameDocument(0)}.querySelectorAll('[data-dm-unlinked]').length === 1`);
      check('unlink detaches one instance only', (await count(`${frameDocument(0)}.querySelectorAll('[data-dm-unlinked]').length`)) === 1);
    });

    await run('reset an element', async () => {
      const card = await point('a card heading', framePoint(0, byText('Fast')));
      const hidden = `${frameDocument(0)}.querySelectorAll('[style*="display: none"]').length`;
      const hiddenBefore = await count(hidden);
      await driver.pointerPress(card, { modifiers: ['meta'] });
      await driver.evaluate(`document.querySelector('[aria-label="Hide"]').click()`);
      await until('hidden', `${hidden} === ${hiddenBefore + 1}`);
      await driver.evaluate(`document.querySelector('[aria-label="Reset element"]').click()`);
      await until('reset', `${hidden} === ${hiddenBefore}`);
      check('reset puts the element back', (await count(hidden)) === hiddenBefore);
    });

    await run('text and box tools', async () => {
      await driver.key('T');
      // Both on the first card, which is on screen at this zoom.
      const target = await point(
        'the first card text',
        framePoint(0, `(doc) => [...doc.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.trim().startsWith('Frames render'))`),
      );
      await driver.pointerPress(target);
      await until('new text being edited', `!!${frameDocument(0)}.querySelector('[data-dm-origin="text"][contenteditable]')`);
      await driver.key('Escape');
      await driver.key('R');
      const box = await point('the first card heading', framePoint(0, byText('Fast')));
      await driver.drag(box, { x: box.x + 40, y: box.y + 30 }, { steps: 6 });
      await until('a box drawn', `!!${frameDocument(0)}.querySelector('[data-dm-origin="box"]')`);
      check('the tools made text and a box', (await count(`${frameDocument(0)}.querySelectorAll('[data-dm-origin]').length`)) >= 2);
      await shot('07-tools');
    });

    await run('duplicate the frame, set its width, rename it, paste across frames, insert a component', async () => {
      const button = await point('the first card heading', framePoint(0, byText('Fast', 'h3')));
      await driver.pointerPress(button, { modifiers: ['meta'] });
      await driver.menu('CmdOrCtrl+C', 'copy');
      await driver.evaluate(`document.querySelector('.dm-frame-header .dm-frame-icon[aria-label="Frame actions"]').click()`);
      await until(
        'the frame menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((e) => e.textContent.startsWith('Duplicate frame'))`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((e) => e.textContent.startsWith('Duplicate frame')).click()`,
      );
      await until('a second frame', `document.querySelectorAll('.dm-frame').length === 2 && ${frameDocument(1)}?.querySelectorAll('[data-dm-id]').length > 20`);
      // Both frames in view (the tool bar's Zoom to fit), so the second frame's elements are on screen to press.
      await driver.evaluate(`document.querySelector('.dm-tool[aria-label="Zoom to fit"]').click()`);
      await until(
        'both frames in view',
        `[...document.querySelectorAll('.dm-frame-iframe:not(.dm-frame-peek)')].every((f) => f.getBoundingClientRect().right <= innerWidth)`,
      );
      await driver.evaluate(`document.querySelectorAll('.dm-frame-chip')[1].click()`);
      await until('the width menu', `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).length > 1`);
      await driver.evaluate(`[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).at(-1).click()`);
      await until('a narrower frame', `Number(document.querySelectorAll('.dm-frame-chip')[1].textContent) < 600`);
      await driver.evaluate(`document.querySelectorAll('.dm-frame-header .dm-frame-icon[aria-label="Frame actions"]')[1].click()`);
      await until(
        'the frame menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((e) => e.textContent === 'Rename')`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((e) => e.textContent === 'Rename').click()`,
      );
      await until('renaming', `!!document.querySelector('.dm-frame-rename')`);
      await until(
        'the name field focused and selected',
        `document.activeElement?.classList.contains("dm-frame-rename") && document.activeElement.selectionEnd > 0`,
      );
      await driver.typeText('Phone idea');
      await driver.key('Enter');
      await until('renamed', `[...document.querySelectorAll('.dm-frame-name')].some((e) => e.textContent === 'Phone idea')`);
      const copies = `${frameDocument(1)}.querySelectorAll('[data-dm-copy-of]').length`;
      const copiesBefore = await count(copies);
      const heading = await point('the copy heading', framePoint(1, `(doc) => doc.querySelector('h1')`));
      await driver.pointerPress(heading, { modifiers: ['meta'] });
      await until('the second frame selected', `document.querySelector('.dm-selection-count')?.textContent === 'h1'`);
      await driver.menu('CmdOrCtrl+V', 'paste');
      await until('pasted into the second frame', `${copies} > ${copiesBefore}`);
      await driver.evaluate(`[...document.querySelectorAll('.dm-tool')].find((b) => b.getAttribute('aria-label') === 'Component').click()`);
      await until(
        'the component list',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((e) => e.textContent.startsWith('Card'))`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((e) => e.textContent.startsWith('Card')).click()`,
      );
      await until('a component inserted', `${frameDocument(1)}.querySelectorAll('[data-dm-origin="component"]').length > 0`);
      check('the second frame holds the paste and the component', true);
      await driver.key('1', { modifiers: ['shift'] });
      await driver.settle();
      await shot('08-two-frames');
    });

    await run('peek the original, reset a frame and undo it', async () => {
      const original = await point('the Original button', centre('.dm-frame-icon[aria-label="Original"]'));
      driver.contents.sendInputEvent({ type: 'mouseMove', x: original.x, y: original.y });
      driver.contents.sendInputEvent({ type: 'mouseDown', x: original.x, y: original.y, button: 'left', clickCount: 1 });
      await until('the original shown', `!!document.querySelector('.dm-frame-peek')?.contentDocument?.querySelector('h1')`);
      await shot('09-peek');
      driver.contents.sendInputEvent({ type: 'mouseUp', x: original.x, y: original.y, button: 'left', clickCount: 1 });
      await until('the peek gone', `!document.querySelector('.dm-frame-peek')`);
      await driver.evaluate(`document.querySelectorAll('.dm-frame-header .dm-frame-icon[aria-label="Frame actions"]')[1].click()`);
      await until(
        'the frame menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((e) => e.textContent.includes('Reset frame'))`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((e) => e.textContent.includes('Reset frame')).click()`,
      );
      await until('the frame reset', `${frameDocument(1)}.querySelectorAll('[data-dm-origin]').length === 0`);
      await driver.menu('CmdOrCtrl+Z', 'undo');
      await until('the reset undone', `${frameDocument(1)}.querySelectorAll('[data-dm-origin]').length > 0`);
      check('reset frame is one undo step', true);
    });

    await run('copy as image and export PNG', async () => {
      await driver.evaluate(`document.querySelectorAll('.dm-frame-header .dm-frame-icon[aria-label="Frame actions"]')[0].click()`);
      await until(
        'the frame menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((e) => e.textContent.includes('Copy as image'))`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((e) => e.textContent.includes('Copy as image')).click()`,
      );
      const toast = await until('a toast about the copy', `[...document.querySelectorAll('.toast-stack')].map((e) => e.textContent).join(' ')`, (text) =>
        /copied as an image|could not be copied/.test(text ?? ''),
      );
      check('copy as image reports success', /copied as an image/.test(toast), toast);
      await waitFor({
        what: 'an image on the clipboard',
        read: () => clipboard.has('image/png'),
        until: Boolean,
        pollIntervalMs: POLL_MS,
        pollCountMax: WAIT_MS_MAX / POLL_MS,
      });
      const items = await clipboard.read();
      const png = items.find((item) => item.types.includes('image/png'));
      const bytes = png === undefined ? undefined : Buffer.from(await (await png.getType('image/png')).arrayBuffer());
      const size = bytes === undefined ? { width: 0, height: 0 } : nativeImage.createFromBuffer(bytes).getSize();
      check('the copied image is the frame, full height', size.width > 300 && size.height > size.width, JSON.stringify(size));
      await driver.evaluate(`document.querySelectorAll('.dm-frame-header .dm-frame-icon[aria-label="Frame actions"]')[0].click()`);
      await until(
        'the frame menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((e) => e.textContent.includes('Export PNG'))`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((e) => e.textContent.includes('Export PNG')).click()`,
      );
      await waitFor({
        what: 'the exported PNG',
        read: () => fs.readdirSync(exportDirectory).some((name) => name.endsWith('.png')),
        until: Boolean,
        pollIntervalMs: POLL_MS,
        pollCountMax: WAIT_MS_MAX / POLL_MS,
      });
      check('the export is saved outside the project', true);
    });

    await run('send to AI', async () => {
      await driver.evaluate(`document.querySelector('.dm-send').click()`);
      await until(
        'pictures in the composer',
        `document.querySelectorAll('.ai-attachment, [class*="attachment"]').length > 0 && !document.querySelector('.dm-busy')`,
      );
      check(
        'the request is prefilled',
        (await count(`document.querySelector('.ai-composer')?.textContent || ''`)).includes('Rebuild the page to look like this.'),
      );
      await shot('10-sent');
    });

    await run('exit, come back to the draft, start over', async () => {
      await driver.evaluate(`document.querySelector('.dm-exit').click()`);
      await until('the editor back', `!document.querySelector('.dm-root')`);
      await driver.evaluate(`[...document.querySelectorAll('.ai-chip')].find((c) => /design|canvas/i.test(c.textContent || '')).click()`);
      await until(
        'the menu',
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).some((r) => /design mode/i.test(r.textContent || ''))`,
      );
      await driver.evaluate(
        `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0).findLast((r) => /design mode/i.test(r.textContent || '')).click()`,
      );
      await until(
        'the draft restored',
        `[...document.querySelectorAll('.dm-frame-name')].some((e) => e.textContent === 'Phone idea') && ${frameDocument(0)}?.querySelector('h1')?.textContent.trim() === 'Design freely'`,
      );
      check('leaving and coming back keeps the frames', true);
      await driver.evaluate(`document.querySelector('[aria-label="Start over"]').click()`);
      await until(
        'a fresh copy',
        `document.querySelectorAll('.dm-frame').length === 1 && ${frameDocument(0)}?.querySelector('h1')?.textContent.trim() === 'Try layouts without saving'`,
      );
      await driver.evaluate(`document.querySelector('.dm-exit').click()`);
      await until('out of Design mode', `!document.querySelector('.dm-root')`);
    });
  } finally {
    await clipboard.write(savedClipboard.map((record) => new ClipboardItem(record)));
  }

  const after = treeDigest(project);
  check('the project folder is byte-identical after every gesture', after === before, `${before} → ${after}`);
  fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, null, 2));
  return 0;
}

module.exports = { runInElectron };

if (process.versions.electron === undefined) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
