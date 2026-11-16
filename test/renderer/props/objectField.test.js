// A prop whose value is an object, edited as the fields it holds.
//
//   node test/renderer/props/objectField.test.js
//
// `tags={{ legend: "Ministry Role", options: ["Pastors", "Staff"] }}` is not a
// program. It is a form somebody filled in: a line of text and a list. Shown as
// code it is a box of JSON to retype by hand, with the quoting and the commas
// left to the person — the one part of it a computer should be doing.
//
// So each key gets the control its value asks for, and a list inside one keeps
// the rows it has everywhere else. What the field cannot show honestly — an
// object inside an object, a call, a name standing for something elsewhere — it
// does not touch: those keep the code editor (see test/renderer/props/arrayValue.test.js for the
// same rule about lists).

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { repoPath } = require('../../helpers/sources.js');

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

  // --- what the reader accepts ------------------------------------------------
  const modOut = path.join(buildDirectory, 'object-value.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/props/arrayValue.ts')],
    outfile: modOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { objectFields, objectText } = await import(`${pathToFileURL(modOut).href}?v=${Date.now()}`);

  const TAGS = '{ legend: "Ministry Role", options: ["Pastors", "Staff", "Prayer"] }';
  {
    const fields = objectFields(TAGS);
    check('an object of plain values reads as fields', !!fields, 'refused');
    check(
      'one per key, in the order they were written',
      fields?.map((field) => field.key).join() === 'legend,options',
      fields?.map((field) => field.key).join(),
    );
    check('a word is a word', fields?.[0].kind === 'text' && fields[0].text === 'Ministry Role', JSON.stringify(fields?.[0]));
    check('and a list is a list', fields?.[1].kind === 'list' && fields[1].items.length === 3, JSON.stringify(fields?.[1]));
    check('written back as it was', objectText(fields) === TAGS, objectText(fields));
  }
  {
    const fields = objectFields('{ shown: true, count: 3 }');
    check('a yes-or-no is one', fields?.[0].kind === 'boolean', JSON.stringify(fields?.[0]));
    check('and a number is a number', fields?.[1].kind === 'number', JSON.stringify(fields?.[1]));
    check('both written back unquoted', objectText(fields) === '{ shown: true, count: 3 }', objectText(fields));
  }
  {
    // The file's own quotes are kept: a project that writes single ones should
    // not find double ones the first time a field is touched.
    const single = "{ legend: 'Ministry Role' }";
    check('the quote the file used is the quote it keeps', objectText(objectFields(single)) === single, objectText(objectFields(single)));
  }
  for (const refused of ['{ nested: { a: 1 } }', '{ options: [...defaults] }', '{ from: getTags() }', '{ legend }', '{ [key]: 1 }', 'tags', '[1, 2]']) {
    check(`what a field cannot show is refused — ${refused}`, objectFields(refused) === undefined, JSON.stringify(objectFields(refused)));
  }

  // --- and what the control does with them --------------------------------------
  const entry = path.join(buildDirectory, 'object-field.entry.jsx');
  fs.writeFileSync(entry, `export { default as ObjectField } from ${JSON.stringify(repoPath('src/features/props/ObjectField.tsx'))};\n`);
  const bundle = path.join(buildDirectory, 'object-field.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
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
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { ObjectField } = require(bundle);

  const host = document.createElement('div');
  document.getElementById('root').appendChild(host);
  const root = createRoot(host);
  const wrote = [];
  const immediate = [];
  // Controlled, like the panel does it: what was written comes back as the
  // value, so a second edit builds on the first.
  let current = TAGS;
  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(ObjectField, {
          value: current,
          onChange: (text, now) => {
            wrote.push(text);
            immediate.push(now);
            current = text;
          },
        }),
      );
    });
  };
  await render();

  const keys = () => [...host.querySelectorAll('.object-field-key')].map((keyElement) => keyElement.textContent);
  const inputs = () => [...host.querySelectorAll('.object-field-input')];
  const rows = () => [...host.querySelectorAll('.list-field-row')];

  check('every key is a row', keys().join() === 'legend,options', keys().join());
  check(
    'the word is in a box',
    inputs().length === 1 && inputs()[0].value === 'Ministry Role',
    inputs()
      .map((i) => i.value)
      .join(),
  );
  check('and the list is rows, not text', rows().length === 3, `${rows().length} rows`);
  check(
    'each row saying what its item says',
    [...host.querySelectorAll('.list-field-text')].map((button) => button.textContent).join() === 'Pastors,Staff,Prayer',
    [...host.querySelectorAll('.list-field-text')].map((button) => button.textContent).join(),
  );

  // Typing in a field writes the whole object back — that is what the file
  // holds — and says it is not the edit yet.
  await act(async () => {
    const input = inputs()[0];
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Ministry Area');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await render();
  check('typing writes the object back', /Ministry Area/.test(wrote[wrote.length - 1] || ''), wrote[wrote.length - 1]);
  check('with the list beside it untouched', /\["Pastors", "Staff", "Prayer"\]/.test(wrote[wrote.length - 1] || ''), wrote[wrote.length - 1]);
  check('and says it is still being typed', immediate[immediate.length - 1] === false, String(immediate[immediate.length - 1]));

  // Dropping an item from the list inside writes the object back too.
  const bin = host.querySelectorAll('.list-field-remove')[1];
  // A missing control is a FAILURE to report, not a stack trace: every check
  // after it would otherwise be lost.
  check('the list inside has a bin on each row', !!bin, `${host.querySelectorAll('.list-field-remove').length} bins`);
  if (bin) {
    await act(async () => {
      bin.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await render();
  }
  check('removing an item from the list inside says so', /\["Pastors", "Prayer"\]/.test(wrote[wrote.length - 1] || ''), wrote[wrote.length - 1]);
  check('and that one IS the edit', immediate[immediate.length - 1] === true, String(immediate[immediate.length - 1]));
  check('the field beside it survives the change', /Ministry Area/.test(wrote[wrote.length - 1] || ''), wrote[wrote.length - 1]);

  // --- the panel reaches for it --------------------------------------------------
  const panel = fs.readFileSync(repoPath('src/features/props/PropField.tsx'), 'utf8');
  check(
    'a code prop holding an object gets the fields',
    /type === 'code' && !showExpr && valueText && objectFields\(valueText\)/.test(panel),
    'an object prop still shows as raw code',
  );
  check('and `{}` still leads back to the code editor', /!showExpr/.test(panel), 'there would be no way back to the text');

  if (failures.length) {
    console.error(`\nobject-field: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`object-field: ${checked} passed  [an object, as the fields it holds]`);
  process.exit(0);
})();
