// Getting the preview back after a compile error.
//
//   node test/preview-recovery.js
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

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- The probe, against a server that really answers ----------------------
  {
    const { probeUrl } = require('../electron/devProbe.js');

    // Flips between serving a page and serving an error, like a dev server
    // either side of a compile error.
    let mode = 'ok';
    const server = http.createServer((req, res) => {
      // Where a redirect lands always serves — otherwise the redirect below
      // points at itself and the fetch dies of a loop, which would be this
      // test's bug rather than the probe's.
      if (req.url === '/landed') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>landed</body></html>');
        return;
      }
      if (mode === 'error') {
        // Astro's error screen: a 5xx with a big HTML body.
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body>${'x'.repeat(50000)}</body></html>`);
        return;
      }
      if (mode === 'redirect') {
        res.writeHead(302, { Location: '/landed' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>the page</body></html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
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
    await new Promise((r) => server.close(r));
    const gone = await probeUrl(`${base}/`);
    check('an unreachable server is not ok', gone.ok === false, JSON.stringify(gone));
    check('and does not throw', gone.status === 0, JSON.stringify(gone));

    check('a missing url is not ok', (await probeUrl('')).ok === false);
    check('and neither is a nonsense one', (await probeUrl('not a url')).ok === false);
  }

  // --- The watch ------------------------------------------------------------
  const { createPreviewWatch } = await (async () => {
    const esbuild = require('esbuild');
    const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
    fs.mkdirSync(buildDir, { recursive: true });
    const out = path.join(buildDir, 'preview-recovery.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'previewRecovery.js')],
      outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent',
    });
    return require(out);
  })();

  // A stand-in dev server whose answer is set by the test.
  const makeWatch = (answers) => {
    const asked = [];
    let reloads = 0;
    const watch = createPreviewWatch({
      probe: async () => {
        const next = answers.length > 1 ? answers.shift() : answers[0];
        asked.push(next);
        return next;
      },
      onRecover: () => { reloads++ },
      retryMs: 20,
      settleMs: 5,
    });
    return { watch, asked, reloads: () => reloads };
  };

  // --- An ordinary edit: nothing was broken, so nothing reloads -------------
  {
    const t = makeWatch([{ ok: true }]);
    t.watch.poke();
    await sleep(80);
    check('a healthy preview is asked about', t.asked.length >= 1, JSON.stringify(t.asked));
    check('and is not reloaded', t.reloads() === 0, `${t.reloads()} reloads`);
    // Repeatedly, because this is what every keystroke does.
    for (let i = 0; i < 5; i++) { t.watch.poke(); await sleep(15) }
    check('and stays un-reloaded across many edits', t.reloads() === 0, `${t.reloads()} reloads`);
    t.watch.stop();
  }

  // --- Broken, then fixed ---------------------------------------------------
  {
    // Still compiling for the first two asks, then serving.
    const t = makeWatch([{ ok: false }, { ok: false }, { ok: true }]);
    t.watch.poke();
    await sleep(200);
    check('a broken preview keeps being asked about', t.asked.length >= 3, JSON.stringify(t.asked));
    check('and is reloaded once it serves again', t.reloads() === 1, `${t.reloads()} reloads`);
    // And exactly once — a second reload would be a loop.
    await sleep(120);
    check('exactly once', t.reloads() === 1, `${t.reloads()} reloads`);
    t.watch.stop();
  }

  // --- It gives up asking when it recovers ----------------------------------
  {
    const t = makeWatch([{ ok: false }, { ok: true }]);
    t.watch.poke();
    await sleep(120);
    const settled = t.asked.length;
    await sleep(150);
    check('a recovered preview stops being polled', t.asked.length === settled, `${settled} → ${t.asked.length} asks`);
    t.watch.stop();
  }

  // --- A probe that throws ---------------------------------------------------
  {
    let reloads = 0;
    let asks = 0;
    const watch = createPreviewWatch({
      probe: async () => { asks++; if (asks < 3) throw new Error('no server'); return { ok: true } },
      onRecover: () => { reloads++ },
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
    const t = makeWatch([{ ok: false }]);
    t.watch.poke();
    await sleep(60);
    const seen = t.asked.length;
    t.watch.stop();
    await sleep(120);
    check('stopping ends the polling', t.asked.length === seen, `${seen} → ${t.asked.length} asks after stop`);
    check('and a poke afterwards does nothing', (t.watch.poke(), await sleep(40), t.asked.length === seen), `${t.asked.length} asks`);
  }

  // --- who asks the first question -------------------------------------------
  //
  // The watcher is fs.watch inside main.js, wired to an ipc handler; standing
  // one up here would be testing the harness. What is checked is the shape of
  // the rule: every change under src/ says so, before any of the branches that
  // return for the kinds this app does not edit.
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    const at = main.indexOf('watcher = fs.watch(srcDir');
    const handler = main.slice(at, main.indexOf("// Watch public/ too", at));
    check('the src watcher is still there', at !== -1);
    const poke = handler.indexOf('notePageMayHaveChanged()');
    const firstBranchReturn = handler.indexOf('return;', handler.indexOf('.json$'));
    check('a change under src says the site may have changed', poke !== -1, handler.slice(0, 300));
    check(
      'before anything decides the kind is not interesting',
      poke !== -1 && firstBranchReturn !== -1 && poke < firstBranchReturn,
      `poke at ${poke}, first return at ${firstBranchReturn}`
    );
    check(
      'and not for the app’s own writes, which say it themselves',
      /if \(!\(mine && Date\.now\(\) - mine < 1000\)\) notePageMayHaveChanged\(\);/.test(handler),
      handler.slice(0, 400)
    );
    check(
      'a write the app makes says it through markSelfWrite',
      /function markSelfWrite\(p\) \{[\s\S]{0,160}notePageMayHaveChanged\(\);/.test(main),
      'an in-app write would go unannounced'
    );
  }

  if (failures.length) {
    console.error(`preview-recovery: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`preview-recovery: ${checked} passed  [real 500s, and the edge]`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
