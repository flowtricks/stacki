// The round-trip gate.
//
// Stacki edits files it did not write. The contract that makes that safe is:
// parsing a page and serializing it straight back must return the ORIGINAL
// BYTES. Anything else means opening a file and saving it rewrites parts the
// user never touched — reformatted markup, reordered imports, lost blank lines.
//
// Every fixture in test/corpus/ is checked for five properties:
//
//   1. parse never throws              — a crash on someone's project is the
//                                        worst possible first impression
//   2. editability is what we expect   — a file silently falling back to code
//                                        view is a feature regression
//   3. parse → serialize is identity   — the contract above
//   4. serialization is idempotent     — weaker fallback: if a file IS damaged,
//                                        it is damaged once, not on every save
//   5. a single edit stays local       — one prop change must produce a one-line
//                                        diff, not a whole-file reflow
//
// Files listed in expectations.json with identity:'fail' are KNOWN defects. The
// gate asserts they STILL fail, so fixing one forces the entry to be deleted and
// the fixture becomes a permanent regression test. See test/README.md.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const CORPUS_DIRECTORY = repoPath('test/corpus');
const expectations = JSON.parse(fs.readFileSync(repoPath('test/corpus/expectations.json'), 'utf8'));

const DEFAULT_EXPECTATION = { editable: true, identity: 'pass' };

function expectationFor(name) {
  return { ...DEFAULT_EXPECTATION, ...(expectations[name] || {}) };
}

const fixtures = fs
  .readdirSync(CORPUS_DIRECTORY)
  .filter((file) => file.endsWith('.astro'))
  .sort()
  .map((name) => ({
    name,
    source: fs.readFileSync(path.join(CORPUS_DIRECTORY, name), 'utf8'),
    expect: expectationFor(name),
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The region that actually differs between two texts, after trimming the lines
// they share at the top and the bottom. This is the whole diff, expressed
// without needing a diff algorithm: if `before` and `after` are one line each,
// the change was local.
function changedRegion(beforeText, afterText) {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start++;
  }
  let end = 0;
  while (
    end < beforeLines.length - start &&
    end < afterLines.length - start &&
    beforeLines[beforeLines.length - 1 - end] === afterLines[afterLines.length - 1 - end]
  ) {
    end++;
  }
  return {
    start,
    before: beforeLines.slice(start, beforeLines.length - end),
    after: afterLines.slice(start, afterLines.length - end),
  };
}

function formatRegion(region) {
  const show = (lines) => (lines.length ? lines.map((line) => JSON.stringify(line)).join('\n      ') : '(nothing)');
  return `at line ${region.start + 1}\n    - ${show(region.before)}\n    + ${show(region.after)}`;
}

// First element node in document order — the node a locality test can safely
// hang an extra attribute off.
function firstElement(nodes, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'firstElement: depth limit');
  for (const node of nodes || []) {
    if (node.kind === 'element') {
      return node;
    }
    const nested = firstElement(node.children, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Parsing never throws
// ---------------------------------------------------------------------------

describe('parse does not throw', () => {
  for (const { name, source } of fixtures) {
    test(name, () => {
      assert.doesNotThrow(() => parsePage(source));
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Editability is stable
// ---------------------------------------------------------------------------

describe('editability matches expectation', () => {
  for (const { name, source, expect } of fixtures) {
    test(name, () => {
      const result = parsePage(source);
      assert.equal(
        !!result.editable,
        expect.editable,
        expect.editable
          ? `expected this fixture to be visually editable, but ` + `the parser bailed to code view: ${result.reason}`
          : 'expected this fixture to fall back to code view, but the parser now accepts it — ' + 'if that is a real improvement, update expectations.json',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Round-trip identity — the contract
// ---------------------------------------------------------------------------

describe('parse -> serialize returns the original bytes', () => {
  for (const { name, source, expect } of fixtures) {
    if (!expect.editable) {
      continue;
    }

    test(name, () => {
      const { editable, model } = parsePage(source);
      if (!editable) {
        return;
      } // reported by the editability suite
      const output = serializePage(model);

      if (expect.identity === 'pass') {
        assert.equal(output, source, `round-trip changed a file nobody edited ${formatRegion(changedRegion(source, output))}`);
        return;
      }

      // Known defect. Assert it still reproduces, so a fix cannot land silently.
      assert.notEqual(
        output,
        source,
        `${name} now round-trips cleanly — delete its entry from test/corpus/expectations.json ` + `so this fixture starts guarding the fix.`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Idempotence — damage, if any, happens once
// ---------------------------------------------------------------------------

describe('serialization is idempotent', () => {
  for (const { name, source, expect } of fixtures) {
    if (!expect.editable) {
      continue;
    }

    test(name, () => {
      const first = parsePage(source);
      if (!first.editable) {
        return;
      }
      const once = serializePage(first.model);

      const second = parsePage(once);
      assert.ok(second.editable, 'serialized output no longer parses as editable');
      const twice = serializePage(second.model);

      assert.equal(twice, once, `saving twice keeps changing the file ${formatRegion(changedRegion(once, twice))}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 4b. An edited inline run keeps its boundary spaces
// ---------------------------------------------------------------------------
//
// The Content field is where words get typed, and the keystroke that ends a
// word is a space: the field emits "hello ", the model serializes it, and the
// parse must hand back the same value — parse∘serialize is the field's save
// echo, and an echo that comes back different resets the caret mid-word. A
// text node on a line of its own may trim its boundary spaces (the file's
// indent carries them back in); a run on one line has nothing else to hold
// them, so the serializer must not strip them.

describe('an edited inline run keeps its boundary spaces', () => {
  const cases = [
    ['trailing', '<h1>hello </h1>', 'hello '],
    ['leading', '<h1> hello</h1>', ' hello'],
    ['both ends of a run after an edit', '<h1>hi</h1>', ' hello '],
  ];

  for (const [name, source, editedValue] of cases) {
    test(name, () => {
      const first = parsePage(source);
      assert.ok(first.editable, 'fixture stopped parsing as editable');
      const heading = first.model.nodes[0];
      assert.ok(heading, 'fixture has a top-level node');
      const text = heading.children?.[0];
      assert.ok(text && text.kind === 'text', 'fixture starts with a text child');

      // The edit the Content field makes: a new model whose heading holds the
      // typed value and no source, the way setNodeInline's text child lands.
      const { source: _written, ...unwritten } = text;
      const edited = { ...heading, children: [{ ...unwritten, value: editedValue }] };
      const nodes = [edited, ...first.model.nodes.slice(1)];
      const once = serializePage({ ...first.model, nodes });

      const second = parsePage(once);
      assert.ok(second.editable, 'edited output no longer parses as editable');
      const echoed = second.model.nodes[0]?.children?.[0];
      assert.ok(echoed && echoed.kind === 'text', 'edited run lost its text child');
      assert.equal(echoed.value, editedValue, `the save echo lost the boundary space of ${JSON.stringify(editedValue)}`);

      // And the round trip is stable: the next save changes nothing.
      const twice = serializePage(second.model);
      assert.equal(twice, once, 'saving twice re-trimmed the boundary space');
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Locality — one edit, one line
// ---------------------------------------------------------------------------
//
// Compared against the serializer's own baseline output, not against the source
// file, so this measures ONLY the blast radius of the edit. It stays meaningful
// while the identity failures above are still outstanding.

describe('a single prop edit produces a single-line diff', () => {
  for (const { name, source, expect } of fixtures) {
    if (!expect.editable) {
      continue;
    }

    test(name, () => {
      const { editable, model } = parsePage(source);
      if (!editable) {
        return;
      }

      const baseline = serializePage(model);

      const edited = structuredClone(model);
      const target = firstElement(edited.nodes);
      if (!target) {
        return;
      } // nothing to hang an attribute off
      target.props = { ...(target.props || {}), 'data-probe': { type: 'string', value: '1' } };

      const output = serializePage(edited);
      const region = changedRegion(baseline, output);

      assert.equal(region.before.length, 1, `editing one attribute rewrote ${region.before.length} lines ${formatRegion(region)}`);
      assert.equal(region.after.length, 1, `editing one attribute produced ${region.after.length} lines ${formatRegion(region)}`);
      assert.ok(region.after[0].includes('data-probe="1"'), 'the changed line should be the one carrying the new attribute');
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Optional: sweep a real project tree
// ---------------------------------------------------------------------------
//
//   STACKI_CORPUS=~/some/astro-project npm test
//
// Only crashes fail the build — real projects legitimately contain markup the
// visual model does not cover. The counts print so the editable/not-editable
// ratio can be tracked as the parser improves.

describe('external corpus sweep', () => {
  const root = process.env.STACKI_CORPUS;

  test('parses every .astro file without throwing', { skip: !root && 'set STACKI_CORPUS to run' }, () => {
    const files = [];
    const skipDirectories = new Set(['node_modules', '.git', 'dist', '.astro', 'release']);
    // A corpus is a project tree: folders nest a handful deep, and a walk past
    // this has met a cycle or a generated tree.
    const WALK_LIMITS = { directoryDepthMax: 32 };
    const walk = (directory, depth) => {
      assert.ok(depth <= WALK_LIMITS.directoryDepthMax, 'walk: depth limit');
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skipDirectories.has(entry.name)) {
            walk(path.join(directory, entry.name), depth + 1);
          }
        } else if (entry.name.endsWith('.astro')) {
          files.push(path.join(directory, entry.name));
        }
      }
    };
    walk(root, 0);

    const stats = { total: files.length, identical: 0, differs: 0, notEditable: 0 };
    const crashes = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      try {
        const { editable, model } = parsePage(source);
        if (!editable) {
          stats.notEditable++;
          continue;
        }
        if (serializePage(model) === source) {
          stats.identical++;
        } else {
          stats.differs++;
        }
      } catch (error) {
        crashes.push(`${file}: ${error.message}`);
      }
    }

    console.log(`\n  ${root}\n  ${stats.total} files — ${stats.identical} identical, ` + `${stats.differs} differ, ${stats.notEditable} not editable\n`);

    assert.deepEqual(crashes, [], `parser threw on ${crashes.length} file(s):\n${crashes.join('\n')}`);
  });
});
