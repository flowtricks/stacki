// The selected segment slides.
//
//   node test/segmented.js
//
// A segmented control can say which option is chosen in two ways: give every
// segment a background and show one of them, or give the control one pill and
// move it. They look the same in a screenshot and read differently in the hand
// — four things blinking in turn is four controls answering, one thing moving
// is one control answering — and only the second can carry a transition.
//
// The Display bar was the last one doing it the first way. It is also the
// awkward one: four segments where the fourth's label changes with the value
// (None / In-block / In-flex …), a chevron sharing the track, and a custom-value
// mode with no segments at all. So the pill is measured from the button's own
// geometry rather than from a fraction of the track, and this checks it lands
// on the selection in each of those cases.
//
// Hover is checked too, in the CSS: with the pill in flight, a background under
// the pointer is a second thing claiming to be the selection.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// Segment geometry, since jsdom lays nothing out: the track is 320px wide with
// 4px of padding, four equal segments, and the pill should land on whichever is
// selected.
const TRACK = 320;
const PAD = 4;
const SEG = (TRACK - PAD * 2) / 4;

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const entry = path.join(buildDir, 'segmented.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as DisplayControl } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'style-panel', 'DisplayControl.tsx')
    )};\n`
  );
  const out = path.join(buildDir, 'segmented.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  // The pill measures with offsetLeft/offsetWidth — zoom-independent, and the
  // reason it can't be a percentage of the track. jsdom reports 0 for both, so
  // they are defined here from the layout above.
  const index = (el) => [...(el.parentElement?.children ?? [])].filter((n) => n.tagName === 'BUTTON').indexOf(el);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', {
    get() {
      if (!this.className?.includes?.('display-seg')) return 0;
      return PAD + index(this) * SEG;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    get() {
      return this.className?.includes?.('display-seg') ? SEG : TRACK;
    },
  });
  // The component keeps the pill in step with layout through one of these; the
  // bundle reads it off the global, which jsdom doesn't provide.
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  // The pill reads the selection off the class the buttons carry, and watches
  // for it changing — jsdom has MutationObserver, it just isn't on the global
  // the bundle reads.
  global.MutationObserver = dom.window.MutationObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { DisplayControl } = require(out);

  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  const show = async (value) => {
    await act(async () => {
      root.render(
        React.createElement(DisplayControl, { value, busy: false, onCommit: () => {} })
      );
    });
    await act(async () => {});
  };
  const pill = () => host.querySelector('.embed-editor_display-indicator');
  const at = () => {
    const style = pill()?.getAttribute('style') || '';
    const x = style.match(/translateX\(([-\d.]+)px\)/);
    const w = style.match(/width:\s*([\d.]+)px/);
    return x && w ? { x: Number(x[1]), width: Number(w[1]) } : null;
  };
  const segments = () => [...host.querySelectorAll('.embed-editor_display-seg')];

  // --- the pill lands on the selection ----------------------------------------
  await show('block');
  check('there is one pill, not four backgrounds', host.querySelectorAll('.embed-editor_display-indicator').length === 1);
  check('and it starts on the selected segment', at()?.x === PAD, JSON.stringify(at()));
  check('as wide as that segment', at()?.width === SEG, JSON.stringify(at()));

  await show('flex');
  check('choosing the second moves it one segment along', at()?.x === PAD + SEG, JSON.stringify(at()));
  await show('grid');
  check('and the third, two', at()?.x === PAD + SEG * 2, JSON.stringify(at()));

  // The fourth slot is whichever non-primary value is set, and its label
  // changes with it — so the pill is measured, never assumed.
  await show('none');
  check('an inline/none value puts it on the fourth', at()?.x === PAD + SEG * 3, JSON.stringify(at()));
  check('and the fourth reads as the value it holds', segments()[3]?.textContent === 'None', segments()[3]?.textContent);
  await show('inline-block');
  check('whatever that value is', at()?.x === PAD + SEG * 3, JSON.stringify(at()));
  check('with the label to match', segments()[3]?.textContent === 'In-block', segments()[3]?.textContent);

  // --- and nothing else claims to be selected ---------------------------------
  await show('grid');
  const selected = segments().filter((el) => el.className.includes('is-selected'));
  check('exactly one segment is marked selected', selected.length === 1, String(selected.length));
  check('the one the pill is under', selected[0]?.textContent === 'Grid', selected[0]?.textContent);
  check(
    'and it is announced as checked',
    segments().filter((el) => el.getAttribute('aria-checked') === 'true').length === 1
  );

  // --- what the fourth slot can hold --------------------------------------------
  //
  // The inline set, plus the two that leave no box: `none` takes the element and
  // its children off the page, `contents` takes only its box, so the children
  // lay out as if it weren't there. Both belong on the bar — before, `contents`
  // fell through to the custom text field, which is where a value goes when the
  // panel doesn't understand it.
  await show('contents');
  check('contents is a segment, not a custom value', segments().length === 4, String(segments().length));
  check('sitting in the fourth slot', at()?.x === PAD + SEG * 3, JSON.stringify(at()));
  check('labelled as itself', segments()[3]?.textContent === 'Contents', segments()[3]?.textContent);
  check(
    'and marked as the one that is on',
    segments()[3]?.getAttribute('aria-checked') === 'true'
  );

  // --- a value with no segment at all ------------------------------------------
  await show('var(--layout)');
  check('a custom value shows no segments', segments().length === 0);
  check('and no pill to hang over them', pill() === null);
  await show('flex');
  check('coming back puts it where the value is', at()?.x === PAD + SEG, JSON.stringify(at()));

  // --- the transition ----------------------------------------------------------
  // The class arrives a frame after the first placement, so that the pill
  // doesn't fly in from the left on mount; jsdom runs those frames on a timer.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  check(
    'the pill can be animated once placed',
    pill()?.className.includes('is-animated'),
    pill()?.className
  );

  await act(async () => {
    root.unmount();
  });

  // It is offered in the menu too — both ways round, since the menu that opens
  // from the bar and the one that opens from a custom value are different lists.
  const display = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'DisplayControl.tsx'),
    'utf8'
  );
  check(
    'the menu lists it beside None, whichever menu it is',
    (display.match(/\{BOXLESS\.map\(/g) || []).length === 2,
    'the two menus render the boxless group'
  );
  check('with a tooltip saying what it does', /contents: <>/.test(display));
  check(
    'and it is a supported value, so the bar keeps it',
    /const BOXLESS = \['none', 'contents'\]/.test(display) && /\.\.\.INLINE, \.\.\.BOXLESS/.test(display)
  );

  // --- every bar that shares the classes ----------------------------------------
  //
  // Eight controls are the same bar: same track, same segment class, different
  // segments. The background they all used to rely on lives on that shared
  // class, so a pill for one of them and not the others leaves the others with
  // no selection at all — which is exactly what happened to Direction and
  // Overflow when Display got the pill first.
  const panel = path.join(__dirname, '..', 'src', 'style-panel');
  const bars = [
    'DisplayControl.tsx',
    'DirectionControl.tsx',
    'SizeSection.tsx',
    'PositionSection.tsx',
    'TypographySection.tsx',
    'FlexChildSection.tsx',
    'BordersSection.tsx',
    'SegmentedField.tsx',
  ];
  for (const file of bars) {
    const source = fs.readFileSync(path.join(panel, file), 'utf8');
    const tracks = (source.match(/className=\{`embed-editor_display /g) || []).length;
    const pills = (source.match(/<SegmentPill \/>/g) || []).length;
    check(
      `${file.replace('.tsx', '')} draws a pill in each of its tracks`,
      tracks > 0 && pills === tracks,
      `${pills} pills for ${tracks} tracks`
    );
  }
  // …and every file that renders a segment is on that list, so a new bar can't
  // quietly appear without one.
  const users = fs
    .readdirSync(panel)
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => fs.readFileSync(path.join(panel, f), 'utf8').includes('embed-editor_display-seg'));
  check(
    'and no other file renders segments without one',
    users.every((f) => bars.includes(f)),
    users.filter((f) => !bars.includes(f)).join(', ')
  );

  // --- what the CSS says --------------------------------------------------------
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'embed-editor.css'),
    'utf8'
  );
  // Every rule with this selector, joined — `.embed-editor_display-seg` is
  // declared twice in the file, and reading only the first says the opposite of
  // what the page renders.
  const rule = (selector) => {
    const out = [];
    let from = 0;
    for (;;) {
      const at = css.indexOf(selector + ' {', from);
      if (at < 0) break;
      const end = css.indexOf('}', at);
      out.push(css.slice(at, end));
      from = end + 1;
    }
    return out.length ? out.join('\n') : null;
  };
  check('the pill is the thing that carries the background', /background:\s*var\(--surface-control\)/.test(rule('.embed-editor_display-indicator') || ''));
  check('and the thing that moves', /transition:\s*transform/.test(rule('.embed-editor_display-indicator.is-animated') || ''));
  check(
    'a selected segment has no background of its own',
    !/background/.test(rule('.embed-editor_display-seg.is-selected') || '') &&
      !css.includes('.embed-editor_display-seg.is-selected:hover'),
    rule('.embed-editor_display-seg.is-selected') || 'no rule'
  );
  check(
    'hover moves the label, not a background',
    /background:\s*none/.test(rule('.embed-editor_display-seg:hover:not(:disabled)') || '') &&
      /color:\s*var\(--color-text-primary\)/.test(rule('.embed-editor_display-seg:hover:not(:disabled)') || ''),
    rule('.embed-editor_display-seg:hover:not(:disabled)') || 'no rule'
  );
  check(
    'the chevron beside them agrees',
    /background:\s*none/.test(rule('.embed-editor_display-arrow:hover:not(:disabled)') || ''),
    rule('.embed-editor_display-arrow:hover:not(:disabled)') || 'no rule'
  );
  check(
    'and the segments sit above the pill rather than under it',
    /z-index:\s*1/.test(rule('.embed-editor_display-seg') || '')
  );

  if (failures.length) {
    console.error(`\nsegmented: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`segmented: ${checked} passed  [display bar, sliding pill]`);
  process.exit(0);
})();
