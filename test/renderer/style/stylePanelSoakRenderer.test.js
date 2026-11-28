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
//
// The servers do not read ahead (preTransformRequests): by default Vite goes on transforming the whole app after
// the one module asked for, so a server was closed with dozens of requests in hand, and Vite 6's close waits for
// them without a limit (closed before its optimizer settles, it never returns). Every request, the teardown and
// the process's exit are bounded here, each failure saying what was still open: a Windows run printed its pass
// and was killed 600 s later with nothing to say why. A close that never settles with nothing else to keep Node
// running would otherwise end the process with status 0, so a run that did not finish fails as it exits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('../../helpers/sources.js');
const { startRendererServer } = require('../../helpers/e2e/soakLaunch.js');
const { pollUntil } = require('../../helpers/waitFor.js');

const ENTRY = 'src/app/main.tsx';
// Each far under the 600 s at which the runner kills a suite without a word. The whole test takes seconds; a
// request waits for a cold optimizer, a close and the exit only for work already done.
const REQUEST_MS_MAX = 120_000;
const CLOSE_MS_MAX = 30_000;
const EXIT_MS_MAX = 30_000;
const RUN_MS_MAX = 420_000;
const LISTED_MAX = 40;

const started = [];
let step = 'starting';
let finished = false;

function note(next) {
  step = next;
  console.log(`# ${new Date().toISOString()} ${step}`);
}

// What the process still has open, and what each server still has in hand. Vite's and Node's underscored fields
// are read only here, to say why something did not end; nothing is asserted on them.
function openState() {
  const servers = started.map((renderer, index) => {
    const environments = Object.entries(renderer.server.environments).map(([name, environment]) => {
      const pending = [...(environment._pendingRequests?.keys() ?? [])];
      const scanning = environment.depsOptimizer?.scanProcessing !== undefined;
      return `${name}: scanning=${scanning} pending=${pending.length} ${pending.slice(0, LISTED_MAX).join(' ')}`;
    });
    return `server ${index} listening=${renderer.server.httpServer?.listening} ${environments.join(' | ')}`;
  });
  const handles = (process._getActiveHandles?.() ?? []).slice(0, LISTED_MAX).map((handle) => {
    const kind = handle.constructor?.name ?? 'unknown';
    if (handle.spawnfile !== undefined) {
      return `${kind} pid=${handle.pid} exit=${handle.exitCode} ${handle.spawnargs?.join(' ')}`;
    }
    return handle.remotePort === undefined ? kind : `${kind} ${handle.localPort}->${handle.remotePort}`;
  });
  return [`last step: ${step}`, ...servers, `resources: ${process.getActiveResourcesInfo().join(',')}`, 'handles:', ...handles].join('\n  ');
}

function giveUp(why) {
  fs.writeSync(2, `not ok - ${why}\n  ${openState()}\n`);
  process.exit(1);
}

async function bounded(what, work, msMax) {
  note(what);
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not end within ${msMax} ms\n  ${openState()}`)), msMax);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS_MAX) }).catch((error) => {
    throw new Error(`GET ${url} failed: ${String(error)}\n  ${openState()}`);
  });
  return { status: response.status, body: await response.text() };
}

// One teardown for every ending: each step runs whether or not an earlier one failed, and the failures are
// thrown together afterwards.
async function tearDown(runs) {
  const failures = [];
  const attempt = async (what, work) => {
    try {
      await bounded(what, work, CLOSE_MS_MAX);
    } catch (error) {
      failures.push(error);
    }
  };
  for (const [index, renderer] of started.entries()) {
    await attempt(`closing server ${index}`, () => renderer.server.close());
  }
  for (const [index, run] of runs.entries()) {
    await attempt(`removing run directory ${index}`, () => fs.promises.rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'the teardown did not complete');
  }
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

// Neither timer keeps the process running: each fires only if something else still does.
setTimeout(() => giveUp(`the test did not end within ${RUN_MS_MAX} ms`), RUN_MS_MAX).unref();
process.on('exit', (code) => {
  if (code === 0 && !finished) {
    fs.writeSync(2, `not ok - Node ran out of work before the test finished\n  ${openState()}\n`);
    process.exitCode = 1;
  }
});

(async () => {
  const base = fs.realpathSync(os.tmpdir());
  const runs = [fs.mkdtempSync(path.join(base, 'stacki-soak-renderer-a-')), fs.mkdtempSync(path.join(base, 'stacki-soak-renderer-b-'))];
  try {
    for (const [index, run] of runs.entries()) {
      note(`starting server ${index}`);
      started.push(await startRendererServer(ROOT, run, { preTransformRequests: false }));
    }
    const dependencies = [];
    for (const [index, renderer] of started.entries()) {
      const cacheDirectory = renderer.server.config.cacheDir;
      // Vite reports the directory with forward slashes on every platform, so the two are compared as paths, not text.
      assert.equal(path.relative(runs[index], cacheDirectory), 'vite-cache', `run ${index} writes its cache inside its own directory, not ${cacheDirectory}`);
      note(`run ${index}: asking for the entry module`);
      const url = await dependencyUrl(renderer);
      // The optimizer may still be writing: the request is what a page would make, polled (bounded).
      note(`run ${index}: asking for the pre-bundled dependency`);
      const served = await pollUntil({
        what: `run ${index}: the pre-bundled dependency`,
        read: () => get(url),
        until: (answer) => answer.status === 200,
        pollCountMax: 600,
      });
      assert.equal(served.value.status, 200, `run ${index} serves its dependency (${url.pathname}): ${served.value.body.slice(0, 300)}`);
      dependencies.push(url);
    }
    await bounded('closing the first run’s server', () => started[0].server.close(), CLOSE_MS_MAX);
    // Windows holds files a moment after the server closes.
    fs.rmSync(runs[0], { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    note('asking the second run for its dependency again');
    const after = await get(dependencies[1]);
    assert.equal(after.status, 200, 'the second run still serves its dependency after the first run is removed');
    console.log('ok - each soak run pre-bundles into a cache of its own');
  } finally {
    await tearDown(runs);
  }
  finished = true;
  note('finished; waiting for the process to exit');
  setTimeout(() => giveUp(`the process did not exit within ${EXIT_MS_MAX} ms of the test ending`), EXIT_MS_MAX).unref();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
