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

/** Longest event-loop block, in milliseconds, an operation meant to yield may show. Raise with STACKI_SCALE_LAG_MS on a loaded machine. */
export function lagMsBound(): number {
  const raw = process.env['STACKI_SCALE_LAG_MS'];
  if (raw === undefined || raw === '') {
    return 250;
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
