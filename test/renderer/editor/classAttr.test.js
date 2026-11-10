// Putting a typed class on the element.
//
//   node test/renderer/editor/classAttr.test.js
//
// Typing `.hero` in the style panel writes a rule for `.hero` — and a rule for
// a class the element does not carry never applies, so the class has to land on
// the element as well. It didn't: the panel's `onAddClass` was wired to the
// assets panel, and the one element it would have reached wrote its classes as
// `class:list={[…]}`, which the model left alone without saying so.
//
// The second half is what is checked here, against the shapes real components
// use: a list, a list broken over lines, a template literal, a plain string,
// and a computed expression, whose source remains intact beside the new class:list.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');
const { repoPath } = require('../../helpers/sources.js');
const { readAppSource, readSourceFolder } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const expr = (value) => ({ type: 'expr', value });
const stringValue = (value) => ({ type: 'string', value });

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'class-attr.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/editor/classAttr.ts')],
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
  check('an element with classes keeps them', withClass({ class: stringValue('card is-wide') }, 'hero').value.value === 'card is-wide hero');
  check('a class it already has is not added twice', withClass({ class: stringValue('card') }, 'card') === undefined);
  check('and is reported as already there', hasClass({ class: stringValue('card') }, 'card'));

  // --- class:list -------------------------------------------------------------
  const oneLine = { 'class:list': expr('["card", isWide && "is-wide"]') };
  check(
    'a list on one line grows on that line',
    withClass(oneLine, 'hero').value.value === '["card", isWide && "is-wide", "hero"]',
    withClass(oneLine, 'hero').value.value,
  );
  check('and stays a list', withClass(oneLine, 'hero').key === 'class:list');
  check('a class already in the list is not added again', withClass(oneLine, 'card') === undefined);
  check('an empty list still takes one', withClass({ 'class:list': expr('[]') }, 'hero').value.value === '["hero"]');
  check(
    'a list that is not written as a list is wrapped in one',
    withClass({ 'class:list': expr('props.classes') }, 'hero').value.value === '[props.classes, "hero"]',
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
    grown.split('\n').find((line) => line.includes('"hero"')) === '        "hero",',
    JSON.stringify(grown.split('\n').find((line) => line.includes('"hero"'))),
  );
  check('with the list still closed', grown.trim().endsWith(']'), grown);
  check('and everything that was in it still in it', /"section"[\s\S]*className/.test(grown), grown);

  // --- class as an expression -------------------------------------------------
  check(
    'a template literal grows by one word',
    withClass({ class: expr('`card ${size}`') }, 'hero').value.value === '`card ${size} hero`',
    withClass({ class: expr('`card ${size}`') }, 'hero').value.value,
  );
  check('a word already in it is not repeated', withClass({ class: expr('`card ${size}`') }, 'card') === undefined);
  check('a hole is not read as a name', !hasClass({ class: expr('`card ${size}`') }, 'size'));
  check(
    'class:list keeps the computed expression and adds the name',
    withClass({ class: expr('cx(base, extra)') }, 'hero').key === 'class:list' &&
      withClass({ class: expr('cx(base, extra)') }, 'hero').value.value === '[(cx(base, extra)), "hero"]' &&
      withClass({ class: expr('cx(base, extra)') }, 'hero').remove === 'class',
  );
  check('a name with a space in it is refused', withClass({}, 'a b') === undefined);

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
  const section = model.nodes.find((node) => node.kind === 'element' && node.name === 'section');
  check('its classes are a list, not a string', !!section?.props?.['class:list'], JSON.stringify(section?.props));

  const edit = withClass(section.props, 'hero');
  section.props[edit.key] = edit.value;
  const written = serializePage(model, source);
  check('the file still has its frontmatter', written.startsWith('---\n'), written.slice(0, 40));
  check('the class landed in the list', /"hero"/.test(written), written);
  check('inside class:list, not beside it', /class:list=\{\[[\s\S]*"hero"[\s\S]*\]\}/.test(written) && !/\sclass="/.test(written), written);
  check(
    'the rest of the file is the rest of the file',
    written.includes('const { class: className } = Astro.props;') && written.includes('<slot />') && /"section"[\s\S]*className[\s\S]*"hero"/.test(written),
    written,
  );

  // Re-parsing what was written gives the class back — the round trip is what
  // the canvas re-renders from.
  const again = parsePage(written);
  const again0 = again.model.nodes.find((node) => node.kind === 'element' && node.name === 'section');
  check('and it reads back as a class the element has', hasClass(again0.props, 'hero'), JSON.stringify(again0.props));
  check('once', (written.match(/"hero"/g) || []).length === 1, written);

  // --- the panel is wired to it ----------------------------------------------
  // The app shell and the modules it was split into (src/app).
  const app = readAppSource();
  check(
    'the style panel is the one given onAddClass',
    /<StylePanel[\s\S]{0,2000}?onAddClass=/.test(app),
    'onAddClass is on some other panel, so typing a class reaches nothing',
  );
  check('the app adds classes through this rule, at the caret’s placement', /withClass\(node\.props, clean, placement\)/.test(app));
  // Error feedback is exercised through the mounted app in styleWrites.test.js.

  // Step 6 (plan §3.3): the class is a page edit, the rule a stylesheet edit
  // that depends on it — written only after the page edit applied, and never
  // submitted when it was refused.
  // The style editor and the modules it was split into (src/features/style/embed).
  const embed = readSourceFolder('src/features/style/EmbedEditor.tsx', 'src/features/style/embed');
  check(
    "the class answers with the page edit's outcome",
    /await flushSave\(\);\s*return \{ tag: 'applied' \};/.test(app),
    'the style panel cannot tell whether the class reached the page',
  );
  check('a typed class gates its rule', /classGatesRef\.current\.set\(trimmed, gate\)/.test(embed), 'the rule is written whatever became of the class');
  check(
    'and a refused class cancels the rule before it is written',
    /if \(outcome\.tag !== 'refused'\) \{\s*return true;\s*\}[\s\S]{0,300}?return false;/.test(embed) &&
      new RegExp('if \\(!\\(await passesClassGate\\(rule\\)\\)\\) \\{\\s*return false;\\s*\\}' + '[\\s\\S]{0,1600}?writeEmbedDocument\\(embedDocument\\)').test(
        embed,
      ),
    'the rule is still written after the page refused the class',
  );

  if (failures.length) {
    console.error(`\nclass-attr: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`class-attr: ${checked} passed`);
})();
