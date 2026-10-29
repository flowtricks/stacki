// Project thumbnails: what gets photographed, and when it goes stale.
//
//   npx electron test/electron/project/thumbs.test.js
//
// Runs under Electron because the thing being tested is a real render — the
// project's home page loaded into its own window and captured. That is the
// whole point of the change: the old thumbnail was a photograph of the app,
// so it showed the page the user was last on, at the scroll position they left
// it, with whatever panel happened to be over the canvas.
//
// The page served here scrolls itself away from the top on load, the way a
// restored scroll position or an in-page anchor would. A capture that comes
// back with the hero's colour at the top of the frame is a capture that put the
// page back where a thumbnail should look.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { app, nativeImage } = require('electron');

const thumbs = require('#dist/electron/project/thumbs.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const HERO = { r: 220, g: 40, b: 60 }; // the hero band
const BELOW = { r: 20, g: 120, b: 220 }; // everything under it
const near = (actual, expected, tolerance = 24) =>
  Math.abs(actual.r - expected.r) <= tolerance &&
  Math.abs(actual.g - expected.g) <= tolerance &&
  Math.abs(actual.b - expected.b) <= tolerance;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title><style>
  body { margin: 0; font: 16px system-ui; }
  .hero { height: 900px; background: rgb(${HERO.r},${HERO.g},${HERO.b}); }
  .rest { height: 4000px; background: rgb(${BELOW.r},${BELOW.g},${BELOW.b}); }
</style></head>
<body>
  <div class="hero" id="top">Hero</div>
  <div class="rest">Everything else</div>
  <script>
    // A page that does not stay where it was loaded: the editor's canvas is
    // full of these (a restored position, an anchor, a scroll-driven pin), and
    // the old thumbnail photographed whatever the result was.
    window.scrollTo(0, 2000);
    setTimeout(() => window.scrollTo(0, 2400), 200);
  </script>
</body></html>`;

// Replay the compositor failure reported by Linux CI before allowing a real screenshot.
// This makes the cold-render failure deterministic without showing a test window.
let captureCalls = 0;
app.once('browser-window-created', (_event, window) => {
  const capturePage = window.webContents.capturePage.bind(window.webContents);
  window.webContents.capturePage = (...args) => {
    captureCalls += 1;
    if (captureCalls === 1) {
      // Exercise native capture setup too: replacing it outright would leave the retry
      // as the compositor's first real attempt and introduce a second, unrelated cold failure.
      return capturePage(...args).then(() => {
        throw new Error('UnknownVizError');
      });
    }
    return capturePage(...args);
  };
});

async function checkCaptureFailure(userData, projectDirectory, url, message, attempts) {
  const file = thumbs.thumbPathFor(userData, projectDirectory);
  const previous = fs.readFileSync(file);
  let calls = 0;
  app.once('browser-window-created', (_event, window) => {
    window.webContents.capturePage = () => {
      calls += 1;
      return message === 'timeout' ? new Promise(() => {}) : Promise.reject(new Error(message));
    };
  });
  const started = Date.now();
  const result = await thumbs.capture(userData, projectDirectory, url);
  const expected = message === 'timeout' ? 'the page capture did not finish' : message;
  check(`${message} is reported`, result.ok === false && result.error === expected, result.error);
  check(`${message} has bounded attempts`, calls === attempts, String(calls));
  check(`${message} finishes within its bound`, Date.now() - started < 15000);
  check(`${message} preserves the previous thumbnail`, previous.equals(fs.readFileSync(file)));
}

// The pixel at (x, y) of a PNG on disk.
function pixelAt(file, x, y) {
  const image = nativeImage.createFromPath(file);
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const at = (y * size.width + x) * 4;
  return {
    b: bitmap[at],
    g: bitmap[at + 1],
    r: bitmap[at + 2],
    width: size.width,
    height: size.height,
  };
}

// The capture opens a window and destroys it. Without this, that destruction
// ends the app on the spot — it is the only window there is — and the test
// exits before it has checked anything.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-thumbs-'));
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-proj-'));
  fs.mkdirSync(path.join(projectDirectory, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'src', 'pages', 'index.astro'), '<h1>Hi</h1>\n');
  fs.writeFileSync(path.join(projectDirectory, 'astro.config.mjs'), 'export default {}\n');

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  // --- the capture ---------------------------------------------------------
  const result = await thumbs.capture(userData, projectDirectory, url);
  check('the capture succeeds', result.ok === true, result.error);
  check('a cold compositor failure retries once', captureCalls === 2, String(captureCalls));

  const file = thumbs.thumbPathFor(userData, projectDirectory);
  check('a file is written', fs.existsSync(file));

  if (fs.existsSync(file)) {
    const top = pixelAt(file, 40, 10);
    check('it is the width thumbnails are stored at', top.width === 720, `${top.width}px`);
    check(
      'the top of the picture is the top of the page',
      near(top, HERO),
      `expected the hero's colour, got rgb(${top.r},${top.g},${top.b}) ` +
        `— the page was photographed where it scrolled to`,
    );
    // The viewport is 1440×900 and the hero is exactly 900 tall, so the bottom
    // of the frame is the last of the hero — proof the whole viewport was
    // captured rather than a strip of it.
    const low = pixelAt(file, 40, Math.round((top.height || 450) * 0.9));
    check('and the frame is one screen of it', near(low, HERO), `rgb(${low.r},${low.g},${low.b})`);
  }

  // --- staleness -----------------------------------------------------------
  check('a fresh capture is not stale', thumbs.isStale(userData, projectDirectory) === false);

  // A change made with the app closed is still a change.
  await new Promise((resolve) => setTimeout(resolve, 1100)); // mtime granularity
  fs.writeFileSync(path.join(projectDirectory, 'src', 'pages', 'about.astro'), '<h1>About</h1>\n');
  check(
    'a page added outside the app makes it stale',
    thumbs.isStale(userData, projectDirectory) === true,
  );

  await thumbs.capture(userData, projectDirectory, url);
  check('and taking it again clears that', thumbs.isStale(userData, projectDirectory) === false);

  // node_modules churn is not a content change.
  const modules = path.join(projectDirectory, 'node_modules', 'left-pad');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, 'index.js'), 'module.exports = 1;\n');
  check('installing a package does not', thumbs.isStale(userData, projectDirectory) === false);

  // --- a project that cannot be rendered -----------------------------------
  const dead = await thumbs.capture(userData, projectDirectory, 'http://127.0.0.1:45999/');
  check('an unreachable site fails quietly', dead.ok === false && typeof dead.error === 'string');
  check('and keeps the picture it had', fs.existsSync(file));

  await checkCaptureFailure(userData, projectDirectory, url, 'UnknownVizError', 2);
  await checkCaptureFailure(userData, projectDirectory, url, 'capture unavailable', 1);
  await checkCaptureFailure(userData, projectDirectory, url, 'timeout', 1);

  // --- forgetting ----------------------------------------------------------
  thumbs.forget(userData, projectDirectory);
  check('removing a project takes its picture with it', !fs.existsSync(file));

  server.close();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(projectDirectory, { recursive: true, force: true });

  // Written synchronously: app.exit() does not wait for a piped stdout to
  // flush, so console.log here reaches nobody.
  const say = (text) => fs.writeSync(1, text + '\n');
  if (failures.length) {
    say(`\nthumbs: ${failures.length} failed, ${checked - failures.length} passed\n`);
    say(failures.join('\n') + '\n');
    app.exit(1);
    return;
  }
  say(`thumbs: ${checked} passed`);
  app.exit(0);
});
