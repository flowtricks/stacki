// What takes the caret.
//
//   node test/focus.js
//
// A free-text field in the style panel appears for two different reasons: the
// value is one no control can show (`var(--_visual-ratio)`, `calc(…)`), or
// somebody just picked "Other"/"Custom" from a menu. They look identical, and
// only the second is somebody about to type.
//
// The Ratio field focused itself on mount either way. So selecting an element
// whose aspect-ratio was a var() moved the caret into the style panel and
// selected its text: a click on the canvas left you typing into a field you
// never opened, one keystroke away from overwriting the value.
//
// The same component is the Image-fit field, so it did it twice.

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
  const entry = path.join(buildDir, 'focus.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { RatioOtherInput } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'style-panel', 'SizeSection.tsx')
    )};\n`
  );
  const out = path.join(buildDir, 'focus.bundle.js');
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
  const dom = new JSDOM('<!doctype html><input id="elsewhere"><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { RatioOtherInput } = require(out);

  const host = dom.window.document.getElementById('root');
  const away = dom.window.document.getElementById('elsewhere');
  const show = async (props) => {
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(RatioOtherInput, {
          value: 'var(--_visual-ratio)',
          busy: false,
          prop: 'aspect-ratio',
          onCommit() {},
          onLiveCommit() {},
          onClear() {},
          ...props,
        })
      );
    });
    await act(async () => {});
    return root;
  };
  const field = () => host.querySelector('input');
  const hasCaret = () => dom.window.document.activeElement === field();

  // --- the field the VALUE brought here ----------------------------------------
  away.focus();
  let root = await show({});
  check('a field that appeared on its own does not take the caret', !hasCaret());
  check('and leaves it where it was', dom.window.document.activeElement === away);
  check('while still showing the value', field()?.value === 'var(--_visual-ratio)', field()?.value);
  await act(async () => { root.unmount() });

  // --- the field somebody ASKED for --------------------------------------------
  away.focus();
  root = await show({ autoFocus: true });
  check('a field that was just chosen takes the caret', hasCaret());
  check(
    'with its text selected, ready to be typed over',
    field()?.selectionStart === 0 && field()?.selectionEnd === field()?.value.length,
    `${field()?.selectionStart}–${field()?.selectionEnd}`
  );
  await act(async () => { root.unmount() });

  // Nothing is focused mid-write: the seeding write disables the field, and
  // focusing a disabled input does nothing at all.
  away.focus();
  root = await show({ autoFocus: true, busy: true });
  check('and not while the seeding write is still going', !hasCaret());
  await act(async () => { root.unmount() });

  // --- a variable reads as one ---------------------------------------------------
  //
  // This is the field you land in BECAUSE the value isn't a plain one, so it is
  // the likeliest place in the panel to be holding a `var(--x)` — and it was the
  // one place showing it as raw text instead of the chip every other field
  // gives it.
  root = await show({});
  check(
    'the field is wrapped in the variable editor, like its neighbours',
    !!host.querySelector('.embed-editor_varconnect, .u-varconnect, [class*="varconnect"]'),
    host.innerHTML.slice(0, 160)
  );
  await act(async () => { root.unmount() });

  // --- both fields it serves ----------------------------------------------------
  const size = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'SizeSection.tsx'),
    'utf8'
  );
  check(
    'Ratio asks for the caret only when Other was picked',
    /autoFocus=\{askedForOther\.current\}/.test(size)
  );
  check(
    'and Image fit only when Custom was',
    /autoFocus=\{askedForCustom\.current\}/.test(size)
  );
  check(
    'both tell the picker which property they are',
    /prop="aspect-ratio"/.test(size) && /prop="object-fit"/.test(size)
  );
  // Picking anything else takes the request back, so returning to the field
  // later — by selecting an element — is silent again.
  check(
    'choosing another option withdraws the request',
    /askedForOther\.current = false/.test(size) && /askedForCustom\.current = false/.test(size)
  );

  // --- the rest of the panel already worked this way ---------------------------
  //
  // Every other custom-value field gates its focus on a ref set when the mode is
  // entered. This one focused on mount, which is the whole bug — so the rule is
  // checked across the panel rather than in the one file that broke it.
  const panel = path.join(__dirname, '..', 'src', 'style-panel');
  // A popover is different: it exists only because it was opened, so mounting
  // IS the request. The spacing box's side editor is one — pressing a side is
  // what puts it on screen, and it should be ready to type in. The rule is
  // about fields that render as part of a control that was already there.
  const OPENED_ON_PURPOSE = new Set(['SpacingBox.tsx']);
  const ungated = [];
  for (const file of fs.readdirSync(panel).filter((f) => f.endsWith('.tsx') && !OPENED_ON_PURPOSE.has(f))) {
    const source = fs.readFileSync(path.join(panel, file), 'utf8');
    for (const effect of source.split('useEffect(').slice(1)) {
      const body = effect.slice(0, effect.indexOf('}, ['));
      if (!/inputRef\.current\?\.focus\(\)/.test(body)) continue;
      // Gated on something: the mode was entered, or the caller asked.
      if (/wantFocus|autoFocus|didFocus/.test(body)) continue;
      ungated.push(file);
    }
  }
  check('no field in the panel focuses itself unasked', ungated.length === 0, ungated.join(', '));

  if (failures.length) {
    console.error(`\nfocus: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`focus: ${checked} passed  [style panel, who takes the caret]`);
  process.exit(0);
})();
