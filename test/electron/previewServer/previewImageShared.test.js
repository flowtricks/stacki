// An image on show survives another frame asking for it and leaving before the answer.
//
//   node test/electron/previewServer/previewImageShared.test.js
//
// On a project's first open the canvas image went blank, only its background colour left, and stayed
// blank until the page was loaded again. The palette's snapshot frames render components in the same
// Chromium process, and one that showed the same image was replaced while still asking for it. The
// server sent images with `no-cache` and an ETag, so Chromium revalidated the one copy it shared
// between the documents, and cancelling that request failed the copy the canvas was showing.
//
// Method: a real Electron window (jsdom has neither an image cache nor frames that cancel loads) shows
// a page with an image from a local server. A same-origin frame then asks for the same address, the
// server holds that answer, and the frame is removed. The page's image must still have its picture.
// The server runs the built plugin's own middleware (previewServer/previewImageCache.ts) in front of
// handlers that answer as the dev server does: the image endpoint with a year-long header, a public
// file with `no-cache`. Both carry an ETag. A control without the plugin, answering `no-cache`, must
// go blank: it proves the harness still reproduces the fault the plugin prevents.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>';
const IMAGE_WIDTH = 40;
// Each wait is a poll of a condition, at most this many polls at this interval.
const WAIT = { pollIntervalMs: 20, pollCountMax: 500 };

const CASES = [
  { name: 'the image endpoint', url: '/_image?href=%2Fa.svg', header: 'public, max-age=31536000', plugin: true, widthAfter: IMAGE_WIDTH },
  { name: 'a public file', url: '/images/a.svg', header: 'no-cache', plugin: true, widthAfter: IMAGE_WIDTH },
  { name: 'the control without the plugin', url: '/control/a.svg', header: 'no-cache', plugin: false, widthAfter: 0 },
];

async function probe() {
  const { app, BrowserWindow } = require('electron');
  const http = require('http');
  const assert = require('assert/strict');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-image-shared-')));
  app.dock?.hide();
  const { previewImageCachePlugin } = require(repoPath('dist/electron/previewServer/previewImageCache.js'));
  let middleware;
  previewImageCachePlugin(undefined).configureServer({ middlewares: { use: (handler) => (middleware = handler) } });
  let current;
  let held = false;
  let heldCount = 0;
  let cancelledCount = 0;
  const server = http.createServer((request, response) => {
    const answer = () => {
      if (!request.url.startsWith(current.url.split('?')[0])) {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end(`<!doctype html><img id="picture" src="${current.url}">`);
        return;
      }
      if (held) {
        heldCount += 1; // Never answered: it is still in flight when its frame leaves.
        response.once('close', () => (cancelledCount += 1));
        return;
      }
      response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': current.header, etag: '"one"' });
      response.end(IMAGE);
    };
    if (current.plugin) {
      middleware(request, response, answer);
    } else {
      answer();
    }
  });
  const until = (what, condition) => waitFor({ ...WAIT, what, read: condition, until: Boolean });
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false });
  const page = (script) => window.webContents.executeJavaScript(script);
  const results = [];
  for (const [index, entry] of CASES.entries()) {
    current = entry;
    held = false;
    heldCount = 0;
    cancelledCount = 0;
    await window.loadURL(`${base}/page-${index}`);
    await until(`${entry.name}: the image loads`, () => page('picture.complete && picture.naturalWidth > 0'));
    held = true;
    await page(`window.frame = document.createElement('iframe'); frame.src = '/frame-${index}'; document.body.append(frame); true`);
    // The frame either asks again or, were the copy reused unasked, never does: the check below says which.
    await until(`${entry.name}: the frame asks for the image`, () => heldCount > 0);
    await page('frame.remove(); true');
    // The cancel has reached the server, and a request the page made after that has come back, so the page has heard
    // of it. The control shows this is late enough: without the plugin its picture is gone by now.
    await until(`${entry.name}: the held request is cancelled`, () => cancelledCount === heldCount);
    await page(`fetch('/after-cancel-${index}', { cache: 'no-store' }).then((reply) => reply.text()).then(() => true)`);
    results.push({ name: entry.name, widthAfter: await page('picture.naturalWidth') });
  }
  assert.equal(results.length, CASES.length);
  server.closeAllConnections();
  server.close();
  process.stdout.write(`RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}

function main() {
  const { runElectronProbe } = require('../../helpers/electronProbe.js');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = runElectronProbe(require('electron'), [__filename, '--use-mock-keychain'], { env: environment });
  const line = String(run.stdout)
    .split('\n')
    .find((text) => text.startsWith('RESULT '));
  if (line === undefined) {
    console.error(`previewImageShared: the probe gave no result (status ${run.status})\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
  }
  const results = JSON.parse(line.slice('RESULT '.length));
  const failures = CASES.filter((entry, index) => results[index]?.widthAfter !== entry.widthAfter).map(
    (entry) => `  ${entry.name}: expected width ${entry.widthAfter} after the frame left, got ${JSON.stringify(results)}`,
  );
  if (failures.length > 0) {
    console.error(`previewImageShared: ${failures.length} of ${CASES.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`previewImageShared: ${CASES.length} cases passed`);
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  probe().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    require('electron').app.exit(1);
  });
} else {
  main();
}
