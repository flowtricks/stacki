// `npm run check:linux`: the ways the Linux release job has failed, checked on
// a Mac before a tag spends a release build finding them. Run it before
// tagging (docs/releases.md); it prints one line per check, and each failure
// says how to fix it.
//
//   npm run check:linux                  every check, probes under slow motion
//   npm run check:linux -- --static      the file checks only (seconds)
//   npm run check:linux -- --repeat=3    the probes three times
//   npm run check:linux -- --only=style/ the probes whose name contains style/
//   npm run check:linux -- --jobs=1      the probes one at a time
//
// The probes are the suites that open an Electron window. They run as the gate
// runs them, from the existing build (run `npm test` first), with
// linuxSlowMotion.js preloaded into Electron so animation frames and
// transitions are as late as on the Linux runner. What stays remote is listed
// in docs/releases.md.
import assert = require('node:assert/strict');
import { spawnSync } from 'node:child_process';
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { discoverTestFiles, suitesFor, type Suite } from '../gate/testDiscovery';
import { runTestCommand, stopTestPool, type TestCommand, type TestOutcome } from '../gate/testPool';
import { repositoryRoot } from '../lib/repoRoot';
import { lockfileMissingDependencies } from './lockfileClosure';
import { linuxInstallerTemplate } from './linuxInstaller';
import {
  PREFLIGHT_LIMITS,
  caseCollisions,
  caseMismatches,
  configPathMismatches,
  directlyExecutedPaths,
  ignoredReferences,
  linuxBuildFindings,
  shebangFindings,
  trackedTree,
  unsettledMeasurements,
  type Finding,
  type TrackedEntry,
  type TrackedTree,
} from './linuxPreflightChecks';
import { SLOW_MOTION_ENVIRONMENT, SLOW_MOTION_LOG_ENVIRONMENT, type SlowMotion } from './linuxSlowMotion';

// The runner's conditions. A 200 ms frame delay holds a popup in its opening
// phase past the sleeps the probes used before they waited for the motion; it
// reproduced v1.0.11's sourceMenu failure to the pixel (9.97998px for 8px). A
// quarter-speed timeline catches measurements taken mid-transition.
const LINUX_RUNNER_MOTION: SlowMotion = { frameDelayMs: 200, animationRate: 0.25 };

export const PREFLIGHT_RUN_LIMITS = {
  repeatMax: 5,
  jobsMax: 4,
  /** One pass over the probes; about a minute on an M-series Mac. */
  probePassMsMax: 10 * 60 * 1_000,
  /** Findings printed per check; the count says how many more there are. */
  findingsShownMax: 20,
  gitOutputBytesMax: 64 * 1024 * 1024,
} as const satisfies Record<string, number>;

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|css|astro)$/;
const CONFIG_FILES = ['package.json', 'studio/package.json', 'packages/create-stacki/package.json'] as const;
const LOCKFILES = ['package-lock.json', 'studio/package-lock.json'] as const;

type CheckResult =
  | { readonly kind: 'pass'; readonly summary: string }
  | { readonly kind: 'fail'; readonly summary: string; readonly findings: readonly Finding[] }
  // A heuristic's findings: printed, never failing the run.
  | { readonly kind: 'warn'; readonly summary: string; readonly findings: readonly Finding[] }
  | { readonly kind: 'skip'; readonly summary: string };

interface Options {
  readonly staticOnly: boolean;
  readonly repeat: number;
  readonly jobs: number;
  readonly only: string | undefined;
}

export function parseOptions(argumentsList: readonly string[]): Options {
  let staticOnly = false;
  let repeat = 1;
  let jobs = 2;
  let only: string | undefined;
  for (const argument of argumentsList) {
    const [flag, value] = argument.split('=', 2);
    if (flag === '--static' && value === undefined) {
      staticOnly = true;
    } else if (flag === '--repeat' && value !== undefined) {
      repeat = boundedInteger(flag, value, PREFLIGHT_RUN_LIMITS.repeatMax);
    } else if (flag === '--jobs' && value !== undefined) {
      jobs = boundedInteger(flag, value, PREFLIGHT_RUN_LIMITS.jobsMax);
    } else if (flag === '--only' && value !== undefined && value !== '') {
      only = value;
    } else {
      throw new Error(`Unknown argument ${argument} (supported: --static, --repeat=<1-5>, --jobs=<1-4>, --only=<name>)`);
    }
  }
  return { staticOnly, repeat, jobs, only };
}

function boundedInteger(flag: string, value: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${flag} takes a whole number from 1 to ${maximum}, not ${value}`);
  }
  return parsed;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const root = repositoryRoot();
  const startedMs = Date.now();
  const entries = trackedEntries(root);
  const tree = trackedTree(entries.map((entry) => entry.file));
  const suites = suitesFor(discoverTestFiles(root));
  const probes = suites.filter((suite) => isProbe(root, suite));
  assert.ok(probes.length > 0, 'linuxPreflight: the probe suites are found by their BrowserWindow');
  const checks: readonly (readonly [string, () => CheckResult | Promise<CheckResult>])[] = [
    ['case', () => checkCase(root, tree)],
    ['config paths', () => checkConfigPaths(root, tree)],
    ['shebangs', () => checkShebangs(root, tree, entries)],
    ['ignored files', () => checkIgnoredFiles(root, entries)],
    ['lockfiles', () => checkLockfiles(root)],
    ['linux build', () => checkLinuxBuild(root, tree)],
    ['deb script', () => checkDebScript()],
    ['settle scan', () => checkSettleScan(root, probes)],
    ['probes', () => (options.staticOnly ? { kind: 'skip', summary: '--static' } : checkProbes(root, probes, options))],
  ];
  let failed = 0;
  for (const [name, run] of checks) {
    const result = await run();
    printResult(name, result);
    if (result.kind === 'fail') {
      failed += 1;
    }
  }
  const seconds = ((Date.now() - startedMs) / 1000).toFixed(1);
  if (failed === 0) {
    console.log(`\ncheck:linux passed in ${seconds}s.`);
    return 0;
  }
  console.error(`\ncheck:linux: ${failed} check(s) failed in ${seconds}s. Fix them before tagging; CI's Linux job fails the same way.`);
  return 1;
}

function printResult(name: string, result: CheckResult): void {
  switch (result.kind) {
    case 'pass':
      console.log(`ok   ${name}: ${result.summary}`);
      return;
    case 'skip':
      console.log(`skip ${name}: ${result.summary}`);
      return;
    case 'fail':
    case 'warn': {
      console.log(`${result.kind === 'fail' ? 'FAIL' : 'warn'} ${name}: ${result.summary}`);
      for (const finding of result.findings.slice(0, PREFLIGHT_RUN_LIMITS.findingsShownMax)) {
        const where = finding.line === 0 ? finding.file : `${finding.file}:${finding.line}`;
        console.log(`     ${where} ${finding.message}`);
      }
      const hidden = result.findings.length - PREFLIGHT_RUN_LIMITS.findingsShownMax;
      if (hidden > 0) {
        console.log(`     … and ${hidden} more`);
      }
      return;
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function verdict(findings: readonly Finding[], passSummary: string, failNoun: string): CheckResult {
  if (findings.length === 0) {
    return { kind: 'pass', summary: passSummary };
  }
  return { kind: 'fail', summary: `${findings.length} ${failNoun}`, findings };
}

// ── The file checks ─────────────────────────────────────────────────────────

function checkCase(root: string, tree: TrackedTree): CheckResult {
  const findings: Finding[] = [...caseCollisions(tree)];
  let scanned = 0;
  for (const file of tree.exact) {
    if (SOURCE_EXTENSIONS.test(file)) {
      const text = readSource(root, file);
      if (text !== undefined) {
        scanned += 1;
        findings.push(...caseMismatches(tree, file, text));
      }
    }
  }
  return verdict(findings, `relative imports in ${scanned} files match their files' case`, 'path(s) resolve only on a case-insensitive disk');
}

function checkConfigPaths(root: string, tree: TrackedTree): CheckResult {
  const files = [...CONFIG_FILES, ...workflowFiles(tree)];
  const findings = files.flatMap((file) => {
    const text = readSource(root, file);
    return text === undefined ? [] : configPathMismatches(tree, file, text);
  });
  return verdict(findings, `paths in ${files.length} package and workflow files match their files' case`, 'config path(s) differ in case');
}

function checkShebangs(root: string, tree: TrackedTree, entries: readonly TrackedEntry[]): CheckResult {
  const workflows = workflowFiles(tree).map((file) => readSource(root, file) ?? '');
  const executed = new Set([
    ...[...tree.exact].filter((file) => file.startsWith('.githooks/') && file.split('/').length === 2),
    ...workflows.flatMap((text) => directlyExecutedPaths(tree, text)),
  ]);
  const findings = shebangFindings(entries, executed);
  const scripts = entries.filter((entry) => entry.head.startsWith('#!')).length;
  return verdict(findings, `${scripts} #! files and ${executed.size} directly run files are portable`, 'executable or shebang problem(s)');
}

function checkIgnoredFiles(root: string, entries: readonly TrackedEntry[]): CheckResult {
  const ignored = git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', 'test'])
    .split('\0')
    .filter((file) => file !== '' && !file.includes('node_modules/'));
  if (ignored.length === 0) {
    return { kind: 'pass', summary: 'no ignored files under test/ to depend on' };
  }
  const findings = entries
    .filter((entry) => entry.file.startsWith('test/') && SOURCE_EXTENSIONS.test(entry.file))
    .flatMap((entry) => {
      const text = readSource(root, entry.file);
      return text === undefined ? [] : ignoredReferences(ignored, entry.file, text);
    });
  return verdict(findings, `no test names one of the ${ignored.length} ignored files under test/`, 'reference(s) to files a clean checkout lacks');
}

function checkLockfiles(root: string): CheckResult {
  const findings = LOCKFILES.flatMap((file) => {
    const input: unknown = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    return lockfileMissingDependencies(input).map((edge) => ({
      file,
      line: 0,
      message: `${edge} is missing; \`npm ci\` on Linux refuses the lockfile. Run \`npm install\` and commit the lockfile.`,
    }));
  });
  return verdict(findings, `${LOCKFILES.length} lockfiles hold every platform's dependencies`, 'missing lockfile edge(s)');
}

function checkLinuxBuild(root: string, tree: TrackedTree): CheckResult {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const build: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'build') : undefined;
  const linux: unknown = typeof build === 'object' && build !== null ? Reflect.get(build, 'linux') : undefined;
  const icon: unknown = typeof linux === 'object' && linux !== null ? Reflect.get(linux, 'icon') : undefined;
  const iconHeader = typeof icon === 'string' && tree.exact.has(icon) ? readHead(path.join(root, icon), 24) : undefined;
  const findings = linuxBuildFindings(build, tree, iconHeader);
  return verdict(findings, 'electron-builder Linux settings, icon and targets are valid', 'Linux packaging problem(s)');
}

function checkDebScript(): CheckResult {
  // The deb's maintainer script is generated from the builder's template; a
  // builder upgrade that changes it fails here instead of at packaging.
  let script: string;
  try {
    script = linuxInstallerTemplate(fs.readFileSync(require.resolve('app-builder-lib/templates/linux/after-install.tpl'), 'utf8'));
  } catch (error: unknown) {
    return { kind: 'fail', summary: 'the deb after-install script no longer renders', findings: [{ file: 'scripts/release/linuxInstaller.ts', line: 0, message: String(error) }] };
  }
  const syntax = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8', timeout: 10_000 });
  if (syntax.status !== 0) {
    const message = `sh -n rejects the rendered script: ${syntax.stderr.trim()}`;
    return { kind: 'fail', summary: 'the deb after-install script is not valid shell', findings: [{ file: 'scripts/release/linuxInstaller.ts', line: 0, message }] };
  }
  return { kind: 'pass', summary: 'the deb after-install script renders and parses as shell' };
}

function checkSettleScan(root: string, probes: readonly Suite[]): CheckResult {
  // The scan reads text, not control flow, so it can flag a sleep that never
  // precedes the read. It warns; the slowed probe run below is what fails.
  const findings = probes.flatMap((suite) => unsettledMeasurements(suite.file, readSource(root, suite.file) ?? ''));
  const summary = `${probes.length} probe suites wait for motion before they measure`;
  if (findings.length === 0) {
    return { kind: 'pass', summary };
  }
  return { kind: 'warn', summary: `${findings.length} measurement(s) after a fixed sleep; fragile on a slower runner even when the probes pass`, findings };
}

// ── The probes under slow motion ────────────────────────────────────────────

async function checkProbes(root: string, probes: readonly Suite[], options: Options): Promise<CheckResult> {
  const only = options.only;
  const selected = only === undefined ? probes : probes.filter((suite) => suite.name.includes(only));
  if (selected.length === 0) {
    return { kind: 'fail', summary: `no probe suite matches --only=${only ?? ''}`, findings: [] };
  }
  if (!fs.existsSync(path.join(root, 'dist', 'electron'))) {
    return { kind: 'fail', summary: 'no build to run the probes from', findings: [{ file: 'dist/', line: 0, message: 'Run `npm test` (or `npm run build`) first.' }] };
  }
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-check-linux-'));
  try {
    const findings: Finding[] = [];
    let slowedSuites = 0;
    for (let pass = 1; pass <= options.repeat; pass += 1) {
      const outcomes = await probePass(root, selected, options.jobs, logDirectory);
      for (const [index, outcome] of outcomes.entries()) {
        const suite = selected[index];
        assert.ok(suite !== undefined, 'checkProbes: an outcome per selected suite');
        assert.equal(outcome.name, suite.name, 'checkProbes: outcomes come back in suite order');
        const slowed = slowedDocuments(path.join(logDirectory, logName(suite)));
        slowedSuites += slowed > 0 ? 1 : 0;
        if (!outcome.passed) {
          findings.push({ file: suite.file, line: 0, message: probeFailure(pass, outcome) });
        }
      }
    }
    const runs = selected.length * options.repeat;
    const summary = `${runs - findings.length}/${runs} probe runs passed with frames delayed ${LINUX_RUNNER_MOTION.frameDelayMs} ms and motion at ${LINUX_RUNNER_MOTION.animationRate}× (${slowedSuites} slowed a window)`;
    if (findings.length > 0) {
      return { kind: 'fail', summary, findings };
    }
    // A pass that slowed nothing proves nothing: the preload never reached Electron.
    if (slowedSuites === 0) {
      return { kind: 'fail', summary: 'no probe window was slowed', findings: [{ file: 'scripts/release/linuxSlowMotion.ts', line: 0, message: 'The NODE_OPTIONS preload did not reach Electron.' }] };
    }
    return { kind: 'pass', summary };
  } finally {
    fs.rmSync(logDirectory, { recursive: true, force: true });
  }
}

async function probePass(root: string, suites: readonly Suite[], jobs: number, logDirectory: string): Promise<readonly TestOutcome[]> {
  const electronInput: unknown = require('electron');
  assert.ok(typeof electronInput === 'string', 'checkProbes: the electron package exports its binary path under Node');
  const hook = path.join(root, 'dist', 'scripts', 'release', 'linuxSlowMotion.js');
  assert.ok(fs.existsSync(hook), 'checkProbes: npm run check:linux builds the scripts first');
  // The pool has no per-command timeout; a hung probe stops the whole pass.
  const deadline = setTimeout(stopTestPool, PREFLIGHT_RUN_LIMITS.probePassMsMax);
  try {
    // One environment per suite, so each counts its own slowed windows.
    const groups = chunk(suites, jobs);
    const results = await Promise.all(
      groups.map(async (group) => {
        const groupOutcomes: TestOutcome[] = [];
        for (const suite of group) {
          const environment = probeEnvironment(hook, path.join(logDirectory, logName(suite)));
          const outcome = await runTestCommand(probeCommand(suite, electronInput), { jobs: 1, cwd: root, environment });
          printProbe(outcome);
          groupOutcomes.push(outcome);
        }
        return groupOutcomes;
      }),
    );
    const byName = new Map(results.flat().map((outcome) => [outcome.name, outcome]));
    const outcomes = suites.map((suite) => byName.get(suite.name));
    assert.equal(byName.size, suites.length, 'probePass: every suite ran once');
    return outcomes.filter((outcome) => outcome !== undefined);
  } finally {
    clearTimeout(deadline);
  }
}

function probeCommand(suite: Suite, electronBinary: string): TestCommand {
  // The same command the gate runs (scripts/gate/runTests.ts).
  if (suite.options.runner === 'electron') {
    return { name: suite.name, command: electronBinary, argumentsList: [suite.file] };
  }
  const nodeArguments = suite.options.nodeArguments ?? [];
  return { name: suite.name, command: process.execPath, argumentsList: [...nodeArguments, suite.file] };
}

function probeEnvironment(hook: string, logFile: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // Electron run as plain Node has no BrowserWindow (CLAUDE.md).
  delete environment['ELECTRON_RUN_AS_NODE'];
  const inherited = environment['NODE_OPTIONS'] ?? '';
  environment['NODE_OPTIONS'] = `${inherited} --require ${JSON.stringify(hook)}`.trim();
  environment[SLOW_MOTION_ENVIRONMENT] = JSON.stringify(LINUX_RUNNER_MOTION);
  environment[SLOW_MOTION_LOG_ENVIRONMENT] = logFile;
  return environment;
}

function printProbe(outcome: TestOutcome): void {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  console.log(`     ${outcome.passed ? 'ok  ' : 'FAIL'} ${outcome.name} (${seconds}s)`);
}

function probeFailure(pass: number, outcome: TestOutcome): string {
  // The suites end with their failed checks; Chromium's own logging is noise.
  const lines = outcome.output
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('['))
    .slice(-8)
    .map((line) => `\n       ${line}`)
    .join('');
  return `failed under slow motion (pass ${pass}). It measures before a transition or frame it depends on; wait for that event, within a bound, instead of a fixed sleep.${lines}`;
}

function slowedDocuments(logFile: string): number {
  if (!fs.existsSync(logFile)) {
    return 0;
  }
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('slowed ')).length;
}

function logName(suite: Suite): string {
  return `${suite.name.replaceAll('/', '_')}.log`;
}

/** `items` dealt round-robin into at most `count` groups. */
function chunk<T>(items: readonly T[], count: number): readonly (readonly T[])[] {
  assert.ok(count >= 1, 'chunk: at least one group');
  const groups: T[][] = Array.from({ length: Math.min(count, items.length) }, () => []);
  for (const [index, item] of items.entries()) {
    groups[index % groups.length]?.push(item);
  }
  return groups;
}

// ── Reading the repository ──────────────────────────────────────────────────

function isProbe(root: string, suite: Suite): boolean {
  if (suite.options.runner === 'electron') {
    return true;
  }
  return (readSource(root, suite.file) ?? '').includes('BrowserWindow');
}

function trackedEntries(root: string): readonly TrackedEntry[] {
  // `-s` prints `<mode> <object> <stage>\t<path>`; -z keeps odd names intact.
  const records = git(root, ['ls-files', '-z', '-s']).split('\0');
  assert.ok(records.length <= PREFLIGHT_LIMITS.trackedFilesMax, 'trackedEntries: tracked file count exceeds limit');
  const entries: TrackedEntry[] = [];
  for (const record of records) {
    if (record !== '') {
      const tab = record.indexOf('\t');
      assert.ok(tab > 0, `trackedEntries: unexpected ls-files record ${record}`);
      const file = record.slice(tab + 1);
      const mode = record.slice(0, record.indexOf(' '));
      // A tracked file deleted in the working copy has no head to read.
      const head = readHead(path.join(root, file), PREFLIGHT_LIMITS.shebangBytesMax);
      if (mode !== '160000' && head !== undefined) {
        entries.push({ file, mode, head: head.toString('latin1') });
      }
    }
  }
  return entries;
}

function workflowFiles(tree: TrackedTree): readonly string[] {
  return [...tree.exact].filter((file) => file.startsWith('.github/workflows/') && file.endsWith('.yml')).sort();
}

function readSource(root: string, file: string): string | undefined {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) {
    return undefined;
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > PREFLIGHT_LIMITS.sourceBytesMax) {
    return undefined;
  }
  return fs.readFileSync(target, 'utf8');
}

function readHead(file: string, sizeBytes: number): Buffer | undefined {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return undefined;
  }
  const head = Buffer.alloc(sizeBytes);
  const descriptor = fs.openSync(file, 'r');
  try {
    const read = fs.readSync(descriptor, head, 0, sizeBytes, 0);
    return head.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

function git(root: string, argumentsList: readonly string[]): string {
  const result = spawnSync('git', [...argumentsList], { cwd: root, encoding: 'utf8', maxBuffer: PREFLIGHT_RUN_LIMITS.gitOutputBytesMax });
  if (result.status !== 0) {
    throw new Error(`git ${argumentsList.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

if (require.main === module) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
