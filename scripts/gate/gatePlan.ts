// What one gate run builds and checks, decided before anything runs.
//
// `npm test` with no suite named is the full gate CI runs: a clean output
// tree, every build, every static check, every suite. Naming suites
// (`npm test -- panelField`) asks a narrower question — do these suites pass
// against the current sources? — so the run builds what the suites load and
// nothing else. The static checks (tsc, ESLint, Prettier, the policy scan, the
// adapter ratchet) answer for the whole tree, not for a suite: the stop hook
// and `npm run check:changed` run them on changed files, and the full gate and
// CI run them on everything. Before this split, naming one suite still cost
// every check over the whole repository (about three minutes) before the
// suite started.

import type { Suite } from './testDiscovery';
import type { Shard } from './testShard';

export type ChecksPart = 'checks-all' | 'checks-desktop' | 'checks-studio';

export type BuildStage = 'build:contracts' | 'build:electron' | 'build:scripts' | 'build:morph' | 'build:preload' | 'stage:runtime' | 'build:web';

export interface GatePlan {
  // `full`: clean the output tree first, then every static check after the
  // builds. `targeted`: build over the existing tree; no static checks.
  readonly kind: 'full' | 'targeted';
  // Builds that run one after another. The TypeScript emits share output
  // folders (shared, electron and preload all emit dist/shared), so running
  // them together would race on the same files.
  readonly chain: readonly BuildStage[];
  // Builds that share no output with the chain and read none of it, run beside
  // it. The renderer bundle (vite) reads src/ and shared/ sources and writes
  // only dist/renderer.
  readonly beside: readonly BuildStage[];
  // `run` for the full gate and for the checks-only runs (CI's `static` and `studio` jobs); `skip` for every
  // shard and for named suites. The checks-only runs plus the n shards are the full gate (testShard.ts).
  readonly staticChecks: 'run' | 'skip';
}

const CHAIN_FULL: readonly BuildStage[] = ['build:contracts', 'build:electron', 'build:scripts', 'build:morph', 'build:preload', 'stage:runtime'];

// `npm test` builds the scripts before the runner starts (package.json), and a
// targeted run keeps the tree, so the scripts are already current.
const CHAIN_TARGETED: readonly BuildStage[] = CHAIN_FULL.filter((stage) => stage !== 'build:scripts');

export function gatePlanFor(input: {
  readonly queries: readonly string[];
  readonly selected: readonly Suite[];
  readonly shard?: Shard;
  // A checks-only run: the builds and the static checks, no suites (CI runs the suites in
  // shards). `checks-all` is every check; CI splits them into `checks-desktop` (everything but
  // Studio's verify) and `checks-studio` (Studio's verify alone, its own long job).
  readonly part?: ChecksPart;
}): GatePlan {
  if (input.selected.length === 0) {
    throw new Error('gatePlanFor: no suite is selected');
  }
  if (input.shard !== undefined && input.queries.length > 0) {
    throw new Error('gatePlanFor: a shard splits the full gate; it cannot be combined with named suites');
  }
  if (input.shard !== undefined && input.part !== undefined) {
    throw new Error('gatePlanFor: a run is a shard of the suites or the checks, not both');
  }
  if (input.part !== undefined && input.queries.length > 0) {
    throw new Error('gatePlanFor: a checks-only run names no suites');
  }
  if (input.queries.length === 0) {
    const staticChecks = input.shard === undefined ? 'run' : 'skip';
    return { kind: 'full', chain: CHAIN_FULL, beside: ['build:web'], staticChecks };
  }
  const renderer = input.selected.some((suite) => suite.options.build === 'renderer');
  const plan: GatePlan = {
    kind: 'targeted',
    chain: CHAIN_TARGETED,
    beside: renderer ? ['build:web'] : [],
    staticChecks: 'skip',
  };
  if (plan.chain.includes('build:web')) {
    throw new Error('gatePlanFor: the renderer bundle never runs in the chain');
  }
  if (plan.chain.at(-1) !== 'stage:runtime') {
    throw new Error('gatePlanFor: staging copies beside compiled code, so it runs last');
  }
  return plan;
}

/** The one line a targeted run prints, so a skipped check is never a surprise. */
export function targetedNotice(plan: GatePlan): string {
  if (plan.kind !== 'targeted') {
    throw new Error('targetedNotice: only a targeted run skips anything');
  }
  const renderer = plan.beside.includes('build:web') ? '' : ', the renderer bundle';
  return (
    `[gate] Named suites only: skipping the clean, tsc, ESLint, Prettier, the policy ` +
    `scan, adapter-surface, test-timing${renderer}. \`npm test\` with no suite runs the full gate.`
  );
}
