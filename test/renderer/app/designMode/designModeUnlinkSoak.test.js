// Goal: in the real app, "Unlink component" in Design mode turns a component instance into the plain elements it
// renders, in the sandbox copy only, and the frame looks exactly as it did. A right-click on an instance in a frame
// offers it, and so does the instance's Navigator row; the copy's page then holds plain elements with the component's
// classes and scope attributes, a component the component placed stays a component, slot content stays the page's
// own; the frame's computed styles and pixels are the same before and after; ⌘Z takes the unlink back in one step
// and ⌘⇧Z brings it again; a component that runs its own script or shows a picture only the dev server makes is
// refused with a toast and nothing written; and the project folder is byte-identical afterwards.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) runs the real desktop app hidden, with a temporary user
// data folder and the mock keychain, on a copy of the Lumos fixture site with the style soak page. Before Design mode
// is entered, the scenario adds three components to that copy (a probe with a nested component, a condition, a loop,
// slots and scoped styles; one with a script; and an Lumos image) and places them on the soak page. Pointer and key
// input are real input events at window coordinates (soakDriver.js); no step sleeps, each waits on the state it
// expects. Pixels are compared from the window's own capture of the frame, with nothing selected or hovered.
// Screenshots go to STACKI_SCREENSHOT_DIR (default node_modules/.stacki-test/design-unlink). Run it by hand with
// `node test/renderer/app/designMode/designModeUnlinkSoak.test.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const WAIT_MS_MAX = 30_000;
const OPEN_WAIT_MS_MAX = 90_000;
const POLL_MS = 100;
/** Captures of a redrawn element before it counts as different. */
const PAINT_POLLS_MAX = 100;
const TREE_FILES_MAX = 50_000;
const CHECKS_MIN = 20;

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../../helpers/e2e/soakLaunch.js');
  // It drives the real pointer, so like every pointer probe it runs on macOS only (docs/release-runbook.md).
  const unavailable = process.platform === 'darwin' ? soakUnavailableReason() : 'a pointer probe, macOS only';
  if (unavailable !== undefined) {
    console.log(`# skip designModeUnlinkSoak: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/design-unlink');
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.rmSync(path.join(outDirectory, 'report.json'), { force: true });
  // While Design mode is on the app may write only to its copy, its own data and the temporary folder.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-unlink-'));
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory: staging }, keepDirectory: false });
  for (const name of fs.readdirSync(staging)) {
    fs.copyFileSync(path.join(staging, name), path.join(outDirectory, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });
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
  if (report.checked < CHECKS_MIN) {
    console.error(`not ok - only ${report.checked} checks ran`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(`ok - ${report.checked} checks: components unlinked faithfully in the copy, refusals told, the project byte-identical`);
  }
}

// --- The components the scenario adds to the fixture copy ------------------------------------

const PROBE = `---
import Heading from "@/components/typography/Heading.astro";
import SoakCard from "@/components/SoakCard.astro";
const { title = "Default title", items = ["one", "two"], show = true } = Astro.props;
---
<div class="probe" id="probe-root">
  <Heading tag="h3" id="probe-heading">{title}</Heading>
  {show && <p class="probe_show" id="probe-show">Shown with {"{braces}"}</p>}
  {!show && <p class="probe_hidden">Hidden</p>}
  <ul class="probe_list">{items.map((item) => <li class="probe_item">{item}</li>)}</ul>
  <slot />
  <div class="probe_named" id="probe-named"><slot name="aside">Fallback aside</slot></div>
  <SoakCard />
</div>

<style>
  .probe { padding: 1.5rem; background-color: rgb(230, 240, 255); border-radius: 0.75rem; }
  .probe_show { color: rgb(20, 90, 160); font-weight: 700; }
  .probe_item { letter-spacing: 0.1em; }
  .probe_named { border-left: 4px solid rgb(200, 0, 120); padding-left: 0.5rem; }
  .probe :global(.probe-slotted) { text-transform: uppercase; }
</style>
`;

const SCRIPTED = `---
---
<div class="scripted" id="probe-scripted">Scripted</div>
<script>
  document.querySelector("#probe-scripted")?.setAttribute("data-ran", "yes");
</script>
`;

const PAGE_IMPORTS = `import UnlinkProbe from "@/components/UnlinkProbe.astro";
import UnlinkScripted from "@/components/UnlinkScripted.astro";
import Img from "@/components/media/Img.astro";
import background from "@/assets/graphics/lumos-background.svg";
`;

const PAGE_USES = `      <UnlinkProbe title="Probe title"><b class="probe-slotted" id="probe-slotted">Slotted text</b><i slot="aside" id="probe-aside">Aside text</i></UnlinkProbe>
      <UnlinkScripted />
      <div class="probe-picture" id="probe-picture"><Img src={background} alt="Probe picture" /></div>
`;

/** Adds the probe components to the fixture copy and places them on the soak page, after the scoped card. */
function addProbes(project) {
  fs.writeFileSync(path.join(project, 'src/components/UnlinkProbe.astro'), PROBE);
  fs.writeFileSync(path.join(project, 'src/components/UnlinkScripted.astro'), SCRIPTED);
  const file = path.join(project, 'src/pages/index.astro');
  const page = fs.readFileSync(file, 'utf8');
  const marker = '      <div class="soak-cards">';
  if (!page.includes(marker) || !page.includes('import SoakCard')) {
    throw new Error('the soak page changed shape: the probes have nowhere to go');
  }
  const withImports = page.replace('import SoakCard', `${PAGE_IMPORTS}import SoakCard`);
  fs.writeFileSync(file, withImports.replace(marker, `${PAGE_USES}${marker}`));
}

// --- Electron side ---------------------------------------------------------------------------

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

const modeButton = (name) => `[...document.querySelectorAll('.ai-header .ai-mode-button')].find((b) => ${name}.test(b.getAttribute('aria-label') || ''))`;
const FRAME_DOCUMENT = `((id) => [...document.querySelectorAll('.dm-tile[data-dm-tile="' + id + '"] iframe')].find((f) => f.style.visibility !== 'hidden')?.contentDocument)`;
const framePointOf = (id, selector) => `(() => {
  const doc = ${FRAME_DOCUMENT}('${id}'); const element = doc && doc.querySelector(${JSON.stringify(selector)});
  const body = document.querySelector('.dm-tile[data-dm-tile="${id}"] .dm-body'); if (!element || !body) return undefined;
  const outer = body.getBoundingClientRect(); const zoom = outer.width / body.offsetWidth; const r = element.getBoundingClientRect();
  for (let row = 1; row < 5; row += 1) for (let column = 1; column < 12; column += 1) {
    const x = r.left + (r.width * column) / 12; const y = r.top + (r.height * row) / 5;
    const sx = outer.left + x * zoom; const sy = outer.top + y * zoom;
    const top = document.elementFromPoint(sx, sy);
    if (element.contains(doc.elementFromPoint(x, y)) && top && top.closest('.dm-plane')) return { x: Math.round(sx), y: Math.round(sy) };
  }
  return undefined;
})()`;
/** Computed styles of the frame's elements matching `selector`, the properties a look is made of. */
const STYLE_PROPERTIES = [
  'display',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'padding-top',
  'padding-left',
  'margin-top',
  'margin-bottom',
  'border-left-width',
  'border-left-color',
  'border-top-left-radius',
  'width',
  'height',
];
const frameStyles = (id, selector) => `(() => {
  const doc = ${FRAME_DOCUMENT}('${id}'); if (!doc) return undefined;
  const list = [...doc.querySelectorAll(${JSON.stringify(selector)})];
  if (list.length === 0) return undefined;
  return list.map((e) => { const s = doc.defaultView.getComputedStyle(e); const r = e.getBoundingClientRect();
    return [e.localName, e.className, ...${JSON.stringify(STYLE_PROPERTIES)}.map((p) => s.getPropertyValue(p)), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join('|'); });
})()`;
const markedInFrame = (id, selector) =>
  `(() => { const doc = ${FRAME_DOCUMENT}('${id}'); const e = doc && doc.querySelector(${JSON.stringify(selector)}); return e ? e.hasAttribute('data-dm-node') : undefined; })()`;
const centreOf = (finder) =>
  `(() => { const e = ${finder}; if (!e) return undefined; const r = e.getBoundingClientRect(); return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : undefined; })()`;
const MENU_ROW = (pattern) =>
  `[...document.querySelectorAll('.menu-surface .menu-row, .ctx-menu .ctx-menu-item')].find((r) => ${pattern}.test(r.textContent || ''))`;
const SELECTED_ROW = `document.querySelector('.structure-node.selected, .structure-node.is-selected, .structure-node[aria-selected="true"]')`;
const FRAME_RECT = `(() => { const b = document.querySelector('.dm-tile[data-dm-tile="f1"] .dm-body'); const p = document.querySelector('.dm-plane'); if (!b || !p) return undefined; const r = b.getBoundingClientRect(); const q = p.getBoundingClientRect(); const x = Math.max(r.left, q.left), y = Math.max(r.top, q.top), right = Math.min(r.right, q.right), bottom = Math.min(r.bottom, q.bottom); return right - x > 50 && bottom - y > 50 ? { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) } : undefined; })()`;
/** Where an element of f1 is on screen, against the canvas: above (negative), inside (0) or below (positive) it. */
const offsetOf = (
  selector,
) => `(() => { const doc = ${FRAME_DOCUMENT}('f1'); const e = doc && doc.querySelector(${JSON.stringify(selector)}); const b = document.querySelector('.dm-tile[data-dm-tile="f1"] .dm-body'); const p = document.querySelector('.dm-plane'); if (!e || !b || !p) return undefined;
  const outer = b.getBoundingClientRect(); const zoom = outer.width / b.offsetWidth; const r = e.getBoundingClientRect(); const q = p.getBoundingClientRect();
  const top = outer.top + r.top * zoom; const bottom = outer.top + r.bottom * zoom; const middle = (top + bottom) / 2;
  return top >= q.top + 40 && bottom <= q.bottom - 120 ? 0 : Math.round(middle - (q.top + q.height / 2)); })()`;

/** A frame channel may differ by this much where a picture is resampled; the unlinked element itself by nothing. */
const FRAME_CHANNEL_DELTA_MAX = 8;

function largestDifference(left, right) {
  if (left.length !== right.length) {
    return 255;
  }
  let largest = 0;
  for (let index = 0; index < left.length; index += 1) {
    largest = Math.max(largest, Math.abs(left[index] - right[index]));
  }
  return largest;
}

/** The on-screen box of an element of f1, within the canvas. */
const elementRect = (
  selector,
) => `(() => { const doc = ${FRAME_DOCUMENT}('f1'); const e = doc && doc.querySelector(${JSON.stringify(selector)}); const b = document.querySelector('.dm-tile[data-dm-tile="f1"] .dm-body'); if (!e || !b) return undefined;
  const outer = b.getBoundingClientRect(); const zoom = outer.width / b.offsetWidth; const r = e.getBoundingClientRect();
  return { x: Math.round(outer.left + r.left * zoom), y: Math.round(outer.top + r.top * zoom), width: Math.round(r.width * zoom), height: Math.round(r.height * zoom) }; })()`;

async function runInElectron({ window, project, options }) {
  const { app } = require('electron');
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor } = require('../../../helpers/waitFor.js');
  const { designFenceState } = require('#dist/electron/lib/designMode/designFence.js');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [] };
  const check = (what, condition, detail) => {
    report.checked += 1;
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${String(detail)})`}`);
    }
  };
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`));
  const until = (what, expression, test = Boolean, waitMsMax = WAIT_MS_MAX) =>
    waitFor({ what, read: () => driver.evaluate(expression).catch(() => undefined), until: test, pollIntervalMs: POLL_MS, pollCountMax: waitMsMax / POLL_MS });
  const run = async (what, act) => {
    try {
      await act();
    } catch (error) {
      report.failures.push(`${what}: ${String(error && error.message ? error.message : error)}`);
      await shot('failed-' + what.replace(/\W+/g, '-')).catch(() => undefined);
    }
  };
  const watchToasts = () =>
    driver.evaluate(`(() => {
      window.__dmToasts = [];
      new MutationObserver(() => {
        for (const toast of document.querySelectorAll('.toast-stack [role="status"], .toast-stack [role="alert"], .toast-list > *')) {
          const text = (toast.textContent || '').trim();
          if (text && !window.__dmToasts.includes(text)) window.__dmToasts.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      return 0;
    })()`);
  const toasts = async () => (await driver.evaluate(`window.__dmToasts || []`).catch(() => [])) ?? [];
  const liveRootNow = () => {
    const fence = designFenceState();
    return fence.kind === 'on' ? path.join(fence.sandboxRoot, 'site', path.basename(project)) : '';
  };
  const sandboxPage = () => fs.readFileSync(path.join(liveRootNow(), 'src/pages/index.astro'), 'utf8');
  const untilPage = (what, test) => waitFor({ what, read: () => sandboxPage(), until: test, pollIntervalMs: POLL_MS, pollCountMax: WAIT_MS_MAX / POLL_MS });
  /** Moves the pointer off the frames and drops the selection, so a capture of the frame shows its page alone. */
  const clearView = async () => {
    const empty = await until(
      'an empty spot on the canvas',
      `(() => { const p = document.querySelector('.dm-plane').getBoundingClientRect();
        const spots = [[p.left + 16, p.top + p.height / 2], [p.right - 16, p.top + p.height / 2], [p.left + p.width / 2, p.bottom - 16], [p.left + 16, p.bottom - 16]];
        for (const [x, y] of spots) { const hit = document.elementFromPoint(x, y); if (hit && hit.closest('.dm-plane') && !hit.closest('.dm-tile, .dm-bar')) return { x: Math.round(x), y: Math.round(y) }; }
        return undefined; })()`,
    );
    await driver.pointerPress(empty, { label: 'press on the board' });
    await driver.hover(empty);
    await until('nothing outlined', `!document.querySelector('[data-dm-outline="picked"]') && !document.querySelector('[data-dm-outline="hover"]')`);
    await driver.settle();
  };
  const framePixels = async (finder = FRAME_RECT) => {
    const rect = await until('the frame on screen', finder);
    const image = await driver.contents.capturePage(rect);
    return { rect, bitmap: image.toBitmap(), png: image.toPNG() };
  };
  /** Pans the canvas, with the wheel, until `selector` in f1 is on screen. */
  const reveal = async (selector) => {
    // Electron's wheel event counts the other way from the DOM's: a positive delta scrolls up.
    let gain = 1;
    for (let step = 0; step < 40; step += 1) {
      const offset = await until(`${selector} measured`, offsetOf(selector), (value) => typeof value === 'number');
      if (offset === 0) {
        await driver.settle();
        return;
      }
      const middle = await until(
        'the canvas middle',
        `(() => { const q = document.querySelector('.dm-plane').getBoundingClientRect(); return { x: Math.round(q.left + 20), y: Math.round(q.top + q.height / 2) }; })()`,
      );
      await driver.wheel(middle, -gain * Math.max(-300, Math.min(300, offset)), 'pan the canvas');
      await driver.settle();
      const after = await until(`${selector} measured again`, offsetOf(selector), (value) => typeof value === 'number');
      // A step that took it further away says the gesture runs the other way here.
      if (Math.abs(after) > Math.abs(offset)) {
        gain = -gain;
      }
    }
    throw new Error(`${selector} never came into view`);
  };
  const rightClickIn = async (selector) => {
    await reveal(selector);
    const at = await until(`${selector} in f1`, framePointOf('f1', selector));
    driver.contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
    driver.contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
  };
  const choose = async (pattern) => {
    const at = await until(`the ${pattern.source} row`, centreOf(MENU_ROW(pattern)));
    await driver.pointerPress(at, { label: `choose ${pattern.source}` });
  };

  addProbes(project);
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  await watchToasts();
  await driver.settle();
  const before = treeDigest(project);

  await run('Design mode opens on the probe page', async () => {
    await driver.evaluate(
      `document.querySelector('.ai-mode-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
    await until('the Design mode button', `!!${modeButton(/design mode/i)}`);
    await driver.settle();
    const button = await until('the Design mode button point', centreOf(modeButton(/design mode/i)));
    await driver.pointerPress(button);
    await until(
      'the Design mode canvas',
      `!!document.querySelector('.dm-bar') && !document.querySelector('.dm-status') && !!document.querySelector('.dm-plane')`,
      Boolean,
      OPEN_WAIT_MS_MAX,
    );
    await driver.waitForApp();
    await driver.setPageFocus('focused');
    await installRecorder(driver.contents);
    await watchToasts();
    await driver.settle();
    check('the fence is up', designFenceState().kind === 'on');
    await until('the probe drawn in the frame', `!!${FRAME_DOCUMENT}('f1')?.querySelector('#probe-show')`, Boolean, OPEN_WAIT_MS_MAX);
    await driver.settle();
    await shot('01-entered');
  });

  /** Waits until f1 draws the page at the width the live canvas has now: a picture from before a resize is not the page. */
  const steadyFrame = async () => {
    const live = await driver.canvasEvaluate('document.documentElement.clientWidth');
    await until(`f1 drawn ${String(live)} pixels wide`, `${FRAME_DOCUMENT}('f1')?.documentElement.clientWidth`, (width) => width === live);
  };
  const unlinkAndCompare = async ({ name, selector, styled, styledRoot, tag, expect }) => {
    await steadyFrame();
    await reveal(selector);
    await clearView();
    const stylesBefore = await until(`${name}'s styles`, frameStyles('f1', styled));
    const pixelsBefore = await framePixels();
    const regionBefore = await framePixels(elementRect(styledRoot));
    fs.writeFileSync(path.join(options.outDirectory, `${name}-before.png`), pixelsBefore.png);
    check(`${name}: drawn inside its component (no page node of its own)`, (await driver.evaluate(markedInFrame('f1', selector))) === false);
    await rightClickIn(selector);
    await shot(`${name}-menu`);
    await choose(/unlink component/i);
    const page = await untilPage(`${name} unlinked in the copy`, (text) => !text.includes(`<${tag}`));
    for (const [what, pattern] of expect) {
      check(`${name}: ${what}`, pattern.test(page), page.slice(0, 4000));
    }
    await until(`${name} drawn as page elements`, markedInFrame('f1', selector), (value) => value === true);
    await steadyFrame();
    await clearView();
    const stylesAfter = await until(`${name}'s styles after`, frameStyles('f1', styled));
    check(
      `${name}: every element computes the same styles and boxes`,
      JSON.stringify(stylesAfter) === JSON.stringify(stylesBefore),
      `${JSON.stringify(stylesBefore)} → ${JSON.stringify(stylesAfter)}`,
    );
    const pixelsAfter = await framePixels();
    fs.writeFileSync(path.join(options.outDirectory, `${name}-after.png`), pixelsAfter.png);
    const sameRect = JSON.stringify(pixelsAfter.rect) === JSON.stringify(pixelsBefore.rect);
    // The visible frame: a picture elsewhere on the page may be resampled a level or two differently each time it is
    // decoded, so the whole frame is held to a small difference per channel and the unlinked element to none.
    const delta = sameRect ? largestDifference(pixelsBefore.bitmap, pixelsAfter.bitmap) : 255;
    check(`${name}: the visible frame is the same before and after`, delta <= FRAME_CHANNEL_DELTA_MAX, `largest channel difference ${String(delta)}`);
    report.frameDelta = { ...(report.frameDelta ?? {}), [name]: delta };
    // One capture may catch the redrawn frame part painted on a loaded machine: it is captured until it matches, and
    // an element that really differs never does.
    const identical = await waitFor({
      what: `${name}: the element painted as before`,
      read: async () => Buffer.compare(regionBefore.bitmap, (await framePixels(elementRect(styledRoot))).bitmap) === 0,
      until: Boolean,
      pollIntervalMs: POLL_MS,
      pollCountMax: PAINT_POLLS_MAX,
    }).then(
      () => true,
      () => false,
    );
    check(`${name}: the unlinked element is pixel-identical`, identical);
    return page;
  };

  let probeUnlinked = '';
  await run('the probe is unlinked from a right-click in the frame, and looks the same', async () => {
    probeUnlinked = await unlinkAndCompare({
      name: 'probe',
      selector: '#probe-show',
      styled: '#probe-root, #probe-root *',
      styledRoot: '#probe-root',
      tag: 'UnlinkProbe',
      expect: [
        ['the root is a plain div with its classes and scope', /<div class="probe" id="probe-root" data-astro-cid-\w+>/],
        ['the nested heading stays a component, with the title it was given', /<Heading tag="h3" id="probe-heading"[^>]*>Probe title<\/Heading>/],
        ['the condition is resolved to what it rendered', /<p class="probe_show" id="probe-show" data-astro-cid-\w+>Shown with &#123;braces&#125;<\/p>/],
        ['the other branch is gone', /^(?![\s\S]*probe_hidden)/],
        ['the loop is resolved to its items', /<li class="probe_item" data-astro-cid-\w+>one<\/li><li class="probe_item" data-astro-cid-\w+>two<\/li>/],
        ['the default slot keeps the page’s own markup', /<b class="probe-slotted" id="probe-slotted">Slotted text<\/b>/],
        ['the named slot keeps the page’s markup, without its slot attribute', /<i id="probe-aside">Aside text<\/i>/],
        ['the nested scoped card stays a component', /<SoakCard \/>/],
        ['the import stays as a bare import, for its styles', /import "@\/components\/UnlinkProbe\.astro";/],
        ['the component file is untouched', /./],
      ],
    });
    const component = fs.readFileSync(path.join(liveRootNow(), 'src/components/UnlinkProbe.astro'), 'utf8');
    check('the component file in the copy is unchanged', component === PROBE);
    await shot('02-probe-unlinked');
  });

  await run('the Navigator and Style panel show the new elements', async () => {
    await reveal('#probe-show');
    const at = await until('the shown paragraph in f1', framePointOf('f1', '#probe-show'));
    await driver.pointerPress(at, { label: 'select the unlinked paragraph' });
    const row = await until(
      'the Navigator row of the paragraph',
      `(${SELECTED_ROW})?.textContent || ''`,
      (text) => typeof text === 'string' && text.length > 0,
    );
    check('the Navigator selects a plain element row, not the component', !/UnlinkProbe/.test(row), row);
    await until('the Style panel on the probe paragraph', `(document.querySelector('.embed-editor_root')?.textContent || '').includes('probe_show')`);
    check('the Style panel names the component’s class on the plain element', true);
    await shot('03-style-panel');
  });

  await run('⌘Z takes the unlink back in one step, and ⌘⇧Z redoes it', async () => {
    await clearView();
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    await driver.key('z', { modifiers: ['meta'] });
    const undone = await untilPage('the probe back as a component', (text) => text.includes('<UnlinkProbe title="Probe title">'));
    check(
      'undo restores the instance and its import',
      undone.includes('import UnlinkProbe from "@/components/UnlinkProbe.astro";') && !undone.includes('id="probe-root"'),
    );
    await until('the probe drawn inside its component again', markedInFrame('f1', '#probe-show'), (value) => value === false);
    await driver.key('z', { modifiers: ['meta', 'shift'] });
    const redone = await untilPage('the probe unlinked again', (text) => !text.includes('<UnlinkProbe'));
    check('redo writes the same unlinked page', redone === probeUnlinked);
    await until('the probe drawn as page elements again', markedInFrame('f1', '#probe-show'), (value) => value === true);
    await shot('04-undo-redo');
  });

  await run('the scoped card is unlinked from its Navigator row', async () => {
    await clearView();
    const stylesBefore = await until('the card styles', frameStyles('f1', '.soak-cards .soak-card, .soak-cards .soak-card *'));
    // A pick in the frame reveals the instance's row; the right-click is on that row.
    await reveal('.soak-cards #soak-card-title');
    await driver.pointerPress(await until('the card in f1', framePointOf('f1', '.soak-cards #soak-card-title')), { label: 'select the card' });
    await until('the SoakCard row selected', `/SoakCard/.test((${SELECTED_ROW})?.textContent || '')`);
    await driver.evaluate(`(${SELECTED_ROW})?.scrollIntoView({ block: 'center' }); 0`);
    await driver.settle();
    const at = await driver.panelPoint(SELECTED_ROW, { scroll: false });
    if (at === undefined) {
      throw new Error('the SoakCard row is not in the Navigator');
    }
    driver.contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
    driver.contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
    await shot('05-navigator-menu');
    await choose(/unlink component/i);
    const page = await untilPage('the card unlinked', (text) => /<div class="soak-cards">\s*<div class="soak-card"/.test(text));
    check(
      'the card is plain elements with its scope',
      /<h3 class="soak-card_title" id="soak-card-title" data-astro-cid-\w+>Scoped card title<\/h3>/.test(page),
    );
    check('the card import stays, used by the probe’s nested card', page.includes('import SoakCard from "@/components/SoakCard.astro";'));
    await until('the card drawn as page elements', markedInFrame('f1', '.soak-cards #soak-card-title'), (value) => value === true);
    await clearView();
    const stylesAfter = await until('the card styles after', frameStyles('f1', '.soak-cards .soak-card, .soak-cards .soak-card *'));
    check(
      'the unlinked card computes the same styles (its scoped rules and the page’s rules still apply)',
      JSON.stringify(stylesAfter) === JSON.stringify(stylesBefore),
      `${JSON.stringify(stylesBefore)} → ${JSON.stringify(stylesAfter)}`,
    );
  });

  await run('a component with its own script is refused with a toast, and nothing is written', async () => {
    await clearView();
    const pageBefore = sandboxPage();
    await rightClickIn('#probe-scripted');
    await choose(/unlink component/i);
    await until('the script refusal toast', `(window.__dmToasts || []).some((t) => /runs its own script/i.test(t))`);
    check('the page is unchanged after a refusal', sandboxPage() === pageBefore);
  });

  await run('a picture only the dev server makes is refused with a toast, and nothing is written', async () => {
    await clearView();
    const pageBefore = sandboxPage();
    await rightClickIn('#probe-picture img');
    await choose(/unlink component/i);
    await until('the picture refusal toast', `(window.__dmToasts || []).some((t) => /picture/i.test(t))`);
    check('the page is unchanged after the picture refusal', sandboxPage() === pageBefore);
    await shot('06-refusals');
  });

  report.toasts = await toasts();
  const refusals = report.toasts.filter((text) => /not available in design mode|design mode:/i.test(text));
  check('no failure or fence refusal reached the person', refusals.length === 0, refusals.join(' | '));
  check('the project folder is byte-identical after everything', treeDigest(project) === before);
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
