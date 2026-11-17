#!/usr/bin/env node
// Superseded by releaseShip.mts (`npm run release:ship`), which builds once and promotes; the
// workflow half (.github/workflows/release-go.yml) was removed because it needed an environment
// and a secret that never existed. The local half below still works as a manual fallback.
//
// The release button. One script, two ways to press it, the same logic in both:
//
//   GitHub: Actions > Release button > Run workflow (.github/workflows/release-go.yml) runs the stages
//     node --experimental-strip-types scripts/release/releaseGo.mts --stage=preflight --dry-run=<true|false> [--version=X.Y.Z] [--allow-minor] [--notes=TEXT]
//     node --experimental-strip-types scripts/release/releaseGo.mts --stage=approve
//     node --experimental-strip-types scripts/release/releaseGo.mts --stage=tag --dry-run=<true|false> --expected-sha=SHA --version=X.Y.Z [--allow-minor] [--notes=TEXT]
//
//   Local:  node --experimental-strip-types scripts/release/releaseGo.mts                    a dry run: the plan, nothing written
//           node --experimental-strip-types scripts/release/releaseGo.mts --confirm X.Y.Z    the release, only if X.Y.Z is the planned version
//
// Stages, in order:
//   preflight  the exact tip of main is green (releaseStatus.mts `assessCode`), the version follows
//              the bump rule, its tag does not exist, and (in the workflow) the approval environment
//              and push token exist. Records the SHA for the later stages.
//   approve    runs inside the `release` environment, so it starts only after a reviewer clicks
//              Approve; it re-checks that the environment really requires a reviewer.
//   tag        refuses if main moved since the preflight (compare and swap), prepares the bump
//              commit (prepare.mts), tags it, and pushes main and the tag in one atomic push.
//   watch      local only: waits, bounded, for release.yml and release-post.yml, then runs
//              verifyRelease. In GitHub the chain continues by itself (release-post.yml).
//
// A dry run stops before any commit, tag or push and says so on its last line.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter, type Reporter } from './actionsReport.mts';
import { ENVIRONMENT_SETUP_STEPS, readEnvironmentVerdict } from './environmentGate.mts';
import { executePlan, planRelease, renderPlan, systemRepositoryFiles, type PreparePlan, type RepositoryFiles } from './prepare.mts';
import { flowtricksEnvironment, systemCommandRunner, systemSleeper, type CommandRunner, type Sleeper } from './releaseCommands.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { listRuns, newestSince, waitForRunToAppear, waitForRunToComplete, type WorkflowRun } from './releaseRuns.mts';
import { SOURCE_REPOSITORY } from './releaseStatus.mts';
import type { BumpPolicy } from './releaseVersion.mts';
import { systemWriteRunner, type WriteRunner } from './releaseWrite.mts';

export const GO_LIMITS = {
  runAppearMinutesMax: 10,
  releaseMinutesMax: 120,
  postMinutesMax: 120,
  pollDelayMs: 120_000,
  appearDelayMs: 30_000,
  verifyWaitMinutes: 10,
} as const satisfies Record<string, number>;

export type GoMode = 'dry-run' | 'release';
export type GoContext = 'workflow' | 'local';

export interface GoDependencies {
  readonly runner: CommandRunner;
  readonly writer: WriteRunner;
  readonly files: RepositoryFiles;
  readonly reporter: Reporter;
  readonly sleeper: Sleeper;
}

export interface PreflightInput {
  readonly version: string | undefined;
  readonly bumpPolicy: BumpPolicy;
  readonly notes: string | undefined;
  readonly mode: GoMode;
  readonly context: GoContext;
  // Whether the workflow can see the RELEASE_PUSH_TOKEN secret; never its value.
  readonly pushToken: 'present' | 'absent' | 'not-needed';
}

export interface PreflightResult {
  readonly sha: string;
  readonly plan: PreparePlan;
  readonly warnings: readonly string[];
}

const PUSH_TOKEN_SETUP =
  'Create the repository secret RELEASE_PUSH_TOKEN: a fine-grained personal access token for flowtricks/stacki with ' +
  'Contents: Read and write (Settings > Secrets and variables > Actions > New repository secret). GITHUB_TOKEN cannot be used: ' +
  'its pushes do not start release.yml.';

/** The one next step a person takes for each refusal, so a summary never ends at an error code. */
export function nextStepFor(code: string): string {
  if (code === 'not-green') {
    return 'Wait for the Check run on this commit to finish green (or fix the red run), then press Run workflow again.';
  }
  if (code === 'tag-exists' || code === 'tag-exists-locally') {
    return 'Never move a release tag. Leave the version input empty so the next patch is computed, and run again.';
  }
  if (code.startsWith('bump-') || code.startsWith('version-')) {
    return 'Leave the version input empty: the next patch after the last tag is computed for you.';
  }
  if (code === 'environment-missing' || code === 'environment-unprotected') {
    return ENVIRONMENT_SETUP_STEPS;
  }
  if (code === 'push-token-missing') {
    return PUSH_TOKEN_SETUP;
  }
  if (code === 'main-moved') {
    return 'Someone pushed to main after the preflight. Press Run workflow again so the new tip is checked.';
  }
  if (code === 'dirty-tree' || code === 'wrong-branch') {
    return 'Release from a clean checkout of main (no tracked changes).';
  }
  if (code.startsWith('command-') || code.startsWith('json-') || code === 'environment-read') {
    return 'GitHub or git could not be read. Run the workflow again once; if it fails the same way, open this log and docs/release-runbook.md "If it fails".';
  }
  return 'Read the message above, then docs/release-runbook.md "If it fails". This is the point to hand the run URL to an agent.';
}

function remoteMain(runner: CommandRunner): Result<string> {
  const remote = runner({ command: 'git', argumentsList: ['ls-remote', 'origin', 'refs/heads/main'] });
  if (!remote.ok) {
    return remote;
  }
  const sha = remote.value.split('\t')[0]?.trim() ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? ok(sha) : fail('json-field', 'origin has no refs/heads/main.');
}

function headSha(runner: CommandRunner): Result<string> {
  const head = runner({ command: 'git', argumentsList: ['rev-parse', '--verify', 'HEAD^{commit}'] });
  return head.ok ? ok(head.value.trim()) : head;
}

/** Everything that must hold before a release starts, checked once and reported as a table. */
export function runPreflight(input: PreflightInput, dependencies: GoDependencies): Result<PreflightResult> {
  const remote = remoteMain(dependencies.runner);
  if (!remote.ok) {
    return remote;
  }
  const head = headSha(dependencies.runner);
  if (!head.ok) {
    return head;
  }
  if (input.context === 'workflow' && head.value !== remote.value) {
    return fail('main-moved', `the checkout is ${head.value.slice(0, 7)} but origin/main is ${remote.value.slice(0, 7)}.`);
  }
  const plan = planRelease(
    { version: input.version, bumpPolicy: input.bumpPolicy, notesOverride: input.notes, expectedSha: input.context === 'workflow' ? head.value : undefined },
    dependencies.runner,
    dependencies.files,
  );
  if (!plan.ok) {
    return plan;
  }
  const warnings: string[] = [];
  if (input.context === 'workflow') {
    const gate = checkReleaseGate(input, dependencies.runner);
    if (!gate.ok) {
      return gate;
    }
    warnings.push(...gate.value);
  }
  assert(plan.value.baseSha === head.value, 'runPreflight: the plan is for the checked commit');
  return ok({ sha: head.value, plan: plan.value, warnings });
}

// A real run needs a protected environment and the push token; a dry run reports their absence.
function checkReleaseGate(input: Pick<PreflightInput, 'mode' | 'pushToken'>, runner: CommandRunner): Result<readonly string[]> {
  const warnings: string[] = [];
  const verdict = readEnvironmentVerdict(runner, SOURCE_REPOSITORY);
  if (!verdict.ok) {
    return verdict;
  }
  switch (verdict.value.kind) {
    case 'protected':
      warnings.push(...verdict.value.warnings);
      break;
    case 'missing':
    case 'unprotected': {
      if (input.mode === 'release') {
        return fail(`environment-${verdict.value.kind}`, verdict.value.text);
      }
      warnings.push(`A real run would be refused: ${verdict.value.text}`);
      break;
    }
    default: {
      const exhaustive: never = verdict.value;
      return exhaustive;
    }
  }
  if (input.pushToken === 'absent') {
    if (input.mode === 'release') {
      return fail('push-token-missing', 'the RELEASE_PUSH_TOKEN secret is not set.');
    }
    warnings.push(`A real run would be refused: the RELEASE_PUSH_TOKEN secret is not set. ${PUSH_TOKEN_SETUP}`);
  }
  return ok(warnings);
}

export function reportPreflight(result: PreflightResult, mode: GoMode, reporter: Reporter): void {
  reporter.output('sha', result.sha);
  reporter.output('version', result.plan.version);
  reporter.output('mode', mode);
  const rows = [
    '| Check | Result |',
    '|---|---|',
    `| Commit | \`${result.sha.slice(0, 7)}\` (tip of main) |`,
    `| Version | ${result.plan.version} (last released ${result.plan.previous}) |`,
    '| Check on this code | green |',
    `| Tag v${result.plan.version} | not on origin |`,
    `| Mode | ${mode === 'dry-run' ? 'dry run: nothing will be pushed or tagged' : 'release: waits for approval, then tags'} |`,
  ];
  reporter.summary(['## Release preflight: ready', '', ...rows, '', ...result.warnings.map((warning) => `> [!WARNING]\n> ${warning}\n`)].join('\n'));
  for (const warning of result.warnings) {
    reporter.warning(warning);
  }
  console.log(renderPlan(result.plan));
}

export function reportRefusal(stage: string, error: { readonly code: string; readonly message: string }, reporter: Reporter): void {
  reporter.error(`${stage}: ${error.message}`);
  reporter.summary([`## Release ${stage}: NOT READY`, '', `**Why:** ${error.message}`, '', `**Next step:** ${nextStepFor(error.code)}`, '', `Code: \`${error.code}\``].join('\n'));
}

export interface TagInput {
  readonly expectedSha: string;
  readonly version: string;
  readonly bumpPolicy: BumpPolicy;
  readonly notes: string | undefined;
  readonly mode: GoMode;
  readonly context: GoContext;
  readonly pushToken: PreflightInput['pushToken'];
}

export type TagOutcome =
  | { readonly kind: 'dry-run'; readonly plan: PreparePlan }
  | { readonly kind: 'pushed'; readonly version: string; readonly commitSha: string; readonly refspecs: readonly string[] };

/** Prepare, tag and push, after proving main is still where the preflight saw it. */
export function runTag(input: TagInput, dependencies: GoDependencies): Result<TagOutcome> {
  assert(/^[0-9a-f]{40}$/.test(input.expectedSha), 'runTag: the preflight SHA is a full SHA');
  const before = compareAndSwap(dependencies.runner, input.expectedSha);
  if (!before.ok) {
    return before;
  }
  const plan = planRelease(
    { version: input.version, bumpPolicy: input.bumpPolicy, notesOverride: input.notes, expectedSha: input.context === 'workflow' ? input.expectedSha : undefined },
    dependencies.runner,
    dependencies.files,
  );
  if (!plan.ok) {
    return plan;
  }
  if (plan.value.version !== input.version) {
    return fail('version-changed', `the preflight planned ${input.version}, the tag stage computed ${plan.value.version}.`);
  }
  const tag = `v${plan.value.version}`;
  if (input.mode === 'dry-run') {
    console.log(renderPlan(plan.value));
    console.log(`DRY RUN: would commit "${plan.value.commitSubject}", tag ${tag} at it, and push HEAD:refs/heads/main and refs/tags/${tag} in one atomic push.`);
    console.log('DRY RUN: nothing was committed, tagged or pushed.');
    return ok({ kind: 'dry-run', plan: plan.value });
  }
  if (input.context === 'workflow') {
    const gate = checkReleaseGate({ mode: 'release', pushToken: input.pushToken }, dependencies.runner);
    if (!gate.ok) {
      return gate;
    }
  }
  const prepared = executePlan(plan.value, dependencies.runner, dependencies.writer, dependencies.files);
  if (!prepared.ok) {
    return prepared;
  }
  const commitSha = prepared.value.commitSha;
  const tagged = dependencies.writer({ command: 'git', argumentsList: ['tag', tag, commitSha], output: 'capture' });
  if (!tagged.ok) {
    return tagged;
  }
  // Main is pushed only when this run made the bump commit; an already-prepared tip is tagged alone.
  const refspecs = [...(prepared.value.kind === 'committed' ? [`${commitSha}:refs/heads/main`] : []), `refs/tags/${tag}:refs/tags/${tag}`];
  const again = compareAndSwap(dependencies.runner, input.expectedSha);
  if (!again.ok) {
    return again;
  }
  const credentials = input.context === 'local' ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
  const pushed = dependencies.writer({
    command: 'git',
    argumentsList: [...credentials, 'push', '--atomic', 'origin', ...refspecs],
    // The local pre-push hook may run the full gate; its output belongs on the terminal.
    output: input.context === 'local' ? 'inherit' : 'capture',
    timeoutMs: 90 * 60 * 1_000,
  });
  if (!pushed.ok) {
    return pushed;
  }
  const landed = verifyPushed(dependencies.runner, tag, commitSha, prepared.value.kind === 'committed' ? 'main-and-tag' : 'tag-only');
  if (!landed.ok) {
    return landed;
  }
  return ok({ kind: 'pushed', version: plan.value.version, commitSha, refspecs });
}

function compareAndSwap(runner: CommandRunner, expectedSha: string): Result<void> {
  const remote = remoteMain(runner);
  if (!remote.ok) {
    return remote;
  }
  if (remote.value !== expectedSha) {
    return fail('main-moved', `origin/main is ${remote.value.slice(0, 7)}, not the preflight's ${expectedSha.slice(0, 7)}.`);
  }
  return ok(undefined);
}

// The pair of the push: what origin now reports, read back, not assumed from the exit status.
function verifyPushed(runner: CommandRunner, tag: string, commitSha: string, scope: 'main-and-tag' | 'tag-only'): Result<void> {
  const refs = runner({ command: 'git', argumentsList: ['ls-remote', 'origin', 'refs/heads/main', `refs/tags/${tag}`] });
  if (!refs.ok) {
    return refs;
  }
  const lines = refs.value.split('\n').filter((line) => line.length > 0);
  const shaOf = (reference: string): string | undefined => lines.find((line) => line.endsWith(`\t${reference}`))?.split('\t')[0];
  if (shaOf(`refs/tags/${tag}`) !== commitSha) {
    return fail('push-readback', `origin's ${tag} is ${shaOf(`refs/tags/${tag}`) ?? 'missing'}, expected ${commitSha.slice(0, 7)}.`);
  }
  if (scope === 'main-and-tag' && shaOf('refs/heads/main') !== commitSha) {
    return fail('push-readback', `origin's main is ${shaOf('refs/heads/main') ?? 'missing'}, expected ${commitSha.slice(0, 7)}.`);
  }
  return ok(undefined);
}

export function reportTag(outcome: TagOutcome, reporter: Reporter): void {
  switch (outcome.kind) {
    case 'dry-run':
      reporter.output('pushed', 'no');
      reporter.summary(
        [
          `## Release dry run: v${outcome.plan.version} would be released`,
          '',
          'Nothing was committed, tagged or pushed.',
          '',
          '```',
          renderPlan(outcome.plan),
          '```',
          '',
          'To release it: Actions > Release button > Run workflow, untick "Dry run".',
        ].join('\n'),
      );
      return;
    case 'pushed':
      reporter.output('pushed', 'yes');
      reporter.output('version', outcome.version);
      reporter.output('commit_sha', outcome.commitSha);
      reporter.summary(
        [
          `## Release v${outcome.version}: tagged and pushed`,
          '',
          `Commit \`${outcome.commitSha.slice(0, 7)}\`, pushed as ${outcome.refspecs.map((refspec) => `\`${refspec}\``).join(' and ')}.`,
          '',
          'release.yml now builds it; "Release post" publishes create-stacki, waits for npm, deploys the site and verifies everything.',
          `Watch: https://github.com/${SOURCE_REPOSITORY}/actions/workflows/release.yml`,
        ].join('\n'),
      );
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** Local only: follows the release in GitHub to the end, then verifies it from the outside. */
export async function watchRelease(version: string, commitSha: string, dependencies: Pick<GoDependencies, 'runner' | 'sleeper'>): Promise<Result<WorkflowRun>> {
  const appear = { minutesMax: GO_LIMITS.runAppearMinutesMax, delayMs: GO_LIMITS.appearDelayMs, sleeper: dependencies.sleeper };
  const long = { minutesMax: GO_LIMITS.releaseMinutesMax, delayMs: GO_LIMITS.pollDelayMs, sleeper: dependencies.sleeper };
  const release = await waitForRunToAppear(appear, () => {
    const runs = listRuns(dependencies.runner, { repository: SOURCE_REPOSITORY, workflow: 'release.yml', event: 'push', commit: commitSha });
    return runs.ok ? ok(runs.value.find((run) => run.headBranch === `v${version}`)) : runs;
  });
  if (!release.ok) {
    return release;
  }
  console.log(`release.yml: ${release.value.url}`);
  const released = await waitForRunToComplete(long, dependencies.runner, SOURCE_REPOSITORY, release.value.id);
  if (!released.ok) {
    return released;
  }
  if (released.value.conclusion !== 'success') {
    return fail('release-failed', `release.yml ended ${released.value.conclusion ?? 'without a conclusion'}: ${released.value.url}. "Release post" applies the rerun policy; read its summary.`);
  }
  const post = await waitForRunToAppear(appear, () => {
    const runs = listRuns(dependencies.runner, { repository: SOURCE_REPOSITORY, workflow: 'release-post.yml', event: undefined, commit: undefined });
    return runs.ok ? ok(newestSince(runs.value, released.value.createdAt)) : runs;
  });
  if (!post.ok) {
    return post;
  }
  console.log(`release-post.yml: ${post.value.url}`);
  const posted = await waitForRunToComplete({ ...long, minutesMax: GO_LIMITS.postMinutesMax }, dependencies.runner, SOURCE_REPOSITORY, post.value.id);
  if (!posted.ok) {
    return posted;
  }
  return posted.value.conclusion === 'success' ? ok(posted.value) : fail('post-failed', `Release post ended ${posted.value.conclusion ?? 'unfinished'}: ${posted.value.url}`);
}

export interface GoArguments {
  readonly stage: 'preflight' | 'approve' | 'tag' | 'local';
  readonly mode: GoMode;
  readonly version: string | undefined;
  readonly bumpPolicy: BumpPolicy;
  readonly notes: string | undefined;
  readonly expectedSha: string | undefined;
  readonly confirm: string | undefined;
}

export function parseGoArguments(argumentsList: readonly string[]): Result<GoArguments> {
  let stage: GoArguments['stage'] = 'local';
  let mode: GoMode | undefined;
  let version: string | undefined;
  let bumpPolicy: BumpPolicy = 'patch-only';
  let notes: string | undefined;
  let expectedSha: string | undefined;
  let confirm: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index] ?? '';
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : '';
    if (argument.startsWith('--stage=')) {
      if (value !== 'preflight' && value !== 'approve' && value !== 'tag') {
        return fail('usage', '--stage takes preflight, approve or tag.');
      }
      stage = value;
    } else if (argument.startsWith('--dry-run=')) {
      // The workflow's boolean input: only the literal "false" makes a real run.
      if (value !== 'true' && value !== 'false') {
        return fail('usage', '--dry-run takes true or false.');
      }
      mode = value === 'false' ? 'release' : 'dry-run';
    } else if (argument.startsWith('--version=')) {
      version = value.trim().length === 0 ? undefined : value.trim();
    } else if (argument === '--allow-minor' || argument === '--allow-minor=true') {
      bumpPolicy = 'minor-or-major';
    } else if (argument === '--allow-minor=false') {
      bumpPolicy = 'patch-only';
    } else if (argument.startsWith('--notes=')) {
      notes = value.trim().length === 0 ? undefined : value;
    } else if (argument.startsWith('--expected-sha=')) {
      expectedSha = value;
    } else if (argument === '--confirm') {
      confirm = argumentsList[index + 1];
      index += 1;
    } else if (argument.startsWith('--confirm=')) {
      confirm = value;
    } else {
      return fail('usage', `unknown argument ${argument}`);
    }
  }
  if (stage === 'local') {
    if (mode !== undefined) {
      return fail('usage', 'locally, a dry run is the default; --confirm X.Y.Z makes a real run.');
    }
    return ok({ stage, mode: confirm === undefined ? 'dry-run' : 'release', version, bumpPolicy, notes, expectedSha: undefined, confirm });
  }
  if (confirm !== undefined) {
    return fail('usage', '--confirm is for the local button; the workflow is confirmed by the approval environment.');
  }
  if (stage !== 'approve' && mode === undefined) {
    return fail('usage', `--stage=${stage} needs --dry-run=true or --dry-run=false.`);
  }
  if (stage === 'tag' && (expectedSha === undefined || !/^[0-9a-f]{40}$/.test(expectedSha) || version === undefined)) {
    return fail('usage', '--stage=tag needs --expected-sha=<full SHA> and --version=X.Y.Z from the preflight.');
  }
  return ok({ stage, mode: mode ?? 'release', version, bumpPolicy, notes, expectedSha, confirm });
}

function pushTokenFrom(environment: NodeJS.ProcessEnv, context: GoContext): PreflightInput['pushToken'] {
  if (context === 'local') {
    return 'not-needed';
  }
  return environment['RELEASE_PUSH_TOKEN_PRESENT'] === 'true' ? 'present' : 'absent';
}

async function runLocal(goArguments: GoArguments, dependencies: GoDependencies): Promise<number> {
  const preflight = runPreflight(
    { version: goArguments.version, bumpPolicy: goArguments.bumpPolicy, notes: goArguments.notes, mode: goArguments.mode, context: 'local', pushToken: 'not-needed' },
    dependencies,
  );
  if (!preflight.ok) {
    reportRefusal('preflight', preflight.error, dependencies.reporter);
    return 1;
  }
  const version = preflight.value.plan.version;
  if (goArguments.mode === 'dry-run') {
    console.log(renderPlan(preflight.value.plan));
    console.log(`DRY RUN: nothing was committed, tagged or pushed. To release: node --experimental-strip-types scripts/release/releaseGo.mts --confirm ${version}`);
    return 0;
  }
  if (goArguments.confirm !== version) {
    console.log(`REFUSED: --confirm ${String(goArguments.confirm)} does not match the planned version ${version}. Nothing was changed.`);
    return 1;
  }
  const tagged = runTag(
    { expectedSha: preflight.value.sha, version, bumpPolicy: goArguments.bumpPolicy, notes: goArguments.notes, mode: 'release', context: 'local', pushToken: 'not-needed' },
    dependencies,
  );
  if (!tagged.ok) {
    reportRefusal('tag', tagged.error, dependencies.reporter);
    return 1;
  }
  if (tagged.value.kind !== 'pushed') {
    return 1;
  }
  reportTag(tagged.value, dependencies.reporter);
  const watched = await watchRelease(version, tagged.value.commitSha, dependencies);
  if (!watched.ok) {
    reportRefusal('watch', watched.error, dependencies.reporter);
    return 1;
  }
  // Loaded here only: verifyRelease reads YAML through a dependency the workflow stages do not install.
  const verify = await import('./verifyRelease.mts');
  const rows = await verify.verifyRelease({ version, groups: verify.CHECK_GROUPS, waitMinutes: GO_LIMITS.verifyWaitMinutes }, dependencies.runner, (await import('./releaseCommands.mts')).systemHttpFetcher(), dependencies.sleeper);
  console.log(verify.renderTable(rows));
  return verify.exitCodeFor(rows);
}

export async function main(argumentsList: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseGoArguments(argumentsList);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    return 2;
  }
  const bootstrap = systemCommandRunner(environment);
  const childEnvironment = flowtricksEnvironment(environment, bootstrap);
  const dependencies: GoDependencies = {
    runner: systemCommandRunner(childEnvironment),
    writer: systemWriteRunner(childEnvironment),
    files: systemRepositoryFiles(process.cwd()),
    reporter: systemReporter(environment),
    sleeper: systemSleeper,
  };
  const goArguments = parsed.value;
  switch (goArguments.stage) {
    case 'local':
      return runLocal(goArguments, dependencies);
    case 'preflight': {
      const result = runPreflight(
        { version: goArguments.version, bumpPolicy: goArguments.bumpPolicy, notes: goArguments.notes, mode: goArguments.mode, context: 'workflow', pushToken: pushTokenFrom(environment, 'workflow') },
        dependencies,
      );
      if (!result.ok) {
        reportRefusal('preflight', result.error, dependencies.reporter);
        return 1;
      }
      reportPreflight(result.value, goArguments.mode, dependencies.reporter);
      return 0;
    }
    case 'approve': {
      const gate = checkReleaseGate({ mode: 'release', pushToken: pushTokenFrom(environment, 'workflow') }, dependencies.runner);
      if (!gate.ok) {
        reportRefusal('approve', gate.error, dependencies.reporter);
        return 1;
      }
      dependencies.reporter.summary('## Release approved\n\nThe `release` environment requires a reviewer, and one approved this run.');
      return 0;
    }
    case 'tag': {
      assert(goArguments.expectedSha !== undefined, 'main: the tag stage has the preflight SHA');
      assert(goArguments.version !== undefined, 'main: the tag stage has the preflight version');
      const result = runTag(
        {
          expectedSha: goArguments.expectedSha,
          version: goArguments.version,
          bumpPolicy: goArguments.bumpPolicy,
          notes: goArguments.notes,
          mode: goArguments.mode,
          context: 'workflow',
          pushToken: pushTokenFrom(environment, 'workflow'),
        },
        dependencies,
      );
      if (!result.ok) {
        reportRefusal('tag', result.error, dependencies.reporter);
        return 1;
      }
      reportTag(result.value, dependencies.reporter);
      return 0;
    }
    default: {
      const exhaustive: never = goArguments.stage;
      return exhaustive;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
