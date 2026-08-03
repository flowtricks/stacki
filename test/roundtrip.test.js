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

const { parsePage, serializePage } = require('../electron/astroParser.js');

const CORPUS_DIR = path.join(__dirname, 'corpus');
const expectations = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'expectations.json'), 'utf8')
);

const DEFAULT_EXPECTATION = { editable: true, identity: 'pass' };

function expectationFor(name) {
  return { ...DEFAULT_EXPECTATION, ...(expectations[name] || {}) };
}

const fixtures = fs
  .readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.astro'))
  .sort()
  .map((name) => ({
    name,
    source: fs.readFileSync(path.join(CORPUS_DIR, name), 'utf8'),
    expect: expectationFor(name),
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The region that actually differs between two texts, after trimming the lines
// they share at the top and the bottom. This is the whole diff, expressed
// without needing a diff algorithm: if `before` and `after` are one line each,
// the change was local.
function changedRegion(aText, bText) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  return { start, before: a.slice(start, a.length - end), after: b.slice(start, b.length - end) };
}

function formatRegion(region) {
  const show = (lines) => (lines.length ? lines.map((l) => JSON.stringify(l)).join('\n      ') : '(nothing)');
  return `at line ${region.start + 1}\n    - ${show(region.before)}\n    + ${show(region.after)}`;
}

// First element node in document order — the node a locality test can safely
// hang an extra attribute off.
function firstElement(nodes) {
  for (const n of nodes || []) {
    if (n.kind === 'element') return n;
    const nested = firstElement(n.children);
    if (nested) return nested;
  }
  return null;
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
          ? `expected this fixture to be visually editable, but the parser bailed to code view: ${result.reason}`
          : 'expected this fixture to fall back to code view, but the parser now accepts it — if that is a real improvement, update expectations.json'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Round-trip identity — the contract
// ---------------------------------------------------------------------------

describe('parse -> serialize returns the original bytes', () => {
  for (const { name, source, expect } of fixtures) {
    if (!expect.editable) continue;

    test(name, () => {
      const { editable, model } = parsePage(source);
      if (!editable) return; // reported by the editability suite
      const output = serializePage(model);

      if (expect.identity === 'pass') {
        assert.equal(
          output,
          source,
          `round-trip changed a file nobody edited ${formatRegion(changedRegion(source, output))}`
        );
        return;
      }

      // Known defect. Assert it still reproduces, so a fix cannot land silently.
      assert.notEqual(
        output,
        source,
        `${name} now round-trips cleanly — delete its entry from test/expectations.json ` +
          `so this fixture starts guarding the fix.`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Idempotence — damage, if any, happens once
// ---------------------------------------------------------------------------

describe('serialization is idempotent', () => {
  for (const { name, source, expect } of fixtures) {
    if (!expect.editable) continue;

    test(name, () => {
      const first = parsePage(source);
      if (!first.editable) return;
      const once = serializePage(first.model);

      const second = parsePage(once);
      assert.ok(second.editable, 'serialized output no longer parses as editable');
      const twice = serializePage(second.model);

      assert.equal(
        twice,
        once,
        `saving twice keeps changing the file ${formatRegion(changedRegion(once, twice))}`
      );
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
    if (!expect.editable) continue;

    test(name, () => {
      const { editable, model } = parsePage(source);
      if (!editable) return;

      const baseline = serializePage(model);

      const edited = structuredClone(model);
      const target = firstElement(edited.nodes);
      if (!target) return; // nothing to hang an attribute off
      target.props = { ...(target.props || {}), 'data-probe': { type: 'string', value: '1' } };

      const output = serializePage(edited);
      const region = changedRegion(baseline, output);

      assert.equal(
        region.before.length,
        1,
        `editing one attribute rewrote ${region.before.length} lines ${formatRegion(region)}`
      );
      assert.equal(
        region.after.length,
        1,
        `editing one attribute produced ${region.after.length} lines ${formatRegion(region)}`
      );
      assert.ok(
        region.after[0].includes('data-probe="1"'),
        'the changed line should be the one carrying the new attribute'
      );
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
    const skipDirs = new Set(['node_modules', '.git', 'dist', '.astro', 'release']);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.astro')) {
          files.push(path.join(dir, entry.name));
        }
      }
    };
    walk(root);

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
        if (serializePage(model) === source) stats.identical++;
        else stats.differs++;
      } catch (err) {
        crashes.push(`${file}: ${err.message}`);
      }
    }

    console.log(
      `\n  ${root}\n  ${stats.total} files — ${stats.identical} identical, ` +
        `${stats.differs} differ, ${stats.notEditable} not editable\n`
    );

    assert.deepEqual(crashes, [], `parser threw on ${crashes.length} file(s):\n${crashes.join('\n')}`);
  });
});
