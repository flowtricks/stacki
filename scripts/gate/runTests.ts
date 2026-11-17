#!/usr/bin/env node
// The gate: builds, static checks, then every test suite under test/.
//
//   npm test                         everything: the full gate CI runs
//   npm test -- hoverCost electron/  suites by name, or every suite under a folder
//   npm test -- --list               the suites, without running them
//   npm test -- --jobs=4             at most four suites at once
//   npm test -- --electron-jobs=2    at most two suites that open Electron windows at once
//   npm test -- --shard=2/4          the full gate's builds and only shard 2 of 4's suites, no static
//                                    checks (testShard.ts), for CI's matrix
//   npm test -- --checks=all         the full gate's builds and static checks, no suites; CI runs
//                --checks=desktop    every check but Studio's verify, and --checks=studio that alone:
//                --checks=studio     with the shards, exactly the full gate
//
// A full, unsharded run that passes writes a marker for the tree it built (gateMarker.ts), which
// lets the pre-push hook skip running the identical gate on the identical tree again.
//
// Naming suites builds what they load over the existing tree and skips the
// clean and the whole-tree static checks (gatePlan.ts says why); the stop hook
// and `npm run check:changed` check changed files.
//
// Suites are found by name (testDiscovery.ts); the few that need a different
// runner, Node flags, the renderer bundle or to run alone say so in
// testSuites.ts. Each runs as a direct spawn with an argument list, never a
// shell line.

import os = require('node:os');
import path = require('node:path');
import { gatePlanFor, targetedNotice, type BuildStage, type ChecksPart } from './gatePlan';
import {
  parseElectronJobs,
  parseJobs,
  POOL_LIMITS,
  runTestCommand,
  runTestPool,
  stopTestPool,
  withDockPreload,
  type TestCommand,
  type TestOutcome,
} from './testPool';
import { repositoryRoot } from '../lib/repoRoot';
import { discoverTestFiles, selectSuites, startsElectron, suitesFor, type Suite } from './testDiscovery';
import { gateVersion, markerFolder, workingTreeHash, writeMarker } from './gateMarker';
import { parseShard, suitesInShard, type Shard } from './testShard';

const root = repositoryRoot();
const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const unknownFlags = flags.filter(
  (flag) =>
    !flag.startsWith('--jobs=') && !flag.startsWith('--electron-jobs=') && !flag.startsWith('--shard=') && !flag.startsWith('--checks=') && flag !== '--list',
);
if (unknownFlags.length > 0) {
  console.error(
    `Unknown flag: ${unknownFlags.join(', ')} (supported: --jobs=<n>, --electron-jobs=<n>, --shard=<k>/<n>, --checks=<all|desktop|studio>, --list)`,
  );
  process.exit(1);
}
const shardFlag = flags.find((flag) => flag.startsWith('--shard='));
const shardParsed = shardFlag === undefined ? undefined : parseShard(shardFlag.slice('--shard='.length));
if (typeof shardParsed === 'string') {
  console.error(shardParsed);
  process.exit(1);
}
const shard: Shard | undefined = shardParsed;
const checksFlag = flags.find((flag) => flag.startsWith('--checks='))?.slice('--checks='.length);
const CHECKS_PARTS: Readonly<Record<string, ChecksPart>> = { all: 'checks-all', desktop: 'checks-desktop', studio: 'checks-studio' };
const checksPart: ChecksPart | undefined = checksFlag === undefined ? undefined : CHECKS_PARTS[checksFlag];
if (checksFlag !== undefined && checksPart === undefined) {
  console.error('--checks takes all, desktop or studio.');
  process.exit(1);
}
const checksOnly = checksPart !== undefined;
if (checksOnly && (shard !== undefined || process.argv.slice(2).some((argument) => !argument.startsWith('--')))) {
  console.error('--checks runs the builds and static checks of the full gate; it takes no shard and no suites.');
  process.exit(1);
}
const jobs = parseJobs(flags.find((flag) => flag.startsWith('--jobs='))?.slice('--jobs='.length), os.availableParallelism());
const electronJobs = parseElectronJobs(flags.find((flag) => flag.startsWith('--electron-jobs='))?.slice('--electron-jobs='.length), jobs);
const queries = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (shard !== undefined && queries.length > 0) {
  console.error('--shard splits the full gate; it cannot be combined with named suites.');
  process.exit(1);
}
const matched = selectSuites(suitesFor(discoverTestFiles(root)), queries);
const unmatched = matched.unmatched;
const selected = shard === undefined ? matched.selected : suitesInShard(matched.selected, shard);
if (selected.length === 0 || unmatched.length > 0) {
  console.error(`No test suite matches: ${unmatched.join(', ')} (npm test -- --list)`);
  process.exit(1);
}
if (flags.includes('--list')) {
  console.log(selected.map((suite) => `${suite.name}  (${suite.file})`).join('\n'));
  process.exit(0);
}

const startedMs = Date.now();
const failed: string[] = [];
const pathValue = process.env['PATH'] ?? '';
const environment = {
  ...process.env,
  PATH: `${path.join(root, 'node_modules', '.bin')}${path.delimiter}${pathValue}`,
};
const node = process.execPath;
// Test commands, and the Electron probes they start, run without a Dock icon (hideDockPreload.js
// says how). The static checks and builds keep the plain environment: nothing there opens a window.
const testEnvironment = {
  ...environment,
  NODE_OPTIONS: withDockPreload(process.env['NODE_OPTIONS'], path.join(root, 'test', 'helpers', 'hideDockPreload.js')),
};
const typeScript = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const plan = gatePlanFor(
  shard !== undefined ? { queries, selected, shard } : checksPart !== undefined ? { queries, selected, part: checksPart } : { queries, selected },
);
// Taken before anything runs, compared after: a marker names only a tree that held still (gateMarker.ts).
const treeHashAtStart = plan.kind === 'full' && shard === undefined && !checksOnly ? workingTreeHash(root) : undefined;
// Node >= 22.18 strips types itself (package.json engines).
const cleanCommand: TestCommand = {
  name: 'build:clean',
  command: node,
  argumentsList: [path.join(root, 'scripts/build/cleanBuild.mts')],
};
const buildArguments: Readonly<Record<BuildStage, readonly string[]>> = {
  'build:contracts': [typeScript, '-p', path.join('shared', 'tsconfig.json')],
  'build:electron': [typeScript, '-p', path.join('electron', 'tsconfig.json')],
  'build:scripts': [typeScript, '-p', path.join('scripts', 'tsconfig.build.json')],
  // The two runtime scripts are type-checked here and bundled after (BUNDLED).
  'build:morph': [typeScript, '-p', path.join('electron', 'tsconfig.morph.json'), '--noEmit'],
  'build:preload': [typeScript, '-p', path.join('electron', 'tsconfig.preload.json'), '--noEmit'],
  'stage:runtime': [path.join(root, 'dist/scripts/build/stageRuntime.js')],
  'build:web': [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
};
// A targeted run keeps the tree, so its TypeScript emits are incremental. The
// build info lives inside dist/, beside the outputs it describes: anything
// that deletes the outputs (build:clean, every packaging path) deletes it too,
// so tsc can never skip an emit whose output is gone. The full gate starts
// clean and stays cold, as CI is.
const INCREMENTAL_STAGES: ReadonlySet<BuildStage> = new Set(['build:contracts', 'build:electron', 'build:morph', 'build:preload']);
// The stages whose output esbuild writes, each into one file the runtime loads
// whole (scripts/build/bundleClients.ts), after tsc has type-checked it.
const BUNDLED: ReadonlyMap<BuildStage, string> = new Map([
  ['build:morph', 'morph'],
  ['build:preload', 'preload'],
]);
// A stage's commands, run in order; the stage fails at the first that fails.
const buildCommands = (stage: BuildStage): readonly TestCommand[] => {
  const client = BUNDLED.get(stage);
  if (client === undefined) {
    return [buildCommand(stage)];
  }
  const bundler = path.join(root, 'dist/scripts/build/bundleClients.js');
  return [buildCommand(stage), { name: `${stage} (bundle)`, command: node, argumentsList: [bundler, client], rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax }];
};
const buildCommand = (stage: BuildStage): TestCommand => {
  const argumentsList = buildArguments[stage];
  if (plan.kind === 'targeted' && INCREMENTAL_STAGES.has(stage)) {
    const buildInfo = path.join(root, 'dist', '.tsbuildinfo', `${stage.slice('build:'.length)}.tsbuildinfo`);
    const incremental = ['--incremental', '--tsBuildInfoFile', buildInfo];
    return { name: stage, command: node, argumentsList: [...argumentsList, ...incremental], rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax };
  }
  // Compilers and bundlers hold the whole program, so they get the static checks' memory bound.
  return { name: stage, command: node, argumentsList, rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax };
};
// The type checks keep what they learned between runs, outside dist/ so a
// clean keeps it. tsc re-checks every file whose own text or dependencies
// changed, so a warm run reaches the verdict a cold one does. `tsc --noEmit`
// shares check:changed's file (scripts/policy/checks.mts): one program, one
// cache, so each warms the other.
const typeCheckCache = path.join(root, 'node_modules', '.cache', 'tsc');
// Prettier formats each file alone, so a file whose content and options are
// unchanged keeps its verdict. Only the content strategy is safe here: a
// checkout rewrites modification times without changing a byte.
const prettierCache = path.join(root, 'node_modules', '.cache', 'prettier', 'gate.json');
// The checks only read what the builds produced, so they run side by side.
const staticChecks: readonly TestCommand[] = [
  {
    name: 'studio verify',
    command: node,
    argumentsList: [path.join(root, 'scripts/policy/studioChecks.mts'), '--full'],
    timeoutMs: POOL_LIMITS.studioVerifyMsMax,
    rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax,
  },
  {
    name: 'tsc --noEmit',
    command: node,
    argumentsList: [typeScript, '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(typeCheckCache, 'root.tsbuildinfo')],
    rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax,
  },
  {
    // The scripts emit CommonJS, so their build config cannot hold
    // verbatimModuleSyntax; this check-only program holds the full flag set.
    name: 'tsc scripts',
    command: node,
    argumentsList: [
      typeScript,
      '-p',
      path.join('scripts', 'tsconfig.json'),
      '--incremental',
      '--tsBuildInfoFile',
      path.join(typeCheckCache, 'scripts.tsbuildinfo'),
    ],
    rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax,
  },
  {
    name: 'eslint',
    command: node,
    // Type-aware lint of the whole tree passed Node's default heap (about 2 GB) on
    // GitHub's macOS runner in 1.1.0; 6 GB leaves room on every runner, which has 7 GB or more.
    argumentsList: ['--max-old-space-size=6144', path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), '--max-warnings', '0', '.'],
    rssBytesMax: POOL_LIMITS.staticCheckRssBytesMax,
  },
  {
    // Line width, shell scripts, test headers, the dependency record, one
    // lockfile, agent instructions, assertion density (docs/enforcement.md).
    name: 'policy scan',
    command: node,
    argumentsList: [path.join(root, 'scripts/policy/scan.mts')],
  },
  {
    name: 'prettier',
    command: node,
    // formatTree.mts names the files through git, so a local exclude list is honoured (issue #78).
    argumentsList: [
      path.join(root, 'scripts', 'policy', 'formatTree.mts'),
      '--check',
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      prettierCache,
      '--log-level',
      'warn',
    ],
  },
  {
    name: 'adapter-surface',
    command: node,
    argumentsList: [path.join(root, 'dist/scripts/gate/adapterSurface.js')],
  },
];

// The checks a run holds: all of them, or CI's two halves. Studio's verify is the long one, so CI
// gives it a job of its own; the halves together are exactly the full list.
function checksFor(part: ChecksPart | undefined): readonly TestCommand[] {
  switch (part) {
    case undefined:
    case 'checks-all':
      return staticChecks;
    case 'checks-desktop':
      return staticChecks.filter((check) => check.name !== 'studio verify');
    case 'checks-studio':
      return staticChecks.filter((check) => check.name === 'studio verify');
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

// Two phases: the shared pool, then the suites that run alone (they measure
// timing or drive a real window) one at a time with nothing else running.
// The Electron binary's path is what the electron package exports.
const electronInput: unknown = require('electron');
const electronBinary = typeof electronInput === 'string' ? electronInput : 'electron';
const toCommand = (suite: Suite): TestCommand => {
  const kind = startsElectron(root, suite) ? 'electron' : undefined;
  if (suite.options.runner === 'electron') {
    return { name: suite.name, command: electronBinary, argumentsList: [suite.file], kind: 'electron' };
  }
  const nodeArguments = suite.options.nodeArguments ?? [];
  const command = { name: suite.name, command: node, argumentsList: [...nodeArguments, suite.file] };
  return kind === undefined ? command : { ...command, kind };
};
const phases: readonly (readonly TestCommand[])[] = [
  selected.filter((suite) => suite.options.phase !== 'alone').map(toCommand),
  selected.filter((suite) => suite.options.phase === 'alone').map(toCommand),
];
const names = selected.map((suite) => suite.name);
process.on('SIGINT', () => {
  stopTestPool();
  process.exit(130);
});
let testsStartedMs = Date.now();
let finished = 0;
const report = (outcome: TestOutcome): void => {
  finished += 1;
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  const verdict = outcome.passed ? 'ok  ' : 'FAIL';
  console.log(`[${finished}/${names.length}] ${verdict} ${outcome.name} (${seconds}s)`);
  if (!outcome.passed) {
    failed.push(outcome.name);
    console.log(outcome.output);
  }
};
// Every check's output is shown (lint warnings included); any failure stops the
// gate before the tests, as a failed build does.
async function runStaticChecks(): Promise<void> {
  const chosen = checksFor(checksPart);
  const options = { cwd: root, environment, jobs: Math.min(jobs, chosen.length) };
  const outcomes = await runTestPool(chosen, options, (outcome) => {
    const seconds = (outcome.durationMs / 1000).toFixed(1);
    console.log(`\n[gate] ${outcome.name} ${outcome.passed ? 'done' : 'FAILED'} in ${seconds}s`);
    console.log(outcome.output);
  });
  const failures = outcomes.filter((outcome) => !outcome.passed);
  if (failures.length > 0) {
    console.error(`\nStatic gate failed: ${failures.map((outcome) => outcome.name).join(', ')}`);
    process.exit(1);
  }
}

// A build's output is shown when it finishes, so the chain and the builds
// beside it never interleave on the terminal.
function reportBuild(outcome: TestOutcome): void {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  console.log(`\n[gate] ${outcome.name} ${outcome.passed ? 'done' : 'FAILED'} in ${seconds}s`);
  const output = outcome.output.trimEnd();
  if (output !== '') {
    console.log(output);
  }
}

// The chain stops at its first failure: each stage reads what the one before
// it wrote.
async function runChain(stages: readonly BuildStage[]): Promise<readonly TestOutcome[]> {
  const options = { cwd: root, environment, jobs: 1 };
  const outcomes: TestOutcome[] = [];
  for (const command of stages.flatMap(buildCommands)) {
    const outcome = await runTestCommand(command, options);
    reportBuild(outcome);
    outcomes.push(outcome);
    if (!outcome.passed) {
      break;
    }
  }
  return outcomes;
}

// Any failed build stops the gate before the checks and the suites.
async function runBuilds(): Promise<void> {
  if (plan.kind === 'full') {
    const clean = await runTestCommand(cleanCommand, { cwd: root, environment, jobs: 1 });
    reportBuild(clean);
    if (!clean.passed) {
      console.error('\nStatic gate failed: build:clean');
      process.exit(1);
    }
  } else {
    console.log(targetedNotice(plan));
  }
  const besideJobs = Math.min(Math.max(plan.beside.length, 1), POOL_LIMITS.jobsMax);
  const besideOptions = { cwd: root, environment, jobs: besideJobs };
  const [chain, beside] = await Promise.all([runChain(plan.chain), runTestPool(plan.beside.flatMap(buildCommands), besideOptions, reportBuild)]);
  const failures = [...chain, ...beside].filter((outcome) => !outcome.passed);
  if (failures.length > 0) {
    console.error(`\nStatic gate failed: ${failures.map((outcome) => outcome.name).join(', ')}`);
    process.exit(1);
  }
}

async function runPhases(): Promise<readonly TestOutcome[]> {
  const buildsStartedMs = Date.now();
  await runBuilds();
  console.log(`\n[gate] builds done in ${((Date.now() - buildsStartedMs) / 1000).toFixed(1)}s`);
  if (plan.staticChecks === 'run') {
    await runStaticChecks();
  } else if (shard !== undefined) {
    console.log(`\n[gate] Shard ${shard.index}/${shard.count}: the static checks run in their own jobs (--checks=desktop and --checks=studio).`);
  }
  if (checksOnly) {
    console.log('\n[gate] Checks only: builds and static checks passed; the suites run in the shards.');
    return [];
  }
  testsStartedMs = Date.now();
  console.log(`\n[gate] ${names.length} test suites, ${jobs} at a time, ${electronJobs} of them with Electron windows`);
  const outcomes: TestOutcome[] = [];
  for (const [index, phase] of phases.entries()) {
    const phaseJobs = index === 0 ? jobs : 1;
    const options = { cwd: root, environment: testEnvironment, jobs: phaseJobs, electronJobs: Math.min(electronJobs, phaseJobs) };
    outcomes.push(...(await runTestPool(phase, options, report)));
  }
  return outcomes;
}

function summarize(outcomes: readonly TestOutcome[]): void {
  if (checksOnly) {
    // A failed check already exited non-zero (runStaticChecks); there are no suites to count.
    process.exitCode = 0;
    return;
  }
  const slowest = [...outcomes].sort((left, right) => right.durationMs - left.durationMs);
  const named = slowest.slice(0, 5).map((outcome) => `${outcome.name} ${(outcome.durationMs / 1000).toFixed(1)}s`);
  const testSeconds = ((Date.now() - testsStartedMs) / 1000).toFixed(1);
  console.log(`\nTest suites took ${testSeconds}s. Slowest: ${named.join(', ')}`);

  const quarantined: readonly string[] = [];
  const flaky = selected.filter((suite) => suite.options.flaky !== undefined).map((suite) => suite.name);
  const durationSeconds = ((Date.now() - startedMs) / 1000).toFixed(1);
  const passed = names.length - failed.length;
  console.log(`\n${passed}/${names.length} test suites passed in ${durationSeconds}s.`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(', ')}`);
  }
  const tolerated = [...quarantined, ...flaky];
  const unexpected = failed.filter((name) => !tolerated.includes(name));
  const healed = quarantined.filter((name) => !failed.includes(name) && names.includes(name));
  if (healed.length > 0) {
    console.error(`\nQuarantined tests now pass — remove them: ${healed.join(', ')}`);
  }
  process.exitCode = unexpected.length > 0 || healed.length > 0 ? 1 : 0;
  if (process.exitCode === 0) {
    recordPass();
  }
}

// Only a full, unsharded, passing run whose tree did not change while it ran earns a marker.
function recordPass(): void {
  if (treeHashAtStart === undefined) {
    return;
  }
  const folder = markerFolder(root);
  const treeHashAtEnd = workingTreeHash(root);
  if (folder === undefined || treeHashAtEnd !== treeHashAtStart) {
    console.log('\n[gate] The tree changed during the run (or git could not hash it): no pre-push marker written.');
    return;
  }
  writeMarker(folder, { treeHash: treeHashAtStart, gateVersion: gateVersion(), finishedAt: new Date().toISOString() });
  console.log(`\n[gate] Marker written for tree ${treeHashAtStart.slice(0, 12)}: pushing this exact tree skips the pre-push gate.`);
}

runPhases().then(summarize, (error: unknown) => {
  console.error(error);
  process.exit(1);
});
