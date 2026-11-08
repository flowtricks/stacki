// Revealing a selection works on pages that a smooth-scroll library drives, and
// on pages whose scrolling happens in a wrapper rather than the window.
//
//   node test/electron/preload/revealSmoothScroll.test.js
//
// Selecting a node in the Navigator asks the canvas frame to bring it into view
// (`avb:scroll-to`, frameReveal.ts). Real sites break the plain `scrollTo` two
// ways. A smooth-scroll library such as Lenis keeps its own scroll position and,
// while it animates, writes it to the page on every frame, which undoes any other
// scroll; while it is idle it adopts native scroll events. And an app-shell page
// (`html, body { height: 100%; overflow: hidden }` and a scrolling <main>) has a
// window that cannot scroll at all.
//
// Method: a real Electron window (jsdom has no layout and no scrolling) serves a
// host page over localhost with the canvas page in an iframe at `#avb-design`,
// the built preload running in both as it does in the app. The host posts
// `avb:track` and then `avb:scroll-to` exactly as the app does, waits for the
// page to settle, and reads where things ended up.
//
// The Lenis stand-in follows the library's own rules (lenis/dist/lenis.mjs,
// `onNativeScroll` and `raf`): while it animates it lerps toward its own target
// and writes the result with an instant scroll each frame, ignoring native scroll
// events; once it arrives it goes idle and copies native scrolls into its
// position. It is a stand-in so the test needs no network and no dependency, and
// it is exactly as hostile as the real library while animating.
//
// Cases:
//   - Lenis idle: a section far below is revealed, and Lenis adopts the position,
//   - Lenis gliding elsewhere when the reveal arrives (the person wheeled just
//     before picking a row): the reveal waits out the glide and still lands,
//   - a person who scrolls during a reveal keeps the page where they put it,
//   - a box far down a scrolling <main> scrolls <main>, not the window,
//   - a box hidden above the top of a scroller that sits below a header is judged
//     by the scroller's own visible area, not the window's, so it scrolls,
//   - a box showing inside that scroller stays put.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { repoPath } = require('../../helpers/sources.js');

// How far one frame of an interrupted smooth scroll can carry the page.
const PERSON_SLACK_PX = 40;

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// Answers the host, so it can tell when the frame has handled what came before.
const REPLY_SCRIPT = `<script>
  addEventListener('message', (event) => {
    if (event.data && event.data.type === 'test:ping') {
      parent.postMessage({ type: 'test:pong' }, '*');
    }
  });
</script>`;

// The rules of Lenis that matter to a reveal, as the library runs them.
const LENIS_SCRIPT = `<script>
  const lenis = { animated: 0, target: 0, animating: false };
  window.testLenis = lenis;
  document.documentElement.classList.add('lenis');
  addEventListener('scroll', () => {
    if (!lenis.animating) {
      lenis.animated = lenis.target = scrollY;
    }
  });
  // Lenis damps by the time since the last frame, not per frame, so a glide takes
  // as long on a machine whose frames arrive late (Animate.advance and damp).
  const LERP = 0.09;
  let lastTime;
  const frame = (time) => {
    const deltaSeconds = lastTime === undefined ? 0 : (time - lastTime) / 1000;
    lastTime = time;
    if (lenis.animating) {
      const amount = 1 - Math.exp(-LERP * 60 * deltaSeconds);
      lenis.animated += (lenis.target - lenis.animated) * amount;
      if (Math.round(lenis.animated) === Math.round(lenis.target)) {
        lenis.animated = lenis.target;
        lenis.animating = false;
      }
      scrollTo({ top: lenis.animated, behavior: 'instant' });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // What a wheel does under Lenis: a glide toward a new target of its own.
  window.glide = (top) => {
    lenis.animated = scrollY;
    lenis.target = top;
    lenis.animating = true;
  };
</script>`;

const page = (style, content, script) => `<!doctype html><html><head><meta charset=utf-8>
<style>
  html, body { margin: 0; }
  html.lenis, html.lenis body { height: auto; }
  .gap { height: 2500px; }
  .box { height: 100px; background: #3c6; }
  ${style}
</style></head><body>
  ${content}
  ${REPLY_SCRIPT}
  ${script}
</body></html>`;

const PAGES = {
  lenis: page(
    '',
    `<div class="gap"></div>
  <!--avb-s:0--><section class="box" id="box"></section><!--avb-e:0-->
  <div class="gap"></div>`,
    LENIS_SCRIPT,
  ),
  // The window cannot scroll; <main> does, below a 200px header.
  shell: page(
    'html, body { height: 100%; overflow: hidden; } header { height: 200px; } main { height: calc(100% - 200px); overflow-y: auto; }',
    `<header></header><main id="scroller">
  <div class="gap"></div>
  <!--avb-s:0--><section class="box" id="box"></section><!--avb-e:0-->
  <div class="gap"></div></main>`,
    '',
  ),
};

const hostPage = (frameFile) => `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: 600px; display: block; }</style>
<iframe id="canvas" src="/${frameFile}#avb-design"></iframe>`;

// Runs in the host page: every reading of the canvas goes through this.
const HOST_HELPERS = `
  // 18 seconds: a glide at a quarter speed, then the watch's longest quiet wait.
  const SETTLE_TRIES_MAX = 300;
  const READING_MS = 60;
  // Still for 720ms: longer than the frame's watch takes to judge a page still
  // (three looks 100ms apart) plus a late animation frame on a slow machine.
  const STILL_READINGS = 12;
  // 2.1 seconds: twice the longest frame gap the watch will wait out (frameReveal.ts).
  const WATCH_DONE_READINGS = 35;
  const frame = document.getElementById('canvas').contentWindow;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const handled = () => new Promise((resolve) => {
    const answered = (event) => {
      if (event.data && event.data.type === 'test:pong') {
        removeEventListener('message', answered);
        resolve();
      }
    };
    addEventListener('message', answered);
    frame.postMessage({ type: 'test:ping' }, '*');
  });
  const scrollerOf = (scrollerId) => (scrollerId === undefined ? undefined : frame.document.getElementById(scrollerId));
  const position = (scroller) => (scroller === undefined ? frame.scrollY : scroller.scrollTop);
  const boxShowing = (scroller) => {
    const box = frame.document.getElementById('box').getBoundingClientRect();
    const view = scroller === undefined ? { top: 0, bottom: frame.innerHeight } : scroller.getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  };
  // Waits, within a bound, until the page has come to rest: not moving, the Lenis
  // stand-in idle, and, for a reveal expected to land, the box showing. How long a
  // reveal takes depends on the machine: on a slow one the stand-in's glide runs
  // for seconds, and the frame's watch then waits out twice the longest gap
  // between its frames before it jumps, so no fixed stillness is long enough to
  // prove a reveal has given up. A reveal that never lands runs out the bound and
  // reads as unsettled, which fails on its own.
  const settle = async (scroller, expected) => {
    let last = position(scroller);
    let still = 0;
    for (let attempt = 0; attempt < SETTLE_TRIES_MAX; attempt += 1) {
      await pause(READING_MS);
      const now = position(scroller);
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= STILL_READINGS) {
        const libraryIdle = !(frame.testLenis && frame.testLenis.animating);
        if (libraryIdle) {
          if (expected !== 'lands') {
            return true;
          }
          // Landed, and held past the longest quiet the watch can need, so it has
          // let go before the next case moves the page.
          if (boxShowing(scroller)) {
            if (still >= WATCH_DONE_READINGS) {
              return true;
            }
          }
        }
      }
    }
    return false;
  };
  const reading = (scroller, start, startTop, settled) => {
    const box = frame.document.getElementById('box').getBoundingClientRect();
    const view = scroller === undefined ? { top: 0, bottom: frame.innerHeight } : scroller.getBoundingClientRect();
    return {
      start,
      startTop,
      settled,
      end: position(scroller),
      windowY: frame.scrollY,
      top: box.top,
      bottom: box.bottom,
      viewTop: view.top,
      viewBottom: view.bottom,
      lenis: frame.testLenis ? { animated: frame.testLenis.animated, target: frame.testLenis.target } : undefined,
    };
  };
  // Puts the page (or the scroller) at a position, then reveals the box. "before"
  // is what happens in the page between the request and the reveal; "during" is
  // what a person does once the reveal has started.
  window.reveal = async ({ from, scrollerId, before, during, expected }) => {
    const scroller = scrollerOf(scrollerId);
    if (scroller === undefined) {
      frame.scrollTo({ top: from, behavior: 'instant' });
    } else {
      scroller.scrollTop = from;
    }
    await settle(scroller);
    const start = position(scroller);
    const startTop = frame.document.getElementById('box').getBoundingClientRect().top;
    if (before === 'glide') {
      frame.glide(1200);
      await pause(50);
    }
    frame.postMessage({ type: 'avb:scroll-to', path: '0', occ: 0 }, '*');
    await handled();
    if (during === 'person') {
      await pause(80);
      frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
      frame.scrollTo({ top: 400, behavior: 'instant' });
    }
    const settled = await settle(scroller, expected);
    return reading(scroller, start, startTop, settled);
  };
`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('reveal-smooth-scroll: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const name = url.pathname.slice(1).replace('.html', '');
    const body = name === 'host' ? hostPage(`${url.searchParams.get('canvas')}.html`) : PAGES[name];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/reveal-smooth-scroll');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: 900, height: 700,
         webPreferences: {
           preload: ${JSON.stringify(preload)},
           contextIsolation: true,
           nodeIntegration: false,
           nodeIntegrationInSubFrames: true,
         },
       });
       const run = (code) => win.webContents.executeJavaScript(code);
       const open = async (canvas) => {
         await win.loadURL('http://127.0.0.1:${port}/host.html?canvas=' + canvas);
         await sleep(600);
         await run(${JSON.stringify(`(() => {${HOST_HELPERS}})()`)});
         const message = { type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 };
         await run('document.getElementById("canvas").contentWindow.postMessage(' + JSON.stringify(message) + ', "*")');
         await sleep(300);
       };
       const reveal = (options) => run('window.reveal(' + JSON.stringify(options) + ')');

       await open('lenis');
       const idle = await reveal({ from: 0, expected: 'lands' });
       const gliding = await reveal({ from: 0, before: 'glide', expected: 'lands' });
       const person = await reveal({ from: 0, during: 'person', expected: 'stays' });

       await open('shell');
       const below = await reveal({ from: 0, scrollerId: 'scroller', expected: 'lands' });
       // 2500px of gap then the box: 2650 puts its top 150px above the scroller's
       // view, which starts 200px down the frame, so it is 50px down the window.
       const hidden = await reveal({ from: 2650, scrollerId: 'scroller', expected: 'lands' });
       const showing = await reveal({ from: 2400, scrollerId: 'scroller', expected: 'stays' });

       console.log(JSON.stringify({ idle, gliding, person, below, hidden, showing }));
       app.quit();
     });`,
  );

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Asynchronous, so this process keeps serving the pages the probe loads.
  const run = await new Promise((resolve) => {
    const child = spawn(electronPath, [probe], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    // Only a ceiling for a hung probe: the cases take as long as the machine needs.
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
  server.close();

  const line = run.stdout.split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { idle, gliding, person, below, hidden, showing } = JSON.parse(line);
    const onScreen = (reading) => reading.top >= reading.viewTop && reading.bottom <= reading.viewBottom;
    // Every reading is taken after the page, the Lenis stand-in and the frame's
    // watch have all come to rest, or it says nothing about where a reveal ends.
    for (const [name, result] of Object.entries({ idle, gliding, person, below, hidden, showing })) {
      check(`the ${name} case came to rest before it was read`, result.settled === true, JSON.stringify(result));
    }

    check('with Lenis idle, a section far below is revealed', idle.end > idle.start, JSON.stringify(idle));
    check('until it is on screen', onScreen(idle), JSON.stringify(idle));
    check('and Lenis adopts the new position, so its next frame keeps it', Math.abs(idle.lenis.animated - idle.end) <= 1, JSON.stringify(idle));

    check('with Lenis gliding elsewhere, the reveal still lands once the glide ends', onScreen(gliding), JSON.stringify(gliding));
    check('and Lenis holds it there', Math.abs(gliding.lenis.target - gliding.end) <= 1, JSON.stringify(gliding));

    // Near 400, not exactly: a smooth scroll already under way can take one more
    // step after the person's jump. Far from the 2250 the reveal was heading for.
    check('a person who scrolls during a reveal keeps the page where they put it', Math.abs(person.end - 400) <= PERSON_SLACK_PX, JSON.stringify(person));
    check('and the box they scrolled away from stays off screen', !onScreen(person), JSON.stringify(person));

    check('in a page whose <main> scrolls, a box far below scrolls <main>', below.end > below.start, JSON.stringify(below));
    check('until the box shows inside it', onScreen(below), JSON.stringify(below));
    check('and the window, which cannot scroll, stays put', below.windowY === 0, JSON.stringify(below));

    check(
      'the hidden case starts above the scroller and inside the window',
      hidden.startTop + 100 <= hidden.viewTop && hidden.startTop >= 0,
      JSON.stringify(hidden),
    );
    check('a box above a scroller below a header is judged by the scroller, so it scrolls', hidden.end !== hidden.start, JSON.stringify(hidden));
    check('until it shows inside the scroller', onScreen(hidden), JSON.stringify(hidden));

    check('a box showing inside the scroller stays put', showing.end === showing.start, JSON.stringify(showing));
  }

  if (failures.length) {
    console.error(`reveal-smooth-scroll: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`reveal-smooth-scroll: ${checked}/${checked} passed`);
})();
