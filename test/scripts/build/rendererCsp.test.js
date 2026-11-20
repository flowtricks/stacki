// Goal: Stacki's main window runs only the scripts it ships with. The build writes a Content Security Policy into
// index.html (scripts/build/rendererCsp.mts, vite.config.mjs): scripts from the app's own files plus each inline
// script by its SHA-256, no plugins, no moved base. Styles, images, fonts and frames are left open on purpose.
// Method: the pure helper over hand-written pages, valid and invalid: one and several inline scripts, a script with a
// src (never hashed), a page with no charset, two charsets, a script before the charset, a page that already has a
// policy, and the bound on inline scripts. Then the page the gate built (dist/renderer/index.html): it carries the
// policy right after its charset, and every inline script in it is allowed by its hash, so editing the startup script
// cannot silently leave it outside the policy. Last, the built page in a real Electron window: the app's scripts load
// and the inline startup mark runs, and nothing is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { repoPath } = require('../../helpers/sources');

const helper = () => import(pathToFileURL(repoPath('scripts/build/rendererCsp.mts')).href);
const sha = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
const page = (head, body = '') => `<!doctype html>\n<html>\n  <head>\n    ${head}\n  </head>\n  <body>${body}</body>\n</html>\n`;
const CHARSET = '<meta charset="UTF-8" />';
const BUILT = repoPath('dist/renderer/index.html');

test('the policy allows the app’s scripts and each inline script by its hash, and nothing else', async () => {
  const { rendererContentSecurityPolicy, inlineScriptHashes } = await helper();
  const first = "\n  performance.mark('a');\n";
  const second = 'window.x = 1;';
  const html = page(CHARSET, `<script>${first}</script><script type="module" src="./assets/index.js"></script><script>${second}</script>`);
  assert.deepEqual(inlineScriptHashes(html), [sha(first), sha(second)], 'a script with a src is not hashed');
  assert.equal(rendererContentSecurityPolicy(html), `script-src 'self' '${sha(first)}' '${sha(second)}'; object-src 'none'; base-uri 'self'`);
  assert.equal(rendererContentSecurityPolicy(page(CHARSET)), "script-src 'self'; object-src 'none'; base-uri 'self'", 'no inline script, no hash');
});

test('the policy goes right after the charset, before any script', async () => {
  const { withContentSecurityPolicy } = await helper();
  const html = page(`${CHARSET}\n    <title>Stacki</title>`, '<script>run();</script>');
  const out = withContentSecurityPolicy(html);
  const meta = out.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(meta > out.indexOf(CHARSET), 'after the charset');
  assert.ok(meta < out.indexOf('<title>'), 'before the rest of the head');
  assert.ok(meta < out.indexOf('<script'), 'before every script');
  assert.equal(out.replace(/\n {4}<meta http-equiv="Content-Security-Policy"[^>]*\/>/, ''), html, 'nothing else changes');
});

test('a page the policy cannot be placed in safely is refused', async () => {
  const { withContentSecurityPolicy, inlineScriptHashes } = await helper();
  assert.throws(() => withContentSecurityPolicy(page('<title>x</title>')), /withContentSecurityPolicy: no <meta charset="UTF-8" \/>/);
  assert.throws(() => withContentSecurityPolicy(page(`${CHARSET}${CHARSET}`)), /withContentSecurityPolicy: more than one <meta charset/);
  assert.throws(() => withContentSecurityPolicy(page(`<script>early();</script>${CHARSET}`)), /withContentSecurityPolicy: a script comes before the charset/);
  const policed = withContentSecurityPolicy(page(CHARSET));
  assert.throws(() => withContentSecurityPolicy(policed), /withContentSecurityPolicy: the page already has a policy/);
  const many = page(CHARSET, '<script>a();</script>'.repeat(17));
  assert.throws(() => inlineScriptHashes(many), /inlineScriptHashes: more than 16 inline scripts/);
  assert.equal(inlineScriptHashes(page(CHARSET, '<script>a();</script>'.repeat(16))).length, 16, 'the bound itself is allowed');
});

test('the built page carries the policy, and allows each of its inline scripts by hash', { skip: !fs.existsSync(BUILT) && 'no built page' }, () => {
  const html = fs.readFileSync(BUILT, 'utf8');
  const policies = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/g)].map((match) => match[1]);
  assert.equal(policies.length, 1, 'exactly one policy');
  const policy = policies[0];
  assert.match(policy, /^script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*; object-src 'none'; base-uri 'self'$/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before every script');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(inline.length > 0, 'the startup mark is an inline script');
  for (const body of inline) {
    assert.ok(policy.includes(`'${sha(body)}'`), `the inline script ${JSON.stringify(body.trim())} is allowed by its hash`);
  }
});

test('in a real window, the built page loads its scripts and nothing is refused', { skip: !fs.existsSync(BUILT) && 'no built page' }, () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/renderer-csp');
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, 'probe.js');
  // No preload: without window.avb the shell stops early, but whether its scripts may load is decided before that. A
  // script the policy refuses is never requested, so a completed request for the app's script is the policy letting it in.
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 700 });
       const refused = [];
       let loaded = false;
       win.webContents.on('console-message', (event) => {
         const message = String(event.message ?? '');
         if (/Content Security Policy|Refused to/.test(message)) refused.push(message.slice(0, 300));
       });
       win.webContents.session.webRequest.onCompleted({ urls: ['file://*/*'] }, (details) => {
         if (details.resourceType === 'script' && /\\/assets\\/index-[^/]*\\.js$/.test(details.url)) loaded = true;
       });
       await win.loadFile(${JSON.stringify(BUILT)});
       // Either way the state is printed: the test's own checks then name what did not happen.
       const outcome = await pollUntil({
         what: 'the startup mark and the app script',
         read: async () => ({ marked: await win.webContents.executeJavaScript("performance.getEntriesByName('stacki:html-parsed').length > 0"), loaded }),
         until: (state) => state.marked && state.loaded,
       });
       console.log(JSON.stringify({ ...outcome.value, refused }));
       app.quit();
     });`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 90000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  assert.ok(line, `the probe ran: ${(run.stderr || run.stdout || '').slice(0, 400)}`);
  const out = JSON.parse(line);
  assert.equal(out.marked, true, 'the inline startup mark ran');
  assert.equal(out.loaded, true, 'the app’s own script loaded');
  assert.deepEqual(out.refused, [], 'nothing was refused');
});
