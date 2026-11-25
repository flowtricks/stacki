// Optional integration smoke test; deliberately outside the offline npm gate.
// Run: node test/integration/devLifecycle.js
// Installs pinned Astro into an isolated temporary project, runs the actual
// Electron main IPC handlers with a hidden empty window, then removes all data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ROOT, repoPath } = require('../helpers/sources.js');
const ASTRO_VERSION = '5.13.10';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function orchestrate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-dev-integration-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({
      name: 'stacki-dev-integration',
      private: true,
      type: 'module',
      dependencies: { astro: ASTRO_VERSION },
    }),
  );
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default { trailingSlash: "always" };\n');
  fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), '<html><body><h1>Lifecycle fixture</h1></body></html>\n');
  writeHoverComponents(project);
  fs.mkdirSync(path.join(project, 'src', 'data'));
  fs.writeFileSync(path.join(project, 'src', 'data', 'posts.json'), JSON.stringify([{ id: 'hello', title: 'Hello', rank: 1 }]));
  fs.writeFileSync(
    path.join(project, 'src', 'content.config.ts'),
    [
      "import { defineCollection, reference, z } from 'astro:content';",
      "import { file } from 'astro/loaders';",
      "export const collections = { posts: defineCollection({ loader: file('src/data/posts.json'),",
      'schema: ({ image }) => z.object({ title: z.string().min(3), rank: ' + 'z.number().int().min(0), live: z.boolean().default(false),',
      "hero: image().optional(), author: reference('authors').optional(), published: " + 'z.coerce.date().optional(),',
      "flag: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),",
      "}).refine((data) => data.title !== 'reserved', { message: 'This title is reserved', " + "path: ['title'] }) }),",
      "authors: defineCollection({ loader: file('src/data/authors.json'), schema: z.object({ " + 'name: z.string() }) }) };',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(project, 'src', 'data', 'authors.json'), JSON.stringify([{ id: 'author', name: 'Author' }]));
  const linkedProject = path.join(directory, 'project-link');
  fs.symlinkSync(project, linkedProject, process.platform === 'win32' ? 'junction' : 'dir');
  const env = {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    STACKI_INTEGRATION_DIR: directory,
    STACKI_INTEGRATION_PROJECT: linkedProject,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  // Avoid invoking the user's interactive shell startup files while discovering
  // Node; the test already supplies its executable directory explicitly.
  env.SHELL = process.platform === 'win32' ? env.SHELL : '/usr/bin/false';
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  try {
    console.log(`Installing Astro ${ASTRO_VERSION} in an isolated temporary project…`);
    const installed = childProcess.spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--cache', path.join(directory, 'npm-cache')],
      { cwd: project, env, stdio: 'inherit', timeout: 180000, shell: process.platform === 'win32' },
    );
    if (installed.error) {
      throw installed.error;
    }
    assert.equal(installed.status, 0, 'fixture dependencies install');
    const electron = require('electron');
    const result = await new Promise((resolve, reject) => {
      const child = childProcess.spawn(electron, [__filename, '--electron'], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    process.exitCode = result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function inElectron() {
  const electron = require('electron');
  const { app, ipcMain, BrowserWindow } = electron;
  const directory = process.env.STACKI_INTEGRATION_DIR;
  assert.ok(directory && path.basename(directory).startsWith('stacki-dev-integration-'), 'use the isolated fixture only');
  const project = process.env.STACKI_INTEGRATION_PROJECT;
  assert.equal(fs.realpathSync(project), fs.realpathSync(path.join(directory, 'project')));
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(directory, 'logs'));
  app.setPath('crashDumps', directory);

  const logs = [];
  const handlers = new Map();
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
    register(channel, handler);
  };
  const servers = [];
  const contentWorkers = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (cmd, args, options) {
    const child = originalSpawn.apply(this, arguments);
    if (options?.cwd === project && args?.includes('dev')) {
      servers.push(child);
    }
    if (options?.cwd === project && args?.some((arg) => String(arg).endsWith('read-config.mjs'))) {
      contentWorkers.push(child);
    }
    return child;
  };

  // Keep the real Electron window/lifecycle APIs, but prevent the renderer
  // application from issuing unrelated IPC or loading any user project.
  const Module = require('node:module');
  const originalLoad = Module._load;
  const mainPath = repoPath('dist/electron/main.js');
  function HiddenWindow(options) {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: { sandbox: true } });
    win.loadFile = () => win.loadURL('data:text/html,<title>Stacki lifecycle smoke</title>');
    win.webContents.send = (channel, payload) => {
      if (channel === 'dev:log') {
        logs.push(payload);
      }
    };
    return win;
  }
  Object.setPrototypeOf(HiddenWindow, BrowserWindow);
  Module._load = function (name, parent) {
    if (name === 'electron' && parent?.filename === mainPath) {
      return { ...electron, BrowserWindow: HiddenWindow };
    }
    return originalLoad.apply(this, arguments);
  };
  require(mainPath);
  Module._load = originalLoad;
  await app.whenReady();
  await sleep(100);

  const invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), `${channel} is registered`);
    return handlers.get(channel)({}, ...args);
  };
  const groupAlive = (child, group = true) => {
    if (!child.pid) {
      return false;
    }
    try {
      process.kill(process.platform === 'win32' || !group ? child.pid : -child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForExit = async (children, group = true) => {
    const deadline = Date.now() + 10000;
    while (children.some((child) => groupAlive(child, group)) && Date.now() < deadline) {
      await sleep(50);
    }
    assert.equal(children.filter((child) => groupAlive(child, group)).length, 0, 'all owned server processes and descendants exit');
  };
  const fetchPreview = async (url) => {
    const response = await fetch(url + '/', { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Lifecycle fixture/);
    assert.match(
      html,
      /<!--avb-s:/,
      `the generated marker config must serve editable preview HTML\n` +
        `Project path: ${project}\nCanonical path: ${fs.realpathSync(project)}\n` +
        `HTML: ${html.slice(0, 2000)}\nDev logs: ${logs.join('').slice(-3000)}`,
    );
    return html;
  };
  const say = (message) => fs.writeSync(1, message + '\n');
  const content = require(repoPath('dist/electron/content/contentConfig.js'));
  try {
    const configs = await Promise.all([content.readContentConfig(project), content.readContentConfig(project)]);
    for (const config of configs) {
      assert.equal(config.error, undefined, config.error);
      const posts = config.collections.find((collection) => collection.name === 'posts');
      assert.equal(posts?.error, undefined, posts?.error);
      assert.equal(posts?.editable, true);
      assert.equal(posts?.schema.properties.title.minLength, 3);
      assert.equal(posts?.schema.properties.live.default, false);
      assert.equal(posts?.crossFieldChecks, true);
      assert.equal(posts?.schema.properties.hero.astroImage, true);
      assert.equal(posts?.schema.properties.author.astroReference, 'authors');
      assert.equal(posts?.schema.properties.published.astroDate, true);
      assert.equal(posts?.schema.properties.published.astroCoerced, true);
      assert.equal(posts?.schema.properties.flag.astroTransform, true);
    }
    assert.equal(contentWorkers.length, 1, 'concurrent config reads share one real worker');
    const valid = await content.validateEntry(project, {
      collection: 'posts',
      data: { title: 'Hello', rank: 1 },
    });
    assert.equal(valid.error, undefined, valid.error);
    assert.equal(valid.issues.length, 0);
    const invalid = await content.validateEntry(project, {
      collection: 'posts',
      data: { title: 'x', rank: -1 },
    });
    assert.equal(invalid.error, undefined, invalid.error);
    assert.deepEqual(invalid.issues.map((issue) => issue.path.join('.')).sort(), ['rank', 'title']);
    const refined = await content.validateEntry(project, {
      collection: 'posts',
      data: { title: 'reserved', rank: 1 },
    });
    assert.match(refined.issues[0]?.message, /reserved/);
    content.stopAllServices();
    await waitForExit(contentWorkers, false);
    say('PASS real content worker shares introspection, validates schemas, and exits cleanly');

    // Zod 3.25 also ships its Zod 4 entrypoint. Exercise the existing modern
    // conversion with real schemas so the compatibility branch cannot regress it.
    const projectRequire = require('node:module').createRequire(path.join(project, 'package.json'));
    const schemaBundle = path.join(directory, 'schema-v4.mjs');
    await projectRequire('esbuild').build({
      stdin: {
        contents: [
          "import { z } from 'astro/zod';",
          `import { withMetadata, toJsonSchema } from ${JSON.stringify(repoPath('dist/electron/content/workers/schemaTools.mjs'))};`,
          'export const result = toJsonSchema(z.object({ title: z.string().min(3), hero: ' +
            'withMetadata(z.string(), { astroImage: true }), date: z.coerce.date(), flag: ' +
            'z.string().transform(Boolean) }));',
        ].join('\n'),
        resolveDir: project,
      },
      outfile: schemaBundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { 'astro/zod': projectRequire.resolve('zod/v4') },
      logLevel: 'silent',
    });
    const modern = (await import(require('node:url').pathToFileURL(schemaBundle).href)).result;
    assert.equal(modern.properties.title.minLength, 3);
    assert.equal(modern.properties.hero.astroImage, true);
    assert.equal(modern.properties.date.astroDate, true);
    assert.equal(modern.properties.flag.astroTransform, true);
    say('PASS existing Zod 4 schema conversion preserves bounds and field annotations');
    const one = invoke('dev:start', project);
    const duplicate = invoke('dev:start', project);
    assert.equal(one, duplicate, 'same-project requests share one pending operation');
    const [first, second] = await Promise.all([one, duplicate]);
    assert.equal(first.url, second.url);
    assert.equal(first.trailingSlash, 'always');
    assert.equal(servers.length, 1, 'concurrent requests spawned one server');
    await fetchPreview(first.url);
    say('PASS concurrent starts share one marked Astro preview');
    await verifyHoverPreview(first.url);
    say('PASS hover previews render guarded props and select exact component files');

    await invoke('dev:stop');
    await waitForExit([...servers]);
    const restarted = await invoke('dev:start', project);
    await fetchPreview(restarted.url);
    assert.equal(servers.length, 2, 'restart owns a fresh server process');
    say('PASS stop kills the server group and restart serves marked HTML');
    await invoke('dev:stop');
    await waitForExit([...servers]);

    const spawning = invoke('dev:start', project);
    const cancelled = assert.rejects(spawning, /cancelled/);
    const deadline = Date.now() + 10000;
    while (servers.length < 3 && Date.now() < deadline) {
      await sleep(5);
    }
    assert.equal(servers.length, 3, 'cancellation reaches a real spawned process');
    await invoke('project:close');
    await cancelled;
    await waitForExit([...servers]);
    await sleep(400);
    assert.equal(servers.length, 3, 'a closed project does not retry startup');
    say('PASS closing during startup cancels work and leaves no server descendants');

    const reopened = await invoke('dev:start', project);
    await fetchPreview(reopened.url);
    await invoke('project:close');
    await waitForExit([...servers]);
    // Exercise the production bundle and real preload against the isolated
    // empty userData, after project teardown has returned to the welcome screen.
    const dist = repoPath('dist/renderer/index.html');
    if (fs.existsSync(dist)) {
      const renderer = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: repoPath('dist/electron/preload/preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      const preloadErrors = [];
      renderer.webContents.on('preload-error', (_event, _file, error) => preloadErrors.push(error.message));
      await renderer.loadFile(dist);
      const bootDeadline = Date.now() + 10000;
      let welcome = false;
      while (!welcome && Date.now() < bootDeadline) {
        welcome = await renderer.webContents.executeJavaScript("!!window.avb && !!document.querySelector('.welcome')");
        if (!welcome) {
          await sleep(50);
        }
      }
      assert.deepEqual(preloadErrors, []);
      assert.equal(welcome, true, 'production renderer and preload reach the welcome screen');
      renderer.destroy();
      say('PASS production dist/preload boots the welcome screen in a hidden window');
    }
    say(`dev-lifecycle integration: passed ` + `(Electron ${process.versions.electron}, Astro ${ASTRO_VERSION})`);
  } finally {
    content.stopAllServices();
    await invoke('project:close').catch(() => {});
    for (const child of contentWorkers) {
      if (groupAlive(child, false)) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }
    for (const child of servers) {
      if (groupAlive(child)) {
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
        } catch {}
      }
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
  }
}

function writeHoverComponents(project) {
  for (const folder of ['Interactive', 'Other']) {
    fs.mkdirSync(path.join(project, 'src', 'components', folder), { recursive: true });
  }
  fs.writeFileSync(
    path.join(project, 'src/components/Interactive/AccordionItem.astro'),
    [
      '---',
      'type Props = { heading?: string; render?: boolean };',
      'const { heading, render = true } = Astro.props;',
      'const content = await Astro.slots.render("default");',
      '---',
      '{render && heading && content && (',
      '  <details><summary>{heading}</summary><p set:html={content} /></details>',
      ')}',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(project, 'src/components/Other/AccordionItem.astro'), '<p>Distinct other component</p>\n');
}

async function verifyHoverPreview(base) {
  // Render through the real generated route: supplying schema data is only
  // useful if Astro passes it through to the guarded component and its slot.
  const url = new URL('/__avb/preview/', base);
  url.searchParams.set('c', 'AccordionItem');
  url.searchParams.set('p', 'src/components/Interactive/AccordionItem.astro');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 1000));
  assert.match(html, /<details[\s>]/, 'the missing heading no longer hides the component');
  assert.match(html, /<summary[^>]*>[\s\S]*?AccordionItem/);
  assert.match(html, /<p[^>]*>[\s\S]*?AccordionItem/);
  url.searchParams.set('p', 'src/components/Other/AccordionItem.astro');
  const other = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.equal(other.status, 200);
  assert.match(await other.text(), /Distinct other component/);
}

if (process.argv.includes('--electron')) {
  const { app } = require('electron');
  inElectron().then(
    () => app.exit(0),
    (error) => {
      fs.writeSync(2, String(error.stack || error) + '\n');
      app.exit(1);
    },
  );
} else {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
