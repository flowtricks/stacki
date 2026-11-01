// Goal: what the projection patch (shared/engine/projectionPatch.ts) and the word-wise
// byteStringsEqual buy on the plan §5.2 pipeline, on the six named large
// fixtures (step-4 latency experiment). A measurement, not a test.
// Method: the spike's pipeline (spike.bench.ts runPipeline), with the candidate
// projection either reparsed (`reparse`, the step-3 engine) or patched
// (`patch`). The two variants alternate intent by intent on the same file in
// one process, so machine load lands on both alike; compare them, not the
// absolute numbers. Every patched candidate is also reparsed, off the clock,
// and must deep-equal it — the brute-force reference on the large fixtures.
// `stale` changes another attribute on disk first; its refresh (a full reparse
// of the other writer's bytes) is reported apart, because an actor that
// refreshes on the watcher tick takes it off the intent's path.
// Step 4, revision A: this bench is the registered harness for E, U1, U2, S and
// P (tracker, Thresholds). It prints the 1-minute load average before any
// result (a run above 1.5 is void), then the stage table, the keystroke table,
// and the verdicts, computed here rather than read off by eye. "Engine" is
// plan + splice + project per sample; the refresh, the §5.2 disk work and the
// candidate's SHA-256 are protocol work, recorded beside it.
// Run: npm run build:runtime && node test/simulator/patch.bench.ts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeVerified } from './verifiedWrite.entry.ts';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { countOccurrences } from '#dist/shared/engine/byteSearch.js';
import { capabilityAcceptsVisualIntent } from '#dist/shared/page/capability.js';
import { toIntent, type Intent } from '#dist/shared/engine/intent.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { planIntent, type Splice } from '#dist/shared/engine/planner.js';
import { hostContext, projectValueSplice, valueBytesNeutral } from '#dist/shared/engine/projectionPatch.js';
import { toAnchorRef, toChildIndex } from '#dist/shared/page/ref.js';
import { createSnapshot, type Snapshot } from '#dist/shared/page/snapshot.js';
import type { ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { byteStringsEqual, decodeUtf8, encodeUtf8, toByteString, type ByteString } from '#dist/shared/core/span.js';
import { Prng } from './prng.ts';
import { projectBytes, sha256, snapshotOf } from './project.ts';
import { applySplices, witnessesHold } from '#dist/shared/engine/splice.js';

// A fixture with no unique element in this many draws fails the bench loudly.
const UNIQUE_DRAWS_MAX = 500;
const ALL = ['nodes-25', 'nodes-50', 'nodes-100', 'bytes-25', 'bytes-50', 'bytes-100'] as const;
// STACKI_PATCH_FIXTURES=bytes-100,nodes-25 narrows the run to named fixtures.
const NAMES = ALL.filter((name) => (process.env['STACKI_PATCH_FIXTURES'] ?? ALL.join(',')).split(',').includes(name));
const SAMPLES = 30;
const KEYSTROKE_SAMPLES = 20;
const TYPING_BATCH_MS = 300;
const LOAD_VOID_ABOVE = 1.5;
// The registered thresholds (tracker, Thresholds, revision A), in milliseconds.
const ENGINE_MS_MAX = 50;
const END_TO_END_MS_MAX = 50;
const KEYSTROKE_MS_MAX = 350;
const REALISTIC: readonly string[] = ['nodes-25', 'nodes-50'];
const WARMUP = 2;
const EQUAL_RUNS = 7;
const STAGES = ['read', 'refresh', 'plan', 'splice', 'project', 'hash', 'verify', 'write'] as const;

type Stage = (typeof STAGES)[number];
type Variant = 'reparse' | 'patch';
type Scenario = 'fresh' | 'stale';
type Stages = Readonly<Record<Stage | 'total', number>>;

// A report counter: which patch-variant candidates were patched, and why the
// others were refused (and reparsed instead). Nothing in the bench reads it back.
const refusals = { patched: 0, host: 0, 'old value': 0, 'new value': 0 };

interface Target {
  readonly node: ProjectedNode;
  readonly name: string;
  readonly valueBytes: number;
}

// Per fixture and scenario, the patch variant's registered p95s.
interface Measured {
  readonly engine: number;
  readonly endToEnd: number;
}

await main();

async function main(): Promise<void> {
  const [load] = os.loadavg();
  assert.ok(load !== undefined, 'The platform reports a load average');
  const verdict = load > LOAD_VOID_ABOVE ? 'VOID (protocol: above 1.5)' : 'counts';
  console.log(`Load average (1 min) at start: ${load.toFixed(2)} — this run ${verdict}.`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-patch-'));
  const rows: string[] = [];
  const equalRows: string[] = [];
  const measured = new Map<string, Measured>();
  const keystrokes = new Map<string, number>();
  let compared = 0;
  try {
    for (const name of NAMES) {
      const file = path.join(directory, `${name}.astro`);
      fs.copyFileSync(path.resolve('test/fixtures/large', `${name}.astro`), file);
      equalRows.push(equalityRow(name, readBounded(file)));
      for (const scenario of ['fresh', 'stale'] as const) {
        const series = runSeries(file, scenario);
        compared += series.compared;
        measured.set(`${name} ${scenario}`, registered(series.patch));
        rows.push(seriesRow(name, scenario, 'reparse', series.reparse));
        rows.push(seriesRow(name, scenario, `patch (${series.patched}/${SAMPLES})`, series.patch));
      }
      if (REALISTIC.includes(name)) {
        const keystroke = await keystrokeSeries(file);
        compared += keystroke.compared;
        keystrokes.set(name, percentile(keystroke.latencies, 95));
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}`);
  console.log(`Patch-variant candidates checked against a full reparse: ${compared}, all equal.`);
  console.log(`Patch variant: ${JSON.stringify(refusals)}\n`);
  const header = STAGES.map((stage) => `${stage} p50`).join(' | ');
  const lead = '| Fixture | Scenario | Variant | p50 | p95 | p95 − refresh | engine p95 |';
  console.log(`${lead} ${header} |`);
  console.log(`|${'---|'.repeat(7 + STAGES.length)}`);
  console.log(rows.join('\n'));
  console.log('\n| Fixture | byteStringsEqual `every` p50 | word loop p50 |');
  console.log('|---|---|---|');
  console.log(equalRows.join('\n'));
  printVerdicts(measured, keystrokes, compared);
}

function registered(runs: readonly Stages[]): Measured {
  const engine = runs.map((stages) => engineOf(stages));
  const endToEnd = runs.map((stages) => stages.total);
  return { engine: percentile(engine, 95), endToEnd: percentile(endToEnd, 95) };
}

function engineOf(stages: Stages): number {
  return stages.plan + stages.splice + stages.project;
}

// Every registered row, and "incomplete" when a narrowed run leaves one
// unmeasured: a verdict is never computed from a partial run.
function printVerdicts(measured: ReadonlyMap<string, Measured>, keystrokes: ReadonlyMap<string, number>, compared: number): void {
  const rows: string[] = [];
  const row = (id: string, where: string, value: number | undefined, max: number): void => {
    if (value === undefined) {
      rows.push(`| ${id} | ${where} | — | ≤ ${max} | incomplete |`);
    } else {
      const verdict = value <= max ? 'pass' : 'FAIL';
      rows.push(`| ${id} | ${where} | ${format(value)} | ≤ ${max} | ${verdict} |`);
    }
  };
  for (const name of ALL) {
    row('E', `${name} fresh, engine p95`, measured.get(`${name} fresh`)?.engine, ENGINE_MS_MAX);
  }
  for (const name of REALISTIC) {
    const endToEnd = measured.get(`${name} fresh`)?.endToEnd;
    row('U1', `${name} fresh, end-to-end p95`, endToEnd, END_TO_END_MS_MAX);
    row('U2', `${name} keystroke → disk p95`, keystrokes.get(name), KEYSTROKE_MS_MAX);
    row('S', `${name} stale, engine p95`, measured.get(`${name} stale`)?.engine, ENGINE_MS_MAX);
  }
  console.log('\n| Id | Measure | ms | Threshold | Verdict |');
  console.log('|---|---|---|---|---|');
  console.log(rows.join('\n'));
  // A mismatch asserts at the event, so reaching here with a count means P held.
  console.log(`| P | patch-variant candidates equal to a reparse | ${compared} | all | pass |`);
}

interface KeystrokeSeries {
  readonly latencies: readonly number[];
  readonly compared: number;
}

// U2: the 300 ms typing batch as a real timer, then the fresh patch pipeline,
// as step 3 measured it (spike.bench.ts keystrokeRow); seed 3, as there.
async function keystrokeSeries(file: string): Promise<KeystrokeSeries> {
  const prng = new Prng(3);
  let snapshot = snapshotOf(toFilePath(file), readBounded(file));
  const latencies: number[] = [];
  let compared = 0;
  for (let index = 0; index < WARMUP + KEYSTROKE_SAMPLES; index++) {
    const intent = setAttributeIntent(snapshot, pickTarget(prng, snapshot, undefined), index);
    const keystroke = performance.now();
    await new Promise((resolve) => setTimeout(resolve, TYPING_BATCH_MS));
    const result = runPipeline(file, snapshot, intent, 'patch');
    const landed = performance.now();
    snapshot = result.snapshot;
    const reference = projectBytes(snapshot.path, snapshot.bytes); // Off the clock.
    assert.deepStrictEqual(snapshot.projection, reference, 'A patched candidate is the reparse');
    compared++;
    if (index >= WARMUP) {
      latencies.push(landed - keystroke);
    }
  }
  return { latencies, compared };
}

interface Series {
  readonly reparse: readonly Stages[];
  readonly patch: readonly Stages[];
  readonly compared: number;
  readonly patched: number;
}

function runSeries(file: string, scenario: Scenario): Series {
  const prng = new Prng(scenario === 'fresh' ? 1 : 2);
  let snapshot = snapshotOf(toFilePath(file), readBounded(file));
  const recorded: Record<Variant, Stages[]> = { reparse: [], patch: [] };
  let compared = 0;
  let patched = 0;
  const iterations = 2 * (WARMUP + SAMPLES);
  for (let index = 0; index < iterations; index++) {
    const variant: Variant = index % 2 === 0 ? 'reparse' : 'patch';
    // A stale intent on an element whose identity bytes repeat is refused by
    // the uniqueness guard (planner.ts), by design; the bench measures the
    // applied path, so its stale targets are unique in the file.
    const target = scenario === 'stale' ? pickUniqueTarget(prng, snapshot) : pickTarget(prng, snapshot, undefined);
    if (scenario === 'stale') {
      writeExternally(file, snapshot.bytes, pickTarget(prng, snapshot, target.node), index);
    }
    const intent = setAttributeIntent(snapshot, target, index);
    const result = runPipeline(file, snapshot, intent, variant);
    snapshot = result.snapshot;
    if (variant === 'patch') {
      const reference = projectBytes(snapshot.path, snapshot.bytes); // Off the clock.
      assert.deepStrictEqual(snapshot.projection, reference, 'A patched candidate is the reparse');
      compared++;
    }
    if (index >= 2 * WARMUP) {
      recorded[variant].push(result.stages);
      patched += result.patched ? 1 : 0;
    }
  }
  return { reparse: recorded.reparse, patch: recorded.patch, compared, patched };
}

interface PipelineResult {
  readonly stages: Stages;
  readonly snapshot: Snapshot;
  readonly patched: boolean;
}

function runPipeline(file: string, held: Snapshot, intent: Intent, variant: Variant): PipelineResult {
  const clock = lapClock();
  const bytes = readBounded(file);
  const checksum = sha256(bytes);
  const read = clock();
  const current = checksum === held.checksum ? held : snapshotOf(held.path, bytes);
  const refresh = clock();
  const planned = planIntent({ authored: held, current }, intent);
  const plan = clock();
  assert.ok(planned.ok, 'Every bench intent plans');
  const splices = planned.value.splices;
  assert.ok(witnessesHold(current.bytes, splices), 'Witnesses hold on the bench file');
  const candidateBytes = applySplices(current.bytes, splices);
  const splice = clock();
  const [only] = splices;
  assert.ok(only !== undefined, 'A set-attribute plans one splice');
  const patched = variant === 'patch' ? projectValueSplice(current.projection, current.bytes, only) : undefined;
  if (variant === 'patch') {
    refusals[patched === undefined ? refusalReason(current, only) : 'patched']++;
  }
  const projection = patched ?? projectBytes(held.path, candidateBytes);
  const project = clock();
  const candidate = createSnapshot({ path: held.path, bytes: candidateBytes, projection }, sha256);
  const hash = clock();
  assert.equal(sha256(readBounded(file)), current.checksum, 'Nobody wrote during the bench');
  const verify = clock();
  const text = decodeUtf8(candidate.bytes);
  assert.ok(text.ok, 'A candidate is UTF-8');
  const written = writeVerified(file, text.value);
  assert.ok(written.ok, 'The bench write succeeds');
  const write = clock();
  const total = read + refresh + plan + splice + project + hash + verify + write;
  const stages = { read, refresh, plan, splice, project, hash, verify, write, total };
  return { stages, snapshot: candidate, patched: patched !== undefined };
}

// Report only: why the patch refused, by the rule's own parts (revision B's
// host contexts replaced revision A's single "host under an expression").
function refusalReason(current: Snapshot, splice: Splice): 'host' | 'old value' | 'new value' {
  const context = hostContext(current.projection, splice.range);
  if (context === 'refused') {
    return 'host';
  }
  return valueBytesNeutral(splice.expectedBytes, context) ? 'new value' : 'old value';
}

function seriesRow(name: string, scenario: Scenario, variant: string, runs: readonly Stages[]) {
  const totals = runs.map((stages) => stages.total);
  const offPath = runs.map((stages) => stages.total - stages.refresh);
  const engine = runs.map((stages) => engineOf(stages));
  const medians = STAGES.map((stage) =>
    format(
      percentile(
        runs.map((run) => run[stage]),
        50,
      ),
    ),
  );
  const cells = [format(percentile(totals, 50)), format(percentile(totals, 95))];
  const offCells = [format(percentile(offPath, 95)), format(percentile(engine, 95))];
  const row = [name, scenario, variant, ...cells, ...offCells, ...medians];
  return `| ${row.join(' | ')} |`;
}

// The identity fast path's assertion, old against new, on two copies of the
// fixture: the `every` closure the spike measured, and the word loop.
function equalityRow(name: string, bytes: ByteString): string {
  const copy = toByteString(bytes);
  const every = (left: ByteString, right: ByteString) => left.length === right.length && left.every((byte, index) => byte === right[index]);
  const series: Record<'every' | 'words', number[]> = { every: [], words: [] };
  for (let run = 0; run < EQUAL_RUNS; run++) {
    let start = performance.now();
    assert.ok(every(bytes, copy));
    series.every.push(performance.now() - start);
    start = performance.now();
    assert.ok(byteStringsEqual(bytes, copy));
    series.words.push(performance.now() - start);
  }
  const every50 = format(percentile(series.every, 50));
  return `| ${name} | ${every50} | ${format(percentile(series.words, 50))} |`;
}

function pickTarget(prng: Prng, snapshot: Snapshot, avoid: ProjectedNode | undefined): Target {
  const projection = snapshot.projection;
  assert.equal(projection.tag, 'valid', 'The large fixtures parse');
  const targets: Target[] = [];
  for (const node of projection.tag === 'valid' ? projection.nodes : []) {
    if (node.span.start === avoid?.span.start || !capabilityAcceptsVisualIntent(node.capability)) {
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
  assert.ok(targets.length > 0, 'A large fixture has editable attributes');
  return prng.pick(targets);
}

// Random editable targets, drawn until one's identity region (tag name through
// its last attribute, planner.ts) occurs once in the file.
function pickUniqueTarget(prng: Prng, snapshot: Snapshot): Target {
  for (let draw = 0; draw < UNIQUE_DRAWS_MAX; draw++) {
    const target = pickTarget(prng, snapshot, undefined);
    const node = target.node;
    const end = node.attributes.reduce((last, attribute) => Math.max(last, attribute.span.end), 0);
    assert.ok(end > node.span.start + 1, 'A target with an attribute has an identity region');
    const region = toByteString(snapshot.bytes.subarray(node.span.start + 1, end));
    if (countOccurrences(snapshot.bytes, region, 2) === 1) {
      return target;
    }
  }
  throw new Error(`No unique target in ${UNIQUE_DRAWS_MAX} draws`);
}

function setAttributeIntent(snapshot: Snapshot, target: Target, index: number): Intent {
  const node = target.node;
  const path = node.path.map(toChildIndex);
  const anchor = toAnchorRef({ span: node.span, path, expectedKind: node.kind });
  const value = { type: 'string' as const, value: sameLengthValue(target.valueBytes, index) };
  return toIntent({
    id: toIntentId(`patch-${index}`),
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor,
    operation: { tag: 'set-attribute', name: target.name, value },
  });
}

function writeExternally(file: string, bytes: ByteString, target: Target, index: number): void {
  const found = target.node.attributes.find((attribute) => attribute.name === target.name);
  const value = found?.valueSpan;
  assert.ok(value !== undefined, 'The external target has a value');
  const next = new Uint8Array(bytes);
  next.set(encodeUtf8(sameLengthValue(target.valueBytes, index + 13)), value.start);
  fs.writeFileSync(file, next);
}

function sameLengthValue(bytes: number, seed: number): string {
  return Array.from({ length: bytes }, (_, offset) => String.fromCharCode(97 + ((seed + offset) % 26))).join('');
}

function lapClock(): () => number {
  let last = performance.now();
  return () => {
    const now = performance.now();
    const lap = now - last;
    last = now;
    return lap;
  };
}

function percentile(values: readonly number[], percent: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.max(Math.ceil((percent / 100) * sorted.length), 1) - 1];
  assert.ok(value !== undefined, 'A nearest rank lies inside the samples');
  return value;
}

function format(milliseconds: number): string {
  return milliseconds.toFixed(1);
}

function readBounded(file: string): ByteString {
  assert.ok(fs.statSync(file).size <= LIMITS.sourceBytesMax, `${file} is inside sourceBytesMax`);
  return toByteString(fs.readFileSync(file));
}
