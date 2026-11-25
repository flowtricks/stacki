// The dev server probe and the app's announcement of changes, the inputs of canvas recovery.
//
//   node test/renderer/preview/previewRecovery.test.js
//
// A compile error replaces the site with the dev server's error screen, which has no HMR client, so the
// canvas has to be told about the fix. The controller that does so is tested in canvasRecovery.test.js
// (a fake clock) and test/integration/canvasRecovery.js (a real dev server). What stays here is what they
// rely on: the HTTP probe against a real server that answers 200, 500, a redirect and nothing, and the
// wiring in main that says "the site may have changed" for every write the app makes and every change
// made outside it, before any branch that returns for a kind of file the app does not edit.

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

  // --- who says the site may have changed -------------------------------------
  //
  // The watcher is fs.watch inside main, wired to an ipc handler; standing one up here would be testing the
  // harness. What is checked is the shape of the rule in the source: every change under src/ that is not the
  // app's own write says so, before the branch that decides which panel cares, and an app write says it too.
  {
    const watcher = fs.readFileSync(repoPath('electron/project/projectWatcher.ts'), 'utf8');
    const main = fs.readFileSync(repoPath('electron/main.ts'), 'utf8');
    const external = watcher.indexOf('noteExternalChange(changed);');
    const poke = watcher.indexOf('notePageMayHaveChanged(true);', external);
    const channel = watcher.indexOf('sourceChangeChannel(', external);
    check('the src watcher says an outside change may have changed the site', external !== -1 && poke !== -1, 'no announcement after the self-write check');
    check(
      'before anything decides the kind is not interesting',
      poke !== -1 && channel !== -1 && poke < channel,
      `poke at ${poke}, first return at ${channel}`,
    );
    check(
      'and not for the app’s own writes, which say it themselves',
      /if \(isSelfWrite\(changed\)\) \{(?:(?!notePageMayHaveChanged)[\s\S])*?return;\s*\}/.test(watcher),
      'a self write must return before it announces',
    );
    check(
      'a write the app makes says it through noteAppWrite',
      /function noteAppWrite\([^)]*\)[^{]*\{[\s\S]{0,160}notePageMayHaveChanged\(\);/.test(main),
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
