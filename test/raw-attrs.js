// Attributes on <style> and <script>.
//
//   node test/raw-attrs.js
//
// These two tags carry the attributes that decide what they DO. `is:global`
// makes a stylesheet apply past the component that wrote it; `define:vars`
// feeds it values from the frontmatter; `is:inline`, `type` and `src` decide
// whether a script is processed, a module, or fetched. None of that is
// decoration.
//
// The panel could show the ones already written but had no way to add one, so
// the only route to a global stylesheet was to open the file and type it —
// which is the thing this app exists to avoid.
//
// Two halves. The panel has to offer it, and the file has to keep it: an
// attribute that is added and then dropped on the next save is worse than one
// that was never offered, because the CSS around it looks like it should work.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  // --- The file keeps them ---------------------------------------------------
  {
    const { parsePage, serializePage } = require('../electron/astroParser.js');
    const findRaw = (nodes) => {
      for (const n of nodes || []) {
        if (n.kind === 'raw') return n;
        const hit = findRaw(n.children);
        if (hit) return hit;
      }
      return null;
    };

    // The three shapes an attribute comes in, all of which these tags use.
    const START = '---\n---\n<div>\n  <style>\n    .x { color: red }\n  </style>\n</div>\n';
    const model = parsePage(START).model;
    const raw = findRaw(model.nodes);
    check('a bare <style> parses with no attributes', JSON.stringify(raw.props) === '{}', JSON.stringify(raw.props));

    raw.props = {
      'is:global': { type: 'bare' },
      class: { type: 'string', value: 'footer-css' },
      'define:vars': { type: 'expr', value: '{ c }' },
    };
    const out = serializePage(model);
    const tag = out.split('\n').find((l) => l.includes('<style')) ?? '';
    // Bare stays bare: `is:global=""` is not the same attribute to Astro.
    check('a bare attribute is written bare', /<style is:global[ >]/.test(tag), tag);
    check('a string attribute is quoted', tag.includes('class="footer-css"'), tag);
    check('an expression keeps its braces', tag.includes('define:vars={{ c }}'), tag);

    const again = findRaw(parsePage(out).model.nodes);
    check('and all three read back', Object.keys(again.props).join(',') === 'is:global,class,define:vars', JSON.stringify(again.props));
    check('bare reads back as bare', again.props['is:global'].type === 'bare', JSON.stringify(again.props['is:global']));
    check('the expression reads back as an expression', again.props['define:vars'].type === 'expr', JSON.stringify(again.props['define:vars']));
    // The whole point of a raw node: what's inside is untouched.
    check('and the CSS inside is untouched', again.inner === raw.inner, JSON.stringify(again.inner));

    // A script's own set, including one that changes how Astro treats it.
    const sModel = parsePage('---\n---\n<script>console.log(1)</script>\n').model;
    const script = findRaw(sModel.nodes);
    script.props = { 'is:inline': { type: 'bare' }, type: { type: 'string', value: 'module' } };
    const sOut = serializePage(sModel);
    check('a script keeps its attributes too', /<script is:inline type="module">/.test(sOut), sOut.trim());
    const sBack = findRaw(parsePage(sOut).model.nodes);
    check('and they read back', Object.keys(sBack.props).join(',') === 'is:inline,type', JSON.stringify(sBack.props));
    check('with the script body intact', sBack.inner.includes('console.log(1)'), JSON.stringify(sBack.inner));
  }

  // --- The panel offers them -------------------------------------------------
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundle = path.join(buildDir, 'raw-attrs.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.DOMRect = dom.window.DOMRect;
  global.Window = dom.window.Window;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const PropsPanel = require(bundle).default;

  const mount = async (node) => {
    const host = dom.window.document.getElementById('root');
    const root = createRoot(host);
    const set = [];
    await act(async () => {
      root.render(
        React.createElement(PropsPanel, {
          node,
          projectPath: '/p',
          onSetProp: (name, value, immediate) => set.push([name, value, immediate]),
          onSetProps: () => {},
          onRenameProp: () => {},
          onOpenCode: () => {},
          onSetText: () => {},
        })
      );
    });
    return {
      host, set, root,
      section: () => [...host.querySelectorAll('.props-label-row')].find((r) => r.textContent.includes('Attributes')),
      rows: () => [...host.querySelectorAll('.attr-row .attr-name')].map((n) => n.textContent),
      done: async () => { await act(async () => root.unmount()) },
    };
  };

  // A <style> with nothing on it — the case from the report.
  {
    const m = await mount({ id: 'n1', kind: 'raw', name: 'style', props: {}, inner: '.x { color: red }' });
    check('a bare <style> still offers Attributes', !!m.section(), m.host.textContent.slice(0, 160));
    const add = m.section()?.querySelector('button');
    check('with something to press to add one', !!add, m.section()?.innerHTML ?? 'no Attributes section at all');
    // Guarded: a missing button is a FAILURE to report, not a stack trace that
    // buries which case broke.
    if (add) {
      await act(async () => { add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) });
      check('pressing it opens the attribute editor', !!dom.window.document.querySelector('.attr-editor'), dom.window.document.body.innerHTML.slice(-200));
    } else {
      check('pressing it opens the attribute editor', false, 'there was nothing to press');
    }
    // And the code editor is still there — this is an addition, not a swap.
    check('and Edit code is still offered', m.host.textContent.includes('Edit code'), m.host.textContent.slice(0, 200));
    await m.done();
  }

  // One that already has attributes lists them.
  {
    const m = await mount({
      id: 'n2', kind: 'raw', name: 'style',
      props: { 'is:global': { type: 'bare' }, class: { type: 'string', value: 'footer-css' } },
      inner: '.x {}',
    });
    check('existing attributes are listed', m.rows().join(',') === 'is:global,class', JSON.stringify(m.rows()));
    // `class` is NOT filtered out here the way it is for an element: an element
    // has a dedicated class field, and this has none — so it must appear.
    check('including class', m.rows().includes('class'), JSON.stringify(m.rows()));
    await m.done();
  }

  // And a <script>, which is the same node kind.
  {
    const m = await mount({ id: 'n3', kind: 'raw', name: 'script', props: { 'is:inline': { type: 'bare' } }, inner: 'console.log(1)' });
    check('a <script> gets the same section', !!m.section(), m.host.textContent.slice(0, 160));
    check('and lists its own', m.rows().join(',') === 'is:inline', JSON.stringify(m.rows()));
    await m.done();
  }

  if (failures.length) {
    console.error(`raw-attrs: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`raw-attrs: ${checked} passed  [offered, and kept by the file]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
