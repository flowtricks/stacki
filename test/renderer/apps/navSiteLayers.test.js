// Goal: a click on a nav link of a real site names its layers in the right order,
// with each file exactly as `page.get().path` names it (docs/apps.md, "Layers").
// The site is my-site's: index.astro uses BaseLayout.astro under the alias
// `Layout`; BaseLayout renders Nav.astro; Nav renders NavLink.astro twice, each
// link's text passed in Nav's own slot content, and both components wrap their
// markup in a `{render && (...)}` condition. Expected, innermost first: the <a> in
// NavLink.astro, the <NavLink> in Nav.astro, the <Nav> in BaseLayout.astro, and
// the <Layout> in the page, last.
// Method: the page as the canvas receives it, written from the marker serializer's
// output for those four files (doctype and <html> between the page's and the
// layout's markers, at the document's top level), collected by the frame's own
// code in jsdom; the files' trees from the editor's own parser, as page.getTree
// reads them; and nodeRefs.ts turning the frame's layers into what an app hears.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const frame = load('test/fixtures/apps/frameLayersEntry.ts');
const refs = load('src/features/apps/nodeRefs.ts');
const { parsePage } = load('electron/parse/astroParser.ts');

const PAGE_FILE = 'src/pages/index.astro';
const LAYOUT_FILE = 'src/layouts/BaseLayout.astro';
const NAV_FILE = 'src/components/global/Nav.astro';
const LINK_FILE = 'src/components/global/NavLink.astro';
const BL = `${LAYOUT_FILE}|`;
const NAV = `${NAV_FILE}|`;
const LINK = `${LINK_FILE}|`;

// One NavLink as Nav renders it at `at`: the instance's markers, NavLink's condition, its <li> and <a>, and
// the link text, which is Nav's own slot content (NavLink renders it with set:html).
const navLink = (at, text) =>
  `<!--avb-s:${NAV}${at}--><!--avb-s:${LINK}0--><!--avb-s:${LINK}0.0--><!--avb-s:${LINK}0.0.0-->` +
  `<li data-avb-p="${LINK}0.0.0 ${NAV}${at}"><!--avb-s:${LINK}0.0.0.0--><a class="nav_link" data-avb-p="${LINK}0.0.0.0 ${NAV}${at}" href="/">` +
  `<!--avb-s:${LINK}0.0.0.0.0--><!--avb-s:${NAV}${at}.0-->${text}<!--avb-e:${NAV}${at}.0--><!--avb-e:${LINK}0.0.0.0.0--></a><!--avb-e:${LINK}0.0.0.0-->` +
  `</li><!--avb-e:${LINK}0.0.0--><!--avb-e:${LINK}0.0--><!--avb-e:${LINK}0--><!--avb-e:${NAV}${at}-->`;
const HTML =
  `<!--avb-s:0--><!--avb-s:${BL}0--><!doctype html><!--avb-e:${BL}0-->\n` +
  `<!--avb-s:${BL}1--><html lang="en" data-avb-p="${BL}1 0"><head data-avb-p="${BL}1.0"></head><body data-avb-p="${BL}1.1">` +
  `<!--avb-s:${BL}1.1.1--><!--avb-s:${NAV}0--><!--avb-s:${NAV}0.0--><!--avb-s:${NAV}0.0.0-->` +
  `<header class="nav_wrap" data-avb-p="${NAV}0.0.0 ${BL}1.1.1"><div data-avb-p="${NAV}0.0.0.0"><nav data-avb-p="${NAV}0.0.0.0.2">` +
  `<div data-avb-p="${NAV}0.0.0.0.2.0"><ul data-avb-p="${NAV}0.0.0.0.2.0.0">` +
  `${navLink('0.0.0.0.2.0.0.0', 'Home')}${navLink('0.0.0.0.2.0.0.1', 'Example Components')}` +
  `</ul></div></nav></div></header><!--avb-e:${NAV}0.0.0--><!--avb-e:${NAV}0.0--><!--avb-e:${NAV}0--><!--avb-e:${BL}1.1.1-->` +
  `<!--avb-s:${BL}1.1.2--><main data-avb-p="${BL}1.1.2"><!--avb-s:${BL}1.1.2.0--><!--avb-s:0.0--><section data-avb-p="0.0">Style Guide</section>` +
  `<!--avb-e:0.0--><!--avb-e:${BL}1.1.2.0--></main><!--avb-e:${BL}1.1.2-->` +
  `</body></html><!--avb-e:${BL}1--><!--avb-e:0--><!--avb-d:x:${PAGE_FILE}-->`;

// A file's tree as page.getTree reads it: the editor's parser, its nodes as an app sees them.
function treeOf(file) {
  const parsed = parsePage(fs.readFileSync(repoPath(path.join('test/fixtures/apps/navSite', file)), 'utf8'));
  assert.equal(parsed.editable, true, `${file} parses`);
  const view = (node) => ({
    id: node.id,
    kind: node.kind,
    name: node.name ?? '',
    classes: [],
    attributes: Object.fromEntries(Object.entries(node.props ?? {}).flatMap(([name, attr]) => (attr.type === 'string' ? [[name, attr.value]] : []))),
    text: undefined,
    children: (node.children ?? []).map(view),
  });
  return parsed.model.nodes.map(view);
}

test('a click on the Home link names NavLink, Nav, BaseLayout and the page, innermost first', async () => {
  const dom = new JSDOM(HTML);
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  const empty = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  dom.window.Range.prototype.getBoundingClientRect = empty;
  dom.window.Range.prototype.getClientRects = () => [];
  try {
    frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
    frame.resetFocusCache();
    frame.collectRegions();
    const home = document.querySelector('a.nav_link');
    const frameLayers = frame.layersAt(home);
    assert.deepEqual(
      frameLayers.map((layer) => layer.path),
      [`${LINK}0.0.0.0`, `${NAV}0.0.0.0.2.0.0.0`, `${BL}1.1.1`, '0'],
    );
    // The open page as page.get answers it: its path is what the page's own layer must carry.
    const page = { path: PAGE_FILE, editable: true, truncated: false, nodes: treeOf(PAGE_FILE) };
    const host = {
      open: () => page,
      canvasPage: () => page.path,
      tree: async (file) => treeOf(file),
      locate: async () => undefined,
    };
    const layers = await refs.nodeLayers(host, frameLayers);
    assert.deepEqual(
      layers.map((layer) => [layer.file, layer.nodeId, layer.component]),
      [
        [LINK_FILE, 'n0.0.0.0', undefined],
        [NAV_FILE, 'n0.0.0.0.2.0.0.0', 'NavLink'],
        [LAYOUT_FILE, 'n1.1.1', 'Nav'],
        [PAGE_FILE, 'layout', 'Layout'],
      ],
    );
    assert.equal(layers.at(-1).file, page.path, 'the page layer is last, named exactly as page.get names the page');
    assert.equal(layers.filter((layer) => layer.file === page.path).length, 1, 'and only the last layer is the page');
    // Each layer's instances are the layers after it, outermost first.
    assert.deepEqual(
      layers[0].instancePath.map((step) => step.file),
      [PAGE_FILE, LAYOUT_FILE, NAV_FILE],
    );
    // The second link is the same files, told apart by its own NavLink instance in Nav.
    const second = frame.layersAt(document.querySelectorAll('a.nav_link')[1]);
    assert.deepEqual(
      second.map((layer) => [layer.path, layer.copy]),
      [
        [`${LINK}0.0.0.0`, 0],
        [`${NAV}0.0.0.0.2.0.0.1`, 0],
        [`${BL}1.1.1`, 0],
        ['0', 0],
      ],
    );
  } finally {
    dom.window.close();
  }
});
