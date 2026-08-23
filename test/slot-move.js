// A `slot=` after the thing carrying it has moved.
//
//   node test/slot-move.js
//
// `slot="column2"` is not a property of the element. It is a word addressed to
// the component the element sits inside — "put me in the slot you call
// column2" — and nobody else is listening. Drag that element out into a plain
// <div> and Astro renders it wherever it now is; the attribute stays in the
// markup saying something that is no longer true, and the next person to read
// it has to work out that it means nothing.
//
// So the question on a move is not "did the parent change" but "is there still
// something here that this word means anything to".

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
  const out = path.join(buildDir, 'slot-attr.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'slotAttr.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { keepsSlot } = await import(`file://${out}?v=${Date.now()}`);

  const wrapper = { kind: 'component', name: 'ContentWrapper' };
  const definition = { name: 'ContentWrapper', slots: ['default', 'column2'] };

  // --- where it still means something -------------------------------------------
  check(
    'inside the component whose slot it names, it stays',
    keepsSlot({ slotName: 'column2', host: wrapper, definition }) === true
  );
  check(
    'and inside another component that has the same slot',
    keepsSlot({ slotName: 'column2', host: { kind: 'component', name: 'Split' }, definition: { slots: ['column2'] } }) === true
  );

  // --- and where it does not -------------------------------------------------------
  check(
    'dragged out into the open, it goes',
    keepsSlot({ slotName: 'column2', host: null, definition: null }) === false
  );
  check(
    'and into a component with no such slot',
    keepsSlot({ slotName: 'column2', host: { kind: 'component', name: 'Card' }, definition: { slots: ['default'] } }) === false
  );
  check(
    'a component with no slots at all is no different',
    keepsSlot({ slotName: 'column2', host: { kind: 'component', name: 'Img' }, definition: { slots: [] } }) === false
  );

  // --- and where it cannot be said -----------------------------------------------------
  //
  // Silence is not a denial. A component nobody scanned might well have that
  // slot, and throwing the attribute away on it would lose something the person
  // wrote for a reason they can no longer see.
  check(
    'a component this project never scanned keeps it',
    keepsSlot({ slotName: 'column2', host: { kind: 'component', name: 'FromAPackage' }, definition: null }) === true
  );
  check(
    'and a node asking for nothing has nothing to lose',
    keepsSlot({ slotName: null, host: null, definition: null }) === true
  );
  check(
    'nor does one asking in code, whose value this cannot read',
    keepsSlot({ slotName: '', host: null, definition: null }) === true
  );

  // --- the move asks -----------------------------------------------------------------
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  const move = app.slice(app.indexOf('const moveNode = useCallback'), app.indexOf('const removeNode = useCallback'));
  check('a move asks about the slot it carries', /keepsSlot\(\{ slotName, host, definition \}\)/.test(move), 'the slot is not reconsidered on a move');
  check('and drops it when the answer is no', /delete node\.props\.slot/.test(move), 'nothing removes it');
  check(
    'the host is the component it landed in, not the node above it',
    /slotHostOf\(model, nodeId\)/.test(move),
    'a wrapper element would be read as the host'
  );

  if (failures.length) {
    console.error(`\nslot-move: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`slot-move: ${checked} passed  [a word addressed to a component]`);
})();
