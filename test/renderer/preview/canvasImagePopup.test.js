// Goal: double-clicking an image on the canvas opens a small popup where its picture and its alt text change,
// even when the image sits inside a component that is not open. The edit lands on the prop of the one Card the
// person double-clicked, in the page file, byte for byte nowhere else; one Undo writes the old bytes back; and
// selecting anything else closes the popup. An image whose picture comes from code (an expression) is refused
// in the popup, and nothing is written.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) starts the real desktop app on a copy of the Lumos
// fixture site (never a person's project). The scenario replaces the copy's home page with a page of Lumos Cards:
// a stacked Card whose image and alt text are string props (Card hands them to Img, which prints the element),
// a Card whose image is an expression, and a plain <img>. It acts through webContents.sendInputEvent at real
// window coordinates (soakDriver.js): two presses make the double click, typing goes through real key events.
// After each action it reads the page file's bytes and compares them with the bytes it expects, which are the
// old bytes with exactly one literal replaced. Screenshots go to the output directory.
// The suite skips (and says why) where the fixture's Astro install or the built main process is missing. It needs
// a display (CI on Linux runs it under xvfb).
// Run it by hand with `node test/renderer/preview/canvasImagePopup.test.js`.

const fs = require('node:fs');
const path = require('node:path');

const PAGE = `---
import Layout from "@/layouts/BaseLayout.astro";
import Section from "@/components/wrapper/Section.astro";
import Card from "@/components/item/Card.astro";
const gallery = [{ photo: "/popup-one.svg" }];
---
<Layout theme="dark">
  <Section>
    <Card id="card-one" variant="stacked" heading="First card" image="/popup-one.svg" imageAlt="First picture" />
    <Card id="card-bound" variant="stacked" heading="Bound card" image={gallery[0].photo} imageAlt="Bound picture" />
    <img id="native" src="/popup-one.svg" alt="Native picture" width="160" height="100" />
  </Section>
</Layout>
`;
const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${fill}"/></svg>\n`;
const WAIT_MS_MAX = 20000;

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
  fs.writeFileSync(pagePath, PAGE);
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  await driver.sleep(800);
  await driver.settle();
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`));
  const until = async (what, probe) => {
    for (let waitedMs = 0; waitedMs < WAIT_MS_MAX; waitedMs += 100) {
      const value = await probe();
      if (value) {
        return value;
      }
      await driver.sleep(100);
    }
    report.failures.push(`never happened: ${what}`);
    return undefined;
  };
  const popupText = () => driver.evaluate(`(document.querySelector('.canvas-image-popup') || {}).innerText || ''`);
  const popupOpen = async () => (await driver.evaluate(`!!document.querySelector('.canvas-image-popup')`)) === true;
  const doubleClick = async (selector, label) => {
    const point = await driver.canvasPoint(selector);
    await driver.pointerPress(point, { label: `${label} (click)` });
    await driver.sleep(60);
    await driver.pointerPress(point, { label: `${label} (second click)`, clickCount: 2 });
    await driver.sleep(60);
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
    // 2. Alt text: the prop that feeds it, though it is called imageAlt and Img calls it alt.
    const altInput = `document.querySelectorAll('.canvas-image-popup .props-field')[1] && (document.querySelectorAll('.canvas-image-popup .props-field')[1].querySelector('input, textarea') || undefined)`;
    if (await click(altInput, 'focus the alt field')) {
      await driver.evaluate(`document.activeElement && document.activeElement.select && document.activeElement.select()`);
      await driver.typeText('A tidy alt');
      await driver.sleep(1500);
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
      await driver.sleep(1500);
      check('one undo restores the bytes', read() === original, read().slice(0, 300));
    }
    // 3. The picture: choose another image from the project's own assets.
    await doubleClick('#card-one .card_visual img', 're-open on the Card image');
    await until('the popup reopens', popupOpen);
    const chooseButton = `[...document.querySelectorAll('.canvas-image-popup button')].find((b) => /Choose|Replace/i.test(b.textContent || '')) || undefined`;
    if (await click(chooseButton, 'Choose Image')) {
      await driver.sleep(1200);
      await driver.settle();
      await shot('3-asset-overlay');
      const overlay = await driver.evaluate(`!!document.querySelector('.asset-pick-overlay')`);
      check('the asset chooser opens over the page', overlay === true);
      check('the popup stays while the chooser is open', await popupOpen());
      report.notes.push(
        `overlay text: ${JSON.stringify(await driver.evaluate(`(document.querySelector('.asset-pick-overlay') || {}).innerText || ''`)).slice(0, 400)}`,
      );
      const tile = `[...document.querySelectorAll('.asset-pick-overlay [title="popup-two.svg"]')].find((e) => e.getClientRects().length > 0) || undefined`;
      if (await click(tile, 'pick popup-two.svg')) {
        await driver.sleep(1500);
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
    // 4. Escape closes it.
    await driver.key('Escape');
    await driver.sleep(500);
    check('Escape closes the popup', !(await popupOpen()));
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
    await driver.key('Escape');
    await driver.sleep(300);
    // 7. A click outside closes it, and single click still only selects.
    await doubleClick('#card-one .card_visual img', 'reopen');
    await until('the popup reopens', popupOpen);
    await driver.pointerPress(await driver.canvasPoint('#card-one h5, #card-one .card_content'), { label: 'click elsewhere on the canvas' });
    await driver.settle();
    check('a click elsewhere closes the popup', !(await popupOpen()));
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
