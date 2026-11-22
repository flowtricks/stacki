// Goal: a real recording stays inside its bounds and writes nothing. The recorder from dist/ records a region
// of a hidden Electron window showing a synthetic animated page for about two seconds through the real
// `webContents.capturePage`; the frame count matches the adaptive rate (between the floor and the ceiling),
// the bytes stay far under the byte bound, frames differ (the page moved), each frame is a JPEG within the
// screenshot edge with a small thumbnail, discard frees everything, and no file is written while it records.
// The measured rate and bytes per frame are printed, so a regression in either shows in the log.
//
//   node test/electron/handlers/ai/screenRecordingElectron.test.js
//
// Method: run under the Electron binary in a window that is never shown (show: false, offscreen rendering,
// and test/helpers/hideWindows.js installed besides). Node's file-writing functions are wrapped for the
// length of the recording and every call is counted. Waits are for a condition or a fixed, bounded time.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repoPath } = require('../../../helpers/sources.js');

const RECORD_MS = 2_000;
/** A small region (a button), a medium one (a section) and a large one (most of the window). */
const REGIONS = {
  small: { x: 220, y: 30, width: 300, height: 100 },
  medium: { x: 0, y: 0, width: 800, height: 500 },
  large: { x: 0, y: 0, width: 1400, height: 900 },
};
/** Wide, square and tall (a phone column) regions, each recorded with a coloured marker in each of its corners. */
const SHAPES = {
  wide: { x: 40, y: 40, width: 1200, height: 300 },
  square: { x: 40, y: 40, width: 500, height: 500 },
  tall: { x: 40, y: 40, width: 360, height: 1200 },
};
/** Marker colours, clockwise from the top-left corner. */
const CORNERS = { topLeft: [255, 0, 0], topRight: [0, 200, 0], bottomRight: [0, 0, 255], bottomLeft: [255, 220, 0] };

// A page about as busy as a real site: a gradient, a moving block and a screenful of text, so the measured
// bytes per frame say something about real recordings.
const PAGE =
  '<!doctype html><html><body style="margin:0;font:15px/1.5 system-ui;color:#ddd;background:linear-gradient(135deg,#123,#432)">' +
  '<div id="box" style="position:absolute;top:40px;left:0;width:160px;height:160px;border-radius:24px;background:#4af"></div>' +
  '<main style="padding:24px 24px 0 220px">' +
  Array.from({ length: 40 }, (_, line) => `<p style="margin:0 0 4px">Line ${line + 1}: the quick brown fox jumps over the lazy dog, 0123456789.</p>`).join('') +
  '</main><script>let x=0;setInterval(()=>{x=(x+9)%900;document.getElementById("box").style.left=x+"px"},16)</script>' +
  '</body></html>';

const PROBE = `
const REGIONS = ${JSON.stringify(REGIONS)};
const SHAPES = ${JSON.stringify(SHAPES)};
const CORNERS = ${JSON.stringify(CORNERS)};
const electron = require('electron');
const { app, BrowserWindow, nativeImage } = electron;
require(${JSON.stringify(repoPath('test/helpers/hideWindows.js'))}).installWindowHiding(electron);
const fs = require('fs');
const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const { ScreenRecorder, RECORDING_LIMITS } = require(${JSON.stringify(repoPath('dist/electron/handlers/ai/screenRecorder.js'))});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const output = {};
  const win = new BrowserWindow({ show: false, width: 1500, height: 1300, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(PAGE)}));
    // The page is drawn and animating once its block has moved.
    await waitFor({ what: 'the page to animate', read: () => win.webContents.executeJavaScript('parseFloat(document.getElementById("box").style.left || "0")'), until: (left) => left > 0, pollIntervalMs: 20, pollCountMax: 250 });
    // Count every Node file write while recording: the recorder must make none.
    const writes = [];
    const wrapped = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'open', 'openSync', 'mkdtemp', 'mkdtempSync'];
    const originals = new Map(wrapped.map((name) => [name, fs[name]]));
    for (const name of wrapped) {
      fs[name] = function (...args) { writes.push(name + ' ' + String(args[0])); return originals.get(name).apply(this, args); };
    }
    const originalPromiseWrite = fs.promises.writeFile;
    fs.promises.writeFile = (...args) => { writes.push('promises.writeFile ' + String(args[0])); return originalPromiseWrite(...args); };
    const recorder = new ScreenRecorder({ now: Date.now, setTimer: (run, delayMs) => { const timer = setTimeout(run, delayMs); return { cancel: () => clearTimeout(timer) }; } });
    const capture = (rect) => win.webContents.capturePage(rect, { stayHidden: true, stayAwake: true });
    output.regions = {};
    for (const [name, rect] of Object.entries(REGIONS)) {
      const captureTimes = [];
      const sender = { capture: async (area) => { const started = Date.now(); const image = await capture(area); captureTimes.push(Date.now() - started); return image; }, visible: () => true };
      const rssBefore = process.memoryUsage().rss;
      const started = await recorder.act({ kind: 'start', rect }, sender);
      if (!started.ok) { throw new Error('start failed'); }
      const id = started.value.id;
      const startedAt = Date.now();
      // Recorded until main has counted RECORD_MS of capture time, read from its own status.
      await waitFor({ what: 'the recording to run its time', read: async () => (await recorder.act({ kind: 'status', id }, sender)).value.elapsedMs, until: (elapsedMs) => elapsedMs >= ${RECORD_MS}, pollIntervalMs: 50, pollCountMax: 400 });
      const status = await recorder.act({ kind: 'status', id }, sender);
      const stopped = await recorder.act({ kind: 'stop', id }, sender);
      const wallMs = Date.now() - startedAt;
      const after = await recorder.act({ kind: 'status', id }, sender);
      const first = await recorder.act({ kind: 'frame', id, index: 0 }, sender);
      const lastIndex = stopped.ok ? stopped.value.frames.length - 1 : 0;
      const last = await recorder.act({ kind: 'frame', id, index: lastIndex }, sender);
      const rssAfter = process.memoryUsage().rss;
      await recorder.act({ kind: 'discard', id }, sender);
      const gone = await recorder.act({ kind: 'frame', id, index: 0 }, sender);
      const frames = stopped.ok ? stopped.value.frames : [];
      output.regions[name] = {
        frames: frames.length,
        fps: stopped.ok ? stopped.value.fps : -1,
        reason: stopped.ok ? stopped.value.stopReason : 'none',
        bytes: after.ok ? after.value.bytes : -1,
        elapsedMs: status.ok ? status.value.elapsedMs : -1,
        wallMs,
        firstAtMs: frames[0] ? frames[0].atMs : -1,
        lastAtMs: frames.length > 0 ? frames[frames.length - 1].atMs : -1,
        thumbChars: frames.length > 0 ? Math.max(...frames.map((frame) => frame.thumb.length)) : -1,
        firstFrame: first.ok ? { mime: first.value.image.mimeType, width: first.value.image.width, height: first.value.image.height, head: first.value.image.data.slice(0, 4) } : undefined,
        framesDiffer: first.ok && last.ok ? first.value.image.data !== last.value.image.data : false,
        goneAfterDiscard: !gone.ok,
        captureMsMedian: captureTimes.sort((a, b) => a - b)[Math.floor(captureTimes.length / 2)],
        rssGrowthBytes: rssAfter - rssBefore,
      };
    }
    // Corner markers: the decoded frame must have the region's aspect and show all four corners.
    output.shapes = {};
    for (const [name, rect] of Object.entries(SHAPES)) {
      await win.webContents.executeJavaScript(\`(() => {
        document.querySelectorAll('.corner').forEach((node) => node.remove());
        const rect = \${JSON.stringify(rect)};
        const colours = \${JSON.stringify(CORNERS)};
        const size = 24;
        const place = { topLeft: [rect.x, rect.y], topRight: [rect.x + rect.width - size, rect.y], bottomRight: [rect.x + rect.width - size, rect.y + rect.height - size], bottomLeft: [rect.x, rect.y + rect.height - size] };
        for (const [corner, [left, top]] of Object.entries(place)) {
          const node = document.createElement('div');
          node.className = 'corner';
          node.style.cssText = 'position:fixed;z-index:9;width:' + size + 'px;height:' + size + 'px;left:' + left + 'px;top:' + top + 'px;background:rgb(' + colours[corner].join(',') + ')';
          document.body.append(node);
        }
      })()\`);
      await waitFor({ what: 'the corner markers', read: () => win.webContents.executeJavaScript('document.querySelectorAll(".corner").length'), until: (count) => count === 4, pollIntervalMs: 20, pollCountMax: 100 });
      await win.webContents.executeJavaScript('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
      const sender = { capture: (area) => capture(area), visible: () => true };
      const started = await recorder.act({ kind: 'start', rect }, sender);
      const id = started.value.id;
      await waitFor({ what: 'a few frames', read: async () => (await recorder.act({ kind: 'status', id }, sender)).value.frames, until: (frames) => frames >= 3, pollIntervalMs: 20, pollCountMax: 250 });
      await recorder.act({ kind: 'stop', id }, sender);
      const frame = await recorder.act({ kind: 'frame', id, index: 0 }, sender);
      await recorder.act({ kind: 'discard', id }, sender);
      const image = nativeImage.createFromBuffer(Buffer.from(frame.value.image.data, 'base64'));
      const size = image.getSize();
      const bitmap = image.toBitmap();
      // A pixel a few marker-widths in from each corner, scaled to the frame; the bitmap is BGRA.
      const inset = (edge, regionEdge) => Math.max(1, Math.floor((8 * edge) / regionEdge));
      const at = (x, y) => { const offset = (y * size.width + x) * 4; return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]; };
      const dx = inset(size.width, rect.width);
      const dy = inset(size.height, rect.height);
      output.shapes[name] = {
        region: rect,
        frame: { width: frame.value.image.width, height: frame.value.image.height },
        decoded: size,
        corners: {
          topLeft: at(dx, dy),
          topRight: at(size.width - 1 - dx, dy),
          bottomRight: at(size.width - 1 - dx, size.height - 1 - dy),
          bottomLeft: at(dx, size.height - 1 - dy),
        },
      };
    }
    for (const [name, original] of originals) { fs[name] = original; }
    fs.promises.writeFile = originalPromiseWrite;
    output.writes = writes;
    output.limits = { framesMax: RECORDING_LIMITS.framesMax, bytesMax: RECORDING_LIMITS.bytesMax, fpsMin: RECORDING_LIMITS.fpsMin, fpsMax: RECORDING_LIMITS.fpsMax };
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); app.quit();
});
`;

// The frame rate and whether a hidden window animates between captures depend on the CPU the runner has
// free: a shared GitHub runner measured 0.8 fps where this Mac records 15. On CI they are printed as
// measurements (the log line above each run) and fail only on a machine of our own.
const RATE_CHECKS_ADVISORY = process.env.CI === 'true';

function check(output) {
  const failures = [];
  const advisories = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(`${name} (${JSON.stringify(detail ?? output)})`.slice(0, 700));
    }
  };
  const expectRate = (name, condition, detail) => {
    if (RATE_CHECKS_ADVISORY) {
      if (!condition) {
        advisories.push(`${name} (${JSON.stringify(detail ?? output)})`.slice(0, 700));
      }
    } else {
      expect(name, condition, detail);
    }
  };
  expect('the recordings ran', output.error === undefined);
  expect('nothing was written while recording', Array.isArray(output.writes) && output.writes.length === 0);
  for (const [name, region] of Object.entries(output.regions ?? {})) {
    expect(`${name}: the person stopped it`, region.reason === 'person', region);
    expect(`${name}: within the frame bound`, region.frames <= output.limits.framesMax, region);
    expectRate(`${name}: at least the floor rate`, region.fps >= output.limits.fpsMin, region);
    expect(`${name}: at most the ceiling rate`, region.fps <= output.limits.fpsMax + 0.5, region);
    expect(`${name}: far under the byte bound`, region.bytes > 0 && region.bytes < output.limits.bytesMax / 4, region);
    expect(`${name}: a full frame is a JPEG within the screenshot edge`, region.firstFrame?.mime === 'image/jpeg' && region.firstFrame.width <= 1600, region);
    expect(`${name}: thumbnails are small`, region.thumbChars > 0 && region.thumbChars < 400_000, region);
    expectRate(`${name}: the animated page gives different frames`, region.framesDiffer === true, region);
    expect(`${name}: the first frame is taken at once`, region.firstAtMs === 0, region);
    expect(`${name}: the last frame is from the moment of Stop`, region.lastAtMs >= region.elapsedMs, region);
    expect(`${name}: the clock matches real time, never ahead of it`, region.elapsedMs >= RECORD_MS && region.elapsedMs <= region.wallMs, region);
    expect(`${name}: discard frees the recording`, region.goneAfterDiscard === true, region);
  }
  // A JPEG pixel is close to its colour, not equal to it.
  const near = (actual, wanted) => actual.every((channel, index) => Math.abs(channel - wanted[index]) <= 60);
  for (const [name, shape] of Object.entries(output.shapes ?? {})) {
    const regionRatio = shape.region.width / shape.region.height;
    const frameRatio = shape.decoded.width / shape.decoded.height;
    expect(`${name}: the decoded frame has the region's aspect`, Math.abs(frameRatio - regionRatio) / regionRatio < 0.02, shape);
    expect(`${name}: the reported size is the decoded size`, shape.frame.width === shape.decoded.width && shape.frame.height === shape.decoded.height, shape);
    for (const [corner, colour] of Object.entries(CORNERS)) {
      expect(`${name}: the ${corner} marker is in the frame (nothing is cropped)`, near(shape.corners[corner], colour), shape);
    }
  }
  expectRate('a small region records at 10 fps or more', output.regions?.small?.fps >= 10, output.regions?.small);
  for (const advisory of advisories) {
    console.log(`screen-recording-electron: ADVISORY on CI, not failed: ${advisory}`);
  }
  return failures;
}

(() => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('screen-recording-electron: skipped  [needs the Electron binary]');
    return;
  }
  // macOS only, like the pointer probes: a hidden window under Linux's virtual display gives capturePage no
  // frames at all, and a Windows runner's 1024x768 desktop clamps the 1400-wide window, so its regions are cut.
  if (process.platform !== 'darwin') {
    console.log(`screen-recording-electron: skipped  [real capture is probed on macOS; this is ${process.platform}]`);
    return;
  }
  if (!fs.existsSync(repoPath('dist/electron/handlers/ai/screenRecorder.js'))) {
    throw new Error('Assertion failed: build dist/ first (npm test builds it)');
  }
  const directory = repoPath('node_modules/.stacki-test/screen-recording-electron');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 60_000, env: environment, maxBuffer: 16 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (line === undefined) {
    throw new Error(`Assertion failed: the Electron probe ran\n${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  }
  const output = JSON.parse(line.slice('RESULT '.length));
  for (const [name, region] of Object.entries(output.regions ?? {})) {
    const perFrame = region.frames > 0 ? Math.round(region.bytes / region.frames) : 0;
    console.log(
      `screen-recording-electron: ${name} ${REGIONS[name].width}x${REGIONS[name].height}: ${region.frames} frames in ${RECORD_MS / 1000}s, ` +
        `${region.fps} fps, capture median ${region.captureMsMedian} ms, ${perFrame} bytes per frame, rss growth ${Math.round(region.rssGrowthBytes / 1024)} KiB`,
    );
  }
  for (const [name, shape] of Object.entries(output.shapes ?? {})) {
    console.log(
      `screen-recording-electron: ${name} ${shape.region.width}x${shape.region.height} recorded as ${shape.decoded.width}x${shape.decoded.height}, corners ${JSON.stringify(shape.corners)}`,
    );
  }
  const failures = check(output);
  if (failures.length > 0) {
    throw new Error(`Assertion failed:\n  ${failures.join('\n  ')}`);
  }
})();
