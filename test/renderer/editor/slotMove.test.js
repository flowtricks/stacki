// A `slot=` after the thing carrying it has moved.
//
//   node test/renderer/editor/slotMove.test.js
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
const { pathToFileURL } = require('url');
const { repoPath } = require('../../helpers/sources.js');
const { readAppSource } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'slot-attr.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/editor/slotAttr.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { keepsSlot } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);

  const wrapper = { kind: 'component', name: 'ContentWrapper' };
  const definition = { name: 'ContentWrapper', slots: ['default', 'column2'] };

  // --- where it still means something -------------------------------------------
  check('inside the component whose slot it names, it stays', keepsSlot({ slotName: 'column2', host: wrapper, definition }) === true);
  check(
    'and inside another component that has the same slot',
    keepsSlot({
      slotName: 'column2',
      host: { kind: 'component', name: 'Split' },
      definition: { slots: ['column2'] },
    }) === true,
  );

  // --- and where it does not -------------------------------------------------------
  check('dragged out into the open, it goes', keepsSlot({ slotName: 'column2', host: undefined, definition: undefined }) === false);
  check(
    'and into a component with no such slot',
    keepsSlot({
      slotName: 'column2',
      host: { kind: 'component', name: 'Card' },
      definition: { slots: ['default'] },
    }) === false,
  );
  check(
    'a component with no slots at all is no different',
    keepsSlot({
      slotName: 'column2',
      host: { kind: 'component', name: 'Img' },
      definition: { slots: [] },
    }) === false,
  );

  // --- and where it cannot be said -----------------------------------------------------
  //
  // Silence is not a denial. A component nobody scanned might well have that
  // slot, and throwing the attribute away on it would lose something the person
  // wrote for a reason they can no longer see.
  check(
    'a component this project never scanned keeps it',
    keepsSlot({
      slotName: 'column2',
      host: { kind: 'component', name: 'FromAPackage' },
      definition: undefined,
    }) === true,
  );
  check('and a node asking for nothing has nothing to lose', keepsSlot({ slotName: undefined, host: undefined, definition: undefined }) === true);
  check('nor does one asking in code, whose value this cannot read', keepsSlot({ slotName: '', host: undefined, definition: undefined }) === true);

  // --- the move asks -----------------------------------------------------------------
  // The app shell and the modules it was split into (src/app).
  const app = readAppSource();
  const move = app.slice(app.indexOf('const moveNode = useCallback'), app.indexOf('const removeNode = useCallback'));
  check('a move asks about the slot it carries', /keepsSlotAttribute\(\{ slotName, host, definition \}\)/.test(move), 'the slot is not reconsidered on a move');
  // Step 6: the move is a gesture (src/editor/editGestures.ts, moveGesture), which
  // asks the app's rule of the model after the move and removes the slot
  // first — as a request, and from the shown model.
  const gestureSource = fs.readFileSync(repoPath('src/editor/editGestures.ts'), 'utf8');
  check(
    'and drops it when the answer is no',
    /tag: 'remove-attribute', target, name: 'slot'/.test(gestureSource) && /patchedProps\(node\.props, \{ slot: undefined \}\)/.test(gestureSource),
    'nothing removes it',
  );
  check(
    'the host is the component it landed in, not the node above it',
    /slotHostOf\(model, id\)/.test(move) && /rules\.keepsSlot\(landing\.model, nodeId\)/.test(gestureSource),
    'a wrapper element would be read as the host',
  );

  if (failures.length) {
    console.error(`\nslot-move: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`slot-move: ${checked} passed  [a word addressed to a component]`);
})();
