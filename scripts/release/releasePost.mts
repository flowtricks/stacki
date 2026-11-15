#!/usr/bin/env node
// The release chain after the tag, run by .github/workflows/release-post.yml when release.yml
// finishes. Each stage is one job's single step:
//
//   --stage=resolve --run-id=<id>           what finished: a Release run for a vX.Y.Z tag push, and how
//   --stage=publish-npm --version=X --sha=S  dispatch publish-create-stacki.yml (or find the run already
//                                            going, or see the version already on npm) and wait for it
//   --stage=deploy-site --version=X          dispatch the stacki.build deploy and wait, when the
//                                            RELEASE_DISPATCH_TOKEN secret exists; otherwise a warning
//   --stage=rerun --run-id=<id> --attempt=N  the failure path: rerunPolicy.mts decides, by rule, whether
//                                            one rerun of the failed jobs is due
//   --stage=summary --version=X --results=…  the final summary with links
//
// The decision inputs come from the API (gh run view), not from the event payload, so a manual
// dispatch with a run id and the automatic workflow_run trigger take the same path. Every wait is
// bounded. Nothing here moves, deletes or recreates a tag.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter, type Reporter } from './actionsReport.mts';
import { flowtricksEnvironment, pollUntil, systemCommandRunner, systemSleeper, type CommandRunner, type Sleeper } from './releaseCommands.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { listRuns, newestSince, viewRun, waitForRunToAppear, waitForRunToComplete, type WorkflowRun } from './releaseRuns.mts';
import { SOURCE_REPOSITORY } from './releaseStatus.mts';
import { parseVersion } from './releaseVersion.mts';
import { systemWriteRunner, type WriteRunner } from './releaseWrite.mts';
import { decideRerun, parseAnnotations, parseRunJobs, splitFailedLog, type FailedJob, type RerunDecision } from './rerunPolicy.mts';

export const SITE_REPOSITORY = 'flowtricks/stacki-marketing-site';

export const POST_LIMITS = {
  appearMinutes: 5,
  appearDelayMs: 15_000,
  publishMinutes: 60,
  siteMinutes: 30,
  rerunMinutes: 120,
  waitDelayMs: 120_000,
  // A dispatch's run is created after the call returns; this much clock skew is tolerated.
  dispatchSkewMs: 30_000,
} as const satisfies Record<string, number>;

export interface PostDependencies {
  readonly runner: CommandRunner;
  readonly writer: WriteRunner;
  readonly reporter: Reporter;
  readonly sleeper: Sleeper;
  readonly now: () => number;
}

export type ResolveOutcome =
  | { readonly kind: 'publish'; readonly version: string; readonly run: WorkflowRun }
  | { readonly kind: 'rerun-policy'; readonly version: string; readonly run: WorkflowRun }
  | { readonly kind: 'ignore'; readonly reason: string };

const TAG = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/;

/** Pure: what a finished run means for the chain, given where origin's tag points. */
export function classifyRun(run: WorkflowRun, tagSha: string | undefined): ResolveOutcome {
  if (run.workflowName !== 'Release') {
    return { kind: 'ignore', reason: `run ${run.url} is "${run.workflowName}", not Release.` };
  }
  if (run.event !== 'push') {
    return { kind: 'ignore', reason: `run ${run.url} came from ${run.event}; only a tag push releases.` };
  }
  const tag = TAG.exec(run.headBranch);
  if (tag?.[1] === undefined) {
    return { kind: 'ignore', reason: `run ${run.url} is for ${run.headBranch}, not a vX.Y.Z tag.` };
  }
  if (tagSha !== run.headSha) {
    return { kind: 'ignore', reason: `origin's ${run.headBranch} is ${tagSha ?? 'missing'}, not the run's ${run.headSha.slice(0, 7)}; refusing to publish a commit the tag does not name.` };
  }
  if (run.status !== 'completed') {
    return { kind: 'ignore', reason: `run ${run.url} is still ${run.status}.` };
  }
  if (run.conclusion === 'success') {
    return { kind: 'publish', version: tag[1], run };
  }
  if (run.conclusion === 'failure') {
    return { kind: 'rerun-policy', version: tag[1], run };
  }
  return { kind: 'ignore', reason: `run ${run.url} ended ${run.conclusion ?? 'without a conclusion'}; nothing to publish or rerun.` };
}

/** The commit a tag names on origin, peeled through an annotated tag. */
export function readTagSha(runner: CommandRunner, tag: string): Result<string | undefined> {
  const refs = runner({ command: 'git', argumentsList: ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`] });
  if (!refs.ok) {
    return refs;
  }
  const lines = refs.value.split('\n').filter((line) => line.length > 0);
  const peeled = lines.find((line) => line.endsWith('^{}'))?.split('\t')[0];
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`))?.split('\t')[0];
  return ok(peeled ?? direct);
}

export function resolveRun(runId: number, runner: CommandRunner): Result<ResolveOutcome> {
  const run = viewRun(runner, SOURCE_REPOSITORY, runId);
  if (!run.ok) {
    return run;
  }
  const tagSha = TAG.test(run.value.headBranch) ? readTagSha(runner, run.value.headBranch) : ok(undefined);
  if (!tagSha.ok) {
    return tagSha;
  }
  return ok(classifyRun(run.value, tagSha.value));
}

function npmHasVersion(runner: CommandRunner, version: string): boolean {
  // E404 (not published yet) and a network failure both read as "not visible"; publishing then
  // either succeeds or npm refuses a duplicate, so neither case can publish twice.
  const view = runner({ command: 'npm', argumentsList: ['view', `create-stacki@${version}`, 'version'], timeoutMs: 60_000 });
  return view.ok && view.value.trim() === version;
}

/** Find or dispatch the npm publish for this tag, then wait for it. Idempotent across reruns. */
export async function publishNpm(version: string, sha: string, dependencies: PostDependencies): Promise<Result<string>> {
  assert(parseVersion(version).ok, 'publishNpm: a release version');
  assert(/^[0-9a-f]{40}$/.test(sha), 'publishNpm: a full SHA');
  if (npmHasVersion(dependencies.runner, version)) {
    return ok(`create-stacki@${version} is already on npm; nothing to publish.`);
  }
  const query = { repository: SOURCE_REPOSITORY, workflow: 'publish-create-stacki.yml', event: 'workflow_dispatch', commit: sha };
  const existing = listRuns(dependencies.runner, query);
  if (!existing.ok) {
    return existing;
  }
  const reusable = existing.value.find((run) => run.headSha === sha && (run.status !== 'completed' || run.conclusion === 'success'));
  let run: WorkflowRun;
  if (reusable === undefined) {
    const since = new Date(dependencies.now() - POST_LIMITS.dispatchSkewMs).toISOString();
    const dispatch = dependencies.writer({
      command: 'gh',
      argumentsList: ['workflow', 'run', 'publish-create-stacki.yml', '--repo', SOURCE_REPOSITORY, '--ref', `v${version}`],
      output: 'capture',
    });
    if (!dispatch.ok) {
      return dispatch;
    }
    const appeared = await waitForRunToAppear({ minutesMax: POST_LIMITS.appearMinutes, delayMs: POST_LIMITS.appearDelayMs, sleeper: dependencies.sleeper }, () => {
      const runs = listRuns(dependencies.runner, query);
      return runs.ok ? ok(newestSince(runs.value.filter((candidate) => candidate.headSha === sha), since)) : runs;
    });
    if (!appeared.ok) {
      return appeared;
    }
    run = appeared.value;
  } else {
    run = reusable;
  }
  console.log(`Publish create-stacki: ${run.url}`);
  const finished = await waitForRunToComplete({ minutesMax: POST_LIMITS.publishMinutes, delayMs: POST_LIMITS.waitDelayMs, sleeper: dependencies.sleeper }, dependencies.runner, SOURCE_REPOSITORY, run.id);
  if (!finished.ok) {
    return finished;
  }
  if (finished.value.conclusion !== 'success') {
    return fail(
      'publish-failed',
      `Publish create-stacki ended ${finished.value.conclusion ?? 'without a conclusion'}: ${finished.value.url}. An E404 on PUT means npm's trusted publisher ` +
        'for create-stacki no longer names flowtricks/stacki and publish-create-stacki.yml (docs/create-stacki.md).',
    );
  }
  return ok(`Publish create-stacki succeeded: ${finished.value.url}`);
}

export type SiteOutcome = { readonly kind: 'skipped'; readonly reason: string } | { readonly kind: 'deployed'; readonly url: string } | { readonly kind: 'failed'; readonly reason: string };

/** Dispatch the site deploy after npm has the version, so the demo bakes the new package. */
export async function deploySite(tokenPresent: 'yes' | 'no', dependencies: PostDependencies): Promise<SiteOutcome> {
  if (tokenPresent === 'no') {
    return {
      kind: 'skipped',
      reason:
        'RELEASE_DISPATCH_TOKEN is not set, so the site deploy was not dispatched. stacki.build picks the version up on its own ' +
        '(release.yml asks for a rebuild, and the site checks daily at 06:17 UTC). The site checks are left out of the final verify.',
    };
  }
  const since = new Date(dependencies.now() - POST_LIMITS.dispatchSkewMs).toISOString();
  const dispatch = dependencies.writer({ command: 'gh', argumentsList: ['workflow', 'run', 'deploy.yml', '--repo', SITE_REPOSITORY, '--ref', 'main'], output: 'capture' });
  if (!dispatch.ok) {
    return { kind: 'failed', reason: `could not dispatch the site deploy: ${dispatch.error.message}` };
  }
  const query = { repository: SITE_REPOSITORY, workflow: 'deploy.yml', event: 'workflow_dispatch', commit: undefined };
  const appeared = await waitForRunToAppear({ minutesMax: POST_LIMITS.appearMinutes, delayMs: POST_LIMITS.appearDelayMs, sleeper: dependencies.sleeper }, () => {
    const runs = listRuns(dependencies.runner, query);
    return runs.ok ? ok(newestSince(runs.value, since)) : runs;
  });
  if (!appeared.ok) {
    return { kind: 'failed', reason: appeared.error.message };
  }
  const finished = await waitForRunToComplete({ minutesMax: POST_LIMITS.siteMinutes, delayMs: POST_LIMITS.waitDelayMs, sleeper: dependencies.sleeper }, dependencies.runner, SITE_REPOSITORY, appeared.value.id);
  if (!finished.ok) {
    return { kind: 'failed', reason: finished.error.message };
  }
  return finished.value.conclusion === 'success'
    ? { kind: 'deployed', url: finished.value.url }
    : { kind: 'failed', reason: `the site deploy ended ${finished.value.conclusion ?? 'unfinished'}: ${finished.value.url}. The old site stays up.` };
}

/** The failed jobs of one attempt, each with its failed log and annotations. */
export function readFailedJobs(runner: CommandRunner, runId: number, attempt: number): Result<readonly FailedJob[]> {
  const jobsText = runner({ command: 'gh', argumentsList: ['run', 'view', String(runId), '--attempt', String(attempt), '--repo', SOURCE_REPOSITORY, '--json', 'jobs'] });
  if (!jobsText.ok) {
    return jobsText;
  }
  const jobs = parseRunJobs(jobsText.value);
  if (!jobs.ok) {
    return jobs;
  }
  const failed = jobs.value.filter((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out');
  const log = runner({ command: 'gh', argumentsList: ['run', 'view', String(runId), '--attempt', String(attempt), '--repo', SOURCE_REPOSITORY, '--log-failed'], timeoutMs: 180_000 });
  // A missing log is no evidence of a flake; the job is then judged on its annotations alone.
  const byJob = log.ok ? splitFailedLog(log.value) : new Map<string, string>();
  const result: FailedJob[] = [];
  for (const job of failed) {
    const annotationsText = runner({ command: 'gh', argumentsList: ['api', `repos/${SOURCE_REPOSITORY}/check-runs/${job.id}/annotations`] });
    const annotations = annotationsText.ok ? parseAnnotations(annotationsText.value) : ok([]);
    const messages = annotations.ok ? annotations.value : [];
    result.push({ id: job.id, name: job.name, text: `${byJob.get(job.name) ?? ''}${messages.join('\n')}\n` });
  }
  return ok(result);
}

export type RerunResult = { readonly kind: 'rerun-passed'; readonly url: string } | { readonly kind: 'stopped'; readonly decision: RerunDecision | undefined; readonly reason: string };

export async function applyRerunPolicy(runId: number, attempt: number, dependencies: PostDependencies): Promise<RerunResult> {
  const failed = readFailedJobs(dependencies.runner, runId, attempt);
  if (!failed.ok) {
    return { kind: 'stopped', decision: undefined, reason: `could not read the failed jobs: ${failed.error.message}` };
  }
  const decision = decideRerun(attempt, failed.value);
  if (decision.kind === 'stop') {
    return { kind: 'stopped', decision, reason: decision.reason };
  }
  const rerun = dependencies.writer({ command: 'gh', argumentsList: ['run', 'rerun', String(runId), '--failed', '--repo', SOURCE_REPOSITORY], output: 'capture' });
  if (!rerun.ok) {
    return { kind: 'stopped', decision, reason: `the rerun could not start: ${rerun.error.message}` };
  }
  const attemptsMax = 1 + Math.ceil((POST_LIMITS.rerunMinutes * 60_000) / POST_LIMITS.waitDelayMs);
  const last = await pollUntil(
    { attemptsMax, delayMs: POST_LIMITS.waitDelayMs, sleeper: dependencies.sleeper },
    () => Promise.resolve(viewRun(dependencies.runner, SOURCE_REPOSITORY, runId)),
    (view) => view.ok && view.value.attempt > attempt && view.value.status === 'completed',
  );
  if (!last.ok || last.value.attempt <= attempt || last.value.status !== 'completed') {
    return { kind: 'stopped', decision, reason: `the rerun did not finish within ${POST_LIMITS.rerunMinutes} minutes.` };
  }
  if (last.value.conclusion !== 'success') {
    return { kind: 'stopped', decision, reason: `the rerun (attempt ${last.value.attempt}) failed too: ${last.value.url}. A failure that repeats is real.` };
  }
  // Hand the green run back to this workflow; the concurrency group keeps exactly one chain running.
  const dispatch = dependencies.writer({
    command: 'gh',
    argumentsList: ['workflow', 'run', 'release-post.yml', '--repo', SOURCE_REPOSITORY, '--ref', 'main', '-f', `release_run_id=${runId}`],
    output: 'capture',
  });
  if (!dispatch.ok) {
    return { kind: 'stopped', decision, reason: `the rerun passed, but Release post could not be started: ${dispatch.error.message}. Run it by hand with release_run_id=${runId}.` };
  }
  return { kind: 'rerun-passed', url: last.value.url };
}

export function renderFinalSummary(version: string, results: ReadonlyMap<string, string>): string {
  const rows = [...results].map(([job, result]) => `| ${job} | ${result} |`);
  const allGreen = [...results.values()].every((result) => result === 'success' || result === 'skipped');
  return [
    `## Release ${version}: ${allGreen ? 'live' : 'NOT complete'}`,
    '',
    '| Stage | Result |',
    '|---|---|',
    ...rows,
    '',
    `- Release: https://github.com/flowtricks/stacki-releases/releases/tag/v${version}`,
    `- npm: https://www.npmjs.com/package/create-stacki/v/${version}`,
    '- Site: https://stacki.build (its /stacki-release.txt names the version it was built from)',
    '',
    allGreen ? 'Next: restart a running `npm run dev` only if you ran the full gate locally.' : 'Next: open the first red stage above; docs/release-runbook.md "If it fails" has its single next step.',
  ].join('\n');
}

interface PostArguments {
  readonly stage: 'resolve' | 'publish-npm' | 'deploy-site' | 'rerun' | 'summary';
  readonly values: ReadonlyMap<string, string>;
}

export function parsePostArguments(argumentsList: readonly string[]): Result<PostArguments> {
  const values = new Map<string, string>();
  for (const argument of argumentsList) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (match?.[1] === undefined || match[2] === undefined) {
      return fail('usage', `unknown argument ${argument}`);
    }
    values.set(match[1], match[2]);
  }
  const stage = values.get('stage');
  if (stage !== 'resolve' && stage !== 'publish-npm' && stage !== 'deploy-site' && stage !== 'rerun' && stage !== 'summary') {
    return fail('usage', '--stage takes resolve, publish-npm, deploy-site, rerun or summary.');
  }
  return ok({ stage, values });
}

function integerValue(values: ReadonlyMap<string, string>, name: string): number | undefined {
  const text = values.get(name) ?? '';
  return /^\d{1,20}$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
}

async function runStage(parsed: PostArguments, dependencies: PostDependencies, environment: NodeJS.ProcessEnv): Promise<number> {
  const { reporter } = dependencies;
  const version = parsed.values.get('version') ?? '';
  switch (parsed.stage) {
    case 'resolve': {
      const runId = integerValue(parsed.values, 'run-id');
      if (runId === undefined) {
        reporter.error('--run-id is missing');
        return 2;
      }
      const outcome = resolveRun(runId, dependencies.runner);
      if (!outcome.ok) {
        reporter.error(outcome.error.message);
        reporter.summary(`## Release post: could not read run ${runId}\n\n${outcome.error.message}\n\n**Next step:** run Release post again with release_run_id=${runId}.`);
        return 1;
      }
      reporter.output('outcome', outcome.value.kind);
      if (outcome.value.kind === 'ignore') {
        reporter.notice(outcome.value.reason);
        return 0;
      }
      reporter.output('version', outcome.value.version);
      reporter.output('sha', outcome.value.run.headSha);
      reporter.output('run_id', String(outcome.value.run.id));
      reporter.output('attempt', String(outcome.value.run.attempt));
      reporter.summary(`## Release post for v${outcome.value.version}\n\nRelease run ${outcome.value.run.url} ended ${outcome.value.run.conclusion ?? ''}: next is ${outcome.value.kind}.`);
      return 0;
    }
    case 'publish-npm': {
      const sha = parsed.values.get('sha') ?? '';
      if (!parseVersion(version).ok || !/^[0-9a-f]{40}$/.test(sha)) {
        reporter.error('--version and --sha are required');
        return 2;
      }
      const published = await publishNpm(version, sha, dependencies);
      if (!published.ok) {
        reporter.error(published.error.message);
        reporter.summary(`## create-stacki ${version}: not published\n\n${published.error.message}`);
        return 1;
      }
      reporter.summary(`## create-stacki ${version}\n\n${published.value}`);
      return 0;
    }
    case 'deploy-site': {
      const site = await deploySite(environment['RELEASE_DISPATCH_TOKEN_PRESENT'] === 'true' ? 'yes' : 'no', dependencies);
      switch (site.kind) {
        case 'skipped':
          reporter.warning(site.reason);
          reporter.output('verify_groups', 'release,npm');
          reporter.summary(`## stacki.build: deploy not dispatched\n\n${site.reason}`);
          return 0;
        case 'deployed':
          reporter.output('verify_groups', 'release,npm,site');
          reporter.summary(`## stacki.build deployed\n\n${site.url}`);
          return 0;
        case 'failed':
          // The desktop release and npm are already public; the final verify reports the site.
          reporter.warning(site.reason);
          reporter.output('verify_groups', 'release,npm,site');
          reporter.summary(`## stacki.build: deploy failed\n\n${site.reason}`);
          return 0;
        default: {
          const exhaustive: never = site;
          return exhaustive;
        }
      }
    }
    case 'rerun': {
      const runId = integerValue(parsed.values, 'run-id');
      const attempt = integerValue(parsed.values, 'attempt');
      if (runId === undefined || attempt === undefined || attempt < 1) {
        reporter.error('--run-id and --attempt are required');
        return 2;
      }
      const result = await applyRerunPolicy(runId, attempt, dependencies);
      switch (result.kind) {
        case 'rerun-passed':
          reporter.summary(`## Release rerun passed\n\nOne rerun of the failed jobs, for a known infrastructure flake, passed: ${result.url}. Release post was started again for it.`);
          return 0;
        case 'stopped': {
          const nextStep = result.decision?.kind === 'stop' ? result.decision.nextStep : 'Open the Release run; docs/release-runbook.md "If it fails" has the next step.';
          const matched = result.decision?.kind === 'rerun' ? result.decision.matches.map((match) => `- ${match.job}: ${match.flake.id} (${match.flake.why})`) : [];
          reporter.error(result.reason);
          reporter.summary(
            [
              '## Release failed: stopped',
              '',
              `**Why:** ${result.reason}`,
              ...(matched.length === 0 ? [] : ['', 'Matched flakes:', ...matched]),
              '',
              `**Next step:** ${nextStep}`,
              '',
              `Run: https://github.com/${SOURCE_REPOSITORY}/actions/runs/${runId}`,
            ].join('\n'),
          );
          return 1;
        }
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }
    case 'summary': {
      const results = new Map<string, string>();
      for (const pair of (parsed.values.get('results') ?? '').split(',').filter((entry) => entry.length > 0)) {
        const [job, result] = pair.split(':');
        if (job !== undefined && result !== undefined) {
          results.set(job, result);
        }
      }
      reporter.summary(renderFinalSummary(version, results));
      return [...results.values()].every((result) => result === 'success' || result === 'skipped') ? 0 : 1;
    }
    default: {
      const exhaustive: never = parsed.stage;
      return exhaustive;
    }
  }
}

async function main(argumentsList: readonly string[]): Promise<number> {
  const parsed = parsePostArguments(argumentsList);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    return 2;
  }
  const environment = flowtricksEnvironment(process.env, systemCommandRunner(process.env));
  const dependencies: PostDependencies = {
    runner: systemCommandRunner(environment),
    writer: systemWriteRunner(environment),
    reporter: systemReporter(process.env),
    sleeper: systemSleeper,
    now: () => Date.now(),
  };
  return runStage(parsed.value, dependencies, process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
