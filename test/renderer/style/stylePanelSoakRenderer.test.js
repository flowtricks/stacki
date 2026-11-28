// Goal: two soak runs at once never share the renderer's pre-bundled dependencies. The gate
// runs soak suites side by side; when their Vite servers wrote one cache, one run's optimizer
// replaced the chunks another was serving, and with HMR off that app was never told to reload:
// it drew nothing ("the canvas never rendered the fixture") or lost the Style panel
// ("Failed to fetch dynamically imported module").
//
// Method: start two renderer servers as the soak starts them (soakLaunch.js), each for a run
// directory of its own. Through each server, over HTTP, fetch the app's entry module and one
// pre-bundled dependency it imports: that dependency must come from that run's own directory
// (and be served although it lies outside the renderer root). Then delete the first run's
// directory, as a finished run does, and fetch the second run's dependency again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('../../helpers/sources.js');
const { startRendererServer } = require('../../helpers/e2e/soakLaunch.js');
const { pollUntil } = require('../../helpers/waitFor.js');

const ENTRY = 'src/app/main.tsx';

async function get(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

// The URL of React as the transformed entry module imports it: a pre-bundled dependency.
async function dependencyUrl(server) {
  const entry = await get(new URL(entryPath(), server.url));
  assert.equal(entry.status, 200, 'the entry module is served');
  const found = /["']([^"']*\/deps\/react\.js[^"']*)["']/.exec(entry.body);
  assert.ok(found, `the entry imports the pre-bundled React: ${entry.body.slice(0, 600)}`);
  return new URL(found[1], server.url);
}

// The module index.html loads, so the test follows the app if its entry moves.
function entryPath() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const found = /<script type="module" src="([^"]+)"/.exec(html);
  return found ? found[1] : ENTRY;
}

(async () => {
  const base = fs.realpathSync(os.tmpdir());
  const runs = [fs.mkdtempSync(path.join(base, 'stacki-soak-renderer-a-')), fs.mkdtempSync(path.join(base, 'stacki-soak-renderer-b-'))];
  const servers = [];
  try {
    for (const run of runs) {
      servers.push(await startRendererServer(ROOT, run));
    }
    const dependencies = [];
    for (const [index, renderer] of servers.entries()) {
      const cacheDirectory = renderer.server.config.cacheDir;
      assert.ok(cacheDirectory.startsWith(runs[index] + path.sep), `run ${index} writes its cache inside its own directory, not ${cacheDirectory}`);
      const url = await dependencyUrl(renderer);
      // The optimizer may still be writing: the request is what a page would make, polled (bounded).
      const served = await pollUntil({
        what: `run ${index}: the pre-bundled dependency`,
        read: () => get(url),
        until: (answer) => answer.status === 200,
        pollCountMax: 600,
      });
      assert.equal(served.value.status, 200, `run ${index} serves its dependency (${url.pathname}): ${served.value.body.slice(0, 300)}`);
      dependencies.push(url);
    }
    await servers[0].server.close();
    fs.rmSync(runs[0], { recursive: true, force: true });
    const after = await get(dependencies[1]);
    assert.equal(after.status, 200, 'the second run still serves its dependency after the first run is removed');
    console.log('ok - each soak run pre-bundles into a cache of its own');
  } finally {
    for (const renderer of servers) {
      await renderer.server.close();
    }
    for (const run of runs) {
      fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
