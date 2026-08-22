// What a click on the canvas means.
//
//   node test/canvas-click.js
//
// Double-click into a component, click something inside it, and it kept closing
// the component instead of selecting what was clicked.
//
// The canvas answers a click with the deepest path it can map under the pointer
// in the open file's scope — or null. Null has two causes that want opposite
// things: the click landed somewhere this file doesn't own (the page around an
// open component), or it landed on something inside it that carries no marker —
// content passed into a slot belongs to the caller, an expression the marker
// serializer can't wrap emits nothing, a text node has no element of its own.
//
// Backing out on either is what made a click inside a component throw you out of
// it. Leaving costs the selection and switches files; it takes a click the
// canvas could actually place somewhere else.

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
  const out = path.join(buildDir, 'canvas-click.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'canvasClick.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { canvasClickAction } = await import(`file://${out}?v=${Date.now()}`);

  // Editing Button.astro, opened from the second instance on the page.
  const COMPONENT = 'src/components/Button.astro|';
  const inside = { focusPath: '0.3.1', scope: COMPONENT };
  const act = (path, where = inside) => canvasClickAction({ path, ...where }).kind;
  // The canvas narrows to the instance being edited, so a click on the page
  // around it arrives with no path AND this flag — that is what tells "looked
  // away" apart from "couldn't place it".
  const away = (path = null) => canvasClickAction({ path, outside: true, ...inside }).kind;

  // --- inside a component -------------------------------------------------------
  check(
    'a click on the component\'s own markup selects that node',
    act(`${COMPONENT}1.0.2`) === 'inner',
    act(`${COMPONENT}1.0.2`)
  );
  check('however deep it is', act(`${COMPONENT}1.0.2.0.1.0`) === 'inner');
  check('the component root included', act(`${COMPONENT}0`) === 'inner');

  // The bug: a click the canvas couldn't name is not a click somewhere else.
  check('a click it could not map changes nothing', act(null) === 'nothing', act(null));
  check('and certainly does not close', act(null) !== 'close');

  // A path in the PAGE's namespace, under the instance being edited: the
  // instance's own markup as the page sees it, or content passed into its slot.
  check('a page-side path inside the instance stays put', act('0.3.1.2') === 'nothing', act('0.3.1.2'));
  check('as does the instance itself', act('0.3.1') === 'nothing');

  // --- leaving ------------------------------------------------------------------
  //
  // With the instance narrowed, a click on the page around it maps to nothing in
  // scope — so the path is null and `outside` is what says it was a click on
  // SOMETHING. Both halves matter: without the flag this reads as "couldn't
  // place it" and there is no way to click away; without the null-is-nothing
  // rule every unmarked node inside the component throws you out.
  check('a click on the page around it leaves', away() === 'close', away());
  check('and one it simply could not place still does not', act(null) === 'nothing');

  //
  // A node the canvas DID place, somewhere else on the page — that is somebody
  // looking away from what they were editing.
  check('a click elsewhere on the page leaves', act('0.4') === 'close', act('0.4'));
  check('including another instance of the same component', act('0.3.2') === 'close');
  check('and a node above it', act('0') === 'close');

  // --- not in a component -------------------------------------------------------
  const page = { focusPath: null, scope: '' };
  check('on a page, a mapped path selects', act('0.1', page) === 'select', act('0.1', page));
  // Chrome the layout renders itself — header, footer, anything outside the
  // page's <slot> — carries no page-model marker, so it arrives with no path.
  check('and an unmapped click selects the layout that owns it', act(null, page) === 'layout', act(null, page));

  // --- the panel asks -----------------------------------------------------------
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  check('the canvas handler goes through it', /canvasClickAction\(\{/.test(app));
  check('and passes what the canvas said about the click', /outside: !!info\?\.outside/.test(app));

  // The canvas narrows to the opened instance whenever it has a region at all —
  // one `<Button/>` written three times gives each its own path, so the opened
  // one has a single run, and requiring two meant no narrowing: three outlines
  // at once, and a scroll-to that went to whichever came first in the document.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  check(
    'one run is enough to narrow to the instance',
    /if \(runs\.length\) focusCache = runs\[focusOcc\]/.test(preload),
    'focusRoots still requires more than one run'
  );
  check('and none still narrows to nothing', /if \(focusPath\) \{/.test(preload));
  check('the click carries whether it landed outside', /outside: !best && !!anyTag/.test(preload));
  check(
    'and closing is the only thing that closes',
    (app.match(/kind === 'close'/g) || []).length === 1 &&
      /if \(kind === 'nothing'\) return;/.test(app)
  );

  if (failures.length) {
    console.error(`\ncanvas-click: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`canvas-click: ${checked} passed  [what a click means]`);
})();
