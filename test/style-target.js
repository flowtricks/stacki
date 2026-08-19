// What the style panel matches selectors against.
//
//   node test/style-target.js
//
// The panel resolves the selected node into a snapshot — tag, id, classes,
// attributes — and every selector in the project is matched against it. For a
// component instance or a layout the SOURCE has no tag of its own (`<Section>`
// says nothing about the `<section class="section">` it renders), so the page
// is asked what it actually rendered. That answer has to reach the matcher and
// not just the header: while it didn't, `html { … }` and `:root { … }` failed
// to target the very element the panel was calling `html.theme-dark`, and the
// class selectors sitting in the same rule matched perfectly well — so the
// styles looked half-read rather than unread, which is a hard thing to spot.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'style-target.bundle.js');
  await esbuild.build({
    // A tiny entry over the three modules involved, bundled from the panel's
    // own directory so its imports resolve the way they do in the app.
    stdin: {
      contents: `
        export { resolveTarget } from './lib/webflow'
        export { setHost, onHostChange, getHost } from './lib/host'
        export { matchSelectorList } from './lib/selectors'
      `,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.avb = {};

  const { resolveTarget, setHost, onHostChange, getHost, matchSelectorList } = require(bundlePath);
  setHost({ nodes: [], projectPath: '/project', files: [], astroFiles: [] });

  // A layout: a component call in the source, `<html class="theme-dark">` on
  // the page. Nothing in the model says "html".
  // Props carry {type, value} in the model, the way the parser writes them.
  const node = {
    id: 'layout',
    kind: 'component',
    name: 'BaseLayout',
    props: { class: { type: 'string', value: 'theme-dark' } },
    children: [],
  };
  const scan = {
    parentByKey: new Map(),
    childrenByKey: new Map(),
    elementByKey: new Map([['layout', node]]),
    embeds: [],
    inComponentContext: false,
  };
  /** The shape queryCanvas answers with — passed straight in, so no canvas is needed. */
  const answer = (identity) => ({ answer: { identity, matched: {} }, askedFor: new Map() });
  const matches = async (target, selector) => (await matchSelectorList(selector, target))[0].matched;

  {
    const { target, rootSnapshot } = await resolveTarget(
      node,
      scan,
      answer({ tag: 'html', id: null, classes: ['theme-dark'], attributes: { lang: 'en' } })
    );
    check('the header reads the rendered tag', rootSnapshot.tag === 'html', rootSnapshot.tag);
    const seen = await target.view.snapshot(target.rootKey);
    check('and so does the matcher', seen?.tag === 'html', JSON.stringify(seen?.tag));
    check('a type selector targets it', await matches(target, 'html'));
    check(':root targets it', await matches(target, ':root'));
    check('tag and class together target it', await matches(target, 'html.theme-dark'));
    check('the class alone still does', await matches(target, '.theme-dark'));
    check('an attribute selector still does', await matches(target, '[class*="theme-"]'));
    // The rule that made this visible: one group, two selectors, both matching.
    // Only the class half used to.
    const both = await matchSelectorList(':root, [class*="theme-"]', target);
    check('every selector in a group is judged', both.every((r) => r.matched), JSON.stringify(both));
    check('and a tag it does not have does not', !(await matches(target, 'body')));
    check(':root does not match a nested element', !(await matches(target, 'body :root')));
  }

  {
    // A component instance: `<Section>` renders `<section class="section">`.
    const section = { id: 'n1', kind: 'component', name: 'Section', props: {}, children: [] };
    const sectionScan = { ...scan, elementByKey: new Map([['n1', section]]) };
    const { target } = await resolveTarget(
      section,
      sectionScan,
      answer({ tag: 'section', id: null, classes: ['section'], attributes: {} })
    );
    check('a component instance matches by what it renders', await matches(target, 'section.section'));
    check('and by the tag alone', await matches(target, 'section'));
    check('but not by another tag', !(await matches(target, 'div')));
  }

  {
    // No canvas (preview offline, or a node that renders nothing): the source
    // is all there is, and an unverifiable type selector stays unmatched
    // rather than being waved through.
    const { target } = await resolveTarget(node, scan, null);
    const seen = await target.view.snapshot(target.rootKey);
    check('with no answer the snapshot is the source one', seen?.tag == null, JSON.stringify(seen?.tag));
    check('an unverifiable tag selector does not match', !(await matches(target, 'html')));
    check('the classes it does know still match', await matches(target, '.theme-dark'));
  }

  // --- the panel hears about undo ------------------------------------------
  {
    // Undo rewrites the stylesheets and the page model directly. The panel
    // reads both, so it is told when that happens — otherwise it keeps showing
    // what it cached until its own refresh comes round, and trails the canvas.
    // Subscribers hear about it a microtask later (the panel patches the host
    // from inside its own render, where calling them would update one component
    // while another is rendering); the state itself is written straight away.
    const settle = () => Promise.resolve().then(() => {});
    let notified = 0;
    const off = onHostChange(() => { notified += 1; });
    const before = getHost().historyTick;
    check('the host carries a history tick', typeof before === 'number', typeof before);
    setHost({ historyTick: before + 1 });
    check('it reads back at once', getHost().historyTick === before + 1, `${getHost().historyTick}`);
    check('without calling anyone mid-render', notified === 0, `${notified} notifications`);
    await settle();
    check('moving it notifies', notified === 1, `${notified} notifications`);
    const after = notified;
    setHost({ historyTick: before + 1 });
    await settle();
    check('setting the same value again says nothing', notified === after, `${notified} vs ${after}, tick=${getHost().historyTick}`);
    const beforeOff = notified;
    off();
    setHost({ historyTick: before + 2 });
    await settle();
    check('and nothing after unsubscribing', notified === beforeOff, `${notified} vs ${beforeOff}`);
  }

  if (failures.length) {
    console.error(`style-target: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`style-target: ${checked} passed  [layout, component instance, no canvas]`);
})();
