// Goal: act on the real app the way a person does. Every press, key, hover and wheel goes
// through Electron's `webContents.sendInputEvent`, at real window coordinates, so hit-testing,
// pointer capture, focus, blur, scrolling and the canvas frame's event routing are Chromium's
// own. Nothing here dispatches a synthetic DOM event.
//
// Method: coordinates come from the live layout (the panel's DOM, or the canvas frame's DOM
// plus the iframe's offset), read immediately before each action. Controls below the fold are
// brought into view with real wheel events over the panel, bounded by WHEEL_STEPS_MAX. Each
// action first leaves a note in the page recorder (panelRecorder.js) so the logs can tell a
// close the person caused from one the panel caused. `settle` waits until the panel has
// painted no new state for a quiet period, bounded by SETTLE_MS_MAX: a wait on the app's
// own frames, not a fixed sleep a slow machine could miss.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const CANVAS_WAIT_MS_MAX = 120000;
const CANVAS_POLL_MS = 250;
const SETTLE_QUIET_MS = 450;
const SETTLE_MS_MAX = 6000;
const SETTLE_POLL_MS = 16;
const WHEEL_STEPS_MAX = 40;
const WHEEL_DELTA_PX = 120;
const PANEL_VIEW_MARGIN_PX = 60;
const PROJECT_FILES_MAX = 400;
const STILL_POLLS_MAX = 60;
const STILL_POLLS_NEEDED = 3;
const MENU_ITEMS_MAX = 200;
const FILM_FRAMES_MAX = 240;
const EVALUATE_MS_MAX = 20000;
// The grid a canvas press searches for a point the element itself receives. The soak page's
// type overflows its boxes (Lumos headings over the paragraphs below them), so the first point
// of an element can belong to its neighbour, and the press then selected that neighbour or the
// container: SP-14's "external" cycle edited the wrong element. Bounded: 6 x 4 probes.
const HIT_GRID_COLUMNS = 7;
const HIT_GRID_ROWS = 5;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createDriver(window, project) {
  const contents = window.webContents;
  // Every page call is bounded: a frame replaced under a call (the canvas reloading) never
  // answers it, and one silent call would hang the whole run.
  const bounded = (promise, what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`soakDriver: ${what} did not answer within ${EVALUATE_MS_MAX} ms`)), EVALUATE_MS_MAX);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const evaluate = (source) => bounded(contents.executeJavaScript(source), 'the app page');
  const note = (detail) => evaluate(`window.__soak && window.__soak.note(${JSON.stringify(detail)}); 0`);

  function canvasFrame() {
    const frames = contents.mainFrame.frames;
    return (
      frames.find((frame) => /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//.test(frame.url) && !frame.url.includes(new URL(contents.getURL()).host)) ?? frames[0]
    );
  }

  async function canvasEvaluate(source) {
    const frame = canvasFrame();
    if (frame === undefined) {
      throw new Error('soakDriver: the canvas frame is not there');
    }
    return bounded(frame.executeJavaScript(source), 'the canvas frame');
  }

  async function waitForApp() {
    for (let waitedMs = 0; waitedMs < CANVAS_WAIT_MS_MAX; waitedMs += CANVAS_POLL_MS) {
      try {
        const nodes = await canvasEvaluate(`document.readyState === 'complete' ? document.querySelectorAll('[data-avb-p]').length : 0`);
        const panel = await evaluate(`!!document.querySelector('.embed-editor_root')`);
        if (nodes > 0 && panel) {
          return;
        }
      } catch {
        // The frame is still loading; ask again.
      }
      await sleep(CANVAS_POLL_MS);
    }
    throw new Error('soakDriver: the canvas never rendered the fixture');
  }

  // The window point at the centre of a canvas element, by CSS selector inside the page.
  async function canvasPoint(selector) {
    const frameBox = await evaluate(
      `(() => { const f = [...document.querySelectorAll('iframe')].find((e) => e.getClientRects().length > 0); if (!f) return undefined; const r = f.getBoundingClientRect(); return { x: r.left + f.clientLeft, y: r.top + f.clientTop, scale: r.width / (f.clientWidth || r.width) }; })()`,
    );
    const inner = await canvasEvaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return undefined; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); for (let row = 1; row < ${HIT_GRID_ROWS}; row += 1) { for (let column = 1; column < ${HIT_GRID_COLUMNS}; column += 1) { const x = r.left + (r.width * column) / ${HIT_GRID_COLUMNS}; const y = r.top + (r.height * row) / ${HIT_GRID_ROWS}; if (e.contains(document.elementFromPoint(x, y))) return { x, y }; } } return { x: r.left + Math.min(r.width / 2, 40), y: r.top + Math.min(r.height / 2, 20) }; })()`,
    );
    if (frameBox === undefined || inner === undefined) {
      throw new Error(`soakDriver: no canvas element ${selector}`);
    }
    return { x: Math.round(frameBox.x + inner.x * frameBox.scale), y: Math.round(frameBox.y + inner.y * frameBox.scale) };
  }

  // A panel element's centre, brought into the panel's view with real wheel events first.
  // `finder` is page-side source for an expression yielding the element.
  async function panelPoint(finder, { scroll = true, offsetX } = {}) {
    let stilled = false;
    for (let step = 0; step < WHEEL_STEPS_MAX; step += 1) {
      const box = await evaluate(`(() => {
        const element = (${finder});
        if (!element) return undefined;
        const r = element.getBoundingClientRect();
        const root = document.querySelector('.embed-editor_root');
        const panel = root ? root.getBoundingClientRect() : { left: 0, width: innerWidth };
        const x = ${offsetX === undefined ? 'r.left + r.width / 2' : `r.left + ${offsetX}`};
        const y = r.top + r.height / 2;
        const hit = y > 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
        return { x, y, hit: !!hit && (hit === element || element.contains(hit) || hit.contains(element)), panelX: panel.left + Math.min(panel.width, 300) / 2, viewHeight: innerHeight };
      })()`);
      if (box === undefined) {
        return undefined;
      }
      const inView = box.y >= PANEL_VIEW_MARGIN_PX && box.y <= box.viewHeight - PANEL_VIEW_MARGIN_PX;
      if (!scroll || (inView && box.hit)) {
        if (step > 0 && !stilled) {
          // A wheel scroll animates; the point is only good once the element stops moving.
          await waitForStill(finder);
          stilled = true;
          continue;
        }
        return { x: Math.round(box.x), y: Math.round(box.y), hit: box.hit };
      }
      // Covered (the sticky header) or out of view: move it toward the middle of the panel.
      const deltaY = box.y < box.viewHeight / 2 ? WHEEL_DELTA_PX : -WHEEL_DELTA_PX;
      await note({ kind: 'action', action: 'wheel', why: 'bring control into view' });
      contents.sendInputEvent({ type: 'mouseWheel', x: Math.round(box.panelX), y: Math.round(box.viewHeight / 2), deltaX: 0, deltaY, canScroll: true });
      await sleep(40);
    }
    return undefined;
  }

  async function waitForStill(finder) {
    let last = '';
    let still = 0;
    for (let poll = 0; poll < STILL_POLLS_MAX && still < STILL_POLLS_NEEDED; poll += 1) {
      const top = await evaluate(`(() => { const e = (${finder}); return e ? Math.round(e.getBoundingClientRect().top) : -1; })()`);
      still = String(top) === last ? still + 1 : 0;
      last = String(top);
      await sleep(16);
    }
  }

  // What the operating system does for a menu shortcut: the app menu item's own click. Input
  // events sent to the page never reach the menu, so Cmd+Z sent as keys would not undo.
  async function menu(accelerator, label) {
    await note({ kind: 'action', action: label ?? `menu ${accelerator}` });
    const { Menu } = require('electron');
    const pending = [...(Menu.getApplicationMenu()?.items ?? [])];
    for (let visited = 0; pending.length > 0 && visited < MENU_ITEMS_MAX; visited += 1) {
      const item = pending.shift();
      if (item.accelerator === accelerator) {
        item.click(undefined, window, contents);
        return true;
      }
      if (typeof item.role === 'string' && item.role.toLowerCase() === accelerator.toLowerCase()) {
        // A role item has no click of its own: the role is the web contents' editing command.
        contents[item.role === 'selectall' ? 'selectAll' : item.role]();
        return true;
      }
      pending.push(...(item.submenu?.items ?? []));
    }
    throw new Error(`soakDriver: no menu item for ${accelerator}`);
  }

  async function pointerPress(point, { modifiers = [], holdMs = 30, label = 'press', clickCount = 1 } = {}) {
    await note({ kind: 'action', action: label, x: point.x, y: point.y, modifiers });
    contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y, modifiers });
    contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount, modifiers });
    await sleep(holdMs);
    contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount, modifiers });
  }

  async function hover(point, label = 'hover') {
    await note({ kind: 'action', action: label, x: point.x, y: point.y });
    contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  }

  async function drag(from, to, { steps = 8, label = 'drag', modifiers = [] } = {}) {
    await note({ kind: 'action', action: label, from, to });
    contents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y, modifiers });
    contents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers });
    for (let step = 1; step <= steps; step += 1) {
      const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
      const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
      contents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers });
      await sleep(16);
    }
    contents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers });
  }

  async function key(keyCode, { modifiers = [], label } = {}) {
    await note({ kind: 'action', action: label ?? `key ${keyCode}`, modifiers });
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && modifiers.length === 0) {
      contents.sendInputEvent({ type: 'char', keyCode, modifiers });
    }
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  async function typeText(text) {
    await note({ kind: 'action', action: `type ${text}` });
    for (const character of text) {
      contents.sendInputEvent({ type: 'keyDown', keyCode: character });
      contents.sendInputEvent({ type: 'char', keyCode: character });
      contents.sendInputEvent({ type: 'keyUp', keyCode: character });
      await sleep(12);
    }
  }

  async function wheel(point, deltaY, label = 'wheel') {
    await note({ kind: 'action', action: label });
    contents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, canScroll: true });
  }

  // Waits until the panel has painted nothing new for SETTLE_QUIET_MS (bounded).
  async function settle() {
    let lastKey = '';
    let quietSinceMs = Date.now();
    const startMs = Date.now();
    while (Date.now() - startMs < SETTLE_MS_MAX) {
      const key = await evaluate(`JSON.stringify(window.__soak.snapshot())`);
      if (key !== lastKey) {
        lastKey = key;
        quietSinceMs = Date.now();
      } else if (Date.now() - quietSinceMs >= SETTLE_QUIET_MS) {
        return { settled: true, waitedMs: Date.now() - startMs };
      }
      await sleep(SETTLE_POLL_MS);
    }
    return { settled: false, waitedMs: Date.now() - startMs };
  }

  // Bytes of every source file in the fixture, hashed: a write anywhere changes it.
  function projectFingerprint() {
    const hash = crypto.createHash('sha256');
    const pending = [path.join(project, 'src')];
    let files = 0;
    while (pending.length > 0 && files < PROJECT_FILES_MAX) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
        } else if (/\.(astro|css)$/.test(entry.name)) {
          hash.update(full);
          hash.update(fs.readFileSync(full));
          files += 1;
        }
      }
    }
    return hash.digest('hex').slice(0, 16);
  }

  // Every source file's text by project-relative path, for saying what a stray write changed.
  function projectSnapshot() {
    const files = new Map();
    const pending = [path.join(project, 'src')];
    while (pending.length > 0 && files.size < PROJECT_FILES_MAX) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
        } else if (/\.(astro|css)$/.test(entry.name)) {
          files.set(path.relative(project, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
        }
      }
    }
    return files;
  }

  function readProjectFile(relative) {
    return fs.readFileSync(path.join(project, ...relative.split('/')), 'utf8');
  }

  let debuggerAttached = false;
  const devtools = (method, parameters) => {
    if (!debuggerAttached) {
      contents.debugger.attach('1.3');
      debuggerAttached = true;
    }
    return contents.debugger.sendCommand(method, parameters);
  };
  async function setCpuThrottling(rate) {
    await devtools('Emulation.setCPUThrottlingRate', { rate });
  }

  // A person types into a window they are looking at, which the system has focused. The soak's
  // window often is not: it opens behind the terminal, or another app takes the front while a
  // long run goes on. In an unfocused page Chromium moves document.activeElement but fires no
  // focus or blur events, so `element.blur()` commits nothing: Enter in a field only wrote its
  // live draft, and every clear, undo and redo after it compared against a set that never
  // happened (the SP-06 report). Focus emulation gives the page the focus the person's window
  // has; the window-blur exit turns it off to take that focus away for real.
  async function setPageFocus(state) {
    assert(state === 'focused' || state === 'unfocused', `setPageFocus: unknown state ${state}`);
    await devtools('Emulation.setFocusEmulationEnabled', { enabled: state === 'focused' });
    if (state === 'focused') {
      const focused = await evaluate('document.hasFocus()');
      assert(focused === true, 'setPageFocus: the page has focus once focus is emulated');
    }
  }

  // The window's real painted frames while `act` runs and for `durationMs` after, cropped to
  // `rect` (window CSS pixels) and written as numbered PNGs: what reached the screen, not what
  // the DOM said. Bounded by FILM_FRAMES_MAX.
  async function film(directory, rect, durationMs, act) {
    fs.mkdirSync(directory, { recursive: true });
    const frames = [];
    const startMs = Date.now();
    contents.beginFrameSubscription(false, (image) => {
      if (frames.length < FILM_FRAMES_MAX) {
        frames.push({ atMs: Date.now() - startMs, image });
      }
    });
    try {
      await act();
      await sleep(durationMs);
    } finally {
      contents.endFrameSubscription();
    }
    const written = [];
    for (const [index, frame] of frames.entries()) {
      const scale = frame.image.getSize().width / window.getContentBounds().width;
      const cropped = frame.image.crop({
        x: Math.round(rect.x * scale),
        y: Math.round(rect.y * scale),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale),
      });
      const file = path.join(directory, `frame-${String(index).padStart(3, '0')}-${frame.atMs}ms.png`);
      fs.writeFileSync(file, cropped.toPNG());
      written.push(file);
    }
    return written;
  }

  async function screenshot(file) {
    const image = await contents.capturePage();
    fs.writeFileSync(file, image.toPNG());
  }

  return {
    contents,
    evaluate,
    note,
    canvasEvaluate,
    waitForApp,
    canvasPoint,
    panelPoint,
    menu,
    pointerPress,
    hover,
    drag,
    key,
    typeText,
    wheel,
    settle,
    sleep,
    projectFingerprint,
    readProjectFile,
    projectSnapshot,
    setCpuThrottling,
    setPageFocus,
    screenshot,
    film,
  };
}

module.exports = { createDriver, sleep };
