// A conditional whose other side is a value.
//
//   node test/cond-branches.js
//
// Wrapping something in a link when there's somewhere to go is written the same
// way everywhere:
//
//   {href ? (
//     <a class="link-card_link" href={href}>{heading}</a>
//   ) : (
//     heading
//   )}
//
// The navigator drew that as one row of code. It reads conditionals whose
// branches are markup, and here one branch is a bare name — so the whole thing
// went back to being an expression, and neither the anchor inside it nor the
// fallback beside it could be selected, styled or moved. In Lumos's LinkCard
// that is the heading, twice.
//
// A value branch is now an expression child. Which raises the question this
// file mostly answers: the same node is written into two different places, and
// they disagree about what a brace means.
//
//   the file    a branch's parens are JS. `heading` goes in as itself —
//               `{heading}` in there is a block, and `{ a: 1 }` an object.
//   the canvas  a branch is wrapped in a <Fragment>, which is JSX. There the
//               same value has to be `{heading}` or it renders as the word.
//
// So the node carries braces, like every other expression node, and the file
// writer takes them off. Both forms are checked here, and the canvas form is
// put through the real Astro compilers.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { parsePage, serializePage, serializePageMarked } = require('../electron/astroParser.js');

const page = (body) => `---\n---\n<div>\n${body}\n</div>\n`;
const first = (src) => parsePage(src).model.nodes[0].children.find((n) => n.kind !== 'text');
// What the tree looks like, flattened: `cond(then:a, else:expr)`.
const shape = (node) => {
  if (!node) return 'nothing';
  if (node.kind === 'cond') {
    return `cond(${(node.children || []).map((b) => `${b.name}:${(b.children || []).map(shape).join('+') || 'empty'}`).join(', ')})`;
  }
  if (node.kind === 'element' || node.kind === 'component') return node.name;
  return node.kind;
};

(async () => {
  // ── What the tree makes of it ─────────────────────────────────────────────
  const LINK = page(
    '  {href ? (\n    <a class="link-card_link" href={href}>{heading}</a>\n  ) : (\n    heading\n  )}'
  );
  const cond = first(LINK);
  check('the conditional is a conditional', shape(cond) === 'cond(then:a, else:expr)', shape(cond));
  check('it keeps its test', cond?.test === 'href', cond?.test);
  check(
    'and the value branch holds the value, in braces',
    cond?.children?.[1]?.children?.[0]?.value === '{heading}',
    JSON.stringify(cond?.children?.[1]?.children?.[0])
  );

  // The other way round, and both ways at once.
  check(
    'a value on the THEN side works the same',
    shape(first(page('  {href ? (heading) : (<a href={href}>x</a>)}'))) === 'cond(then:expr, else:a)',
    shape(first(page('  {href ? (heading) : (<a href={href}>x</a>)}')))
  );
  check(
    'markup on both sides is unchanged',
    shape(first(page('  {href ? (<a/>) : (<b/>)}'))) === 'cond(then:a, else:b)',
    shape(first(page('  {href ? (<a/>) : (<b/>)}')))
  );
  check(
    'and so is a branch that renders nothing',
    shape(first(page('  {href ? (<a/>) : null}'))) === 'cond(then:a, else:empty)',
    shape(first(page('  {href ? (<a/>) : null}')))
  );

  // A conditional between two VALUES is a value, not markup. Drawing it as a
  // branch of the tree would say you could put an element in it.
  check(
    'two values is still code',
    shape(first(page('  {big ? "large" : "small"}'))) === 'expr',
    shape(first(page('  {big ? "large" : "small"}')))
  );
  check(
    'and so is a value guarded by &&',
    shape(first(page('  {isOpen && label}'))) === 'expr',
    shape(first(page('  {isOpen && label}')))
  );
  check(
    'while markup guarded by && is a conditional, as before',
    shape(first(page('  {isOpen && (<a/>)}'))) === 'cond(then:a)',
    shape(first(page('  {isOpen && (<a/>)}')))
  );
  // Markup that doesn't parse must not be swallowed as a value: that would hide
  // a real bail behind a node that looks fine.
  check(
    'broken markup is not read as a value',
    shape(first(page('  {href ? (<a href=>) : (heading)}'))) === 'expr',
    shape(first(page('  {href ? (<a href=>) : (heading)}')))
  );

  // ── What gets written back ────────────────────────────────────────────────
  check('an untouched file is written exactly as it was', serializePage(parsePage(LINK).model) === LINK);

  // Edited, the writer has to produce it from the tree — and a branch's parens
  // are JS, so the braces come off.
  const edited = parsePage(LINK);
  const node = edited.model.nodes[0].children.find((n) => n.kind === 'cond');
  check('there is a conditional to edit', !!node, 'it never became one');
  if (node) delete node.source; // what an edit does
  const written = serializePage(edited.model);
  check('the value goes back in as itself', /\) : \(\n\s+heading\n\s+\)/.test(written), written);
  check('not wrapped in braces, which there would be a block', !/\{heading\}\s*\n\s*\)/.test(written), written);
  check('and what comes back is the same tree', shape(first(written)) === 'cond(then:a, else:expr)', shape(first(written)));

  // ── What the canvas is given ──────────────────────────────────────────────
  // Every branch is wrapped in a <Fragment> there, which is JSX: the value
  // needs its braces back, or it renders as the word "heading".
  const marked = serializePageMarked(parsePage(LINK).model);
  check('the canvas form keeps the braces', /<Fragment>[\s\S]*\{heading\}[\s\S]*<\/Fragment>/.test(marked), marked);
  check(
    'and both branches are marked, so both can be selected',
    /avb-s:0\.0\.0/.test(marked) && /avb-s:0\.0\.1/.test(marked),
    marked
  );

  // The compilers are the only thing that can say the emitted JSX is real.
  for (const [label, mod] of [
    ['@astrojs/compiler-rs (Astro 7+)', '@astrojs/compiler-rs'],
    ['@astrojs/compiler (Astro ≤6)', '@astrojs/compiler'],
  ]) {
    let error = null;
    try {
      const { transform } = require(mod);
      await transform(marked, { filename: 'LinkCard.astro' });
    } catch (err) {
      error = String(err?.message || err);
    }
    check(`the canvas form compiles — ${label}`, error === null, error);
  }

  if (failures.length) {
    console.error(`\ncond-branches: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`cond-branches: ${checked} passed  [tree, file, canvas]`);
})();
