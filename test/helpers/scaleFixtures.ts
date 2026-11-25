// Goal: one place for the measurements every "no size limit" suite shares, so
// the numbers they print are comparable: how big the generated input is, how
// long an operation took, and the longest the event loop was blocked meanwhile.
// Method: `measureOperation` runs an async operation while Node's
// `monitorEventLoopDelay` histogram samples the loop every few milliseconds,
// then reports wall time and the largest delay seen. A slice that blocked for
// longer than the sampling period shows up as that delay, so an operation meant
// to yield proves it by keeping `lagMsMax` under a stated bound. Inputs are
// generated under os.tmpdir by each suite (never committed) and sized by
// `scaleMegabytes()`: STACKI_SCALE_MB raises it for manual runs.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/** Megabytes of the biggest generated input. Moderate by default so the gate stays fast. */
export function scaleMegabytes(): number {
  const raw = process.env['STACKI_SCALE_MB'];
  if (raw === undefined || raw === '') {
    return 24;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('STACKI_SCALE_MB must be a number of megabytes, at least 1');
  }
  return parsed;
}

// The bound is relative, not absolute: 250 ms on the reference machine (the maintainer's Mac,
// where the calibration below takes CALIBRATION_REFERENCE_MS), scaled by how much slower this
// process runs the same fixed workload, measured once per process. A loaded shared CI runner is
// then held to the same standard as the Mac instead of failing on 278 ms against 250 (1.4.7,
// astroEditorScale on macOS). The factor never goes below 1 (the bound is never stricter than
// before) and is capped at 4: an operation that does not yield at all blocks for seconds and still
// fails everywhere.
export const LAG_LIMITS = {
  lagMsReference: 250,
  calibrationReferenceMs: 15,
  calibrationRuns: 7,
  factorMax: 4,
} as const satisfies Record<string, number>;

/** A fixed CPU workload like a slice of grammar work: regular expressions and JSON over markup. */
export function calibrationWorkload(): number {
  let text = '';
  for (let index = 0; index < 4000; index += 1) {
    text += `<p class="row-${index}" data-index={${index}}>{title} item ${index}</p>\n`;
  }
  let count = 0;
  for (let pass = 0; pass < 18; pass += 1) {
    for (const match of text.matchAll(/<(\w+)\s+class="([^"]*)"[^>]*>/g)) {
      count += (match[2] ?? '').length;
    }
    const rows: unknown = JSON.parse(JSON.stringify(text.split('\n').map((line, index) => ({ line, index }))));
    count += Array.isArray(rows) ? rows.length : 0;
  }
  return count;
}

/** How much slower than the reference this process runs the workload: the median of several runs. */
export function measureSpeedFactor(time: () => number = () => performance.now()): number {
  calibrationWorkload();
  const durations: number[] = [];
  for (let run = 0; run < LAG_LIMITS.calibrationRuns; run += 1) {
    const started = time();
    calibrationWorkload();
    durations.push(time() - started);
  }
  durations.sort((left, right) => left - right);
  const median = durations[Math.floor(durations.length / 2)] ?? LAG_LIMITS.calibrationReferenceMs;
  return speedFactorFor(median);
}

/** The factor for one measured calibration time, clamped to [1, factorMax]. */
export function speedFactorFor(calibrationMs: number): number {
  if (!Number.isFinite(calibrationMs) || calibrationMs <= 0) {
    throw new Error('speedFactorFor: the calibration time is a positive number of milliseconds');
  }
  return Math.min(LAG_LIMITS.factorMax, Math.max(1, calibrationMs / LAG_LIMITS.calibrationReferenceMs));
}

let speedFactorCached: number | undefined;

/** Longest event-loop block, in milliseconds, an operation meant to yield may show. STACKI_SCALE_LAG_MS overrides it. */
export function lagMsBound(): number {
  const raw = process.env['STACKI_SCALE_LAG_MS'];
  if (raw === undefined || raw === '') {
    speedFactorCached ??= measureSpeedFactor();
    const bound = Math.round(LAG_LIMITS.lagMsReference * speedFactorCached);
    console.log(`SCALE lag bound ${bound} ms (speed factor ${speedFactorCached.toFixed(2)} against the reference machine)`);
    return bound;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('STACKI_SCALE_LAG_MS must be a number of milliseconds, at least 1');
  }
  return parsed;
}

export interface ScaleMeasurement<T> {
  readonly value: T;
  readonly wallMs: number;
  /** The longest the event loop was blocked while the operation ran. */
  readonly lagMsMax: number;
}

const SAMPLE_PERIOD_MS = 5;

/**
 * Run `operation`, print one line of numbers under `label`, and return them.
 * The printed line is the record the report quotes: `SCALE <label> ...`.
 */
export async function measureOperation<T>(label: string, detail: string, operation: () => Promise<T>): Promise<ScaleMeasurement<T>> {
  const histogram = monitorEventLoopDelay({ resolution: SAMPLE_PERIOD_MS });
  histogram.enable();
  // Let the monitor's first timer arm so the setup above is not counted.
  await new Promise<void>((resolve) => setTimeout(resolve, SAMPLE_PERIOD_MS * 2));
  const started = performance.now();
  try {
    const value = await operation();
    const wallMs = performance.now() - started;
    // The monitor reports delay beyond its resolution; the nanosecond max is the worst single block.
    const lagMsMax = Math.max(0, histogram.max / 1e6 - SAMPLE_PERIOD_MS);
    console.log(`SCALE ${label} ${detail} wallMs=${Math.round(wallMs)} lagMsMax=${Math.round(lagMsMax)}`);
    return { value, wallMs, lagMsMax };
  } finally {
    histogram.disable();
  }
}

/** A deterministic pseudo-random sequence, so a failing size reproduces. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
