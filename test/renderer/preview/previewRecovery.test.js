// Getting the preview back after a compile error.
//
//   node test/renderer/preview/previewRecovery.test.js
//
// A compile error replaces the site with the dev server's error screen. That
// screen has no HMR client in it, so when the mistake is fixed nothing tells it
// — the preview goes on showing the error until someone presses refresh. So the
// app asks the dev server whether it is serving a page again, and reloads the
// frame when it is.
//
// Two ways for that to be quietly wrong, and both look like a working feature:
//
//   Reload too eagerly — on every probe rather than on the not-serving →
//   serving edge — and every edit becomes a full page reload, throwing away the
//   live patching the app does instead.
//
//   Ask once and give up. A fix takes a moment to compile, so the first ask
//   almost always lands while the error is still there; a watch that doesn't
//   come back leaves the preview stuck exactly as before.
//
//   Never ask at all. The poll only starts once a probe has FAILED, so
//   something has to ask the first question — and the app said "the site may
//   have changed" only for the file kinds it edits itself. Break a .ts a
//   component imports, in an editor, and the preview goes to the error screen
//   with nothing that will ever ask again.
//
// The probe half is checked against a real HTTP server, because the thing being
// relied on is what a 500 and an unreachable port actually do.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // --- The probe, against a server that really answers ----------------------
  {
    const { probeUrl } = require('#dist/electron/preview/devProbe.js');

    // Flips between serving a page and serving an error, like a dev server
    // either side of a compile error.
    let mode = 'ok';
    const server = http.createServer((request, response) => {
      // Where a redirect lands always serves — otherwise the redirect below
      // points at itself and the fetch dies of a loop, which would be this
      // test's bug rather than the probe's.
      if (request.url === '/landed') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html><body>landed</body></html>');
        return;
      }
      if (mode === 'error') {
        // Astro's error screen: a 5xx with a big HTML body.
        response.writeHead(500, { 'Content-Type': 'text/html' });
        response.end(`<html><body>${'x'.repeat(50000)}</body></html>`);
        return;
      }
      if (mode === 'redirect') {
        response.writeHead(302, { Location: '/landed' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html><body>the page</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    check('a served page is ok', (await probeUrl(`${base}/`)).ok === true);
    check('and reports its status', (await probeUrl(`${base}/`)).status === 200);

    mode = 'error';
    const bad = await probeUrl(`${base}/`);
    check('an error screen is not ok', bad.ok === false, JSON.stringify(bad));
    check('and reports the 500', bad.status === 500, JSON.stringify(bad));

    // A redirect is still the server serving something — following it is what a
    // browser would do, so the verdict has to match what the frame will see.
    mode = 'redirect';
    const red = await probeUrl(`${base}/`);
    check('a redirect is followed to what it lands on', red.ok === true && red.status === 200, JSON.stringify(red));

    mode = 'ok';
    check('and recovering reads as ok again', (await probeUrl(`${base}/`)).ok === true);

    // A server that isn't there yet is not a page either — the same verdict, so
    // the watch keeps asking rather than deciding it has recovered.
    await new Promise((resolve) => server.close(resolve));
    const gone = await probeUrl(`${base}/`);
    check('an unreachable server is not ok', gone.ok === false, JSON.stringify(gone));
    check('and does not throw', gone.status === 0, JSON.stringify(gone));

    check('a missing url is not ok', (await probeUrl('')).ok === false);
    check('and neither is a nonsense one', (await probeUrl('not a url')).ok === false);
  }

  // --- The watch ------------------------------------------------------------
  const { createPreviewWatch } = await (async () => {
    const esbuild = require('esbuild');
    const buildDirectory = repoPath('node_modules/.stacki-test');
    fs.mkdirSync(buildDirectory, { recursive: true });
    const out = path.join(buildDirectory, 'preview-recovery.bundle.js');
    await esbuild.build({
      entryPoints: [repoPath('src/features/preview/previewRecovery.ts')],
      outfile: out,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    return require(out);
  })();

  // A stand-in dev server whose answer is set by the test.
  const makeWatch = (answers, extra = {}) => {
    const asked = [];
    let reloads = 0;
    const watch = createPreviewWatch({
      probe: async () => {
        const next = answers.length > 1 ? answers.shift() : answers[0];
        asked.push(next);
        return next;
      },
      onRecover: () => {
        reloads++;
      },
      retryMs: 20,
      settleMs: 5,
      quietMs: 120,
      ...extra,
    });
    return { watch, asked, reloads: () => reloads };
  };

  // The initial frame failed, but Astro recovered before the first probe.
  // A later healthy probe must reload that empty document exactly once.
  {
    const harness = makeWatch([{ ok: true }]);
    harness.watch.failed();
    await sleep(40);
    check('a known frame failure recovers on an already healthy server', harness.reloads() === 1);
    harness.watch.poke();
    await sleep(30);
    check('the successful retry does not create a reload loop', harness.reloads() === 1);
    harness.watch.failed();
    await sleep(40);
    check('a second failure bypasses the healthy quiet period', harness.reloads() === 2);
    harness.watch.stop();
    harness.watch.failed();
    await sleep(30);
    check('a closed project cannot restart recovery', harness.reloads() === 2);
  }

  // --- An ordinary edit: nothing was broken, so nothing reloads -------------
  {
    const harness = makeWatch([{ ok: true }]);
    harness.watch.poke();
    await sleep(80);
    check('a healthy preview is asked about', harness.asked.length >= 1, JSON.stringify(harness.asked));
    check('and is not reloaded', harness.reloads() === 0, `${harness.reloads()} reloads`);
    // Repeatedly, because this is what every keystroke does.
    for (let i = 0; i < 5; i++) {
      harness.watch.poke();
      await sleep(15);
    }
    check('and stays un-reloaded across many edits', harness.reloads() === 0, `${harness.reloads()} reloads`);
    harness.watch.stop();
  }

  // --- Asking costs a page --------------------------------------------------
  //
  // The only way to ask "is the dev server serving a page" is to request the
  // page, which makes the server render the whole thing for a status code. On
  // a big page that is a third of a second of the server's attention, and it
  // was spent on every write the app made — so the canvas waited behind a
  // render nobody wanted to see, to be shown the one it did. A variant hovered
  // in a dropdown paid for two renders and showed one.
  {
    const harness = makeWatch([{ ok: true }]);
    for (let i = 0; i < 6; i++) {
      harness.watch.poke();
      await sleep(10);
    }
    await sleep(60);
    check('a healthy preview is asked about once, not once per edit', harness.asked.length === 1, `${harness.asked.length} asks`);
    // …but not never: it is how a breakage is noticed at all.
    await sleep(140);
    harness.watch.poke();
    await sleep(40);
    check('and again once the quiet spell is over', harness.asked.length === 2, `${harness.asked.length} asks`);
    harness.watch.stop();
  }
  {
    // A broken preview is a different matter: nothing is being rendered but an
    // error screen, and the answer is the whole point. The retry is held off
    // here so that what is measured is the poke and not the loop.
    const harness = makeWatch([{ ok: false }], { retryMs: 5000 });
    harness.watch.poke();
    await sleep(40);
    const first = harness.asked.length;
    check('a broken preview is asked about', first === 1, `${first} asks`);
    harness.watch.poke();
    await sleep(40);
    check('and asked again on the next edit, quiet spell or not', harness.asked.length === 2, `${first} → ${harness.asked.length}`);
    harness.watch.stop();
  }

  // --- Broken, then fixed ---------------------------------------------------
  {
    // Still compiling for the first two asks, then serving.
    const harness = makeWatch([{ ok: false }, { ok: false }, { ok: true }]);
    harness.watch.poke();
    await sleep(200);
    check('a broken preview keeps being asked about', harness.asked.length >= 3, JSON.stringify(harness.asked));
    check('and is reloaded once it serves again', harness.reloads() === 1, `${harness.reloads()} reloads`);
    // And exactly once — a second reload would be a loop.
    await sleep(120);
    check('exactly once', harness.reloads() === 1, `${harness.reloads()} reloads`);
    harness.watch.stop();
  }

  // --- It gives up asking when it recovers ----------------------------------
  {
    const harness = makeWatch([{ ok: false }, { ok: true }]);
    harness.watch.poke();
    await sleep(120);
    const settled = harness.asked.length;
    await sleep(150);
    check('a recovered preview stops being polled', harness.asked.length === settled, `${settled} → ${harness.asked.length} asks`);
    harness.watch.stop();
  }

  // --- A probe that throws ---------------------------------------------------
  {
    let reloads = 0;
    let asks = 0;
    const watch = createPreviewWatch({
      probe: async () => {
        asks++;
        if (asks < 3) {
          throw new Error('no server');
        }
        return { ok: true };
      },
      onRecover: () => {
        reloads++;
      },
      retryMs: 20,
      settleMs: 5,
    });
    watch.poke();
    await sleep(200);
    check('a throwing probe counts as not serving', asks >= 3, `${asks} asks`);
    check('and recovery still lands', reloads === 1, `${reloads} reloads`);
    watch.stop();
  }

  // --- Stopping means stopping ----------------------------------------------
  {
    const harness = makeWatch([{ ok: false }]);
    harness.watch.poke();
    await sleep(60);
    const seen = harness.asked.length;
    harness.watch.stop();
    await sleep(120);
    check('stopping ends the polling', harness.asked.length === seen, `${seen} → ${harness.asked.length} asks after stop`);
    check('and a poke afterwards does nothing', (harness.watch.poke(), await sleep(40), harness.asked.length === seen), `${harness.asked.length} asks`);
  }

  // --- who asks the first question -------------------------------------------
  //
  // The watcher is fs.watch inside main.js, wired to an ipc handler; standing
  // one up here would be testing the harness. What is checked is the shape of
  // the rule: every change under src/ says so, before any of the branches that
  // return for the kinds this app does not edit.
  {
    const main = fs.readFileSync(repoPath('dist/electron/main.js'), 'utf8');
    const source = fs.readFileSync(repoPath('dist/electron/project/projectWatcher.js'), 'utf8');
    const at = source.indexOf('watchers.push(watch(sourceDirectory');
    const handler = source.slice(at, source.indexOf('const publicDir', at));
    check('the src watcher is still there', at !== -1);
    // `(true)` — the watcher only ever hears about changes the app did not
    // make, and saying which kind it was is what lets the canvas be told
    // directly (see test/electron/previewClient/outsideEdit.test.js).
    const poke = handler.indexOf('notePageMayHaveChanged(true)');
    const firstBranchReturn = handler.indexOf('sourceChangeChannel(');
    check('a change under src says the site may have changed', poke !== -1, handler.slice(0, 300));
    check(
      'before anything decides the kind is not interesting',
      poke !== -1 && firstBranchReturn !== -1 && poke < firstBranchReturn,
      `poke at ${poke}, first return at ${firstBranchReturn}`,
    );
    check(
      'and not for the app’s own writes, which say it themselves',
      new RegExp(
        // The self-write branch may tell the Variables panel; it may not poke the page.
        String.raw`if \(isSelfWrite\(changed\)\) \{(?:(?!notePageMayHaveChanged)[\s\S])*?return;\s*\}\s*` +
          String.raw`noteExternalChange\(changed\);\s*notePageMayHaveChanged\(true\);`,
      ).test(handler),
      handler.slice(0, 400),
    );
    check(
      'a write the app makes says it through noteAppWrite',
      /function noteAppWrite\(\)[^{]*\{[\s\S]{0,160}notePageMayHaveChanged\(\);/.test(main),
      'an in-app write would go unannounced',
    );
  }

  if (failures.length) {
    console.error(`preview-recovery: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`preview-recovery: ${checked} passed  [real 500s, and the edge]`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
