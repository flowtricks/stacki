// Goal: the step-3 spike report (plan §11 step 3; tracker Step 3). Intent →
// map → witness check → splice → reparse → reproject, measured against the
// thresholds pre-registered on 2026-09-28 (plan §11 step 4): intent→applied
// p95 ≤ 50 ms and last keystroke→disk p95 ≤ 350 ms on the named large fixtures.
// A measurement, not a test: it asserts no threshold, and it prints what it saw.
//
// Method, in three parts:
//   1. Mapping correctness. SPIKE_SEEDS seeded runs of the simulator, whose
//      actor plans set-attribute with the shipping planner and whose judge
//      (remapJudge.ts) decides every stale plan again from recorded byte
//      origins; the verdicts are tallied per fixture. The runs count wrong-site
//      plans instead of failing on them (the gate fails), and list each one.
//   2. Engine latency on the six named large fixtures (manifest-checked): the
//      plan §5.2 pipeline on a real disk — read and hash, rebuild the snapshot
//      if the bytes changed, plan (diffing when stale), verify witnesses,
//      splice, reparse and reproject the candidate, re-read and hash again,
//      and write through electron/documents/atomicWrite.ts (temp file, fsync, rename,
//      read-back). `fresh`: nothing changed since the intent was authored.
//      `stale`: another editor changed a different attribute first. Edits keep
//      byte length, because bytes-100 sits exactly at sourceBytesMax.
//   3. Last keystroke → disk: the 300 ms typing batch (src/app/App.tsx:462-470,
//      saveDelay) as a real timer, then the fresh pipeline.
// Percentiles are nearest-rank over the recorded samples, after WARMUP unrecorded
// runs per series. Run: npm run spike:editor-core (after npm run fixtures:large).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeVerified } from './verifiedWrite.entry.ts';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { capabilityAcceptsVisualIntent } from '#dist/shared/page/capability.js';
import { toIntent, type Intent } from '#dist/shared/engine/intent.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { toAnchorRef, toChildIndex } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { projectPage, type ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { decodeUtf8, encodeUtf8, toByteString, type ByteString } from '#dist/shared/core/span.js';
import { loadSimulationFixtures } from './fixtures.entry.ts';
import { Prng } from './prng.ts';
import { sha256, snapshotOf } from './project.ts';
import { applySplices, witnessesHold } from '#dist/shared/engine/splice.js';
import { runSimulation } from './world.ts';

const THRESHOLD_INTENT_MS = 50;
const THRESHOLD_KEYSTROKE_MS = 350;
/** The typing batch the persistence layer owns (src/app/App.tsx saveDelay). */
const TYPING_BATCH_MS = 300;
const SIMULATION_STEPS = 400;
const WARMUP = 2;
const BREAKDOWN_RUNS = 5;
const FIXTURES_MAX = 16;
const MANIFEST = path.resolve('test/fixtures/large/manifest.json');

const SEEDS = boundedEnvironment('STACKI_SPIKE_SEEDS', 400, 100_000);
const SAMPLES = boundedEnvironment('STACKI_SPIKE_SAMPLES', 30, 1_000);
const KEYSTROKE_SAMPLES = boundedEnvironment('STACKI_SPIKE_KEYSTROKES', 20, 1_000);

interface FixtureEntry {
  readonly name: string;
  readonly bytes: number;
  readonly nodes: number;
  readonly sha256: string;
}

interface Stages {
  readonly read: number;
  readonly refresh: number;
  readonly plan: number;
  readonly splice: number;
  readonly reproject: number;
  readonly verify: number;
  readonly write: number;
  readonly total: number;
}

type PipelineResult =
  | { readonly tag: 'applied'; readonly stages: Stages; readonly snapshot: Snapshot }
  | { readonly tag: 'rejected'; readonly reason: string; readonly snapshot: Snapshot };

const STAGE_NAMES = ['read', 'refresh', 'plan', 'splice', 'reproject', 'verify', 'write'] as const;

await main();

async function main(): Promise<void> {
  console.log(environmentReport());
  console.log(mappingReport());
  const manifest: unknown = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const fixtures = parseManifest(manifest);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-spike-'));
  try {
    const rows: string[] = [];
    const breakdown: string[] = [];
    const keystrokes: string[] = [];
    for (const fixture of fixtures) {
      const file = stageFixture(directory, fixture);
      breakdown.push(reprojectBreakdown(file, fixture));
      rows.push(latencyRow(file, fixture, 'fresh'), latencyRow(file, fixture, 'stale'));
      keystrokes.push(await keystrokeRow(file, fixture));
    }
    console.log(latencyTable(rows));
    console.log(breakdownTable(breakdown));
    console.log(keystrokeTable(keystrokes));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// --- Part 1: mapping correctness ----------------------------------------------

function mappingReport(): string {
  const fixtures = loadSimulationFixtures();
  const tally: Record<string, number> = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    const input = { seed, steps: SIMULATION_STEPS, wrongSite: 'count' as const, ...fixtures };
    const report = runSimulation(input);
    for (const [key, value] of Object.entries(report.tally)) {
      tally[key] = (tally[key] ?? 0) + value;
    }
  }
  const files = fixtures.files.map((file) => file.name);
  const lines = [
    `## Mapping correctness: ${SEEDS} seeds × ${SIMULATION_STEPS} steps`,
    '',
    '| Fixture | Stale decisions | Applied, correct | Wrong site | Conservative | ' + 'Rejected, conflict | Rejected, gone | Other | Unjudged |',
    '|---|---|---|---|---|---|---|---|---|',
    ...files.map((name) => mappingRow(name, perFile(tally, name))),
    mappingRow('**All**', perFile(tally, undefined)),
    '',
    `Fresh set-attribute decisions (identity, no diff): ${tally['mapping:identity'] ?? 0}.`,
    `Brute-force reference agreed on ${tally['reference:agreed'] ?? 0} stale decisions; ` +
      `${tally['reference:skipped'] ?? 0} skipped (file over the reference table bound, or ` +
      'rejected before mapping).',
    `Authored snapshot age, in actor snapshots before the current one: ${ages(tally)}.`,
    '',
    'Wrong-site plans:',
    ...wrongSites(tally),
    '',
    'Verdict detail (all fixtures):',
    ...Object.entries(tally)
      .filter(([key]) => key.startsWith('remap:'))
      .sort()
      .map(([key, value]) => `- ${key.slice('remap:'.length)}: ${value}`),
    '',
  ];
  return lines.join('\n');
}

function perFile(tally: Record<string, number>, name: string | undefined): Record<string, number> {
  const verdicts: Record<string, number> = {};
  for (const [key, value] of Object.entries(tally)) {
    if (name === undefined) {
      if (key.startsWith('remap:')) {
        const verdict = key.slice('remap:'.length).split(' ')[0] ?? '';
        verdicts[verdict] = (verdicts[verdict] ?? 0) + value;
      }
    } else if (key.startsWith(`remap-file:${name}|`)) {
      const verdict = key.slice(`remap-file:${name}|`.length).split(' ')[0] ?? '';
      verdicts[verdict] = (verdicts[verdict] ?? 0) + value;
    }
  }
  return verdicts;
}

function mappingRow(name: string, verdicts: Record<string, number>): string {
  const count = (verdict: string) => verdicts[verdict] ?? 0;
  const total = Object.values(verdicts).reduce((sum, value) => sum + value, 0);
  const cells = [
    total,
    count('applied-correct'),
    count('wrong-site'),
    count('conservative'),
    count('rejected-conflict'),
    count('rejected-gone'),
    count('other'),
    count('unjudged'),
  ];
  return `| ${name} | ${cells.join(' | ')} |`;
}

function wrongSites(tally: Record<string, number>): readonly string[] {
  const found = Object.keys(tally)
    .filter((key) => key.startsWith('remap-wrong-site:'))
    .map((key) => `- ${key.slice('remap-wrong-site:'.length)}`);
  return found.length === 0 ? ['- none'] : found;
}

function ages(tally: Record<string, number>): string {
  return ['1', '2', '3+', 'unseen'].map((age) => `${age}: ${tally[`authored-age:${age}`] ?? 0}`).join(', ');
}

// --- Part 2: engine latency -----------------------------------------------------

/** One series of SAMPLES intents on one fixture, each authored against the
 * actor's snapshot; `stale` changes another attribute on disk first. */
function latencyRow(file: string, fixture: FixtureEntry, scenario: 'fresh' | 'stale'): string {
  const prng = new Prng(scenario === 'fresh' ? 1 : 2);
  let snapshot = snapshotOf(toFilePath(file), readBounded(file));
  const recorded: Stages[] = [];
  const rejected: string[] = [];
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const target = pickTarget(prng, snapshot, undefined);
    if (scenario === 'stale') {
      const other = pickTarget(prng, snapshot, target.node);
      writeExternally(file, snapshot.bytes, other, index);
    }
    const intent = setAttributeIntent(snapshot, target, index);
    const result = runPipeline(file, snapshot, intent);
    snapshot = result.snapshot;
    if (index < WARMUP) {
      continue;
    }
    if (result.tag === 'applied') {
      recorded.push(result.stages);
    } else {
      rejected.push(result.reason);
    }
  }
  const totals = recorded.map((stages) => stages.total);
  const percentile95 = percentile(totals, 95);
  const medians = STAGE_NAMES.map((name) =>
    format(
      percentile(
        recorded.map((sample) => sample[name]),
        50,
      ),
    ),
  );
  const verdict = percentile95 <= THRESHOLD_INTENT_MS ? 'pass' : 'FAIL';
  const outcome = `${recorded.length} / ${rejected.length}${rejectionNote(rejected)}`;
  const cells = [fixture.name, scenario, outcome, format(percentile(totals, 50)), format(percentile95)];
  return `| ${[...cells, format(Math.max(...totals)), verdict, ...medians].join(' | ')} |`;
}

/** The plan §5.2 pipeline, steps 1–10, with the fake disk swapped for the real
 * one: the actor's snapshot in, the committed (or refreshed) snapshot out. */
function runPipeline(file: string, held: Snapshot, intent: Intent): PipelineResult {
  const clock = lapClock();
  const bytes = readBounded(file); // §5.2 step 1.
  const checksum = sha256(bytes);
  const read = clock();
  const current = checksum === held.checksum ? held : snapshotOf(held.path, bytes);
  const refresh = clock();
  const planned = planIntent({ authored: held, current }, intent); // Steps 2–3.
  const plan = clock();
  if (!planned.ok) {
    return { tag: 'rejected', reason: planned.error, snapshot: current };
  }
  const splices = planned.value.splices;
  if (!witnessesHold(current.bytes, splices)) {
    return { tag: 'rejected', reason: 'region-externally-modified', snapshot: current };
  }
  const candidateBytes = applySplices(current.bytes, splices); // Steps 4–5.
  const splice = clock();
  const candidate = snapshotOf(held.path, candidateBytes); // Step 6.
  if (candidate.projection.tag === 'parse-error') {
    return { tag: 'rejected', reason: 'source-invalid', snapshot: current };
  }
  const reproject = clock();
  if (sha256(readBounded(file)) !== current.checksum) {
    return { tag: 'rejected', reason: 'region-externally-modified', snapshot: current }; // Step 7.
  }
  const verify = clock();
  const text = decodeUtf8(candidate.bytes);
  if (!text.ok) {
    throw new Error('Assertion failed: a candidate that parsed is UTF-8');
  }
  const written = writeVerified(file, text.value); // Steps 8–9.
  if (!written.ok) {
    return { tag: 'rejected', reason: written.error.code, snapshot: current };
  }
  if (written.value !== candidate.checksum) {
    throw new Error('Assertion failed: the disk holds the candidate after the write');
  }
  const write = clock();
  const total = read + refresh + plan + splice + reproject + verify + write;
  const stages = { read, refresh, plan, splice, reproject, verify, write, total };
  return { tag: 'applied', stages, snapshot: candidate }; // Step 10.
}

interface Target {
  readonly node: ProjectedNode;
  readonly name: string;
  readonly valueBytes: number;
}

/** A string attribute on an editable element, unique on it, with a non-empty
 * value; never `avoid`, the element the other writer is about to edit. */
function pickTarget(prng: Prng, snapshot: Snapshot, avoid: ProjectedNode | undefined): Target {
  const projection = snapshot.projection;
  if (projection.tag === 'parse-error') {
    throw new Error('Assertion failed: the large fixtures parse');
  }
  const targets: Target[] = [];
  for (const node of projection.nodes) {
    if (node.span.start === avoid?.span.start) {
      continue;
    }
    if (!capabilityAcceptsVisualIntent(node.capability)) {
      continue;
    }
    for (const attribute of node.attributes) {
      const value = attribute.valueSpan;
      if (attribute.type === 'string' && value !== undefined && value.end > value.start) {
        if (node.attributes.filter((other) => other.name === attribute.name).length === 1) {
          targets.push({ node, name: attribute.name, valueBytes: value.end - value.start });
        }
      }
    }
  }
  if (targets.length === 0) {
    throw new Error('Assertion failed: a large fixture has editable attributes');
  }
  return prng.pick(targets);
}

function setAttributeIntent(snapshot: Snapshot, target: Target, index: number): Intent {
  const node = target.node;
  const anchor = toAnchorRef({
    span: node.span,
    path: node.path.map(toChildIndex),
    expectedKind: node.kind,
  });
  const value = { type: 'string' as const, value: sameLengthValue(target.valueBytes, index) };
  return toIntent({
    id: toIntentId(`spike-${index}`),
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor,
    operation: { tag: 'set-attribute', name: target.name, value },
  });
}

/** The other editor: rewrites another element's attribute value in place, with
 * the same byte length, so the file size never moves past sourceBytesMax. */
function writeExternally(file: string, bytes: ByteString, target: Target, index: number): void {
  const value = target.node.attributes.find((attribute) => attribute.name === target.name)?.valueSpan;
  if (value === undefined) {
    throw new Error('Assertion failed: the external target has a value');
  }
  const next = new Uint8Array(bytes);
  next.set(encodeUtf8(sameLengthValue(target.valueBytes, index + 13)), value.start);
  fs.writeFileSync(file, next);
}

/** ASCII letters of exactly `bytes` bytes; no quote, so every edit is plannable. */
function sameLengthValue(bytes: number, seed: number): string {
  return Array.from({ length: bytes }, (_, offset) => String.fromCharCode(97 + ((seed + offset) % 26))).join('');
}

// Where the reprojection time goes, for the step-4 lever (plan §12: incremental
// reparse): the parser, the wire validation, the projection, the hash.
function reprojectBreakdown(file: string, fixture: FixtureEntry): string {
  const bytes = readBounded(file);
  const series: Record<'decode' | 'parse' | 'validate' | 'project' | 'hash', number[]> = {
    decode: [],
    parse: [],
    validate: [],
    project: [],
    hash: [],
  };
  for (let run = 0; run < WARMUP + BREAKDOWN_RUNS; run++) {
    const clock = lapClock();
    const text = decodeUtf8(bytes);
    if (!text.ok) {
      throw new Error('Assertion failed: the large fixtures are UTF-8');
    }
    const decode = clock();
    const parsed: unknown = parsePage(text.value, { locs: true });
    const parse = clock();
    const result = parsePageResult(parsed);
    const validate = clock();
    const projection = projectPage(text.value, result);
    const project = clock();
    sha256(bytes);
    const hash = clock();
    if (projection.tag !== 'valid') {
      throw new Error('Assertion failed: the large fixtures project');
    }
    if (run >= WARMUP) {
      series.decode.push(decode);
      series.parse.push(parse);
      series.validate.push(validate);
      series.project.push(project);
      series.hash.push(hash);
    }
  }
  const cells = Object.values(series).map((values) => format(percentile(values, 50)));
  return `| ${fixture.name} | ${cells.join(' | ')} |`;
}

// --- Part 3: last keystroke → disk ---------------------------------------------

async function keystrokeRow(file: string, fixture: FixtureEntry): Promise<string> {
  const prng = new Prng(3);
  let snapshot = snapshotOf(toFilePath(file), readBounded(file));
  const latencies: number[] = [];
  const lateness: number[] = [];
  for (let index = 0; index < WARMUP + KEYSTROKE_SAMPLES; index++) {
    const intent = setAttributeIntent(snapshot, pickTarget(prng, snapshot, undefined), index);
    const keystroke = performance.now();
    await new Promise((resolve) => setTimeout(resolve, TYPING_BATCH_MS));
    const fired = performance.now();
    const result = runPipeline(file, snapshot, intent);
    const landed = performance.now();
    if (result.tag !== 'applied') {
      throw new Error(`Assertion failed: a fresh intent applies (${result.reason})`);
    }
    snapshot = result.snapshot;
    if (index >= WARMUP) {
      latencies.push(landed - keystroke);
      lateness.push(fired - keystroke - TYPING_BATCH_MS);
    }
  }
  const percentile95 = percentile(latencies, 95);
  const verdict = percentile95 <= THRESHOLD_KEYSTROKE_MS ? 'pass' : 'FAIL';
  const cells = [format(percentile(latencies, 50)), format(percentile95), format(Math.max(...latencies))];
  const row = [fixture.name, ...cells, format(percentile(lateness, 95)), verdict];
  return `| ${row.join(' | ')} |`;
}

// --- Helpers ------------------------------------------------------------------------

/** Milliseconds since the previous lap (or since the clock was made). */
function lapClock(): () => number {
  let last = performance.now();
  return () => {
    const now = performance.now();
    const lap = now - last;
    last = now;
    return lap;
  };
}

/** Nearest-rank percentile: the smallest sample with at least p % at or below it. */
function percentile(values: readonly number[], percent: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percent / 100) * sorted.length);
  const value = sorted[Math.max(rank, 1) - 1];
  if (value === undefined) {
    throw new Error('Assertion failed: a nearest rank lies inside the samples');
  }
  return value;
}

function format(milliseconds: number): string {
  return Number.isNaN(milliseconds) ? '—' : milliseconds.toFixed(1);
}

function rejectionNote(reasons: readonly string[]): string {
  if (reasons.length === 0) {
    return '';
  }
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return ` (${[...counts].map(([reason, count]) => `${reason} ${count}`).join(', ')})`;
}

function readBounded(file: string): ByteString {
  const size = fs.statSync(file).size;
  if (size > LIMITS.sourceBytesMax) {
    throw new Error(`Assertion failed: ${file} is inside sourceBytesMax`);
  }
  return toByteString(fs.readFileSync(file));
}

/** Copy one named fixture into the scratch directory, after checking it is
 * the manifest's exact bytes: the thresholds are registered against these. */
function stageFixture(directory: string, fixture: FixtureEntry): string {
  const source = path.resolve('test/fixtures/large', `${fixture.name}.astro`);
  if (!fs.existsSync(source)) {
    throw new Error(`${source} is missing: run npm run fixtures:large first`);
  }
  const bytes = fs.readFileSync(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== fixture.sha256) {
    throw new Error(`${fixture.name}: bytes differ from the manifest; regenerate the fixtures`);
  }
  const target = path.join(directory, `${fixture.name}.astro`);
  fs.writeFileSync(target, bytes);
  return target;
}

// The manifest is a file: parsed at the boundary, bounded, never cast.
function parseManifest(input: unknown): readonly FixtureEntry[] {
  if (!Array.isArray(input)) {
    throw new Error('manifest: expected an array');
  }
  if (input.length === 0 || input.length > FIXTURES_MAX) {
    throw new Error(`manifest: expected 1 to ${FIXTURES_MAX} fixtures`);
  }
  return input.map((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`manifest[${index}]: expected an object`);
    }
    const name: unknown = Reflect.get(entry, 'name');
    const bytes: unknown = Reflect.get(entry, 'bytes');
    const nodes: unknown = Reflect.get(entry, 'nodes');
    const digest: unknown = Reflect.get(entry, 'sha256');
    if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) {
      throw new Error(`manifest[${index}].name: expected a fixture name`);
    }
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes > LIMITS.sourceBytesMax) {
      throw new Error(`manifest[${index}].bytes: expected a size inside sourceBytesMax`);
    }
    if (typeof nodes !== 'number' || !Number.isSafeInteger(nodes) || nodes > LIMITS.treeNodesMax) {
      throw new Error(`manifest[${index}].nodes: expected a count inside treeNodesMax`);
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`manifest[${index}].sha256: expected 64 lowercase hex characters`);
    }
    return { name, bytes, nodes, sha256: digest };
  });
}

function boundedEnvironment(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name}: expected an integer from 1 to ${max}`);
  }
  return value;
}

function environmentReport(): string {
  const cpus = os.cpus();
  return [
    '# Editor-core spike report',
    '',
    `Node ${process.version}, ${os.platform()} ${os.release()}, ` +
      `${cpus[0]?.model ?? 'unknown CPU'} ` +
      `× ${cpus.length}; scratch disk ${os.tmpdir()}. Samples: ${SAMPLES} per latency series, ` +
      `${KEYSTROKE_SAMPLES} per keystroke series, ${WARMUP} warm-up runs each.`,
    '',
  ].join('\n');
}

function latencyTable(rows: readonly string[]): string {
  return [
    `## Intent → applied (threshold p95 ≤ ${THRESHOLD_INTENT_MS} ms), milliseconds`,
    '',
    '| Fixture | Scenario | Applied / rejected | p50 | p95 | max | Verdict | ' + STAGE_NAMES.map((name) => `${name} p50`).join(' | ') + ' |',
    `|${'---|'.repeat(7 + STAGE_NAMES.length)}`,
    ...rows,
    '',
  ].join('\n');
}

function breakdownTable(rows: readonly string[]): string {
  return [
    `## Reprojection breakdown, p50 of ${BREAKDOWN_RUNS} runs, milliseconds`,
    '',
    '| Fixture | decode | parsePage | parsePageResult | projectPage | sha256 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function keystrokeTable(rows: readonly string[]): string {
  return [
    `## Last keystroke → disk (threshold p95 ≤ ${THRESHOLD_KEYSTROKE_MS} ms), milliseconds`,
    '',
    `${TYPING_BATCH_MS} ms typing batch as a real timer, then the fresh pipeline.`,
    '',
    '| Fixture | p50 | p95 | max | Timer lateness p95 | Verdict |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
