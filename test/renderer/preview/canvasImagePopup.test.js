// Goal: double-clicking an image on the canvas opens a small popup where its picture and its alt text change,
// even when the image sits inside a component that is not open. The edit lands on the prop of the one Card the
// person double-clicked, in the page file, byte for byte nowhere else; one Undo writes the old bytes back; and
// selecting anything else closes the popup. An image whose picture comes from code (an expression) is refused
// in the popup, and nothing is written. A picture a closed component computes or writes itself opens nothing.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) starts the real desktop app on a copy of the Lumos
// fixture site (never a person's project). The scenario replaces the copy's home page with a page of Lumos Cards:
// a stacked Card whose image and alt text are string props (Card hands them to Img, which prints the element),
// a Card whose image is an expression, and a plain <img>. It acts through webContents.sendInputEvent at real
// window coordinates (soakDriver.js): two presses make the double click, typing goes through real key events.
// After each action it reads the page file's bytes and compares them with the bytes it expects, which are the
// old bytes with exactly one literal replaced. Screenshots go to the output directory. No step sleeps: each waits
// on the state it expects (the popup open or closed, the file's bytes, a position at rest) through test/helpers/waitFor.js,
// so a slow runner gets the time it needs and a fast one moves on at once.
// The suite skips (and says why) where the fixture's Astro install or the built main process is missing. It needs
// a display (CI on Linux runs it under xvfb).
// Run it by hand with `node test/renderer/preview/canvasImagePopup.test.js`.

const fs = require('node:fs');
const path = require('node:path');

const PAGE = `---
import Layout from "@/layouts/BaseLayout.astro";
import Section from "@/components/wrapper/Section.astro";
import Card from "@/components/item/Card.astro";
import ClosedPicture from "@/components/ClosedPicture.astro";
const gallery = [{ photo: "/popup-one.svg" }];
---
<Layout theme="dark">
  <Section>
    <Card id="card-one" variant="stacked" heading="First card" image="/popup-one.svg" imageAlt="First picture" />
    <Card id="card-bound" variant="stacked" heading="Bound card" image={gallery[0].photo} imageAlt="Bound picture" />
    <Card id="card-cover" variant="cover" heading="Cover card" buttonHref="/about" buttonLabel="Button Text" image="/popup-one.svg" imageAlt="Cover picture" />
    <Card id="card-link" variant="stacked" heading="Linked card" buttonHref="/about" buttonLabel="Button Text" image="/popup-one.svg" imageAlt="Linked picture" />
    <img id="native" src="/popup-one.svg" alt="Native picture" width="160" height="100" />
    <ClosedPicture />
  </Section>
</Layout>
`;
// A closed component that draws its pictures itself: one computed in its frontmatter, one written in its template. No prop of
// the instance decides either, so a double click on them opens nothing (closedComponentReach.ts).
const CLOSED_PICTURE = `---
const parts = ["/popup", "one.svg"];
const picture = parts.join("-");
---
<div class="closed-picture">
  <img id="closed-computed" src={picture} alt="Computed picture" width="160" height="100" />
  <img id="closed-fixed" src="/popup-one.svg" alt="Fixed picture" width="160" height="100" />
</div>
`;
const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${fill}"/></svg>\n`;
const WAIT_MS_MAX = 20000;
// A reopen double click is tried this many times, each given this long to open the popup (see `reopen`).
const REOPEN_ATTEMPTS_MAX = 4;
const REOPEN_WAIT_MS = 4000;

// --- Node side: start the app and read its verdict -----------------------------------------

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../helpers/e2e/soakLaunch.js');
  const unavailable = soakUnavailableReason();
  if (unavailable !== undefined) {
    console.log(`# skip canvasImagePopup: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/canvas-image-popup');
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
  for (const note of report.notes) {
    console.log(`# ${note}`);
  }
  for (const failure of report.failures) {
    console.error(`not ok - ${failure}`);
    process.exitCode = 1;
  }
  if (report.checked === 0) {
    console.error('not ok - nothing was checked');
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(`ok - ${report.checked} checks: the image popup edits, undoes, refuses and closes`);
  }
}

// --- Electron side: act, and check the bytes -------------------------------------------------

async function runInElectron({ window, project, options }) {
  const { createDriver } = require('../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../helpers/e2e/panelRecorder.js');
  const { pollUntil, waitForSteady } = require('../../helpers/waitFor.js');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [], notes: [] };
  const check = (what, condition, detail) => {
    report.checked += 1;
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${detail})`}`);
    }
  };
  const pagePath = path.join(project, 'src', 'pages', 'index.astro');
  const read = () => fs.readFileSync(pagePath, 'utf8');
  fs.mkdirSync(path.join(project, 'public'), { recursive: true });
  fs.writeFileSync(path.join(project, 'public', 'popup-one.svg'), svg('#c1352b'));
  fs.writeFileSync(path.join(project, 'public', 'popup-two.svg'), svg('#2b6ac1'));
  fs.writeFileSync(path.join(project, 'src', 'components', 'ClosedPicture.astro'), CLOSED_PICTURE);
  fs.writeFileSync(pagePath, PAGE);
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  // The Desktop canvas draws the page at the pane's own width, which at the harness window is a Laptop layout. The scenario reads the
  // wide Card layout (a bare picture area beside the words over a cover picture), so it types a 1440px canvas width into the toolbar.
  await driver.evaluate(`document.querySelector('.preview-width-field input').focus()`);
  await driver.typeText('1440');
  await driver.key('Enter');
  await driver.settle();
  const CARD_IMAGE_DECODED = `(() => { const image = document.querySelector('#card-one .card_visual img'); return !!image && image.complete && image.naturalWidth > 0; })()`;
  await pollUntil({
    what: 'the Card image decoded on the canvas',
    read: () => driver.canvasEvaluate(CARD_IMAGE_DECODED),
    until: (decoded) => decoded === true,
    pollIntervalMs: 100,
    pollCountMax: WAIT_MS_MAX / 100,
  });
  await driver.settle();
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`));
  // Polls `probe` until it is truthy, for WAIT_MS_MAX at most; the last value read comes back either way.
  const becomes = async (what, probe) => {
    const outcome = await pollUntil({ what, read: probe, until: (value) => Boolean(value), pollIntervalMs: 100, pollCountMax: WAIT_MS_MAX / 100 });
    return outcome;
  };
  const until = async (what, probe) => {
    const outcome = await becomes(what, probe);
    if (outcome.kind === 'reached') {
      return outcome.value;
    }
    report.failures.push(`never happened: ${what}`);
    return undefined;
  };
  const popupText = () => driver.evaluate(`(document.querySelector('.canvas-image-popup') || {}).innerText || ''`);
  const popupOpen = async () => (await driver.evaluate(`!!document.querySelector('.canvas-image-popup')`)) === true;
  // The second press carries clickCount 2, so no pause between the presses is needed to make the double click.
  const doubleClick = async (selector, label) => {
    const point = await driver.canvasPoint(selector);
    await driver.pointerPress(point, { label: `${label} (click)` });
    await driver.pointerPress(point, { label: `${label} (second click)`, clickCount: 2 });
  };
  // After an edit or an undo the canvas may swap its frame at any moment, and a double click that lands on the frame being replaced
  // opens nothing. Waiting for the image to be decoded cannot tell the old frame from the new one, so the double click itself is
  // retried: each attempt waits for the image, presses, and gives the popup REOPEN_WAIT_MS to appear, at most REOPEN_ATTEMPTS_MAX times.
  const reopen = async (selector, label) => {
    for (let attempt = 1; attempt <= REOPEN_ATTEMPTS_MAX; attempt += 1) {
      await becomes(`${label}: the image drawn (attempt ${attempt})`, () => driver.canvasEvaluate(CARD_IMAGE_DECODED));
      await driver.settle();
      await doubleClick(selector, `${label} (attempt ${attempt})`);
      const opened = await pollUntil({
        what: `${label}: the popup (attempt ${attempt})`,
        read: popupOpen,
        until: (value) => value === true,
        pollIntervalMs: 100,
        pollCountMax: REOPEN_WAIT_MS / 100,
      });
      if (opened.kind === 'reached') {
        return true;
      }
    }
    report.failures.push(`never happened: ${label}`);
    return false;
  };
  const popupClosed = async () => (await popupOpen()) === false;
  // Escape, then the popup is gone: the next step starts from a closed popup.
  const escapeAndClose = async (what) => {
    await driver.key('Escape');
    return (await becomes(what, popupClosed)).kind === 'reached';
  };
  const click = async (finder, label) => {
    const point = await driver.panelPoint(finder, { scroll: false });
    if (point === undefined) {
      report.failures.push(`no control: ${label}`);
      return false;
    }
    await driver.pointerPress(point, { label });
    return true;
  };
  const original = read();
  try {
    // 1. A Card's image, inside a component that is not open.
    await doubleClick('#card-one .card_visual img', 'double click the Card image');
    check('the popup opens', (await until('the popup opens', popupOpen)) === true);
    await driver.settle();
    const opened = await popupText();
    report.notes.push(`popup text: ${JSON.stringify(opened)}`);
    check('the popup is titled by the component', /Card/.test(opened), opened);
    await shot('1-popup-open');
    check('opening it writes nothing', read() === original);
    const fields = await driver.evaluate(
      `[...document.querySelectorAll('.canvas-image-popup .props-field')].map((f) => (f.querySelector('label, .props-label') || f).innerText.trim().split('\\n')[0])`,
    );
    report.notes.push(`fields: ${JSON.stringify(fields)}`);
    check('the picture and its alt text are the fields', fields.length === 2, JSON.stringify(fields));
    // 1b. The header is a handle: the popup follows the pointer, stays inside the window, and the page beneath sees none of it.
    const rect = () =>
      driver.evaluate(
        `(() => { const r = document.querySelector('.canvas-image-popup').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; })()`,
      );
    const header = await driver.panelPoint(`document.querySelector('.canvas-image-head strong') || undefined`, { scroll: false });
    const home = await rect();
    if (header === undefined) {
      report.failures.push('no popup header to drag');
    } else {
      await driver.drag(header, { x: header.x + 60, y: header.y - 40 }, { label: 'drag the popup header' });
      const dragged =
        (
          await becomes('the dragged popup at its new place', async () => {
            const at = await rect();
            return Math.abs(at.left - (home.left + 60)) <= 2 && Math.abs(at.top - (home.top - 40)) <= 2 ? at : undefined;
          })
        ).value ?? (await rect());
      check(
        'dragging the header moves the popup with the pointer',
        Math.abs(dragged.left - (home.left + 60)) <= 2 && Math.abs(dragged.top - (home.top - 40)) <= 2,
        JSON.stringify([home, dragged]),
      );
      check('a drag does not close the popup or select anything', await popupOpen());
      const grabbed = { x: header.x + 60, y: header.y - 40 };
      await driver.drag(grabbed, { x: -2000, y: -2000 }, { label: 'drag the popup far outside the window', steps: 12 });
      // At rest: the clamp has been applied and the position no longer changes.
      const clamped = await waitForSteady({ what: 'the clamped popup at rest', read: rect, until: () => true });
      check(
        'the popup cannot leave the window: its header stays partly in view',
        clamped.top >= 0 && clamped.left + clamped.width >= 60,
        JSON.stringify(clamped),
      );
      check('the popup is still open after being dragged to an edge', await popupOpen());
      await shot('1b-dragged');
      // Only the header's right end is left in view: that is where it is grabbed again.
      const handle = { x: Math.round(clamped.left + clamped.width - 50), y: Math.round(clamped.top + 15) };
      await driver.drag(handle, { x: handle.x + (home.left - clamped.left), y: handle.y + (home.top - clamped.top) }, { label: 'drag the popup back' });
      const back =
        (
          await becomes('the popup back home', async () => {
            const at = await rect();
            return Math.abs(at.left - home.left) <= 2 && Math.abs(at.top - home.top) <= 2 ? at : undefined;
          })
        ).value ?? (await rect());
      check(
        'the popup can be grabbed again at the edge and dragged back',
        Math.abs(back.left - home.left) <= 2 && Math.abs(back.top - home.top) <= 2,
        JSON.stringify([home, back]),
      );
    }
    // 2. Alt text: the prop that feeds it, though it is called imageAlt and Img calls it alt.
    const altInput = `document.querySelectorAll('.canvas-image-popup .props-field')[1] && (document.querySelectorAll('.canvas-image-popup .props-field')[1].querySelector('input, textarea') || undefined)`;
    if (await click(altInput, 'focus the alt field')) {
      await driver.evaluate(`document.activeElement && document.activeElement.select && document.activeElement.select()`);
      await driver.typeText('A tidy alt');
      // The panel saves behind its own debounce: wait for the bytes, not for a guessed time.
      await becomes('the alt text written to the page', () => read().includes('imageAlt="A tidy alt"'));
      await driver.settle();
      const edited = read();
      check('the alt prop literal changed', edited === original.replace('imageAlt="First picture"', 'imageAlt="A tidy alt"'), edited.slice(0, 400));
      check('the popup stays open while typing', await popupOpen());
      await shot('2-alt-edited');
      // One undo restores the bytes.
      await driver.pointerPress(await driver.canvasPoint('#native'), { label: 'select the native image' });
      await driver.settle();
      check('selecting another element closes the popup', !(await popupOpen()));
      await driver.key('z', { modifiers: ['meta'] });
      await becomes('the undo written to the page', () => read() === original);
      check(
        'one undo restores the bytes',
        read() === original,
        read()
          .split('\n')
          .filter((line) => line.includes('card-one'))
          .join(' | '),
      );
    }
    // 3. The picture: choose another image from the project's own assets. The undo rewrote the page, so the frame may be reloading.
    await reopen('#card-one .card_visual img', 'the popup reopens');
    const chooseButton = `[...document.querySelectorAll('.canvas-image-popup button')].find((b) => /Choose|Replace/i.test(b.textContent || '')) || undefined`;
    if (await click(chooseButton, 'Choose Image')) {
      const overlay = (await becomes('the asset chooser', () => driver.evaluate(`!!document.querySelector('.asset-pick-overlay')`))).value;
      await driver.settle();
      await shot('3-asset-overlay');
      check('the asset chooser opens over the page', overlay === true);
      check('the popup stays while the chooser is open', await popupOpen());
      report.notes.push(
        `overlay text: ${JSON.stringify(await driver.evaluate(`(document.querySelector('.asset-pick-overlay') || {}).innerText || ''`)).slice(0, 400)}`,
      );
      const tile = `[...document.querySelectorAll('.asset-pick-overlay [title="popup-two.svg"]')].find((e) => e.getClientRects().length > 0) || undefined`;
      if (await click(tile, 'pick popup-two.svg')) {
        await becomes('the picked picture written to the page', () => read().includes('image="/popup-two.svg"'));
        await driver.settle();
        const picked = read();
        check(
          'the picture prop changed and nothing else',
          picked === original.replace('image="/popup-one.svg"', 'image="/popup-two.svg"'),
          picked.slice(0, 500),
        );
        await shot('4-picture-changed');
      }
    }
    // 3b. A Card with a link stretches the link over the whole card, and a cover Card's picture takes no pointer: the
    // double click lands on something else and still means the image.
    await escapeAndClose('the popup closes before the cover Card');
    // The picture just changed, so the canvas may still swap frames: pressed within the reopen's bound.
    check('a double click over the cover overlay opens the popup', await reopen('#card-cover .card_visual', 'double click the cover Card image'));
    await shot('3b-cover-popup');
    await escapeAndClose('the cover popup closes');
    check('a double click on a linked Card image opens the popup', await reopen('#card-link .card_visual', 'double click the linked Card image'));
    await shot('3c-linked');
    await escapeAndClose('the linked popup closes');
    // 3d. Words win: on a cover Card the heading sits over the picture. A double click on the words is text editing,
    // and only the picture area no words cover opens the popup.
    await doubleClick('#card-cover .card_content :is(h1,h2,h3,h4,h5,h6)', 'double click the words over the cover picture');
    // The double click has run its course once text editing has started; only then can "no popup" be read, with no guess at how long to wait.
    const editing = (
      await becomes('text editing started', () =>
        driver.canvasEvaluate(
          `!!document.querySelector('[contenteditable="true"], [contenteditable=""], [data-avb-text-editing]') || (document.activeElement && document.activeElement.isContentEditable) === true`,
        ),
      )
    ).value;
    await driver.settle();
    check('a double click on words over the picture opens no image popup', !(await popupOpen()));
    check('and it starts text editing', editing === true);
    await driver.key('Escape');
    await driver.settle();
    await doubleClick('#card-cover .card_visual', 'double click the picture area of the cover Card');
    check('a double click on bare picture area still opens the popup', (await until('the picture popup', popupOpen)) === true);
    await escapeAndClose('the picture popup closes');
    // 4. Escape closes it.
    check('Escape closes the popup', await escapeAndClose('Escape closes the popup'));
    // 5. A picture that comes from code is refused, and nothing is written.
    const beforeBound = read();
    await doubleClick('#card-bound .card_visual img', 'double click the bound Card image');
    await until('the refusal shows', popupOpen);
    const refusal = await popupText();
    report.notes.push(`refusal: ${JSON.stringify(refusal)}`);
    check('the refusal names the expression', /gallery\[0\]\.photo/.test(refusal), refusal);
    check('the refusal shows no field', (await driver.evaluate(`document.querySelectorAll('.canvas-image-popup .props-field').length`)) === 0);
    await shot('5-refused');
    check('a refusal writes nothing', read() === beforeBound);
    await driver.pointerPress(await driver.canvasPoint('#native'), { label: 'select the native image' });
    await driver.settle();
    check('selecting another element closes the refusal', !(await popupOpen()));
    // 6. A plain <img> on the page edits its own attributes.
    await doubleClick('#native', 'double click the native image');
    await until('the native image popup', popupOpen);
    check('the native image opens the popup too', await popupOpen());
    await shot('6-native');
    await escapeAndClose('the native popup closes');
    // 6b. A picture a closed component computes or writes itself: nothing on the instance changes it, so the double click opens
    // nothing at all, not even an explanation. The panel settling (nothing new painted for a quiet spell) is the end of the double click.
    for (const selector of ['#closed-computed', '#closed-fixed']) {
      // The picture is drawn first, so a popup that stays shut is the decision, not a double click on nothing.
      const drawn = await until(`${selector} drawn`, () =>
        driver.canvasEvaluate(`(() => { const image = document.querySelector('${selector}'); return !!image && image.complete && image.naturalWidth > 0; })()`),
      );
      check(`${selector} is drawn on the canvas`, drawn === true);
      const beforeClosed = read();
      await doubleClick(selector, `double click ${selector}`);
      await driver.settle();
      check(`a double click on ${selector} opens no popup`, !(await popupOpen()));
      check(`and it writes nothing (${selector})`, read() === beforeClosed);
    }
    await shot('6b-closed-picture');
    // 7. A click outside closes it, and single click still only selects.
    await reopen('#card-one .card_visual img', 'the popup reopens');
    await driver.pointerPress(await driver.canvasPoint('#card-bound .card_content'), { label: 'click elsewhere on the canvas' });
    await driver.settle();
    check('a click elsewhere closes the popup', (await becomes('the popup closes after a click elsewhere', popupClosed)).kind === 'reached');
  } catch (error) {
    report.failures.push(`the run threw: ${String(error && error.stack ? error.stack : error)}`);
  }
  fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, undefined, 1));
  return 0;
}

module.exports = { runInElectron };

if (process.versions.electron === undefined) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
