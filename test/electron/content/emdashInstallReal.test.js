// Goal: the whole install, for real, leaves a project whose pages still render. Opt-in and slow (it uses the network and
// installs Astro and EmDash): run with STACKI_REAL_EMDASH=1. It is the regression test for the white canvas found in the
// real app: after EmDash was added the home page was served fine (200, the project's own markup), but EmDash's integration
// adds `X-Frame-Options: SAMEORIGIN` to every response, which the canvas's iframe refuses; test/electron/app/previewFraming.test.js
// holds the fix in a real browser. This test holds the other half: the install itself, run with the real package manager,
// the real config merge and EmDash's own init, produces a project that starts and serves its page and the EmDash admin.
// Method: a throwaway Astro project in a temporary folder (never a real project), the install run through the same
// function the dialog calls, then `astro dev` on a free port and plain HTTP requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitFor } = require('../../helpers/waitFor.js');
const { runEmDashInstall, planEmDashInstall } = require('#dist/electron/handlers/emdashInstall.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');

const enabled = process.env.STACKI_REAL_EMDASH === '1';

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

test(
  'a project with EmDash added by the install still serves its own page and the EmDash admin',
  { skip: !enabled && 'set STACKI_REAL_EMDASH=1 (network, slow)', timeout: 600000 },
  async () => {
    setToolPathHome(os.homedir());
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-real-emdash-')));
    fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'site', type: 'module', dependencies: { astro: '^7.4.0' } }));
    fs.writeFileSync(path.join(root, 'astro.config.mjs'), 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n');
    fs.writeFileSync(path.join(root, 'src', 'pages', 'index.astro'), '---\n---\n<html><body><h1>Home page of the site</h1></body></html>\n');
    assert.equal(spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8' }).status, 0, 'the plain project installs');

    const plan = await planEmDashInstall(root);
    assert.equal(plan.kind, 'ready');
    const result = await runEmDashInstall(root, { confirmedCommand: plan.command, onLog: () => undefined });
    assert.equal(result.kind, 'installed');
    assert.equal(result.complete, true, JSON.stringify(result.project));
    assert.equal(result.config, 'merged');
    assert.equal(result.databaseReady, true, 'EmDash’s own init made the database');
    assert.ok(fs.existsSync(path.join(root, 'data.db')));

    const port = await freePort();
    const dev = spawn(path.join(root, 'node_modules', '.bin', 'astro'), ['dev', '--port', String(port), '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
    try {
      await waitFor({
        what: 'the home page answers',
        read: () =>
          fetch(`http://127.0.0.1:${port}/`).then(
            (response) => response.status,
            () => 0,
          ),
        until: (status) => status === 200,
        pollCountMax: 200,
        pollIntervalMs: 1000,
      });
      const home = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(home.status, 200);
      assert.match(await home.text(), /Home page of the site/, 'the project’s own page renders as before');
      // The header that blanked the canvas is real, which is why the app drops it for its own frame (previewFraming.ts).
      assert.equal(home.headers.get('x-frame-options'), 'SAMEORIGIN');
      const admin = await fetch(`http://127.0.0.1:${port}/_emdash/admin/`, { redirect: 'manual' });
      assert.ok(admin.status < 500, `the EmDash admin answers: ${admin.status}`);
    } finally {
      dev.kill('SIGTERM');
    }
  },
);
