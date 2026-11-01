// Goal: a style edit reaches the canvas fresh on its own write. Astro serves a
// component's <style> from the last server-side compile of its file, so the
// generated preview config (avb-morph in electron/preview/markerConfig.ts) compiles a file whose
// <style> text changed before Vite announces the new stylesheet — and keeps
// filtering the stylesheet out of updates whose style text did not change, so
// typing into a text field never restarts an animation.
// Method: write the real preview config into a temporary project with the
// windowless main harness and import it, as Astro would. Seed a file through
// the marker plugin's load, edit the file on disk, and call avb-morph's
// handleHotUpdate with a fake Vite server: its environments say which files
// their module graphs hold and record every transformRequest, in order. Each
// case states what the hook returns, what was compiled, and in which order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAGE = (color, heading = 'Home') => `<main><h1>${heading}</h1></main>\n<style>.box { color: ${color}; }</style>\n`;

// A temporary project with the generated config imported: the two plugins
// under test, and a function that writes the page and returns its path.
async function preview() {
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-recompile-')));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  const configPath = harness.call('writeMarkerConfig', root);
  assert.equal(typeof configPath, 'string', 'the generated config parses');
  const config = (await import(pathToFileURL(configPath).href)).default;
  const plugin = (name) => config.vite.plugins.find((candidate) => candidate.name === name);
  const file = (name, text) => {
    const target = path.join(root, 'src', 'pages', name);
    fs.writeFileSync(target, text);
    return target;
  };
  const dispose = () => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { markers: plugin('avb-node-markers'), morph: plugin('avb-morph'), file, dispose };
}

// A Vite server whose environments hold `file` as `holders` says. Each
// transform logs its start and end and settles as `settle` says: 'resolve'
// after a tick, 'reject', 'hang' (never), or 'manual' (the test settles it).
function fakeServer(file, holders, settle = 'resolve') {
  const log = [];
  const pending = [];
  const environment = (name, consumer) => ({
    config: { consumer },
    moduleGraph: {
      getModulesByFile: (asked) => (asked === file && holders.includes(name) ? new Set([{ id: file, url: '/src/pages/index.astro' }]) : undefined),
    },
    transformRequest: (url) => {
      log.push(`start ${name} ${url}`);
      if (settle === 'reject') {
        return Promise.reject(new Error('does not compile'));
      }
      return new Promise((resolve) => {
        const done = () => {
          log.push(`end ${name}`);
          resolve({ code: '' });
        };
        if (settle === 'resolve') {
          setTimeout(done, 5);
        } else if (settle === 'manual') {
          pending.push(done);
        }
      });
    },
  });
  const environments = {
    client: environment('client', 'client'),
    ssr: environment('ssr', 'server'),
    prerender: environment('prerender', 'server'),
  };
  return { server: { environments }, log, pending };
}

const PAGE_MODULE = { id: 'page', url: '/src/pages/index.astro' };
const STYLE_MODULE = {
  id: 'style',
  url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
};

// One hot update for `file`, as Vite hands it to the hook; the return value
// is logged too, so a case can read the order of compile and return.
async function hotUpdate(morph, file, server, log) {
  const context = { file, modules: [PAGE_MODULE, STYLE_MODULE], server };
  const returned = await Reflect.apply(morph.handleHotUpdate, morph, [context]);
  log?.push('returned');
  return returned;
}

const filtered = (returned) => Array.isArray(returned) && returned.length === 1 && returned[0] === PAGE_MODULE;

test('a real style change compiles on the server first, then passes', async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    file('index.astro', PAGE('blue'));
    const { server, log } = fakeServer(page, ['client', 'ssr']);
    const returned = await hotUpdate(morph, page, server, log);
    assert.equal(returned, undefined, 'the stylesheet goes out with the update');
    assert.deepEqual(log, ['start ssr /src/pages/index.astro', 'end ssr', 'returned']);
    // The same bytes again (what the old nudge wrote): no new stylesheet.
    const again = fakeServer(page, ['client', 'ssr']);
    assert.ok(filtered(await hotUpdate(morph, page, again.server)), 'the repeat is filtered');
    assert.deepEqual(again.log, [], 'and nothing compiles');
  } finally {
    dispose();
  }
});

test('typing into the template never sends the stylesheet or compiles', async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    for (const heading of ['Hom', 'Ho', 'Hello']) {
      file('index.astro', PAGE('red', heading));
      const { server, log } = fakeServer(page, ['ssr']);
      assert.ok(filtered(await hotUpdate(morph, page, server)), `"${heading}" is filtered`);
      assert.deepEqual(log, [], `"${heading}" compiles nothing`);
    }
  } finally {
    dispose();
  }
});

test('a compile that fails is not trusted: the next update compiles again', async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    file('index.astro', PAGE('blue'));
    const failing = fakeServer(page, ['ssr'], 'reject');
    assert.equal(await hotUpdate(morph, page, failing.server), undefined, 'Vite keeps its order');
    assert.deepEqual(failing.log, ['start ssr /src/pages/index.astro']);
    const next = fakeServer(page, ['ssr']);
    assert.equal(await hotUpdate(morph, page, next.server), undefined, 'the next one passes');
    assert.deepEqual(next.log, ['start ssr /src/pages/index.astro', 'end ssr']);
  } finally {
    dispose();
  }
});

test('a compile that outruns the bound gives way, and is not trusted', async () => {
  const { markers, morph, file, dispose } = await preview();
  const realSetTimeout = globalThis.setTimeout;
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    file('index.astro', PAGE('blue'));
    const hung = fakeServer(page, ['ssr'], 'hang');
    // The bound's timer fires at once, so the case needs no real wait.
    globalThis.setTimeout = (callback) => realSetTimeout(callback, 0);
    const returned = await hotUpdate(morph, page, hung.server);
    globalThis.setTimeout = realSetTimeout;
    assert.equal(returned, undefined, 'the stylesheet goes out with Vite order');
    // The hung transform never settles; the next edit must not wait behind it.
    const next = fakeServer(page, ['ssr']);
    const started = Date.now();
    assert.equal(await hotUpdate(morph, page, next.server), undefined, 'the next one passes');
    assert.deepEqual(next.log, ['start ssr /src/pages/index.astro', 'end ssr'], 'and compiles');
    assert.ok(Date.now() - started < 1000, 'without waiting out the bound again');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    dispose();
  }
});

test('two quick edits compile in order', async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    const held = fakeServer(page, ['ssr'], 'manual');
    file('index.astro', PAGE('blue'));
    const first = hotUpdate(morph, page, held.server, held.log);
    file('index.astro', PAGE('green'));
    const second = hotUpdate(morph, page, held.server, held.log);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(held.log, ['start ssr /src/pages/index.astro'], 'the second waits');
    held.pending.shift()();
    await new Promise((resolve) => setTimeout(resolve, 10));
    held.pending.shift()();
    await Promise.all([first, second]);
    const starts = held.log.flatMap((entry, index) => (entry.startsWith('start') ? [index] : []));
    assert.equal(starts.length, 2, 'both edits compile');
    assert.ok(starts[1] > held.log.indexOf('end ssr'), 'the second starts after the first ends');
  } finally {
    dispose();
  }
});

test('nothing compiles where there is nothing to refresh', async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    file('index.astro', PAGE('blue'));
    const clientOnly = fakeServer(page, ['client']);
    assert.equal(await hotUpdate(morph, page, clientOnly.server), undefined);
    assert.deepEqual(clientOnly.log, [], 'a file only the browser holds');
    file('index.astro', PAGE('green'));
    assert.equal(await hotUpdate(morph, page, {}), undefined, 'Vite 5: no environments');
    const markdown = file('post.md', '# Post\n<style>.a { color: red; }</style>\n');
    markers.load(markdown);
    file('post.md', '# Post\n<style>.a { color: blue; }</style>\n');
    const md = fakeServer(markdown, ['ssr']);
    assert.equal(await hotUpdate(morph, markdown, md.server), undefined);
    assert.deepEqual(md.log, [], 'Markdown has no style modules to refresh');
  } finally {
    dispose();
  }
});

test('a page only the prerender environment holds is compiled there', async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', PAGE('red'));
    markers.load(page);
    file('index.astro', PAGE('blue'));
    const { server, log } = fakeServer(page, ['client', 'prerender']);
    assert.equal(await hotUpdate(morph, page, server), undefined);
    assert.deepEqual(log, ['start prerender /src/pages/index.astro', 'end prerender']);
  } finally {
    dispose();
  }
});
