// Goal: a style edit reaches the canvas fresh on its own write. Astro serves a
// component's <style> from the last server-side compile of its file, so the
// generated preview config (avb-morph in electron/preview/markerConfig.ts) compiles a file whose
// <style> text changed before Vite announces the new stylesheet — and keeps
// filtering the stylesheet out of updates whose style text did not change, so
// typing into a text field never restarts an animation. And a <style> block
// that was deleted, asked for again by the browser, is an empty stylesheet
// rather than Astro's "No Astro CSS at index N" error.
// Method: write the real preview config into a temporary project with the
// windowless main harness and import it, as Astro would. Seed a file through
// the marker plugin's load, edit the file on disk, and call avb-morph's
// handleHotUpdate with a fake Vite server: its environments say which files
// their module graphs hold and record every transformRequest, in order. Each
// case states what the hook returns, what was compiled, and in which order.
// The load of a deleted block's stylesheet is called directly, against the file on disk. Astro's compile of a file is
// stood in for by the module text it produces (one `?astro&type=style&index=N` import per extracted block), handed to
// avb-style-check's transform as the server environment would.
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
  return {
    markers: plugin('avb-node-markers'),
    morph: plugin('avb-morph'),
    vanished: plugin('avb-vanished-styles'),
    check: plugin('avb-style-check'),
    configText: fs.readFileSync(configPath, 'utf8'),
    file,
    dispose,
  };
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
    markers.load.handler(page);
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
    markers.load.handler(page);
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
    markers.load.handler(page);
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
    markers.load.handler(page);
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
    markers.load.handler(page);
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
    markers.load.handler(page);
    file('index.astro', PAGE('blue'));
    const clientOnly = fakeServer(page, ['client']);
    assert.equal(await hotUpdate(morph, page, clientOnly.server), undefined);
    assert.deepEqual(clientOnly.log, [], 'a file only the browser holds');
    file('index.astro', PAGE('green'));
    assert.equal(await hotUpdate(morph, page, {}), undefined, 'Vite 5: no environments');
    const markdown = file('post.md', '# Post\n<style>.a { color: red; }</style>\n');
    markers.load.handler(markdown);
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
    markers.load.handler(page);
    file('index.astro', PAGE('blue'));
    const { server, log } = fakeServer(page, ['client', 'prerender']);
    assert.equal(await hotUpdate(morph, page, server), undefined);
    assert.deepEqual(log, ['start prerender /src/pages/index.astro', 'end prerender']);
  } finally {
    dispose();
  }
});

// Deleting a <style> block (docs/canvas-recovery.md, "No Astro CSS at index 0"): Vite's update still names the
// modules of the blocks the file had, the browser asks for them again, and Astro's load throws for a block that is
// gone. The marker plugin's load answers that ask with an empty stylesheet; every block that still exists is left
// to Astro, and the update itself keeps its stylesheet modules, which Astro's reload logic needs.
const STYLED = (blocks) => `<div class="my-class">Hello</div>\n${blocks.map((block) => `\n${block}\n`).join('')}`;
const LAYERED = '<style>\n  @layer components {\n    .my-class {\n      padding: 1.25rem;\n    }\n  }\n</style>';
const styleAsk = (page, index) => `${page}?astro&type=style&index=${index}&lang.css`;
const EMPTY = { code: '' };
// What a load hook returns for "not mine, ask the next plugin" is Rollup's null; read from JSON, since our own code
// never writes one.
const PASSED_ON = JSON.parse('null');

test("the ask for a deleted block is an empty stylesheet; a block that exists is Astro's", async () => {
  const { markers, morph, file, dispose } = await preview();
  try {
    const page = file('index.astro', STYLED([LAYERED]));
    markers.load.handler(page);
    assert.equal(markers.load.handler(styleAsk(page, 0)), PASSED_ON, 'block 0 exists: Astro serves it');
    file('index.astro', STYLED([]));
    const { server, log } = fakeServer(page, ['ssr']);
    const returned = await hotUpdate(morph, page, server);
    assert.equal(returned, undefined, 'the update goes out whole: Astro sees the stylesheet module changed');
    assert.deepEqual(log, ['start ssr /src/pages/index.astro', 'end ssr'], 'the file compiles first');
    assert.deepEqual(markers.load.handler(styleAsk(page, 0)), EMPTY, 'the browser asking for block 0 gets nothing, not an error');
    // Undo puts the block back: it is Astro's again.
    file('index.astro', STYLED([LAYERED]));
    assert.equal(markers.load.handler(styleAsk(page, 0)), PASSED_ON, 'restored');
  } finally {
    dispose();
  }
});

test('deleting block 0 of two: the old block 1 is past the end, block 0 is still served', async () => {
  const { markers, file, dispose } = await preview();
  try {
    const page = file('index.astro', STYLED(['<style>.a { color: red; }</style>', '<style>.b { color: blue; }</style>']));
    assert.equal(markers.load.handler(styleAsk(page, 1)), PASSED_ON);
    file('index.astro', STYLED(['<style>.b { color: blue; }</style>']));
    assert.equal(markers.load.handler(styleAsk(page, 0)), PASSED_ON, 'block 0 is now the old block 1');
    assert.deepEqual(markers.load.handler(styleAsk(page, 1)), EMPTY, 'there is no block 1');
    assert.deepEqual(markers.load.handler(styleAsk(page, 7)), EMPTY);
  } finally {
    dispose();
  }
});

test('is:inline is not a module; global, scss and define:vars blocks count like any other', async () => {
  const { markers, file, dispose } = await preview();
  try {
    const blocks = [
      '<style is:global>.g { color: red; }</style>',
      '<style lang="scss">.s { .t { color: red; } }</style>',
      '<style define:vars={{ c: "red" }}>.v { color: var(--c); }</style>',
      '<style is:inline>.i { color: red; }</style>',
    ];
    const page = file('index.astro', STYLED(blocks));
    assert.equal(markers.load.handler(styleAsk(page, 2)), PASSED_ON, 'three compiled blocks');
    assert.deepEqual(markers.load.handler(styleAsk(page, 3)), EMPTY, 'the inline block has no module');
    file('index.astro', STYLED(blocks.slice(1)));
    assert.equal(markers.load.handler(styleAsk(page, 1)), PASSED_ON);
    assert.deepEqual(markers.load.handler(styleAsk(page, 2)), EMPTY, 'deleting the global block leaves two');
  } finally {
    dispose();
  }
});

test('other asks pass untouched (scripts, no index, a non-Astro file); a deleted file has no blocks', async () => {
  const { markers, file, dispose } = await preview();
  try {
    const page = file('index.astro', STYLED([]));
    assert.equal(markers.load.handler(`${page}?astro&type=script&index=0&lang.ts`), PASSED_ON, 'a script is not a style');
    assert.equal(markers.load.handler(`${page}?astro&type=style&lang.css`), PASSED_ON, 'no index: Astro says what is wrong');
    assert.deepEqual(markers.load.handler(styleAsk(page.replace('index.astro', 'gone.astro'), 0)), EMPTY, 'a deleted file has no blocks');
    const markdown = file('post.md', '# Post\n');
    assert.equal(markers.load.handler(`${markdown}?astro&type=style&index=0&lang.css`), PASSED_ON, 'only .astro files have blocks');
  } finally {
    dispose();
  }
});

// The browser's update (the client environment's hotUpdate) leaves out the blocks past the file's last; the server's
// update is untouched, since Astro's reload logic reads its stylesheet modules to refresh the page's collected CSS.
const clientStyle = (page, index) => ({ id: styleAsk(page, index), url: `/src/pages/index.astro?astro&type=style&index=${index}&lang.css` });
const hotUpdateIn = (vanished, environmentName, file, modules) =>
  Reflect.apply(vanished.hotUpdate, { environment: { name: environmentName } }, [{ file, modules }]);

test('the browser is never told about a block the file no longer has', async () => {
  const { markers, vanished, file, dispose } = await preview();
  try {
    const page = file('index.astro', STYLED(['<style>.b { color: blue; }</style>']));
    const pageModule = { id: page, url: '/src/pages/index.astro' };
    const modules = [pageModule, clientStyle(page, 0), clientStyle(page, 1)];
    assert.deepEqual(hotUpdateIn(vanished, 'client', page, modules), [pageModule, clientStyle(page, 0)], 'block 1 is gone: left out');
    assert.equal(hotUpdateIn(vanished, 'ssr', page, modules), undefined, "the server update is Astro's, whole");
    assert.equal(hotUpdateIn(vanished, 'client', page, [pageModule, clientStyle(page, 0)]), undefined, 'nothing to leave out');
    file('index.astro', STYLED([]));
    assert.deepEqual(hotUpdateIn(vanished, 'client', page, modules), [pageModule], 'the only block deleted');
    fs.rmSync(page);
    assert.deepEqual(hotUpdateIn(vanished, 'client', page, modules), [pageModule], 'a deleted component has no blocks');
    assert.deepEqual(markers.load.handler(styleAsk(page, 0)), EMPTY, 'and an ask for one is an empty stylesheet');
    const markdown = file('post.md', '# Post\n');
    assert.equal(hotUpdateIn(vanished, 'client', markdown, [{ id: markdown, url: '/src/pages/post.md' }]), undefined, 'not an Astro file');
  } finally {
    dispose();
  }
});

// 1.4.8: a self-closing <style is:inline … /> before a block read as no block, so block 0 was answered empty and the
// component rendered unstyled. The count now comes from a scan that reads the template as the compiler does, or from
// Astro's own compile of the same bytes; a count that is not certain never empties a block.
const SELF_CLOSING = '<div class="repro-a">A</div>\n<style is:inline set:html={"/* inline */"} />\n<style>.repro-a { color: red; }</style>\n';
const CLOSED = '<div class="repro-a">A</div>\n<style is:inline set:html={"/* inline */"}></style>\n<style>.repro-a { color: red; }</style>\n';
const compiledWith = (page, blocks) =>
  Array.from({ length: blocks }, (_, index) => `import "${page}?astro&type=style&index=${index}&lang.css";`).join('\n') + '\nexport default {};\n';
const compileIn = (check, page, blocks) =>
  Reflect.apply(check.transform, { environment: { config: { consumer: 'server' } } }, [compiledWith(page, blocks), page, {}]);

test("a self-closing is:inline tag before a block: block 0 is Astro's, LF and CRLF", async () => {
  const { markers, vanished, file, dispose } = await preview();
  try {
    for (const [name, text] of [
      ['self-closing', SELF_CLOSING],
      ['closed', CLOSED],
      ['self-closing CRLF', SELF_CLOSING.replace(/\n/g, '\r\n')],
    ]) {
      const page = file('index.astro', text);
      markers.load.handler(page);
      assert.equal(markers.load.handler(styleAsk(page, 0)), PASSED_ON, `${name}: block 0 exists`);
      assert.deepEqual(markers.load.handler(styleAsk(page, 1)), EMPTY, `${name}: there is no block 1`);
      const pageModule = { id: page, url: '/src/pages/index.astro' };
      assert.equal(hotUpdateIn(vanished, 'client', page, [pageModule, clientStyle(page, 0)]), undefined, `${name}: the browser keeps block 0`);
    }
  } finally {
    dispose();
  }
});

test('the scan is uncertain of a template: no ask is answered empty', async () => {
  const { markers, vanished, file, dispose } = await preview();
  try {
    // An unclosed <p> is a compile error to Astro: what it serves, it serves.
    const page = file('index.astro', '<p>a<style is:inline set:html={"x"} />\n<style>.a { color: red; }</style>\n');
    assert.equal(markers.load.handler(styleAsk(page, 0)), PASSED_ON);
    assert.equal(markers.load.handler(styleAsk(page, 3)), PASSED_ON, 'not even past any count it could have');
    const pageModule = { id: page, url: '/src/pages/index.astro' };
    assert.equal(hotUpdateIn(vanished, 'client', page, [pageModule, clientStyle(page, 0), clientStyle(page, 1)]), undefined, 'the browser update is whole');
  } finally {
    dispose();
  }
});

test("Astro's compile of the bytes on disk is the count; a scan it contradicts is not used again until one agrees", async () => {
  const { markers, check, file, dispose } = await preview();
  try {
    const page = file('index.astro', STYLED(['<style>.a { color: red; }</style>']));
    markers.load.handler(page);
    // Astro extracted two blocks where the scan read one: for these bytes Astro's count holds.
    compileIn(check, page, 2);
    assert.equal(markers.load.handler(styleAsk(page, 1)), PASSED_ON, 'block 1 is served as Astro serves it');
    assert.deepEqual(markers.load.handler(styleAsk(page, 2)), EMPTY, 'past what Astro extracted');
    // New bytes Astro has not compiled: the scan read this file wrong once, so it is not trusted alone.
    file('index.astro', STYLED([]));
    assert.equal(markers.load.handler(styleAsk(page, 0)), PASSED_ON, 'never an empty block 0 on a scan that disagreed');
    // A compile that agrees with the scan restores it.
    markers.load.handler(page);
    compileIn(check, page, 0);
    file('index.astro', STYLED(['<style>.b { color: blue; }</style>']));
    markers.load.handler(page);
    compileIn(check, page, 1);
    file('index.astro', STYLED([]));
    assert.deepEqual(markers.load.handler(styleAsk(page, 0)), EMPTY, 'the deleted block, on a scan that agrees');
  } finally {
    dispose();
  }
});

test('only a server compile of the file itself is a count: the browser stub, sub-modules and gaps are not', async () => {
  const { markers, check, file, dispose } = await preview();
  try {
    const page = file('index.astro', STYLED(['<style>.a { color: red; }</style>']));
    markers.load.handler(page);
    Reflect.apply(check.transform, { environment: { config: { consumer: 'client' } } }, [compiledWith(page, 3), page, {}]);
    Reflect.apply(check.transform, { environment: { config: { consumer: 'server' } } }, [compiledWith(page, 3), styleAsk(page, 0), {}]);
    assert.deepEqual(markers.load.handler(styleAsk(page, 1)), EMPTY, 'neither the client nor a sub-module counted');
    // Imports numbered 0 and 2, but not 1: not a count Astro could have made.
    const gapped = `import "${page}?astro&type=style&index=0&lang.css";\nimport "${page}?astro&type=style&index=2&lang.css";\n`;
    Reflect.apply(check.transform, { environment: { config: { consumer: 'server' } } }, [gapped, page, {}]);
    assert.deepEqual(markers.load.handler(styleAsk(page, 1)), EMPTY, 'the scan still counts one');
    // Vite 5: no environments, the ssr flag says server.
    markers.load.handler(page);
    Reflect.apply(check.transform, {}, [compiledWith(page, 2), page, { ssr: true }]);
    assert.equal(markers.load.handler(styleAsk(page, 1)), PASSED_ON, 'the ssr compile counted');
  } finally {
    dispose();
  }
});

test('the generated config counts blocks with the scan, not a regular expression over the source', async () => {
  const { configText, dispose } = await preview();
  try {
    assert.ok(!configText.includes('<style[^>]*>[\\s\\S]*?<\\/style>'), 'the 1.4.8 expression is gone');
    assert.ok(!configText.includes('avbStyleBlocksOf'), 'and the helper that used it');
    assert.ok(configText.includes('scanStyleBlocks'), 'the scan is required from the markers module');
    assert.ok(configText.includes("name: 'avb-style-check'"), "and Astro's compile is checked against it");
  } finally {
    dispose();
  }
});
