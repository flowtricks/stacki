// Goal: in the real app, Design mode opens on the page the person is on and stays there: a static page that is not
// the home page, a nested one, and a dynamic route showing one of its entries; Exit and Send to AI come back to the
// same page; a component opened from a page opens Design mode on that page; and switching pages inside the mode
// works, with no frame showing a picture of another page.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) on the Lumos fixture, with a nested page and a dynamic
// one written into the temporary copy. Pages are picked with real presses in the title bar's switcher and entry
// list. After each way in or out, the editor's page, the live preview's address and every frame's document are
// sampled for several seconds: once they show the expected page they must not leave it, and no frame may ever show
// another page, the home page among them. The suite skips where the fixture's Astro install or the built main
// process is missing. Run it by hand with `node test/renderer/app/designMode/designModePagesSoak.test.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** How long the page is watched after it should have arrived: longer than any late navigation seen. */
const WATCH_MS = 8_000;
const SAMPLE_MS = 100;
const STARTUP_STEADY_POLLS = 40;
const WAIT_MS_MAX = 60_000;
/** How long a way in or out may take to arrive on the page. */
const ARRIVE_MS_MAX = 30_000;
const CHECKS_MIN = 12;

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../../helpers/e2e/soakLaunch.js');
  // It drives the real pointer, so like every pointer probe it runs on macOS only (docs/release-runbook.md).
  const unavailable = process.platform === 'darwin' ? soakUnavailableReason() : 'a pointer probe, macOS only';
  if (unavailable !== undefined) {
    console.log(`# skip designModePagesSoak: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/design-mode-pages');
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.rmSync(path.join(outDirectory, 'report.json'), { force: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-pages-'));
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory: staging }, keepDirectory: false });
  for (const name of fs.readdirSync(staging)) {
    fs.copyFileSync(path.join(staging, name), path.join(outDirectory, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const reportFile = path.join(outDirectory, 'report.json');
  if (code !== 0 || !fs.existsSync(reportFile) || leftovers.length > 0 || fs.existsSync(directory)) {
    console.error(`not ok - the run did not finish cleanly (exit ${code}, left ${leftovers.join(', ')})`);
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
    console.log(`ok - ${report.checked} checks: Design mode opened on the page the person was on and stayed there`);
  }
}

const page = (title) => `---\nimport Layout from "@/layouts/BaseLayout.astro";\n---\n<Layout><h1 id="where">${title}</h1></Layout>\n`;
const DYNAMIC = `---
import Layout from "@/layouts/BaseLayout.astro";
export function getStaticPaths() {
  return [{ params: { slug: "first-post" } }, { params: { slug: "second-post" } }];
}
const { slug } = Astro.params;
---
<Layout><h1 id="where">Post {slug}</h1></Layout>
`;

/** In the page: what the editor shows (switcher, entry, preview address) and what each drawn frame shows. */
const SAMPLE = `(() => {
  const preview = document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]');
  const frames = [...document.querySelectorAll('.dm-tile')].flatMap((tile) => {
    const shown = [...tile.querySelectorAll('iframe')].find((f) => f.style.visibility !== 'hidden');
    const document_ = shown && shown.contentDocument;
    if (!document_ || !document_.body || document_.body.childElementCount === 0) return [];
    return [document_.querySelector('#where')?.textContent?.trim() ?? (document_.querySelector('#soak-plain') ? 'HOME' : 'OTHER')];
  });
  return {
    editor: document.querySelector('.page-switch-btn')?.textContent?.trim(),
    entry: document.querySelector('.route-dd')?.textContent?.trim() ?? '',
    preview: preview ? new URL(preview.src).pathname.replace(/\\/$/, '') || '/' : undefined,
    frames,
    mode: document.querySelector('.dm-bar') ? (document.querySelector('.dm-status') ? 'opening' : 'on') : 'off',
  };
})()`;

async function runInElectron({ window, project, options }) {
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { pollUntil, waitFor, waitForSteady } = require('../../../helpers/waitFor.js');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [], watched: {} };
  const check = (what, condition, detail) => {
    report.checked += 1;
    console.log(`CHECK ${condition ? 'pass' : 'FAIL'} ${what}${condition || detail === undefined ? '' : ` ${String(detail).slice(0, 400)}`}`);
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${String(detail)})`}`);
    }
  };
  const until = (what, expression, test = Boolean) =>
    waitFor({
      what,
      read: () => driver.evaluate(expression).catch(() => undefined),
      until: test,
      pollIntervalMs: SAMPLE_MS,
      pollCountMax: WAIT_MS_MAX / SAMPLE_MS,
    });
  const centre = (finder) =>
    `(() => { const e = ${finder}; if (!e) return undefined; const r = e.getBoundingClientRect(); return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : undefined; })()`;
  const press = async (what, finder) => {
    await driver.pointerPress(await until(what, centre(finder)));
  };
  const reopened = async () => {
    await driver.waitForApp();
    await driver.setPageFocus('focused');
    await installRecorder(driver.contents);
    await driver.settle();
  };
  const switchTo = async (item) => {
    await press('the page switcher', `document.querySelector('.page-switch-btn')`);
    await press(`the ${item} page`, `[...document.querySelectorAll('.page-menu-item')].find((b) => b.textContent.includes(${JSON.stringify(item)}))`);
    await driver.settle();
  };
  const pickEntry = async (entry) => {
    await press('the entry list', `document.querySelector('.route-dd')`);
    await press(
      `the ${entry} entry`,
      `[...document.querySelectorAll('.u-select-option, .dd-option, .dd-menu button, [role="option"], [role="menuitemradio"], .menu-row')].find((o) => o.textContent.includes(${JSON.stringify(entry)}))`,
    );
    await driver.settle();
  };
  const modeButton = `[...document.querySelectorAll('.ai-header .ai-mode-button')].find((b) => /design mode/i.test(b.getAttribute('aria-label') || ''))`;
  const pressDesignMode = async () => {
    await driver.evaluate(
      `document.querySelector('.ai-mode-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
    await press('the Design mode button', modeButton);
  };
  /**
   * Watches from now: waits for `arrived`, then samples for WATCH_MS. The page wanted must hold for all of it, and
   * no frame may show anything else at any time, from the first sample on.
   */
  const watch = async (label, mode, want) => {
    const matches = (sample) =>
      sample.mode === mode &&
      sample.editor === want.editor &&
      sample.entry === want.entry &&
      sample.preview === want.preview &&
      (mode === 'off' || sample.frames.includes(want.heading));
    const strayFrames = new Set();
    const left = [];
    let arrivedAt;
    let last;
    const started = Date.now();
    const take = async () => {
      const sample = await driver.evaluate(SAMPLE).catch(() => undefined);
      if (sample !== undefined) {
        last = sample;
        for (const shown of sample.frames) {
          if (shown !== want.heading) {
            strayFrames.add(`${shown} while ${sample.mode}`);
          }
        }
        if (matches(sample)) {
          arrivedAt ??= Date.now();
        } else if (arrivedAt !== undefined) {
          left.push(sample);
        }
      }
    };
    // Sampled until the page has been watched for long enough after arriving, or it never arrives.
    await pollUntil({
      what: `${label}: watched`,
      read: take,
      until: () => (arrivedAt === undefined ? Date.now() - started >= ARRIVE_MS_MAX : Date.now() - arrivedAt >= WATCH_MS),
      pollIntervalMs: SAMPLE_MS,
      pollCountMax: (ARRIVE_MS_MAX + WATCH_MS) / SAMPLE_MS,
    });
    report.watched[label] = { arrivedAfterMs: arrivedAt === undefined ? undefined : arrivedAt - started, last };
    check(`${label}: arrives on the page`, arrivedAt !== undefined, JSON.stringify(last));
    check(`${label}: nothing navigates away for ${WATCH_MS / 1000} s`, arrivedAt !== undefined && left.length === 0, JSON.stringify(left.slice(0, 2)));
    check(`${label}: no frame ever shows another page`, strayFrames.size === 0, [...strayFrames].join(', '));
    await driver.screenshot(path.join(options.outDirectory, `${label.replace(/\W+/g, '-')}.png`)).catch(() => undefined);
  };
  const run = async (what, act) => {
    try {
      await act();
    } catch (error) {
      console.log(`CHECK FAIL ${what}: ${String(error && error.message ? error.message : error).slice(0, 300)}`);
      report.failures.push(`${what}: ${String(error && error.message ? error.message : error)}`);
    }
  };
  const enter = async (label, want) => {
    await pressDesignMode();
    await watch(`${label}, entering`, 'on', want);
    await reopened();
  };
  const exit = async (label, want) => {
    await press('Exit', `document.querySelector('.dm-bar .dm-exit')`);
    await watch(`${label}, after Exit`, 'off', want);
    await reopened();
  };

  await reopened();
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    fs.writeFileSync(path.join(project, relative), text);
  };
  write('src/pages/docs/guide.astro', page('Nested guide page'));
  write('src/pages/about.astro', page('About page'));
  write('src/pages/blog/[slug].astro', DYNAMIC);
  const NESTED = { editor: 'guide', entry: '', preview: '/docs/guide', heading: 'Nested guide page' };
  const ABOUT = { editor: 'about', entry: '', preview: '/about', heading: 'About page' };
  const POST = { editor: 'Blog Template', entry: 'second-post', preview: '/blog/second-post', heading: 'Post second-post' };
  await until('the new pages in the switcher', `(() => { const b = document.querySelector('.page-switch-btn'); if (!b) return false; return true; })()`);
  // The editor reads the new files and settles: what it shows holds still before the first page is picked.
  await waitForSteady({
    what: 'the editor to settle on the new files',
    read: () => driver.evaluate(SAMPLE),
    until: () => true,
    pollIntervalMs: SAMPLE_MS,
    steadyPollCount: STARTUP_STEADY_POLLS,
    pollCountMax: WAIT_MS_MAX / SAMPLE_MS,
  });

  await run('a nested page', async () => {
    await switchTo('/docs/guide');
    await enter('nested page', NESTED);
    await exit('nested page', NESTED);
  });

  await run('a dynamic route on its second entry', async () => {
    await switchTo('/blog/[slug]');
    await until('the entry list', `!!document.querySelector('.route-dd')`);
    await pickEntry('second-post');
    await enter('dynamic entry', POST);
    await exit('dynamic entry', POST);
  });

  if (process.env.DM_PAGES_FIRST === '1') {
    fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, null, 2));
    return 0;
  }

  await run('frames kept on another page, and switching pages inside the mode', async () => {
    await switchTo('/about');
    // The kept frame was last drawn on the blog entry: it must come back showing this page, not that one.
    await enter('another page than last time', ABOUT);
    await switchTo('/docs/guide');
    await watch('switching pages inside Design mode', 'on', NESTED);
    // With a second frame that changes nothing, both show the page switched to.
    await press('the frame name', `document.querySelector('.dm-title-name')`);
    await driver.settle();
    await driver.key('d', { modifiers: ['meta'] });
    await until('two frames', `document.querySelectorAll('.dm-tile').length === 2`);
    await driver.settle();
    await switchTo('/about');
    await watch('switching with two frames', 'on', ABOUT);
    const both = await driver.evaluate(SAMPLE);
    check('both unchanged frames show the page switched to', both.frames.length === 2, JSON.stringify(both.frames));
    // Exit goes back to the page now open, not the one the mode was entered on.
    await exit('left on a page switched to inside', ABOUT);
  });

  await run('Send to AI comes back to the same page', async () => {
    await switchTo('/docs/guide');
    await enter('before Send to AI', NESTED);
    await press('Send to AI', `document.querySelector('.dm-bar .dm-send')`);
    await watch('after Send to AI', 'off', NESTED);
    await reopened();
  });

  await run('a component opened from a page enters on that page', async () => {
    await switchTo('/about');
    await press('the Navigator button', `[...document.querySelectorAll('.rail button')].find((b) => /navigator/i.test(b.getAttribute('aria-label') || ''))`);
    await press('the layout row', `[...document.querySelectorAll('.structure-node')].find((n) => /layout/i.test(n.textContent))`);
    await press('Edit component', `document.querySelector('.node-outline-edit')`);
    await driver.settle();
    await enter('a component opened from a page', ABOUT);
    await exit('after the component case', ABOUT);
  });

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
