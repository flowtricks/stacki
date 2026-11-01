// Selection → source location.
//
// .stacki/selection.json (and ⇧⌘C) hand an AI agent a `file:line-range` for
// whatever the canvas has selected. A wrong range is worse than none: the agent
// edits confidently, in the wrong place. So rather than hand-written line
// numbers, this checks invariants that must hold for EVERY node of every
// corpus fixture:
//
//   1. every node path resolves to a range
//   2. the range is inside the file, and start <= end
//   3. a child's range sits inside its parent's
//   4. the tag is really at the line we point at
//
// Together those pin the range to the right markup: (4) proves the start line
// is the node's own opening tag, (3) proves the end line didn't run past it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parsePage, locateSelection } = require('#dist/electron/parse/astroParser.js');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { repoPath } = require('../../helpers/sources.js');

const CORPUS_DIRECTORY = repoPath('test/corpus');

const fixtures = fs
  .readdirSync(CORPUS_DIRECTORY)
  .filter((file) => file.endsWith('.astro'))
  .sort()
  .map((name) => ({ name, file: path.join(CORPUS_DIRECTORY, name) }))
  .filter(({ file }) => parsePage(fs.readFileSync(file, 'utf8')).editable);

// Every node in the tree, as {path, node} pairs keyed the way the canvas is.
function everyNode(nodes, prefix = '', depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'everyNode: depth limit');
  const out = [];
  nodes.forEach((node, i) => {
    const key = prefix ? `${prefix}.${i}` : String(i);
    out.push({ key, node });
    if (Array.isArray(node.children)) {
      out.push(...everyNode(node.children, key, depth + 1));
    }
  });
  return out;
}

describe('locateSelection', () => {
  for (const { name, file } of fixtures) {
    test(name, () => {
      const source = fs.readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const model = parsePage(source).model;
      const ranges = new Map();

      for (const { key, node } of everyNode(model.nodes)) {
        const at = locateSelection(file, key);
        assert.ok(at, `${key}: no location`);
        assert.equal(at.file, file, `${key}: wrong file`);
        assert.equal(typeof at.startLine, 'number', `${key} (${node.kind}): no line range`);

        assert.ok(at.startLine >= 1, `${key}: line ${at.startLine} before the file`);
        assert.ok(at.endLine <= lines.length, `${key}: line ${at.endLine} past the file`);
        assert.ok(at.startLine <= at.endLine, `${key}: inverted range`);

        const parent = ranges.get(key.slice(0, key.lastIndexOf('.')));
        if (parent) {
          assert.ok(
            at.startLine >= parent.startLine && at.endLine <= parent.endLine,
            `${key}: ${at.startLine}-${at.endLine} escapes ` + `its parent's ${parent.startLine}-${parent.endLine}`,
          );
        }
        ranges.set(key, at);

        if (node.kind === 'element' || node.kind === 'component' || node.kind === 'raw') {
          const opening = node.shorthand ? '<>' : `<${node.name}`;
          assert.ok(lines[at.startLine - 1].includes(opening), `${key}: ${opening} is not on line ${at.startLine}: ${lines[at.startLine - 1]}`);
        }
      }
    });
  }

  test('the frontmatter block is the file up to its closing ---', () => {
    const file = fixtures.map((entry) => entry.file).find((file) => fs.readFileSync(file, 'utf8').startsWith('---'));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const at = locateSelection(file, 'frontmatter');
    assert.equal(at.startLine, 1);
    assert.equal(lines[at.endLine - 1].trim(), '---');
  });

  test('an empty path is the file itself, with no range', () => {
    const at = locateSelection(fixtures[0].file, '');
    assert.equal(at.file, fixtures[0].file);
    assert.equal(at.startLine, undefined);
  });

  test('a path that no longer resolves falls back to the file', () => {
    const at = locateSelection(fixtures[0].file, '99.99');
    assert.equal(at.file, fixtures[0].file);
    assert.equal(at.startLine, undefined);
  });

  test('a file that does not exist has no location', () => {
    assert.equal(locateSelection(path.join(CORPUS_DIRECTORY, 'nope.astro'), '0'), undefined);
  });
});
