// Goal: one way to turn timestamped marks into a latency table, and one way to bound a latency
// that does not depend on how fast the machine is. Wall-clock bounds made flaky gates in this
// repository (a busy runner is slow at everything), so a bound here is always a ratio to a
// baseline measured in the same run, on the same machine, under the same load.
//
// Method: a run is a map of mark name to a time in milliseconds (any one clock per run). A stage is
// the time from one mark to another; a run missing either mark does not count for that stage, and
// the table says how many runs did. Percentiles are nearest-rank (no interpolation), so every
// reported value is one that was measured.

const PERCENTILE_MIN = 0;
const PERCENTILE_MAX = 100;
const RUNS_MAX = 10000;

/** The nearest-rank percentile of `values` (undefined when there are none). */
function percentile(values, rank) {
  if (!Number.isFinite(rank)) {
    throw new Error('percentile: rank is a number');
  }
  if (rank < PERCENTILE_MIN || rank > PERCENTILE_MAX) {
    throw new Error(`percentile: rank is within ${PERCENTILE_MIN}..${PERCENTILE_MAX}`);
  }
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((rank / PERCENTILE_MAX) * sorted.length) - 1);
  return sorted[index];
}

/** Each stage's samples across `runs`: `stages` are `{ name, from, to }` mark names. */
function stageSamples(runs, stages) {
  if (runs.length > RUNS_MAX) {
    throw new Error(`stageSamples: at most ${RUNS_MAX} runs`);
  }
  return stages.map((stage) => {
    const samples = [];
    for (const marks of runs) {
      const from = marks[stage.from];
      const to = marks[stage.to];
      if (typeof from === 'number' && typeof to === 'number') {
        samples.push(to - from);
      }
    }
    return { name: stage.name, samples };
  });
}

/** Rows of `{ stage, runs, p50, p95 }`, in milliseconds rounded to a tenth. */
function stageTable(runs, stages) {
  return stageSamples(runs, stages).map(({ name, samples }) => ({
    stage: name,
    runs: samples.length,
    p50: rounded(percentile(samples, 50)),
    p95: rounded(percentile(samples, 95)),
  }));
}

/** The table as Markdown, for a report. */
function markdownTable(rows) {
  const lines = ['| Stage | Runs | p50 ms | p95 ms |', '|---|---|---|---|'];
  for (const row of rows) {
    lines.push(`| ${row.stage} | ${row.runs} | ${row.p50 ?? 'n/a'} | ${row.p95 ?? 'n/a'} |`);
  }
  return lines.join('\n');
}

/**
 * Whether `measured` is within `factorMax` times `baseline` (both from the same run). A baseline
 * of zero is lifted to `floor` so a measurement too quick to time does not divide by nothing.
 */
function withinBaseline({ measured, baseline, factorMax, floor }) {
  if (!(factorMax > 0)) {
    throw new Error('withinBaseline: factorMax is positive');
  }
  if (!(floor > 0)) {
    throw new Error('withinBaseline: floor is positive');
  }
  const reference = Math.max(baseline, floor);
  return { ok: measured <= reference * factorMax, ratio: measured / reference };
}

function rounded(value) {
  return value === undefined ? undefined : Math.round(value * 10) / 10;
}

module.exports = { percentile, stageSamples, stageTable, markdownTable, withinBaseline };
