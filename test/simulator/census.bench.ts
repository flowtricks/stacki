// Goal: how often an edit on a real page reaches the projection patch's
// fallback — the input revision B of step 4 registered as recorded, not gated.
// A measurement, not a test.
// Method: walk the roots given on the command line for `.astro` files, skipping
// node_modules, dot-directories and this repository's test/ tree, and keep one
// file per distinct content (SHA-256): mirrors such as WSL's /mnt/wslg/distro
// and scratch copies would otherwise count a page twice. For every value site
// the planner could edit (an editable host, an editable string attribute),
// replace the value with each of REPLACEMENTS and record whether revision A's
// rule and revision B's rule patch it. Every patch B accepts is compared with a
// full reparse, as everywhere else. Only aggregate counts are printed: no path
// and no page content leaves the machine through this report.
// Run: npm run build:runtime && node test/simulator/census.bench.ts <root>...
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toFilePath } from '#dist/shared/core/brand.js';
import { capabilityAcceptsVisualIntent } from '#dist/shared/page/capability.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import type { Splice } from '#dist/shared/engine/planner.js';
import { hostContext, projectValueSplice, valueBytesNeutral } from '#dist/shared/engine/projectionPatch.js';
import type { Projection } from '#dist/shared/page/sourceProjection.js';
import { encodeUtf8, toByteString, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';
import { projectBytes } from './project.ts';
import { applySplices } from '#dist/shared/engine/splice.js';

const PAGE = toFilePath('/project/page.astro');
const FILES_MAX = 10_000;
const DIRECTORIES_MAX = 200_000;
// A plain title, and a URL with a query: the second holds `/ ? :`, which the
// expression table refuses, so the two bracket what users type.
const REPLACEMENTS = ['New title', '/about/team?x=1'] as const;
const OWN_TESTS = path.resolve('test');

interface Tally {
  files: number;
  duplicates: number;
  invalid: number;
  sites: number;
  markup: number;
  expression: number;
  refusedHost: number;
  compared: number;
  /** Full reparse + reprojection per distinct file, milliseconds: what a
   * fallback costs on a real page. */
  readonly reparseMs: number[];
  readonly accepted: Record<string, { a: number; b: number }>;
}

main();

function main(): void {
  const roots = process.argv.slice(2);
  assert.ok(roots.length > 0, 'Usage: census.bench.ts <root>...');
  const files = astroFiles(roots);
  const tally: Tally = {
    files: 0,
    duplicates: 0,
    invalid: 0,
    sites: 0,
    markup: 0,
    expression: 0,
    refusedHost: 0,
    compared: 0,
    reparseMs: [],
    accepted: Object.fromEntries(REPLACEMENTS.map((value) => [value, { a: 0, b: 0 }])),
  };
  const seen = new Set<string>();
  for (const file of files) {
    const bytes = toByteString(fs.readFileSync(file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (seen.has(digest)) {
      tally.duplicates++;
      continue;
    }
    seen.add(digest);
    tally.files++;
    // The tally is main's alone: each file reports its own counts, added here.
    const found = censusFile(bytes);
    tally.reparseMs.push(found.reparseMs);
    tally.invalid += found.invalid;
    tally.sites += found.sites;
    tally.markup += found.markup;
    tally.expression += found.expression;
    tally.refusedHost += found.refusedHost;
    tally.compared += found.compared;
    for (const value of REPLACEMENTS) {
      const counts = tally.accepted[value];
      const more = found.accepted[value];
      assert.ok(counts !== undefined, 'Every replacement has a tally');
      assert.ok(more !== undefined, 'Every replacement has a count for the file');
      counts.a += more.a;
      counts.b += more.b;
    }
  }
  report(tally);
}

// One file's share of the tally: the counts it adds, and its own reparse time.
interface FileTally extends Omit<Tally, 'files' | 'duplicates' | 'reparseMs'> {
  readonly reparseMs: number;
}

function censusFile(bytes: ByteString): FileTally {
  const started = performance.now();
  const projection = projectBytes(PAGE, bytes);
  const tally: FileTally = {
    reparseMs: performance.now() - started,
    invalid: 0,
    sites: 0,
    markup: 0,
    expression: 0,
    refusedHost: 0,
    compared: 0,
    accepted: Object.fromEntries(REPLACEMENTS.map((value) => [value, { a: 0, b: 0 }])),
  };
  if (projection.tag !== 'valid') {
    tally.invalid++;
    return tally;
  }
  for (const range of editableValues(projection)) {
    tally.sites++;
    const context = hostContext(projection, range);
    if (context === 'refused') {
      tally.refusedHost++;
    } else {
      tally[context]++;
    }
    for (const value of REPLACEMENTS) {
      const splice = spliceAt(bytes, range, value);
      const counts = tally.accepted[value];
      assert.ok(counts !== undefined, 'Every replacement has a tally');
      if (context === 'markup') {
        counts.a += markupRuleAccepts(splice) ? 1 : 0; // Revision A: markup hosts only.
      }
      const patched = projectValueSplice(projection, bytes, splice);
      if (patched !== undefined) {
        const reference = projectBytes(PAGE, applySplices(bytes, [splice]));
        assert.deepStrictEqual(patched, reference, 'A patch on a real page is its reparse');
        tally.compared++;
        counts.b++;
      }
    }
  }
  return tally;
}

// The sites the planner could target (planner.ts soleAttribute): an editable
// host, and an editable string attribute with a value.
function editableValues(projection: Extract<Projection, { tag: 'valid' }>): readonly ByteSpan[] {
  const sites: ByteSpan[] = [];
  for (const node of projection.nodes) {
    if (capabilityAcceptsVisualIntent(node.capability)) {
      for (const attribute of node.attributes) {
        if (attribute.type === 'string') {
          if (capabilityAcceptsVisualIntent(attribute.capability)) {
            if (attribute.valueSpan !== undefined) {
              sites.push(attribute.valueSpan);
            }
          }
        }
      }
    }
  }
  return sites;
}

function markupRuleAccepts(splice: Splice): boolean {
  if (splice.replacementBytes.length > LIMITS.attrCharsMax) {
    return false;
  }
  if (valueBytesNeutral(splice.expectedBytes, 'markup')) {
    return valueBytesNeutral(splice.replacementBytes, 'markup');
  }
  return false;
}

function spliceAt(bytes: ByteString, range: ByteSpan, value: string): Splice {
  return {
    range,
    expectedBytes: toByteString(bytes.subarray(range.start, range.end)),
    replacementBytes: encodeUtf8(value),
  };
}

// Depth-first, iterative, bounded in directories visited and files kept.
function astroFiles(roots: readonly string[]): readonly string[] {
  const pending = roots.map((root) => path.resolve(root));
  const found: string[] = [];
  for (let visited = 0; visited < DIRECTORIES_MAX; visited++) {
    const directory = pending.pop();
    if (directory === undefined) {
      return found.sort();
    }
    for (const entry of readDirectory(directory)) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (walkable(entry.name, full)) {
          pending.push(full);
        }
      } else if (entry.isFile() && entry.name.endsWith('.astro')) {
        assert.ok(found.length < FILES_MAX, `More than ${FILES_MAX} .astro files`);
        found.push(full);
      }
    }
  }
  throw new Error(`Assertion failed: more than ${DIRECTORIES_MAX} directories under the roots`);
}

function walkable(name: string, full: string): boolean {
  if (name === 'node_modules') {
    return false;
  }
  if (name.startsWith('.')) {
    return false;
  }
  return full !== OWN_TESTS;
}

function readDirectory(directory: string): readonly fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return []; // Unreadable (permissions, a vanished mount): not a page.
  }
}

function report(tally: Tally): void {
  const share = (count: number): string => (tally.sites === 0 ? '—' : `${((100 * count) / tally.sites).toFixed(1)} %`);
  console.log(`Distinct .astro files: ${tally.files} (${tally.duplicates} duplicates skipped)`);
  console.log(`Not valid as projected: ${tally.invalid}`);
  console.log(`Editable string value sites: ${tally.sites}`);
  console.log(`  host in markup: ${tally.markup} (${share(tally.markup)})`);
  console.log(`  host in a condition or loop: ${tally.expression} (${share(tally.expression)})`);
  console.log(`  host context refused: ${tally.refusedHost} (${share(tally.refusedHost)})`);
  console.log('\n| Replacement | A patches | A falls back | B patches | B falls back |');
  console.log('|---|---|---|---|---|');
  for (const value of REPLACEMENTS) {
    const counts = tally.accepted[value];
    assert.ok(counts !== undefined, 'Every replacement has a tally');
    const cells = [share(counts.a), share(tally.sites - counts.a)];
    const more = [share(counts.b), share(tally.sites - counts.b)];
    console.log(`| ${JSON.stringify(value)} | ${[...cells, ...more].join(' | ')} |`);
  }
  console.log(`\nB patches compared with a full reparse: ${tally.compared}, all equal.`);
  const sorted = [...tally.reparseMs].sort((left, right) => left - right);
  const rank = (percent: number): string => (sorted[Math.max(Math.ceil((percent / 100) * sorted.length), 1) - 1] ?? 0).toFixed(1);
  const max = (sorted.at(-1) ?? 0).toFixed(1);
  console.log(`Full reparse per file, ms: p50 ${rank(50)}, p95 ${rank(95)}, max ${max}`);
}
