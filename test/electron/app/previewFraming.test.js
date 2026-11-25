// Goal: a site that forbids being framed does not blank the canvas. EmDash's integration answers every page with
// `X-Frame-Options: SAMEORIGIN` (found in the real app: the canvas showed a white page after EmDash was added, and the
// log said ERR_BLOCKED_BY_RESPONSE for the preview address), and a Content-Security-Policy may add `frame-ancestors`.
// The app lets frame responses from loopback through without those two rules, and changes nothing else.
// Method: pure tests of the header filter and the loopback check, then a real browser: an Electron window frames a local
// http server that sends both rules, once in a session without the fix (the frame must be blocked: this proves the
// failure) and once in a session with it (the frame must load, and a request to a non-loopback address is untouched).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repoPath } = require('../../helpers/sources.js');
const { isLoopbackAddress, withoutFramingRules } = require('#dist/electron/app/previewFraming.js');
const ELECTRON_SOURCE = repoPath('electron');

test('the framing rules are dropped and every other header is kept as it was', () => {
  const headers = {
    'X-Frame-Options': ['SAMEORIGIN'],
    'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'self'; img-src data:"],
    'content-type': ['text/html'],
    'x-content-type-options': ['nosniff'],
  };
  const result = withoutFramingRules(headers);
  assert.deepEqual(result, {
    'Content-Security-Policy': ["default-src 'self'; img-src data:"],
    'content-type': ['text/html'],
    'x-content-type-options': ['nosniff'],
  });
  assert.ok('X-Frame-Options' in headers, 'the input is not changed');
});

test('a policy that was only frame-ancestors disappears, others stay, and report-only is treated alike', () => {
  assert.deepEqual(withoutFramingRules({ 'content-security-policy': ["frame-ancestors 'none'"] }), {});
  assert.deepEqual(withoutFramingRules({ 'content-security-policy-report-only': ["frame-ancestors 'none'; script-src 'self'"] }), {
    'content-security-policy-report-only': ["script-src 'self'"],
  });
  assert.deepEqual(withoutFramingRules({ 'content-security-policy': ["default-src 'self'", "frame-ancestors 'self'"] }), {
    'content-security-policy': ["default-src 'self'"],
  });
  assert.deepEqual(withoutFramingRules({ 'x-frame-options': ['DENY'], Vary: ['Origin'] }), { Vary: ['Origin'] });
});

test('a Cross-Origin-Resource-Policy on a framed document is dropped with the other framing rules', () => {
  assert.deepEqual(withoutFramingRules({ 'Cross-Origin-Resource-Policy': ['same-origin'], Vary: ['Origin'] }), { Vary: ['Origin'] });
});

test('only previewFraming.ts registers onHeadersReceived: a second registration would silently replace the first', () => {
  const found = [];
  // Iterative, with a stated bound: the folder tree is small, and a runaway link fails here rather than hangs.
  const pending = [ELECTRON_SOURCE];
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert.ok(visited < 5000, 'the electron source tree is walked within a bound');
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/\.(ts|js|mjs)$/.test(entry.name) && /webRequest\.onHeadersReceived\(/.test(fs.readFileSync(full, 'utf8'))) {
        found.push(path.relative(ELECTRON_SOURCE, full));
      }
    }
  }
  assert.deepEqual(found, [path.join('app', 'previewFraming.ts')], 'every header rule goes through addResponseHeaderRule');
});

test('only an address on this machine counts as loopback', () => {
  for (const address of ['http://127.0.0.1:4321/', 'http://localhost:3000/a', 'http://[::1]:4321/', 'https://localhost/']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['http://example.com/', 'http://127.0.0.1.example.com/', 'http://192.168.1.5:4321/', 'file:///tmp/x.html', 'not a url', '']) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test('in a real browser, a frame the site forbids is blocked without the fix and shown with it', (context) => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    context.skip('needs a Chromium');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/preview-framing');
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow, session } = require('electron');
     const http = require('http');
     const path = require('path');
     const fs = require('fs');
     const { allowLoopbackFraming, addResponseHeaderRule } = require(${JSON.stringify(repoPath('dist/electron/app/previewFraming.js'))});
     app.disableHardwareAcceleration();
     // The first window is destroyed before the second opens; the probe quits itself.
     app.on('window-all-closed', () => undefined);
     const server = http.createServer((request, response) => {
       response.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'" });
       response.end('<!doctype html><h1>Home page</h1>');
     });
     // The app's page and the project's dev server are different origins (localhost and 127.0.0.1 here), as in the app.
     const host = http.createServer((request, response) => {
       response.writeHead(200, { 'content-type': 'text/html' });
       response.end('<!doctype html><iframe id="canvas" src="http://127.0.0.1:' + server.address().port + '/#avb-design" width="500" height="300"></iframe>');
     });
     const attempt = (partition, fixed) => new Promise((resolve) => {
       const target = session.fromPartition(partition);
       if (fixed) { allowLoopbackFraming(target); addResponseHeaderRule(({ resourceType, headers }) => resourceType === 'subFrame' ? Object.assign({}, headers, { 'Server-Timing': ['stackitest;desc=ok'] }) : undefined); }
       const win = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { partition } });
       const failures = [];
       win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => { if (!isMainFrame) { failures.push({ code, description }); } });
       win.loadURL('http://localhost:' + host.address().port + '/').catch(() => undefined).then(() => setTimeout(() => {
         const frames = win.webContents.mainFrame.frames;
         const timing = fixed && frames[0] !== undefined
           ? frames[0].executeJavaScript("performance.getEntriesByType('navigation')[0].serverTiming.map((entry) => entry.name)").catch(() => [])
           : Promise.resolve([]);
         timing.then((names) => {
           resolve({ failures, timing: names, loaded: frames.length === 1 && frames[0].url.startsWith('http://127.0.0.1:') });
           win.destroy();
         });
       }, 1500));
     });
     app.whenReady().then(() => server.listen(0, '127.0.0.1', () => host.listen(0, '127.0.0.1', async () => {
       const blocked = await attempt('without', false);
       const framed = await attempt('with', true);
       console.log(JSON.stringify({ blocked, framed }));
       server.close();
       host.close();
       app.quit();
     })));`,
  );
  const ran = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 60000 });
  const line = (ran.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  assert.ok(line, `the browser probe ran: ${(ran.stderr || ran.stdout || '').slice(0, 500)}`);
  const { blocked, framed } = JSON.parse(line);
  assert.ok(
    blocked.failures.some((failure) => failure.description === 'ERR_BLOCKED_BY_RESPONSE'),
    `without the fix the frame is blocked: ${JSON.stringify(blocked)}`,
  );
  assert.deepEqual(framed.failures, [], 'with the fix nothing fails');
  assert.equal(framed.loaded, true, 'and the frame shows the page');
  assert.deepEqual(framed.timing, ['stackitest'], 'a rule added after the framing rule still applied: one composed listener, nothing replaced');
});
