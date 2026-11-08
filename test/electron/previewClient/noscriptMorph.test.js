// Goal: a <noscript> in the page stays inert after the canvas patches it. The
// canvas parses the page with scripting on, so a <noscript>'s markup is one text
// node there. Each new rendering is parsed by DOMParser, with scripting off, so
// the same markup came back as real elements, and the patch imported them into
// the live page: a fallback `<style>` inside `<noscript>` became a live
// stylesheet, and on stacki.build the mobile menu opened over the hero after
// any edit. The static demo's early rendering moved DOMParser nodes into its
// page the same way.
// Method: the live page is a jsdom window with scripting on (it parses
// <noscript> as text, as a browser does) and the renderings come from that
// window's DOMParser (scripting off, as in a browser). Each rendering goes
// through the client's own preparation (inertNoscripts, then the anchor-free
// clone) and the morph modules patch the live page. The checks read the live
// page's stylesheets for the fallback rule, and the <noscript>'s text. The
// static demo's early script is taken from a baked page and run against the
// same kind of window.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadMorphModules = require('../../helpers/morphModules.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const FALLBACK = `
  <style>
    .nav_toggle { display: none; }
    .nav_menu { grid-template-rows: 1fr; visibility: visible; }
  </style>
`;
const CHANGED_FALLBACK = `
  <style>
    .nav_toggle { display: none; }
    .nav_menu { visibility: visible; }
  </style>
`;

// The server marks the nodes inside a <noscript> like any others. With
// scripting on, those markers are text too, and must stay where they are.
const marked = (fallback) => (fallback === '' ? '' : `<!--avb-s:1.1-->${fallback}<!--avb-e:1.1-->`);

const NAV = (label, fallback) =>
  `<!--avb-s:1--><header class="nav" data-avb-p="1"><!--avb-s:1.0--><a class="nav_link" data-avb-p="1.0">${label}</a><!--avb-e:1.0-->
<noscript>${marked(fallback)}</noscript></header><!--avb-e:1-->`;

const PAGE = (body) => `<!doctype html><html><head><title>Page</title></head><body>
${body}
<main><h1>Hero</h1></main>
</body></html>`;

// A live page as the canvas has it: parsed with scripting on.
function livePage(html) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  global.document = dom.window.document;
  const morph = loadMorphModules(LIMITS);
  return { dom, document: dom.window.document, morph };
}

// What fetchDocument in morphClient.ts makes of a rendering.
function rendering(dom, morph, html) {
  const withAnchors = new dom.window.DOMParser().parseFromString(html, 'text/html');
  morph.inertNoscripts(withAnchors);
  const clean = withAnchors.cloneNode(true);
  morph.stripAnchors(clean);
  return { withAnchors, clean };
}

function applyRendering(document, morph, previous, next) {
  morph.patchChildren(document.head, previous.clean.head, next.clean.head);
  morph.patchChildren(document.body, previous.clean.body, next.clean.body);
  morph.syncAnchors(document.body, next.withAnchors.body);
}

// Every selector of every stylesheet the page applies.
function liveSelectors(document) {
  const selectors = [];
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule.selectorText !== undefined) {
        selectors.push(rule.selectorText);
      }
    }
  }
  return selectors;
}

function onlyText(element) {
  assert.ok(element, 'the page has its <noscript>');
  assert.equal(element.children.length, 0, 'a <noscript> holds no elements');
  assert.ok(
    [...element.childNodes].every((node) => node.nodeType === 3),
    'a <noscript> holds only text',
  );
  return element.textContent;
}

test('the test environment parses <noscript> the way browsers do', () => {
  const { dom, document } = livePage(PAGE(NAV('Home', FALLBACK)));
  assert.equal(onlyText(document.querySelector('noscript')), marked(FALLBACK), 'scripting on: the markup is text');
  assert.deepEqual(liveSelectors(document), []);
  const parsed = new dom.window.DOMParser().parseFromString(PAGE(NAV('Home', FALLBACK)), 'text/html');
  assert.equal(parsed.querySelector('noscript > style')?.tagName, 'STYLE', 'scripting off: the markup is elements');
});

test('inertNoscripts leaves each <noscript> as its markup in one text node', () => {
  const { dom, morph } = livePage(PAGE(''));
  const parsed = new dom.window.DOMParser().parseFromString(
    PAGE(`<noscript><img src="/pixel.gif" alt=""></noscript><div><noscript></noscript></div>${NAV('Home', FALLBACK)}`),
    'text/html',
  );
  morph.inertNoscripts(parsed);
  const all = [...parsed.querySelectorAll('noscript')];
  assert.equal(all.length, 3);
  assert.equal(onlyText(all[0]), '<img src="/pixel.gif" alt="">');
  assert.equal(all[1].childNodes.length, 0, 'an empty <noscript> stays empty');
  assert.equal(onlyText(all[2]), marked(FALLBACK));
  assert.equal(parsed.querySelectorAll('noscript *').length, 0);
});

test('an inserted component brings its <noscript> in as text, never as a live stylesheet', () => {
  const { dom, document, morph } = livePage(PAGE(''));
  const previous = rendering(dom, morph, PAGE(''));
  const next = rendering(dom, morph, PAGE(NAV('Home', FALLBACK)));
  applyRendering(document, morph, previous, next);
  assert.equal(document.querySelectorAll('header.nav').length, 1, 'the component was inserted');
  assert.equal(onlyText(document.querySelector('noscript')), marked(FALLBACK));
  assert.deepEqual(liveSelectors(document), [], 'no rule from the fallback applies');
});

test('an edit elsewhere keeps the live <noscript> and its text exactly as first parsed', () => {
  const { dom, document, morph } = livePage(PAGE(NAV('Home', FALLBACK)));
  const liveNoscript = document.querySelector('noscript');
  let previous = rendering(dom, morph, PAGE(NAV('Home', FALLBACK)));
  for (const label of ['Home 2', 'Home 3']) {
    const next = rendering(dom, morph, PAGE(NAV(label, FALLBACK)));
    applyRendering(document, morph, previous, next);
    previous = next;
    assert.equal(document.querySelector('.nav_link').textContent, label, 'the edit landed');
    assert.equal(document.querySelector('noscript'), liveNoscript, 'the same <noscript> node');
    assert.equal(onlyText(liveNoscript), marked(FALLBACK), 'nothing was added to it');
    assert.deepEqual(liveSelectors(document), []);
  }
});

test('a <noscript> whose markup changes between renders takes the new text and stays inert', () => {
  const { dom, document, morph } = livePage(PAGE(NAV('Home', FALLBACK)));
  const liveNoscript = document.querySelector('noscript');
  const previous = rendering(dom, morph, PAGE(NAV('Home', FALLBACK)));
  const next = rendering(dom, morph, PAGE(NAV('Home', CHANGED_FALLBACK)));
  applyRendering(document, morph, previous, next);
  assert.equal(document.querySelector('noscript'), liveNoscript, 'patched in place');
  assert.equal(onlyText(liveNoscript), marked(CHANGED_FALLBACK));
  assert.deepEqual(liveSelectors(document), []);
  // Back again, and from markup into none at all.
  const emptied = rendering(dom, morph, PAGE(NAV('Home', '')));
  applyRendering(document, morph, next, emptied);
  assert.equal(document.querySelector('noscript'), liveNoscript);
  assert.equal(liveNoscript.textContent, '');
  assert.deepEqual(liveSelectors(document), []);
});

// The baked page's early script, bundled from its module. Its vendored imports
// are the repository's own files, so they resolve here.
async function bakedEarlyScript() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bake-html-'));
  const output = path.join(directory, 'bakeHtml.cjs');
  try {
    await build({
      entryPoints: [repoPath('studio/src/features/bake/bakeHtml.ts')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'vendored-stacki',
          setup(builder) {
            builder.onResolve({ filter: /vendor\/stacki\// }, (arguments_) => ({
              path: repoPath(`${arguments_.path.slice(arguments_.path.indexOf('vendor/stacki/') + 'vendor/stacki/'.length)}.ts`),
            }));
          },
        },
      ],
    });
    const { bakePage } = require(output);
    const { html } = bakePage('<!doctype html><html><head></head><body></body></html>', () => undefined);
    const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, 'a baked page carries its early script');
    return match[1];
  } finally {
    delete require.cache[output];
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("the static demo's early rendering moves in each <noscript> as text", async () => {
  const body = await bakedEarlyScript();
  const { dom, document } = livePage(PAGE(''));
  const current = PAGE(NAV('Edited', FALLBACK));
  const frame = { parent: { __stackiBakeRendering: () => current } };
  new dom.window.Function('window', 'location', body)(frame, { hash: '#avb-design', pathname: '/' });
  assert.equal(document.querySelector('.nav_link')?.textContent, 'Edited', 'the current rendering was swapped in');
  assert.equal(onlyText(document.querySelector('noscript')), marked(FALLBACK));
  assert.deepEqual(liveSelectors(document), [], 'no rule from the fallback applies');
});
