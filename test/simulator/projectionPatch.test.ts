// Goal: a patched projection (shared/engine/projectionPatch.ts) is exactly the one a
// full reparse produces, wherever the patch accepts a value splice, and the
// patch refuses every splice outside its stated rule (step-4 latency
// experiment; plan §10: a fast path is held to its brute-force reference).
// Method: (1) a sweep over every `.astro` fixture: every string attribute on
// every node, replaced by each value in VALUES (empty, long, URL-like,
// punctuation, multi-byte UTF-8); where the patch accepts, the patched
// projection must deep-equal the reparse of the spliced bytes; where it
// refuses, the refusal must follow from the rule, so the fast path is not
// silently narrower than claimed. (2) The negative space, pinned: each refused
// byte in the new value and in the old one, a host under a condition or a
// loop, a splice that is not a value, a file that does not parse, a value over
// the attribute bound. (3) Seeded simulator runs, where the actor compares
// every patched candidate with its reparse (candidate.ts) and fails the run on
// a difference; the test checks the reference compared something.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { toFilePath } from '#dist/shared/core/brand.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import type { Splice } from '#dist/shared/engine/planner.js';
import { hostContext, projectValueSplice, valueBytesNeutral } from '#dist/shared/engine/projectionPatch.js';
import type { ProjectedNode, Projection } from '#dist/shared/page/sourceProjection.js';
import { decodeUtf8, encodeUtf8, toByteSpan, toByteString, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';
import { patchCounts } from './candidate.ts';
import { Prng } from './prng.ts';
import { loadSimulationFixtures } from './fixtures.entry.ts';
import { projectBytes } from './project.ts';
import { applySplices } from '#dist/shared/engine/splice.js';
import { runSimulation } from './world.ts';

const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const PAGE = toFilePath('/project/page.astro');
const SIMULATION_SEEDS = seedCount();
const SIMULATION_STEPS = 400;
const VALUES = [
  '',
  'x',
  'Hello, world',
  '/about/team?x=1&y=2#top',
  'a:b; c=d',
  'x*/y//z',
  'café 漢字 😀',
  'a-b_c.d,e!f@g$h%i^j*k(l)m[n]o|p~q+r=s',
  'w'.repeat(300),
] as const;
const REFUSED = ['"', "'", '`', '\\', '<', '>', '{', '}', '\n', '\r', '\t', '\u0000', '\u007f'];

// STACKI_SIMULATOR_SEEDS raises the seed count off the gate, as in
// simulator.test.ts; the gate runs 12. Step 10's Markdown events took a share
// of the attribute edits this samples: 8 seeds patched 78 candidates, 12 patch
// 120, above the 100 the sample must reach.
function seedCount(): number {
  const raw = process.env['STACKI_SIMULATOR_SEEDS'];
  if (raw === undefined) {
    return 12;
  }
  const seeds = Number(raw);
  assert.ok(Number.isSafeInteger(seeds), 'STACKI_SIMULATOR_SEEDS is an integer');
  assert.ok(seeds > 0, 'STACKI_SIMULATOR_SEEDS is positive');
  assert.ok(seeds <= 100_000, 'STACKI_SIMULATOR_SEEDS is at most 100 000');
  return seeds;
}

function valueSplice(bytes: ByteString, range: ByteSpan, value: string): Splice {
  return {
    range,
    expectedBytes: toByteString(bytes.subarray(range.start, range.end)),
    replacementBytes: encodeUtf8(value),
  };
}

interface ValueSite {
  readonly node: ProjectedNode;
  readonly range: ByteSpan;
}

function stringValues(projection: Projection): readonly ValueSite[] {
  if (projection.tag !== 'valid') {
    return [];
  }
  return projection.nodes.flatMap((node) =>
    node.attributes.flatMap((attribute) => (attribute.type === 'string' && attribute.valueSpan !== undefined ? [{ node, range: attribute.valueSpan }] : [])),
  );
}

function astroFixtures(): readonly { name: string; bytes: ByteString }[] {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.astro'))
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        bytes: toByteString(fs.readFileSync(path.join(directory, name))),
      })),
  );
}

test('the patched projection is the reparsed one on every fixture value', () => {
  let compared = 0;
  let refusedByHost = 0;
  let refusedByBytes = 0;
  for (const fixture of astroFixtures()) {
    const projection = projectBytes(PAGE, fixture.bytes);
    for (const { range } of stringValues(projection)) {
      for (const value of VALUES) {
        const splice = valueSplice(fixture.bytes, range, value);
        const patched = projectValueSplice(projection, fixture.bytes, splice);
        if (patched === undefined) {
          const context = hostContext(projection, range);
          if (context === 'refused') {
            refusedByHost++;
          } else {
            // The fast path is never silently narrower than its stated rule.
            assert.ok(!allNeutral(splice, context), `${fixture.name} @${range.start} ← ${value}`);
            refusedByBytes++;
          }
          continue;
        }
        const reference = projectBytes(PAGE, applySplices(fixture.bytes, [splice]));
        assert.deepStrictEqual(patched, reference, `${fixture.name} @${range.start} ← ${value}`);
        compared++;
      }
    }
  }
  console.log(`compared ${compared}; refused: host context ${refusedByHost}, ` + `a value outside its context's bytes ${refusedByBytes}`);
  assert.ok(compared > 500, `the sweep compared a real sample (${compared})`);
});

const NESTED = '<div>\n  <div>\n    <a title="x">x</a>\n  </div>\n  <p>after</p>\n</div>\n';

interface TitleSplice {
  readonly projection: Projection;
  readonly bytes: ByteString;
  readonly splice: Splice;
}

function titleSplice(text: string, value: string): TitleSplice {
  const bytes = encodeUtf8(text);
  const projection = projectBytes(PAGE, bytes);
  const [target] = stringValues(projection);
  assert.ok(target !== undefined, 'The page has a string attribute');
  return { projection, bytes, splice: valueSplice(bytes, target.range, value) };
}

test('every refused byte in the new value refuses the patch', () => {
  for (const byte of REFUSED) {
    const { projection, bytes, splice } = titleSplice(NESTED, `a${byte}b`);
    assert.equal(projectValueSplice(projection, bytes, splice), undefined, JSON.stringify(byte));
  }
  const accepted = titleSplice(NESTED, 'ab');
  const patched = projectValueSplice(accepted.projection, accepted.bytes, accepted.splice);
  assert.notEqual(patched, undefined);
});

test('a refused byte in the old value refuses the patch, whatever the new one is', () => {
  for (const byte of ['}', '{', '`', '\\', '>', "'"]) {
    const { projection, bytes, splice } = titleSplice(NESTED.replace('"x"', `"a${byte}b"`), 'ok');
    assert.equal(projection.tag, 'valid', `the page with ${byte} parses`);
    assert.equal(projectValueSplice(projection, bytes, splice), undefined, JSON.stringify(byte));
  }
});

test('tag-like values use a full reparse and remain ordinary attribute text', () => {
  const { projection, bytes, splice } = titleSplice(NESTED, '</div>');
  assert.equal(projectValueSplice(projection, bytes, splice), undefined);
  const changed = projectBytes(PAGE, applySplices(bytes, [splice]));
  assert.equal(changed.tag, 'valid');
  assert.ok(changed.tag === 'valid');
  assert.ok(projection.tag === 'valid');
  assert.deepEqual(
    changed.nodes.map((node) => node.kind),
    projection.nodes.map((node) => node.kind),
  );
});

const EXPRESSION_PAGES = [
  '{show && <a title="x">y</a>}\n<p>z</p>\n',
  '{show ? (<a title="x">y</a>) : null}\n',
  '{items.map((item) => (<a title="x">y</a>))}\n',
  // The value in each JavaScript-scanner mode: a string, code (the text's quote
  // closes at the value's opening quote), a block comment, a template literal,
  // after a line comment, and after a URL's `//`.
  '{show && <p>it\'s <a title="x">y</a></p>}\n',
  '{show && <p>say "hi <a title="x">y</a></p>}\n',
  '{show && <p>x /* y <a title="x">y</a> z */ w</p>}\n',
  '{show && <p>tick ` a <a title="x">y</a> b ` tock</p>}\n',
  '{show && <p>a // b\n<a title="x">y</a></p>}\n',
  '{show && <p>see http://x.test/ <a title="x">y</a></p>}\n',
];

// Revision B: hosts inside conditions and loops patch, with the stricter
// table, and the patch equals the reparse.
test('a host under a condition or a loop patches values inert to the JS scanners', () => {
  for (const page of EXPRESSION_PAGES) {
    const { projection, bytes, splice } = titleSplice(page, 'New value 2 é');
    assert.equal(projection.tag, 'valid', page);
    assert.equal(hostContext(projection, splice.range), 'expression', page);
    const patched = projectValueSplice(projection, bytes, splice);
    assert.notEqual(patched, undefined, page);
    assert.deepStrictEqual(patched, projectBytes(PAGE, applySplices(bytes, [splice])), page);
  }
});

test('inside an expression, each byte the JS scanners react to refuses the patch', () => {
  const [page] = EXPRESSION_PAGES;
  assert.ok(page !== undefined);
  for (const byte of '()[]?:&;/*') {
    const inNew = titleSplice(page, `a${byte}b`);
    assert.equal(projectValueSplice(inNew.projection, inNew.bytes, inNew.splice), undefined, byte);
    const inOld = titleSplice(page.replace('"x"', `"a${byte}b"`), 'ok');
    assert.equal(inOld.projection.tag, 'valid', `the page with ${byte} parses`);
    assert.equal(projectValueSplice(inOld.projection, inOld.bytes, inOld.splice), undefined, byte);
    const markup = titleSplice(NESTED, `a${byte}b`); // The same byte is inert in markup.
    assert.notEqual(projectValueSplice(markup.projection, markup.bytes, markup.splice), undefined);
  }
});

function allNeutral(splice: Splice, context: 'markup' | 'expression'): boolean {
  if (splice.replacementBytes.length > LIMITS.attrCharsMax) {
    return false;
  }
  if (valueBytesNeutral(splice.expectedBytes, context)) {
    return valueBytesNeutral(splice.replacementBytes, context);
  }
  return false;
}

test('a splice that is not a string value, or a file that does not parse, is refused', () => {
  const bytes = encodeUtf8(NESTED);
  const projection = projectBytes(PAGE, bytes);
  const inText = valueSplice(bytes, toByteSpan(31, 32), 'y'); // The `x` text node.
  assert.equal(projectValueSplice(projection, bytes, inText), undefined);
  const broken = encodeUtf8('<div>\n  <a title="x">y</a>\n');
  const invalid = projectBytes(PAGE, broken);
  assert.equal(invalid.tag, 'parse-error');
  const start = broken.indexOf(0x22) + 1;
  const splice = valueSplice(broken, toByteSpan(start, start + 1), 'z');
  assert.equal(projectValueSplice(invalid, broken, splice), undefined);
});

test('a value over the attribute bound is refused', () => {
  const { projection, bytes, splice } = titleSplice(NESTED, 'w'.repeat(LIMITS.attrCharsMax + 1));
  assert.equal(projectValueSplice(projection, bytes, splice), undefined);
});

// The parser bounds a page in UTF-16 units (ipcFieldCharsMax), and the patch
// keeps that bound from the projection's own count, never by walking the file.
// A page exactly at the bound: an edit that keeps the units patches and equals
// the reparse; one that adds a unit is refused, and the parser refuses it too.
test('the UTF-16 bound is kept from the projection count, on both sides of it', () => {
  const head = '<div title="ab">\n';
  const tail = '</div>\n';
  // Paragraphs of 100 000 characters: a text node has its own bound.
  const paragraph = `<p>${'x'.repeat(100_000 - 8)}</p>\n`;
  const room = LIMITS.ipcFieldCharsMax - head.length - tail.length;
  const last = room % paragraph.length;
  assert.ok(last > 8, 'The remainder holds a paragraph of its own');
  const filler = paragraph.repeat(Math.floor(room / paragraph.length));
  const text = head + filler + `<p>${'x'.repeat(last - 8)}</p>\n` + tail;
  assert.equal(text.length, LIMITS.ipcFieldCharsMax, 'The page sits exactly at the bound');
  for (const value of ['cd', 'é']) {
    const { projection, bytes, splice } = titleSplice(text, value);
    assert.equal(projection.tag, 'valid', 'A page at the bound parses');
    const patched = projectValueSplice(projection, bytes, splice);
    assert.notEqual(patched, undefined, `${value} keeps the page inside the bound`);
    assert.deepEqual(patched, projectBytes(PAGE, applySplices(bytes, [splice])));
  }
  const grown = titleSplice(text, 'abc');
  assert.equal(projectValueSplice(grown.projection, grown.bytes, grown.splice), undefined);
  const grownText = decodeUtf8(applySplices(grown.bytes, [grown.splice]));
  assert.ok(grownText.ok, 'The grown page is UTF-8');
  const reparsed = parsePage(grownText.value, { locs: true });
  assert.equal(reparsed.editable, false, 'The parser refuses one unit past the bound too');
});

// Pages built to drive the JavaScript scanners into every mode around a value:
// JSX text carrying apostrophes, quotes, `//`, `/*`, backticks, URLs and
// operators, hosts in conditions, ternaries and loops, nested. Every value is
// replaced by random bytes from all of printable ASCII plus multi-byte UTF-8;
// an accepted patch must equal the reparse, and a refusal must follow from the
// rule. Bounded: PROPERTY_PAGES pages, PROPERTY_EDITS edits per value site.
const PROPERTY_PAGES = 1500;
const PROPERTY_EDITS = 3;
const PROPERTY_LIMITS = { depthMax: 2 } as const;
const TEXTS = [
  'plain words',
  "it's",
  'say "hi',
  'a // b\n',
  'x /* y',
  'z */ w',
  'http://x.test/a',
  'tick ` here',
  'a ? b : c',
  'p && q',
  '(open',
  'close)',
  '[x]',
  'semi; colon',
  'café 漢字',
] as const;
// Openers and their closers, placed around a host so the value sits inside a
// block comment or a template literal as the scanners read it.
const AROUND: readonly (readonly [string, string])[] = [
  ['', ''],
  ['x /* y', 'z */ w'],
  ['tick ` a', 'b ` tock'],
  ['a // b\n', ''],
];
const ORIGINALS = ['x', 'Old title', 'a-b_c', 'é', "it's", 'a/b', 'q?r', ''] as const;
const ALPHABET = [...Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)), 'é', '漢', '😀'];

function propertyBody(prng: Prng, depth: number): string {
  const text = (): string => prng.pick(TEXTS);
  const value = (): string => prng.pick(ORIGINALS).replace('"', '');
  const host = `<a title="${value()}" data-x="${value()}">${text()}</a>`;
  const [before, after] = prng.pick(AROUND);
  const element = `<p>${text()} ${before} ${host} ${after} ${text()}</p>`;
  if (depth >= PROPERTY_LIMITS.depthMax) {
    return element;
  }
  const inner = (): string => propertyBody(prng, depth + 1);
  switch (prng.below(5)) {
    case 0:
      return `{show && ${inner()}}`;
    case 1:
      return `{show && (${inner()})}`;
    case 2:
      return `{ok ? (${inner()}) : (${inner()})}`;
    case 3:
      return `{items.map((item) => (${inner()}))}`;
    default:
      return `<div class="c">${inner()}</div>`;
  }
}

function randomValue(prng: Prng): string {
  const length = prng.below(12);
  return Array.from({ length }, () => prng.pick(ALPHABET)).join('');
}

test('property: every accepted patch equals the reparse, around every scanner mode', () => {
  const prng = new Prng(20260928);
  const accepted = { markup: 0, expression: 0 };
  let refused = 0;
  let pagesValid = 0;
  for (let index = 0; index < PROPERTY_PAGES; index++) {
    const page = `${propertyBody(prng, 0)}\n${propertyBody(prng, 0)}\n`;
    const bytes = encodeUtf8(page);
    const projection = projectBytes(PAGE, bytes);
    if (projection.tag !== 'valid') {
      continue;
    }
    pagesValid++;
    for (const { range } of stringValues(projection)) {
      const context = hostContext(projection, range);
      for (let edit = 0; edit < PROPERTY_EDITS; edit++) {
        const splice = valueSplice(bytes, range, randomValue(prng));
        const patched = projectValueSplice(projection, bytes, splice);
        const where = `${JSON.stringify(page)} @${range.start}`;
        if (patched === undefined) {
          assert.ok(context === 'refused' || !allNeutral(splice, context), where);
          refused++;
          continue;
        }
        assert.ok(context !== 'refused', where);
        assert.deepStrictEqual(patched, projectBytes(PAGE, applySplices(bytes, [splice])), where);
        accepted[context]++;
      }
    }
  }
  const tallies = `accepted ${JSON.stringify(accepted)}, refused ${refused}`;
  const counts = `${pagesValid} valid pages, ${tallies}`;
  console.log(`property: ${counts}`);
  assert.ok(pagesValid > PROPERTY_PAGES / 4, `most generated pages parse (${counts})`);
  assert.ok(accepted.expression > 200, `expression hosts were exercised (${counts})`);
  assert.ok(accepted.markup > 200, `markup hosts were exercised (${counts})`);
});

test('seeded simulator runs: every patched candidate matched its reparse', () => {
  const fixtures = loadSimulationFixtures();
  for (let seed = 1; seed <= SIMULATION_SEEDS; seed++) {
    runSimulation({ seed, steps: SIMULATION_STEPS, wrongSite: 'count', ...fixtures });
  }
  const counts = patchCounts();
  console.log(`simulator candidates: patched ${counts.patched}, reparsed ${counts.reparsed}`);
  assert.ok(counts.patched > 100, `the reference compared a real sample (${counts.patched})`);
});
