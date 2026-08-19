// Putting a typed class on the element.
//
//   node test/class-attr.js
//
// Typing `.hero` in the style panel writes a rule for `.hero` — and a rule for
// a class the element does not carry never applies, so the class has to land on
// the element as well. It didn't: the panel's `onAddClass` was wired to the
// assets panel, and the one element it would have reached wrote its classes as
// `class:list={[…]}`, which the model left alone without saying so.
//
// The second half is what is checked here, against the shapes real components
// use: a list, a list broken over lines, a template literal, a plain string,
// and an expression that means something only the code knows — that one is
// refused out loud rather than guessed at.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePage, serializePage } = require('../electron/astroParser.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const expr = (value) => ({ type: 'expr', value });
const str = (value) => ({ type: 'string', value });

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'class-attr.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'classAttr.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { withClass, hasClass } = require(bundlePath);

  // --- a plain class ----------------------------------------------------------
  check('an element with no classes gets one', withClass({}, 'hero').value.value === 'hero');
  check('under the plain attribute', withClass({}, 'hero').key === 'class');
  check(
    'an element with classes keeps them',
    withClass({ class: str('card is-wide') }, 'hero').value.value === 'card is-wide hero'
  );
  check('a class it already has is not added twice', withClass({ class: str('card') }, 'card') === null);
  check('and is reported as already there', hasClass({ class: str('card') }, 'card'));

  // --- class:list -------------------------------------------------------------
  const oneLine = { 'class:list': expr('["card", isWide && "is-wide"]') };
  check(
    'a list on one line grows on that line',
    withClass(oneLine, 'hero').value.value === '["card", isWide && "is-wide", "hero"]',
    withClass(oneLine, 'hero').value.value
  );
  check('and stays a list', withClass(oneLine, 'hero').key === 'class:list');
  check(
    'a class already in the list is not added again',
    withClass(oneLine, 'card') === null
  );
  check('an empty list still takes one', withClass({ 'class:list': expr('[]') }, 'hero').value.value === '["hero"]');
  check(
    'a list that is not written as a list is wrapped in one',
    withClass({ 'class:list': expr('props.classes') }, 'hero').value.value === '[props.classes, "hero"]'
  );

  // The shape Lumos writes: one entry per line, trailing comma.
  const multi = {
    'class:list': expr(`[
        "section",
        padClass("top", paddingTop),
        className,
      ]`),
  };
  const grown = withClass(multi, 'hero').value.value;
  check('a list broken over lines gets its own line', /\n\s+"hero",\n/.test(grown), grown);
  check(
    'indented like the entries above it',
    grown.split('\n').find((l) => l.includes('"hero"')) === '        "hero",',
    JSON.stringify(grown.split('\n').find((l) => l.includes('"hero"')))
  );
  check('with the list still closed', grown.trim().endsWith(']'), grown);
  check('and everything that was in it still in it', /"section"[\s\S]*className/.test(grown), grown);

  // --- class as an expression -------------------------------------------------
  check(
    'a template literal grows by one word',
    withClass({ class: expr('`card ${size}`') }, 'hero').value.value === '`card ${size} hero`',
    withClass({ class: expr('`card ${size}`') }, 'hero').value.value
  );
  check(
    'a word already in it is not repeated',
    withClass({ class: expr('`card ${size}`') }, 'card') === null
  );
  check(
    'a hole is not read as a name',
    !hasClass({ class: expr('`card ${size}`') }, 'size')
  );
  check(
    'an expression nobody can read is refused',
    withClass({ class: expr('cx(base, extra)') }, 'hero') === null
  );
  check('a name with a space in it is refused', withClass({}, 'a b') === null);

  // --- the real thing ---------------------------------------------------------
  // Parse a component the way the app does, add the class, write it back: the
  // file has to come out as a file, with one line more than it went in.
  const source = `---
interface Props { class?: string }
const { class: className } = Astro.props;
---

<section
  class:list={[
    "section",
    className,
  ]}
>
  <slot />
</section>
`;
  const { editable, model } = parsePage(source);
  check('the component parses', editable && !!model);
  const section = model.nodes.find((n) => n.kind === 'element' && n.name === 'section');
  check('its classes are a list, not a string', !!section?.props?.['class:list'], JSON.stringify(section?.props));

  const edit = withClass(section.props, 'hero');
  section.props[edit.key] = edit.value;
  const written = serializePage(model, source);
  check('the file still has its frontmatter', written.startsWith('---\n'), written.slice(0, 40));
  check('the class landed in the list', /"hero"/.test(written), written);
  check(
    'inside class:list, not beside it',
    /class:list=\{\[[\s\S]*"hero"[\s\S]*\]\}/.test(written) && !/\sclass="/.test(written),
    written
  );
  check(
    'the rest of the file is the rest of the file',
    written.includes('const { class: className } = Astro.props;') &&
      written.includes('<slot />') &&
      /"section"[\s\S]*className[\s\S]*"hero"/.test(written),
    written
  );

  // Re-parsing what was written gives the class back — the round trip is what
  // the canvas re-renders from.
  const again = parsePage(written);
  const again0 = again.model.nodes.find((n) => n.kind === 'element' && n.name === 'section');
  check('and it reads back as a class the element has', hasClass(again0.props, 'hero'), JSON.stringify(again0.props));
  check('once', (written.match(/"hero"/g) || []).length === 1, written);

  // --- the panel is wired to it ----------------------------------------------
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  check(
    'the style panel is the one given onAddClass',
    /<StylePanel[\s\S]{0,2000}?onAddClass=/.test(app),
    'onAddClass is on some other panel, so typing a class reaches nothing'
  );
  check('the app adds classes through this rule', /withClass\(node\.props, clean\)/.test(app));
  check(
    'and says so when it cannot',
    /refused[\s\S]{0,200}showToast/.test(app),
    'an element whose class is code fails silently again'
  );

  if (failures.length) {
    console.error(`\nclass-attr: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`class-attr: ${checked} passed`);
})();
