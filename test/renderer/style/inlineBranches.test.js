// A `style={…}` expression edited branch by branch, from the CSS code editor and from
// the panel's controls, and an instance's style written to its component file.
//
//   node test/renderer/style/inlineBranches.test.js
//
// Goal: an edit replaces exactly one branch's literal and leaves every other byte of
// the expression (tests, spacing, quotes, the other branches) as written; `${…}`
// interpolations survive an edit untouched and are the editor's atomic tokens; a
// panel set on a branch is the declaration editor's own write inside that branch; an
// instance's edit is one write of the component file with one undo step; and a shape
// the conditional model cannot read stays read-only.
//
// Method: readStyleBranches and writeStyleBranch on the Heading's real expression and
// on reformatted variants; inlineStyleWrite composed with writeStyleBranch as the panel
// composes them (useInlineTarget.ts); interpolationRanges for the tokens; and
// writeComponentStyle against a stubbed main-process bridge and host, counting writes
// and undo steps and running the undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const writes = [];
globalThis.window = {
  avb: {
    writeStyleFile: async (payload) => {
      writes.push(payload);
      return { ok: true };
    },
  },
};

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'inline-branches.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { readStyleBranches, writeStyleBranch, interpolationRanges, displayStyleDeclarations, declarationsFromDisplay, STYLE_BLOCK_PREFIX, STYLE_BLOCK_SUFFIX } from './src/features/style/model/inlineBranches';",
      "export { inlineStyleWrite, inlineDeclaration, expressionStyle } from './src/features/style/model/inlineTarget';",
      "export { componentStyleText, writeComponentStyle } from './src/features/style/model/componentStyleWrite';",
      "export { componentSource, rememberComponentSource, forgetComponentSources } from './src/features/style/model/componentSourceCache';",
      "export { setHost, getHost } from './src/features/style/model/host';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);

const HEADING = 'maxWidth ? `--_mw: ${maxWidth}ch;` : render ? "color: red" : undefined';

function branches(expression) {
  const read = model.readStyleBranches(expression);
  assert.equal(read.tag, 'branches', expression);
  return read.branches;
}

test('editing a branch in the code editor replaces that literal only', () => {
  const [first, second, third] = branches(HEADING);
  const edited = model.writeStyleBranch(HEADING, first, '--_mw: ${maxWidth}ch; gap: 1rem;');
  assert.deepEqual(edited, { tag: 'written', expression: 'maxWidth ? `--_mw: ${maxWidth}ch; gap: 1rem;` : render ? "color: red" : undefined' });
  // The string branch keeps its quote; one that gains an interpolation becomes a template.
  assert.equal(model.writeStyleBranch(HEADING, second, 'color: blue').expression, 'maxWidth ? `--_mw: ${maxWidth}ch;` : render ? "color: blue" : undefined');
  assert.equal(
    model.writeStyleBranch(HEADING, second, 'color: ${tone}').expression,
    'maxWidth ? `--_mw: ${maxWidth}ch;` : render ? `color: ${tone}` : undefined',
  );
  // No value gains declarations, and emptying a branch gives no value.
  assert.equal(
    model.writeStyleBranch(HEADING, third, 'opacity: 0.5').expression,
    'maxWidth ? `--_mw: ${maxWidth}ch;` : render ? "color: red" : "opacity: 0.5"',
  );
  assert.equal(model.writeStyleBranch(HEADING, second, '  ').expression, 'maxWidth ? `--_mw: ${maxWidth}ch;` : render ? undefined : undefined');
  // Formatting outside the branch is the file's own and survives byte for byte.
  const prettier = "(maxWidth)\n  ? `--_mw: ${maxWidth}ch;`\n  : ( render ) ? 'color: red'\n  : null";
  const [, quoted] = branches(prettier);
  assert.equal(
    model.writeStyleBranch(prettier, quoted, 'color: blue').expression,
    "(maxWidth)\n  ? `--_mw: ${maxWidth}ch;`\n  : ( render ) ? 'color: blue'\n  : null",
  );
  // A value with a backtick cannot be written into a template.
  assert.equal(model.writeStyleBranch(HEADING, first, 'content: `x`').tag, 'refused');
});

test('a panel set on a branch is the declaration editor’s write inside it', () => {
  const [first] = branches(HEADING);
  const body = model.inlineStyleWrite(first.body, ['padding'], model.inlineDeclaration('1rem', { important: false }));
  assert.deepEqual(body, { tag: 'write', next: '--_mw: ${maxWidth}ch; padding: 1rem;' });
  const written = model.writeStyleBranch(HEADING, first, body.next);
  assert.equal(written.expression, 'maxWidth ? `--_mw: ${maxWidth}ch; padding: 1rem;` : render ? "color: red" : undefined');
  // Clearing the branch's last declaration leaves it no value; the others stand.
  const cleared = model.inlineStyleWrite(first.body, ['--_mw'], { tag: 'remove' });
  assert.equal(cleared.next, undefined);
  assert.equal(model.writeStyleBranch(HEADING, first, cleared.next ?? '').expression, 'maxWidth ? undefined : render ? "color: red" : undefined');
});

test('interpolations are atomic tokens and survive an edit unchanged', () => {
  const body = '--_mw: ${maxWidth}ch; gap: ${ gap.size };';
  assert.deepEqual(model.interpolationRanges(body), [
    { from: 7, to: 18 },
    { from: 27, to: 40 },
  ]);
  const [first] = branches(HEADING);
  const set = model.inlineStyleWrite(first.body, ['color'], model.inlineDeclaration('red', { important: false }));
  assert.ok(set.next.includes('${maxWidth}'), 'the interpolation is kept');
  const [rewritten] = branches(model.writeStyleBranch(HEADING, first, set.next).expression);
  assert.deepEqual(model.interpolationRanges(rewritten.body), [{ from: 7, to: 18 }]);
});

test('an instance’s edit is one write of its component file and one undo step', async () => {
  const path = '/p/src/components/Heading.astro';
  const before = `---\nconst { maxWidth } = Astro.props;\n---\n<Tag style={${HEADING}} />\n`;
  const start = before.indexOf(HEADING);
  const [first] = branches(HEADING);
  const next = model.writeStyleBranch(HEADING, first, '--_mw: ${maxWidth}rem;').expression;
  const after = model.componentStyleText({ text: before, start, end: start + HEADING.length }, next);
  assert.equal(after, before.replace('${maxWidth}ch;', '${maxWidth}rem;'));
  const undo = [];
  model.setHost({ ...model.getHost(), recordUndo: (command) => undo.push(command) });
  writes.length = 0;
  await model.writeComponentStyle(path, 'Heading.astro', { before, after });
  assert.deepEqual(writes, [{ filePath: path, css: after }]);
  assert.equal(undo.length, 1, 'one undo step');
  assert.equal(model.componentSource(path), after, 'the next edit builds on the new text');
  await undo[0].undo();
  assert.deepEqual(writes[1], { filePath: path, css: before });
  assert.equal(model.componentSource(path), before);
  // Nothing changed, nothing written.
  await model.writeComponentStyle(path, 'Heading.astro', { before, after: before });
  assert.equal(writes.length, 2);
});

test('a shape the conditional model cannot read stays read-only, with a reason', () => {
  for (const expression of ['styles', 'theme?.style ?? "color: red"', 'a ? `x: 1` : b', 'cond ? "a: \\"b\\"" : undefined', 'fn(`x: 1`)']) {
    const read = model.readStyleBranches(expression);
    assert.equal(read.tag, 'unsupported', expression);
    assert.ok(read.reason.length > 0);
    const style = model.expressionStyle(expression, { kind: 'node' });
    assert.equal(style.kind, 'code', expression);
    assert.ok(style.code.startsWith('element.style {'));
  }
});

test('the editor shows one declaration per indented line and writes back in the attribute’s own formatting', () => {
  const plain = 'min-height: calc(100svh - var(--nav-height));';
  assert.equal(
    model.STYLE_BLOCK_PREFIX + model.displayStyleDeclarations(plain) + model.STYLE_BLOCK_SUFFIX,
    'element.style {\n  min-height: calc(100svh - var(--nav-height));\n}',
  );
  // Parentheses, strings and `${…}` hold their own `;`.
  const tricky = 'background: url("a;b.png");--x: ${a ? "1;2" : "3"}; content: ";"';
  assert.equal(model.displayStyleDeclarations(tricky), '  background: url("a;b.png");\n  --x: ${a ? "1;2" : "3"};\n  content: ";";');
  // Unedited, the text is byte for byte what it was, however it was spaced.
  for (const body of [plain, tricky, 'color:red ;  margin: 0', ' gap: 1rem; ', '']) {
    assert.equal(model.declarationsFromDisplay(model.displayStyleDeclarations(body), body), body, JSON.stringify(body));
  }
  // An edit changes that declaration only; the others keep their separators.
  const spaced = 'color:red ;  margin: 0';
  assert.equal(model.declarationsFromDisplay('  color: blue;\n  margin: 0;', spaced), 'color: blue ;  margin: 0');
  assert.equal(model.declarationsFromDisplay('  color:red;\n  margin: 0;\n  gap: 1rem;', spaced), 'color:red ;  margin: 0; gap: 1rem');
  assert.equal(model.declarationsFromDisplay('  min-height: 50vh;\n  gap: 1rem;', plain), 'min-height: 50vh; gap: 1rem;');
  assert.equal(model.declarationsFromDisplay('  color: red;', ''), 'color: red;');
  assert.equal(model.declarationsFromDisplay('', plain), '');
  // A branch with an interpolation keeps it through the round trip.
  const [first] = branches(HEADING);
  assert.equal(model.declarationsFromDisplay(model.displayStyleDeclarations(first.body), first.body), first.body);
  assert.equal(model.declarationsFromDisplay('  --_mw: ${maxWidth}ch;\n  gap: 1rem;', first.body), '--_mw: ${maxWidth}ch; gap: 1rem;');
});
