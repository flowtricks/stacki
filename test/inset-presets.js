// Pinning a positioned element to a corner, an edge, or the whole box.
//
//   node test/inset-presets.js
//
// Nine buttons, each of which writes some of top/right/bottom/left and clears
// the rest. The clearing is the half that is easy to leave out and impossible
// to spot in a screenshot: an element that already has `left` set and then
// gains `right` STRETCHES between the two rather than moving, so a preset that
// only added sides would do something other than what its icon shows.
//
// The other half is which button lights up. It is read from which sides are
// SET rather than from whether they are still 0 — nudging a pinned corner to
// `12px` has not stopped it being pinned to that corner.

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
  const bundlePath = path.join(buildDir, 'inset-presets.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'PositionSection.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const PositionSection = require(bundlePath).default;

  // A panel over an element whose declared styles are `decls`.
  const mount = async (decls) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const set = [];
    const cleared = [];
    // The shape the panel's resolver hands back (see displayOf): a declaration
    // has a `winner`, and an absent one is simply undefined.
    const read = (prop) =>
      decls[prop] != null
        ? {
            source: 'selected',
            overridden: false,
            contributors: [],
            winner: { selectorText: '.x', value: decls[prop], important: false },
            selectedValue: { value: decls[prop], important: false },
          }
        : undefined;
    await act(async () => {
      root.render(
        React.createElement(PositionSection, {
          read,
          busy: false,
          setProp: (prop, value) => set.push([prop, value]),
          clearProp: (prop) => cleared.push(...(Array.isArray(prop) ? prop : [prop])),
          liveSetProp: () => {},
          onProvenance: () => {},
          onSelectSelector: () => {},
        })
      );
    });
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    const presets = () => [...host.querySelectorAll('.embed-editor_inset-preset')];
    const press = async (label) => {
      const btn = presets().find((b) => b.getAttribute('aria-label') === label);
      if (!btn) throw new Error(`no preset button "${label}"`);
      await act(async () => {
        btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
    };
    return { host, set, cleared, presets, press, done };
  };

  // --- The row is always there ----------------------------------------------
  //
  // Whatever `position` says, and whether or not anything is set yet. A row
  // that comes and goes as the dropdown changes is a row you have to go and
  // find again — and the inset box underneath has never hidden either, so a
  // disappearing row of buttons above a permanent box would be the odd one out.
  {
    const stat = await mount({ position: 'static' });
    check('a static element still gets them', stat.presets().length === 9, String(stat.presets().length));
    await stat.done();

    const rel = await mount({ position: 'relative' });
    check('and a relative one', rel.presets().length === 9, String(rel.presets().length));
    await rel.done();

    const bare = await mount({});
    check('and one with no position declared at all', bare.presets().length === 9, String(bare.presets().length));
    await bare.done();

    const abs = await mount({ position: 'absolute' });
    check('an absolute one gets all nine', abs.presets().length === 9, String(abs.presets().length));
    await abs.done();

    const fixed = await mount({ position: 'fixed' });
    check('and so does fixed', fixed.presets().length === 9, String(fixed.presets().length));
    await fixed.done();

    const sticky = await mount({ position: 'sticky' });
    check('and sticky', sticky.presets().length === 9, String(sticky.presets().length));
    await sticky.done();
  }

  // --- z-index is always there too ------------------------------------------
  {
    // It used to appear only once the element was positioned, so the field
    // moved in and out of the panel as the dropdown changed. A field showing
    // "Auto" says more than a field that isn't there.
    for (const pos of ['static', 'relative', 'absolute', undefined]) {
      const m = await mount(pos ? { position: pos } : {});
      const z = m.host.querySelector('[aria-label="z-index"]');
      check(`z-index is present for position: ${pos ?? '(unset)'}`, !!z, m.host.innerHTML.slice(0, 120));
      await m.done();
    }
  }

  // --- What a corner writes, and what it clears -----------------------------
  {
    const m = await mount({ position: 'absolute' });
    await m.press('Bottom right');
    check('a corner sets its two sides', m.set.length === 2, JSON.stringify(m.set));
    check('to zero', m.set.every(([, v]) => v === '0'), JSON.stringify(m.set));
    check(
      'namely bottom and right',
      m.set.map(([p]) => p).sort().join(',') === 'bottom,right',
      JSON.stringify(m.set)
    );
    // The half that is easy to miss: left and top must GO, or the element
    // stretches across the parent instead of sitting in the corner.
    check(
      'and the opposite sides are cleared',
      m.cleared.sort().join(',') === 'left,top',
      JSON.stringify(m.cleared)
    );
    await m.done();
  }

  // --- An edge pins three sides ---------------------------------------------
  {
    const m = await mount({ position: 'absolute' });
    await m.press('Left edge');
    check(
      'an edge sets three sides',
      m.set.map(([p]) => p).sort().join(',') === 'bottom,left,top',
      JSON.stringify(m.set)
    );
    check('and clears the fourth', m.cleared.join(',') === 'right', JSON.stringify(m.cleared));
    await m.done();
  }

  // --- Fill pins all four ----------------------------------------------------
  {
    const m = await mount({ position: 'absolute' });
    await m.press('Fill');
    check(
      'fill sets every side',
      m.set.map(([p]) => p).sort().join(',') === 'bottom,left,right,top',
      JSON.stringify(m.set)
    );
    check('with nothing left to clear', m.cleared.length === 0, JSON.stringify(m.cleared));
    await m.done();
  }

  // --- Which one lights up ---------------------------------------------------
  {
    const selected = (m) =>
      m.presets().filter((b) => b.getAttribute('aria-checked') === 'true')
        .map((b) => b.getAttribute('aria-label'));

    const corner = await mount({ position: 'absolute', top: '0', left: '0' });
    check('the matching corner is shown as chosen', selected(corner).join(',') === 'Top left', JSON.stringify(selected(corner)));
    check('and only that one', selected(corner).length === 1, JSON.stringify(selected(corner)));
    await corner.done();

    // Read from WHICH sides are set, not from whether they are still zero: a
    // nudged corner is still pinned to that corner.
    const nudged = await mount({ position: 'absolute', top: '12px', left: '2rem' });
    check('a nudged corner still reads as that corner', selected(nudged).join(',') === 'Top left', JSON.stringify(selected(nudged)));
    await nudged.done();

    const edge = await mount({ position: 'absolute', top: '0', bottom: '0', left: '0' });
    check('three sides read as an edge', selected(edge).join(',') === 'Left edge', JSON.stringify(selected(edge)));
    await edge.done();

    const all = await mount({ position: 'absolute', top: '0', right: '0', bottom: '0', left: '0' });
    check('four sides read as fill', selected(all).join(',') === 'Fill', JSON.stringify(selected(all)));
    await all.done();

    // `auto` is what an unset side reads as, and it is not a pin.
    const autos = await mount({ position: 'absolute', top: '0', left: 'auto' });
    check('an auto side does not count as pinned', selected(autos).length === 0, JSON.stringify(selected(autos)));
    await autos.done();

    const none = await mount({ position: 'absolute' });
    check('nothing set means nothing chosen', selected(none).length === 0, JSON.stringify(selected(none)));
    await none.done();
  }

  if (failures.length) {
    console.error(`inset-presets: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`inset-presets: ${checked} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
