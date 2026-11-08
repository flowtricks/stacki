// Revealing a selection scrolls the page down to it, never sideways.
//
//   node test/electron/preload/revealScrollsDown.test.js
//
// Selecting a node in the Navigator asks the canvas frame to bring it into
// view (`avb:scroll-to`). A site is often wider than the frame on purpose — a
// hero video bleeding off the right edge — and clips the overflow with
// `overflow-x: hidden` on the body or a wrapper. The reveal used to scroll
// sideways as well, and a viewport whose overflow is hidden still scrolls when
// script asks it to, while nothing on the canvas can scroll it back: the page
// stayed stuck to one side.
//
// Method: a real Electron window (jsdom has no layout and no scrolling) serves
// a host page over localhost with the canvas page in an iframe at
// `#avb-design`, the built preload running in both as it does in the app. The
// host posts `avb:track` and then `avb:scroll-to` exactly as the app does, and
// reads the frame's scroll state afterwards:
//   - a video overflowing to the right inside an `overflow-x: hidden` wrapper,
//   - a video bleeding off the right of a body with `overflow-x: hidden`,
// both already in vertical view, leave the window and every ancestor at
// scrollLeft 0 and the page where it was; a section below the fold scrolls the
// page down until it is on screen, even when the page undoes the first scroll
// and leaves itself a few pixels down (as a stalled smooth scroll did on Linux,
// and as a smooth-scroll library does); revealing it again does not move the page.
//
// Whether a reveal moves the page at all is then tested from a known place: the
// host scrolls a box to a chosen top in the frame, reveals it, and compares the
// scroll position before and after. The rule under test:
//   - a box with any part inside the frame stays put: whole, cut by any edge, or
//     showing one pixel, however tall it is,
//   - a box with no part inside the frame scrolls, in either direction, and one
//     that only touches the edge shows nothing, so it scrolls too,
//   - a box off to the side stays put when a vertical move could not help it,
//   - a ::before is judged by its own painted box, even inside a host that is in
//     view, and a ::before with no box falls back to its host,
//   - <html> and <body> never scroll, whatever their boxes say: on a long page,
//     on one where `height: 100%` leaves their boxes above the frame, and on
//     pages whose scrolling happens in <body> or a wrapper,
//   - a box with no area is judged whole, and a node with no box does nothing.
//
// Reading the result must not depend on how long a reveal takes, because
// on a slow Linux machine one can pause between frames for longer than any fixed
// wait. So each case says what it expects. The host first waits for a reply from
// the frame, which proves the reveal was handled, as messages arrive in order. A
// case that expects a scroll then waits until the box has landed and the page has
// held still past the frame's own watch. A case that expects none only has to see
// the page hold still: a slow machine can miss a wrong scroll there, but it can
// never fail a right one, and a fast one catches it.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { repoPath } = require('../../helpers/sources.js');

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

// <html> and <body> are marked as the serializer marks them on a real page: a
// comment pair around each, and the path on the tag itself.
const ROOT_PATH = '9';
const BODY_PATH = '9.1';

const FRAME_PAGE = `<!doctype html><!--avb-s:${ROOT_PATH}--><html data-avb-p="${ROOT_PATH}"><head><meta charset=utf-8>
<style>
  html, body { margin: 0; }
  body { overflow-x: hidden; }
  .spacer { height: 40px; }
  .wrap { overflow-x: hidden; }
  .video { width: 2000px; height: 200px; margin-left: 600px; background: #c33; }
  .bleed { margin-top: 20px; }
  .tall { height: 3000px; }
  .below { height: 200px; background: #36c; }
  .gap { height: 1500px; }
  .box { height: 100px; background: #3c6; }
  .host { position: relative; height: 2000px; background: #eee; }
  .host::before { content: ''; position: absolute; top: 50px; left: 20px; width: 100px; height: 60px; background: #c6c; }
  .long { height: 1500px; background: #cc3; }
  .bare { height: 100px; }
  .bare::before { content: ''; }
  .side { width: 300px; height: 100px; background: #6cc; }
  .right { margin-left: 700px; }
  .left { margin-left: -200px; }
  .away { margin-left: 900px; }
  .flat { height: 0; }
  .thin { width: 0; height: 100px; }
  .empty { width: 0; height: 0; }
  .gone { display: none; height: 100px; }
</style></head><!--avb-s:${BODY_PATH}--><body data-avb-p="${BODY_PATH}">
  <div class="spacer"></div>
  <div class="wrap"><!--avb-s:0--><div class="video" id="wrapped"></div><!--avb-e:0--></div>
  <!--avb-s:1--><div class="video bleed" id="bleeding"></div><!--avb-e:1-->
  <div class="tall"></div>
  <!--avb-s:2--><section class="below" id="below"></section><!--avb-e:2-->
  <div class="gap"></div>
  <!--avb-s:3--><section class="box" id="box"></section><!--avb-e:3-->
  <div class="gap"></div>
  <!--avb-s:4--><section class="host" id="host"></section><!--avb-e:4-->
  <div class="gap"></div>
  <!--avb-s:5--><section class="long" id="long"></section><!--avb-e:5-->
  <div class="gap"></div>
  <!--avb-s:6--><section class="bare" id="bare"></section><!--avb-e:6-->
  <div class="gap"></div>
  <!--avb-s:10--><section class="side right" id="right"></section><!--avb-e:10-->
  <div class="gap"></div>
  <!--avb-s:11--><section class="side left" id="left"></section><!--avb-e:11-->
  <div class="gap"></div>
  <!--avb-s:12--><section class="side away" id="away"></section><!--avb-e:12-->
  <div class="gap"></div>
  <!--avb-s:13--><section class="flat" id="flat"></section><!--avb-e:13-->
  <div class="gap"></div>
  <!--avb-s:14--><section class="thin" id="thin"></section><!--avb-e:14-->
  <div class="gap"></div>
  <!--avb-s:15--><section class="empty" id="empty"></section><!--avb-e:15-->
  <div class="gap"></div>
  <!--avb-s:16--><section class="gone" id="gone"></section><!--avb-e:16-->
  <div class="gap"></div>
  ${REPLY_SCRIPT}
  <script>
    // The stall the Linux runner showed, made to happen everywhere: the first
    // scroll the page sees is undone, leaving it 9px down. The reveal must still
    // arrive at the section.
    let halted = false;
    addEventListener('scroll', () => {
      if (!halted && scrollY > 9) {
        halted = true;
        scrollTo({ top: 9, behavior: 'instant' });
      }
    });
  </script>
</body><!--avb-e:${BODY_PATH}--></html><!--avb-e:${ROOT_PATH}-->`;

const rootPage = (style, content) => `<!doctype html><!--avb-s:${ROOT_PATH}--><html data-avb-p="${ROOT_PATH}"><head><meta charset=utf-8>
<style>
  html, body { margin: 0; }
  body::before { content: ''; }
  .content { height: 4000px; }
  .box { height: 100px; background: #3c6; }
  .gap { height: 1500px; }
  ${style}
</style></head><!--avb-s:${BODY_PATH}--><body data-avb-p="${BODY_PATH}">
  ${content}
  ${REPLY_SCRIPT}
</body><!--avb-e:${BODY_PATH}--></html><!--avb-e:${ROOT_PATH}-->`;

const SCROLLING_CONTENT = `<div class="gap"></div>
  <!--avb-s:0--><section class="box" id="box"></section><!--avb-e:0-->
  <div class="gap"></div>
  <!--avb-s:1--><section class="box" id="far"></section><!--avb-e:1-->
  <div class="gap"></div>`;

const PAGES = {
  // The window scrolls, but <html> and <body> are only one frame tall, so a page
  // scrolled past the first screen has both boxes wholly above the frame.
  pinned: rootPage('html, body { height: 100%; }', `<div class="content"></div>${SCROLLING_CONTENT}`),
  // <body> scrolls and the window cannot: overflow on <html> stops it reaching the viewport.
  bodyScroller: rootPage('html { height: 100%; overflow: hidden; } body { height: 100%; overflow-y: auto; }', SCROLLING_CONTENT),
  // A wrapper scrolls, and neither the window nor <body> can.
  innerScroller: rootPage(
    'html, body { height: 100%; overflow: hidden; } main { height: 100%; overflow-y: auto; }',
    `<main id="scroller">${SCROLLING_CONTENT}</main>`,
  ),
};

const hostPage = (frameFile) => `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: 600px; display: block; }</style>
<iframe id="canvas" src="/${frameFile}#avb-design"></iframe>`;

const FRAME_PATHS = ['0', '1', '2', '3', '4', '4::before', '5', '6', '6::before', ROOT_PATH, BODY_PATH, '10', '11', '12', '13', '14', '15', '16'];
const ROOT_PAGE_PATHS = ['0', '1', ROOT_PATH, BODY_PATH, `${BODY_PATH}::before`];

// How far from its margin a box too tall to fit may land. When the reveal still
// glided, one animation step on a starved machine carried it past its target, and it
// stopped there: 61px was the most seen with the probe held to background priority.
// The reveal now jumps, so it lands on the margin; the slack stays as it was. This is still far
// from any wrong answer: a centred box of 1500px would sit 450px above the frame.
const LANDING_SLACK_PX = 150;

// Runs in the host page: every reading of the canvas goes through this.
const HOST_HELPERS = `
  const SETTLE_TRIES_MAX = 200;
  const READING_MS = 60;
  // Past the frame's own watch, which looks every 100ms: a page still for this
  // long has been seen by it, so a stalled scroll has already been finished.
  // The watch may still be running when a case ends: placing the page for the
  // next case ends it, as a person's scroll does, so no case relies on it.
  const STILL_READINGS_LANDED = 5;
  const STILL_READINGS_STAYED = 10;
  const MARGIN = 24;
  const LANDING_SLACK = ${LANDING_SLACK_PX};
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
  // Where a box comes to rest: on screen when it fits, a margin below the top of
  // the frame when it does not.
  const landed = (top, height) => {
    if (height <= frame.innerHeight) {
      return top >= 0 && top + height <= frame.innerHeight;
    }
    return Math.abs(top - MARGIN) <= LANDING_SLACK;
  };
  // Waits, within a bound, until the page holds still where it was put, one
  // animation frame at a time: the placement check after the reveal says whether
  // it got there.
  const settlePlacement = async () => {
    let last = frame.scrollY;
    for (let attempt = 0; attempt < SETTLE_TRIES_MAX; attempt += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (frame.scrollY === last) {
        return;
      }
      last = frame.scrollY;
    }
  };
  // A person puts the page somewhere, with a wheel as a person would. That input
  // also ends an earlier reveal's watch (frameReveal.ts), which would otherwise be
  // free to act on the page until this case's reveal cancels it.
  window.place = async (id, boxTop) => {
    const element = frame.document.getElementById(id);
    frame.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    frame.scrollTo({ top: frame.scrollY + element.getBoundingClientRect().top - boxTop, behavior: 'instant' });
    await settlePlacement();
  };
  // Reveals a path and reads where everything ended up. "painted" is the part of
  // the element that was asked for, for a ::before inside its host.
  window.reveal = async ({ nodePath, id, expected, painted, scrollerId }) => {
    const element = frame.document.getElementById(id);
    const scroller = scrollerId === undefined ? undefined : frame.document.querySelector(scrollerId);
    const startY = frame.scrollY;
    const startScroller = scroller === undefined ? 0 : scroller.scrollTop;
    const placed = element.getBoundingClientRect().top;
    frame.postMessage({ type: 'avb:scroll-to', path: nodePath, occ: 0 }, '*');
    await handled();
    let last = startY;
    let still = 0;
    for (let attempt = 0; attempt < SETTLE_TRIES_MAX; attempt += 1) {
      await pause(READING_MS);
      still = frame.scrollY === last ? still + 1 : 0;
      last = frame.scrollY;
      if (expected === 'stays') {
        if (still >= STILL_READINGS_STAYED) { break; }
      } else {
        const box = element.getBoundingClientRect();
        const top = box.top + painted.top;
        const height = painted.height === undefined ? box.height : painted.height;
        if (frame.scrollY !== startY && landed(top, height) && still >= STILL_READINGS_LANDED) { break; }
      }
    }
    const lefts = [];
    for (let node = element; node; node = node.parentElement) {
      lefts.push(node.scrollLeft);
    }
    lefts.push(frame.document.scrollingElement.scrollLeft);
    const rect = element.getBoundingClientRect();
    return {
      startY,
      placed,
      scrollX: frame.scrollX,
      scrollY: frame.scrollY,
      lefts,
      top: rect.top,
      bottom: rect.bottom,
      height: frame.innerHeight,
      startScroller,
      scroller: scroller === undefined ? 0 : scroller.scrollTop,
    };
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
    console.log('reveal-scrolls-down: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const pageFor = (url) => {
    const name = url.pathname.slice(1).replace('.html', '');
    if (name === 'frame') {
      return FRAME_PAGE;
    }
    if (name === 'host') {
      return hostPage(`${url.searchParams.get('canvas') ?? 'frame'}.html`);
    }
    return PAGES[name];
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const page = pageFor(url);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/reveal-scrolls-down');
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
       const open = async (canvas, paths) => {
         await win.loadURL('http://127.0.0.1:${port}/host.html?canvas=' + canvas);
         await sleep(600);
         await run(${JSON.stringify(`(() => {${HOST_HELPERS}})()`)});
         const message = { type: 'avb:track', paths, scope: '', focus: '', focusOcc: 0 };
         await run('document.getElementById("canvas").contentWindow.postMessage(' + JSON.stringify(message) + ', "*")');
         await sleep(300);
       };
       const reveal = (options) => run('window.reveal(' + JSON.stringify({ painted: { top: 0 }, ...options }) + ')');
       // Puts a box at a chosen top in the frame, then reveals a path from there.
       const revealFrom = async (nodePath, id, boxTop, expected, extra) => {
         await run('window.place(' + JSON.stringify(id) + ', ' + boxTop + ')');
         return reveal({ nodePath, id, expected, ...extra });
       };
       const stays = (nodePath, id, boxTop, extra) => revealFrom(nodePath, id, boxTop, 'stays', extra);
       const moves = (nodePath, id, boxTop, extra) => revealFrom(nodePath, id, boxTop, 'moves', extra);

       await open('frame', ${JSON.stringify(FRAME_PATHS)});
       const wrapped = await reveal({ nodePath: '0', id: 'wrapped', expected: 'stays' });
       const bleeding = await reveal({ nodePath: '1', id: 'bleeding', expected: 'stays' });
       const below = await reveal({ nodePath: '2', id: 'below', expected: 'moves' });
       const again = await reveal({ nodePath: '2', id: 'below', expected: 'stays' });
       const pseudoBox = { painted: { top: 50, height: 60 } };
       const cases = {
         inside: await stays('3', 'box', 200),
         touchingTop: await stays('3', 'box', 0),
         nearTop: await stays('3', 'box', 5),
         nearBottom: await stays('3', 'box', 495),
         touchingBottom: await stays('3', 'box', 500),
         cutByTop: await stays('3', 'box', -40),
         cutByBottom: await stays('3', 'box', 550),
         pixelAtTop: await stays('3', 'box', -99),
         pixelAtBottom: await stays('3', 'box', 599),
         sharingTopEdge: await moves('3', 'box', -100),
         sharingBottomEdge: await moves('3', 'box', 600),
         belowFrame: await moves('3', 'box', 900),
         aboveFrame: await moves('3', 'box', -500),
         cutByRight: await stays('10', 'right', 200),
         cutByLeft: await stays('11', 'left', 200),
         cutByRightAndTop: await stays('10', 'right', -40),
         cutByLeftAndBottom: await stays('11', 'left', 550),
         awayBeside: await stays('12', 'away', 200),
         awayBelow: await moves('12', 'away', 900),
         pseudoInView: await stays('4::before', 'host', 100),
         hostOfPseudo: await stays('4', 'host', 100),
         pseudoAboveFrame: await moves('4::before', 'host', -700, pseudoBox),
         longCovering: await stays('5', 'long', -300),
         longFlushTop: await stays('5', 'long', 0),
         longTopShowing: await stays('5', 'long', 400),
         longLanded: await stays('5', 'long', 24),
         longBottomShowing: await stays('5', 'long', -1200),
         longPixelAtBottom: await stays('5', 'long', -1499),
         longAboveFrame: await moves('5', 'long', -1600),
         longBelowFrame: await moves('5', 'long', 700),
         bareInView: await stays('6::before', 'bare', 200),
         bareCutByTop: await stays('6::before', 'bare', -40),
         bareBelowFrame: await moves('6::before', 'bare', 900),
         flatInside: await stays('13', 'flat', 200),
         flatOnTopEdge: await stays('13', 'flat', 0),
         flatOnBottomEdge: await stays('13', 'flat', 600),
         flatAbove: await moves('13', 'flat', -50),
         flatBelow: await moves('13', 'flat', 900),
         thinInside: await stays('14', 'thin', 200),
         thinCutByTop: await moves('14', 'thin', -40),
         thinBelow: await moves('14', 'thin', 900),
         emptyBelow: await stays('15', 'empty', 900),
         emptyAbove: await stays('15', 'empty', -500),
         bodyAtTop: await stays('${BODY_PATH}', 'wrapped', 40),
         htmlAtTop: await stays('${ROOT_PATH}', 'wrapped', 40),
         bodyFarDown: await stays('${BODY_PATH}', 'box', 200),
         htmlFarDown: await stays('${ROOT_PATH}', 'box', 200),
       };
       // display: none has no box to place, so it is revealed from wherever a neighbour left the page.
       await run('window.place("thin", 200)');
       const gone = await reveal({ nodePath: '16', id: 'gone', expected: 'stays' });

       await open('pinned', ${JSON.stringify(ROOT_PAGE_PATHS)});
       const pinned = {
         body: await stays('${BODY_PATH}', 'box', 200),
         html: await stays('${ROOT_PATH}', 'box', 200),
         bodyStandIn: await stays('${BODY_PATH}::before', 'box', 200),
         boxes: await run('(() => { const frame = document.getElementById("canvas").contentWindow; return [frame.document.body.getBoundingClientRect().bottom, frame.document.documentElement.getBoundingClientRect().bottom]; })()'),
         farOffScreen: await moves('1', 'far', 900),
       };

       const scrollerCases = async (canvas, scrollerId) => {
         await open(canvas, ${JSON.stringify(ROOT_PAGE_PATHS)});
         const scroller = { scrollerId };
         // The box is placed by scrolling the scroller, since the window cannot.
         const placeInScroller = (boxTop) =>
           run('(() => { const frame = document.getElementById("canvas").contentWindow; const scroller = frame.document.querySelector(' + JSON.stringify(scrollerId) + '); frame.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 })); scroller.scrollTop += frame.document.getElementById("box").getBoundingClientRect().top - ' + boxTop + '; })()');
         await placeInScroller(200);
         const body = await reveal({ nodePath: '${BODY_PATH}', id: 'box', expected: 'stays', ...scroller });
         const html = await reveal({ nodePath: '${ROOT_PATH}', id: 'box', expected: 'stays', ...scroller });
         await placeInScroller(-40);
         const cut = await reveal({ nodePath: '0', id: 'box', expected: 'stays', ...scroller });
         return { body, html, cut };
       };
       const bodyScroller = await scrollerCases('bodyScroller', 'body');
       const innerScroller = await scrollerCases('innerScroller', '#scroller');

       console.log(JSON.stringify({ wrapped, bleeding, below, again, cases, gone, pinned, bodyScroller, innerScroller }));
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
    const timer = setTimeout(() => child.kill(), 300000);
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
    const { wrapped, bleeding, below, again, cases, gone, pinned, bodyScroller, innerScroller } = JSON.parse(line);
    const allZero = (lefts) => lefts.every((left) => left === 0);

    check('a video overflowing a clipped wrapper does not scroll the window sideways', wrapped.scrollX === 0, JSON.stringify(wrapped));
    check('nor any ancestor of it', allZero(wrapped.lefts), JSON.stringify(wrapped.lefts));
    check('and, already in view, the page stays put', wrapped.scrollY === 0, JSON.stringify(wrapped));

    check('a video bleeding off a clipped body does not scroll the window sideways', bleeding.scrollX === 0, JSON.stringify(bleeding));
    check('nor any ancestor of it', allZero(bleeding.lefts), JSON.stringify(bleeding.lefts));
    check('and, already in view, the page stays put', bleeding.scrollY === 0, JSON.stringify(bleeding));

    check('a section below the fold scrolls the page down', below.scrollY > 0, JSON.stringify(below));
    check('until it is on screen', below.top >= 0 && below.bottom <= below.height, JSON.stringify(below));
    check('still without going sideways', below.scrollX === 0 && allZero(below.lefts), JSON.stringify(below));

    check('revealing it again does not move the page', again.scrollY === below.scrollY, JSON.stringify({ below, again }));

    // Every case must have started where it asked to, or "did not move" proves nothing.
    const placedAsAsked = {
      inside: 200,
      touchingTop: 0,
      nearTop: 5,
      nearBottom: 495,
      touchingBottom: 500,
      cutByTop: -40,
      cutByBottom: 550,
      pixelAtTop: -99,
      pixelAtBottom: 599,
      sharingTopEdge: -100,
      sharingBottomEdge: 600,
      belowFrame: 900,
      aboveFrame: -500,
      cutByRight: 200,
      cutByLeft: 200,
      cutByRightAndTop: -40,
      cutByLeftAndBottom: 550,
      awayBeside: 200,
      awayBelow: 900,
      pseudoInView: 100,
      hostOfPseudo: 100,
      pseudoAboveFrame: -700,
      longCovering: -300,
      longFlushTop: 0,
      longTopShowing: 400,
      longLanded: 24,
      longBottomShowing: -1200,
      longPixelAtBottom: -1499,
      longAboveFrame: -1600,
      longBelowFrame: 700,
      bareInView: 200,
      bareCutByTop: -40,
      bareBelowFrame: 900,
      flatInside: 200,
      flatOnTopEdge: 0,
      flatOnBottomEdge: 600,
      flatAbove: -50,
      flatBelow: 900,
      thinInside: 200,
      thinCutByTop: -40,
      thinBelow: 900,
      emptyBelow: 900,
      emptyAbove: -500,
      bodyAtTop: 40,
      htmlAtTop: 40,
      bodyFarDown: 200,
      htmlFarDown: 200,
    };
    for (const [name, top] of Object.entries(placedAsAsked)) {
      check(`the ${name} case starts where it asked to`, cases[name].placed === top, JSON.stringify(cases[name]));
    }
    const stays = (what, move) => {
      check(what, move.scrollY === move.startY, JSON.stringify(move));
      check(`${what}, nor sideways`, move.scrollX === 0, JSON.stringify(move));
    };
    const scrollsOnScreen = (what, move) => {
      check(what, move.scrollY !== move.startY, JSON.stringify(move));
      check(`${what}, until all of it is on screen`, move.top >= 0 && move.bottom <= move.height, JSON.stringify(move));
      check(`${what}, and never sideways`, move.scrollX === 0 && allZero(move.lefts), JSON.stringify(move));
    };
    const scrollsToTop = (what, move) => {
      check(what, move.scrollY !== move.startY, JSON.stringify(move));
      check(`${what}, landing near a margin below the top of the frame`, Math.abs(move.top - 24) <= LANDING_SLACK_PX, JSON.stringify(move));
    };

    stays('a box inside the frame does not move the page', cases.inside);
    stays('nor does one touching the top of the frame', cases.touchingTop);
    stays('nor one inside the margin at the top', cases.nearTop);
    stays('nor one inside the margin at the bottom', cases.nearBottom);
    stays('nor one touching the bottom of the frame', cases.touchingBottom);

    stays('a box cut by the top of the frame does not move the page', cases.cutByTop);
    stays('nor one cut by the bottom of the frame', cases.cutByBottom);
    stays('nor one showing a single pixel at the top', cases.pixelAtTop);
    stays('nor one showing a single pixel at the bottom', cases.pixelAtBottom);

    scrollsOnScreen('a box ending exactly at the top of the frame shows nothing, so it scrolls', cases.sharingTopEdge);
    scrollsOnScreen('a box starting exactly at the bottom of the frame shows nothing, so it scrolls', cases.sharingBottomEdge);
    scrollsOnScreen('a box below the frame scrolls', cases.belowFrame);
    scrollsOnScreen('a box above the frame scrolls', cases.aboveFrame);

    stays('a box cut by the right of the frame does not move the page', cases.cutByRight);
    stays('nor one cut by the left of the frame', cases.cutByLeft);
    stays('nor one cut by the right and the top', cases.cutByRightAndTop);
    stays('nor one cut by the left and the bottom', cases.cutByLeftAndBottom);
    stays('a box wholly beside the frame stays put, since a vertical move could not help it', cases.awayBeside);
    check('and a box beside the frame and below it scrolls down', cases.awayBelow.scrollY !== cases.awayBelow.startY, JSON.stringify(cases.awayBelow));
    check('until it is level with the frame, not sideways', cases.awayBelow.scrollX === 0 && allZero(cases.awayBelow.lefts), JSON.stringify(cases.awayBelow));

    stays('a ::before in view does not move the page, however tall its host', cases.pseudoInView);
    stays('nor does its host, which is in view too', cases.hostOfPseudo);
    check(
      'a ::before out of view scrolls, though its host covers the frame',
      cases.pseudoAboveFrame.scrollY !== cases.pseudoAboveFrame.startY,
      JSON.stringify(cases.pseudoAboveFrame),
    );
    // The ::before sits 50px down its host and 60px tall, so its top is 50px below the host's.
    const pseudoTop = cases.pseudoAboveFrame.top + 50;
    check('until the ::before is on screen', pseudoTop >= 0 && pseudoTop + 60 <= cases.pseudoAboveFrame.height, JSON.stringify(cases.pseudoAboveFrame));

    stays('a box taller than the frame does not move the page while it covers the frame', cases.longCovering);
    stays('nor with its top exactly at the top of the frame', cases.longFlushTop);
    stays('nor with only its top showing', cases.longTopShowing);
    stays('nor where a reveal lands it', cases.longLanded);
    stays('nor with only its bottom showing', cases.longBottomShowing);
    stays('nor with a single pixel of its bottom showing', cases.longPixelAtBottom);
    scrollsToTop('one wholly above the frame aligns to its top', cases.longAboveFrame);
    scrollsToTop('one wholly below the frame aligns to its top', cases.longBelowFrame);

    stays('a ::before with no box stays put while its host is in view', cases.bareInView);
    stays('and while its host is partly in view', cases.bareCutByTop);
    scrollsOnScreen('and reveals its host when that is out of view', cases.bareBelowFrame);

    stays('a box with no height stays put inside the frame', cases.flatInside);
    stays('and on the top edge of the frame', cases.flatOnTopEdge);
    stays('and on the bottom edge of the frame', cases.flatOnBottomEdge);
    scrollsOnScreen('and scrolls from above the frame', cases.flatAbove);
    scrollsOnScreen('and from below it', cases.flatBelow);

    stays('a box with no width stays put inside the frame', cases.thinInside);
    scrollsOnScreen('and is judged whole, so being cut by the frame still scrolls', cases.thinCutByTop);
    scrollsOnScreen('and scrolls from below the frame', cases.thinBelow);

    stays('an element with no size does nothing from below the frame', cases.emptyBelow);
    stays('nor from above it', cases.emptyAbove);
    check('the display: none case starts down the page', gone.startY > 0, JSON.stringify(gone));
    stays('an element with display: none does nothing', gone);

    stays('<body> does not move a page at its top', cases.bodyAtTop);
    stays('nor does <html>', cases.htmlAtTop);
    check('the far-down cases start down the page', cases.bodyFarDown.startY > 0 && cases.htmlFarDown.startY > 0, JSON.stringify(cases.bodyFarDown));
    stays('<body> does not move a page scrolled far down it', cases.bodyFarDown);
    stays('nor does <html>', cases.htmlFarDown);

    // The rule that makes this case hard: both boxes really are above the frame.
    check(
      'on a page with height: 100%, <body> and <html> end above the frame',
      pinned.boxes.every((bottom) => bottom < 0),
      JSON.stringify(pinned.boxes),
    );
    check('that page starts down the page', pinned.body.startY > 0, JSON.stringify(pinned.body));
    stays('even so, <body> does not move it', pinned.body);
    stays('nor does <html>', pinned.html);
    stays('nor a body::before with no box, which <body> stands in for', pinned.bodyStandIn);
    scrollsOnScreen('while a box out of view on that page still scrolls', pinned.farOffScreen);

    const scrollerStays = (what, move) => {
      check(`${what}: it started scrolled`, move.startScroller > 0, JSON.stringify(move));
      check(what, move.scroller === move.startScroller, JSON.stringify(move));
      check(`${what}, and the window stays put`, move.scrollY === 0, JSON.stringify(move));
    };
    scrollerStays('<body> does not move a scrolling <body>', bodyScroller.body);
    scrollerStays('nor does <html>', bodyScroller.html);
    scrollerStays('nor a box partly in view inside it', bodyScroller.cut);
    scrollerStays('<body> does not move a scrolling wrapper', innerScroller.body);
    scrollerStays('nor does <html>', innerScroller.html);
    scrollerStays('nor a box partly in view inside it', innerScroller.cut);
  }

  if (failures.length) {
    console.error(`reveal-scrolls-down: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`reveal-scrolls-down: ${checked} passed  [a reveal scrolls down, never sideways, and only when no part is in view]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
