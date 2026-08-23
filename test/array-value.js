// An array a list can edit, and one it cannot.
//
//   node test/array-value.js
//
// A prop that takes a list of words is edited as a list of rows. That only
// works while every item is a value a row can SHOW — a word or a number.
// `[...defaults, other]`, `[{ value, label }]`, a name standing for a list
// somewhere else: those are programs, and a row that pretended otherwise would
// lose what it could not draw. So the reader answers with items or with null,
// and null is the field's cue to stay in the code editor.
//
// The writer's job is smaller and just as easy to get wrong: put back what the
// file had. A project that writes single quotes should not find double ones the
// first time somebody drags a row.

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
  const out = path.join(buildDir, 'array-value.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'arrayValue.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { arrayItems, arrayText, moveItem } = await import(`file://${out}?v=${Date.now()}`);

  const texts = (src) => (arrayItems(src) || []).map((i) => i.text);

  // --- what a list can show ------------------------------------------------------
  check('a list of words', texts('["Designer", "Developer"]').join() === 'Designer,Developer');
  check('written with single quotes', texts("['a', 'b']").join() === 'a,b');
  check('numbers', texts('[1, 2.5, -3]').join() === '1,2.5,-3');
  check('one item', texts('["only"]').join() === 'only');
  check(
    'an empty list is a list, not a refusal',
    Array.isArray(arrayItems('[]')) && arrayItems('[]').length === 0,
    JSON.stringify(arrayItems('[]'))
  );
  check('laid out across lines', texts('[\n  "a",\n  "b",\n]').join() === 'a,b');
  check('with a trailing comma', texts('["a", "b",]').join() === 'a,b');
  check('a comma inside an item is part of it', texts('["Smith, Jane", "b"]').join() === 'Smith, Jane,b');
  check('and an escaped quote', texts('["say \\"hi\\"", "b"]').join() === 'say "hi",b');
  check('a backtick with nothing in it is a word', texts('[`a`, `b`]').join() === 'a,b');

  // --- and what it cannot ----------------------------------------------------------
  const refuses = (src, why) => check(`refuses ${why}`, arrayItems(src) === null, JSON.stringify(arrayItems(src)));
  refuses('jobs', 'a name standing for a list');
  refuses('[...defaults, "other"]', 'a spread');
  refuses('[{ value: "a", label: "A" }]', 'an object per item');
  refuses('["a", other]', 'an item that is a name');
  refuses('[items.map((i) => i.name)]', 'a call');
  refuses('[`${prefix} one`]', 'a template with a hole in it');
  refuses('[["a"], ["b"]]', 'a list of lists');
  refuses('["a", , "b"]', 'a hole');
  refuses('["a"', 'an unclosed array');
  refuses('', 'nothing at all');
  refuses('"a"', 'a value that is not an array');

  // --- putting it back ---------------------------------------------------------------
  check('a list comes back as it went in', arrayText(arrayItems('["a", "b"]')) === '["a", "b"]');
  check(
    'in the quote the file used',
    arrayText(arrayItems("['a', 'b']")) === "['a', 'b']",
    arrayText(arrayItems("['a', 'b']"))
  );
  check('numbers stay numbers', arrayText(arrayItems('[1, 2]')) === '[1, 2]', arrayText(arrayItems('[1, 2]')));
  check('an empty list writes as one', arrayText([]) === '[]', arrayText([]));
  check(
    'a quote inside an item is escaped',
    arrayText([{ text: 'say "hi"', quote: '"' }]) === '["say \\"hi\\""]',
    arrayText([{ text: 'say "hi"', quote: '"' }])
  );
  check(
    'and what comes back reads the same again',
    texts(arrayText([{ text: 'say "hi"', quote: '"' }])).join() === 'say "hi"',
    texts(arrayText([{ text: 'say "hi"', quote: '"' }])).join()
  );
  check(
    'a new item takes the list’s own quote',
    arrayText([...arrayItems("['a']"), { text: 'b', quote: "'" }]) === "['a', 'b']",
    arrayText([...arrayItems("['a']"), { text: 'b', quote: "'" }])
  );

  // --- moving one -----------------------------------------------------------------
  //
  // The target is a GAP between rows, which is what a drop lands in: dropping
  // the first row into the gap after the second means "after b", so the answer
  // is [b, a, c] and not [b, c, a].
  const abc = arrayItems('["a", "b", "c"]');
  const order = (from, to) => moveItem(abc, from, to).map((i) => i.text).join();
  check('to the end', order(0, 3) === 'b,c,a', order(0, 3));
  check('to the middle', order(0, 2) === 'b,a,c', order(0, 2));
  check('backwards', order(2, 0) === 'c,a,b', order(2, 0));
  check('into the gap it already fills changes nothing', order(1, 1) === 'a,b,c', order(1, 1));
  check('and neither does the gap just after it', order(1, 2) === 'a,b,c', order(1, 2));
  check('a row that is not there changes nothing', order(9, 0) === 'a,b,c', order(9, 0));
  check('a gap past the end is the end', order(0, 99) === 'b,c,a', order(0, 99));
  check('the list it was given is not touched', abc.map((i) => i.text).join() === 'a,b,c');

  if (failures.length) {
    console.error(`\narray-value: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`array-value: ${checked} passed  [a list, and what is not one]`);
})();
