// Goal: the release button can only publish through its gates. A dry run commits, tags and pushes
// nothing; a real run needs a protected `release` environment and the push token in the workflow
// and an exactly typed --confirm locally; main moving after the preflight stops it (compare and
// swap); a real run makes exactly one atomic push of the bump commit and the tag, then reads it
// back from origin. Every refusal names one next step.
// Methodology: the stages run end to end against a scripted repository and GitHub
// (test/helpers/releaseWorld.ts) with recorded writes; argument parsing and the next-step table
// are pure and tested directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordingReporter } from '../../../scripts/release/actionsReport.mts';
import { nextStepFor, parseGoArguments, reportPreflight, reportTag, runPreflight, runTag, type GoDependencies, type TagInput } from '../../../scripts/release/releaseGo.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';
import { BUMP_SHA, HEAD_SHA, newWorld, worldFiles, worldRunner, worldWriter, type World } from '../../helpers/releaseWorld.ts';

function dependencies(world: World): GoDependencies & { readonly report: ReturnType<typeof recordingReporter>['report'] } {
  const { reporter, report } = recordingReporter();
  return { runner: worldRunner(world), writer: worldWriter(world), files: worldFiles(world), reporter, sleeper: () => Promise.resolve(), report };
}

const TAG_INPUT: TagInput = { expectedSha: HEAD_SHA, version: '1.4.4', bumpPolicy: 'patch-only', notes: undefined, mode: 'release', context: 'workflow', pushToken: 'present' };
const MISSING = fail('command-failed', 'gh api repos/flowtricks/stacki/environments/release exited 1: Not Found (HTTP 404)');

test('preflight: a dry run reports what a real run would refuse, and records the SHA and version', () => {
  const world = newWorld();
  world.environment = MISSING;
  const deps = dependencies(world);
  const result = runPreflight({ version: undefined, bumpPolicy: 'patch-only', notes: undefined, mode: 'dry-run', context: 'workflow', pushToken: 'absent' }, deps);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.sha, HEAD_SHA);
  assert.equal(result.value.warnings.length, 2);
  assert.match(result.value.warnings.join('\n'), /no "release" environment exists/);
  assert.match(result.value.warnings.join('\n'), /RELEASE_PUSH_TOKEN/);
  reportPreflight(result.value, 'dry-run', deps.reporter);
  assert.equal(deps.report.outputs.get('sha'), HEAD_SHA);
  assert.equal(deps.report.outputs.get('version'), '1.4.4');
  assert.equal(deps.report.outputs.get('mode'), 'dry-run');
  assert.deepEqual(world.writes, []);
});

test('preflight: a real run refuses a missing or reviewer-less environment and a missing push token', () => {
  const missing = newWorld();
  missing.environment = MISSING;
  const refusedMissing = runPreflight({ version: undefined, bumpPolicy: 'patch-only', notes: undefined, mode: 'release', context: 'workflow', pushToken: 'present' }, dependencies(missing));
  assert.ok(!refusedMissing.ok);
  assert.equal(refusedMissing.error.code, 'environment-missing');
  const open = newWorld();
  open.environment = ok(JSON.stringify({ name: 'release', protection_rules: [{ type: 'wait_timer', wait_timer: 5 }] }));
  const refusedOpen = runPreflight({ version: undefined, bumpPolicy: 'patch-only', notes: undefined, mode: 'release', context: 'workflow', pushToken: 'present' }, dependencies(open));
  assert.ok(!refusedOpen.ok);
  assert.equal(refusedOpen.error.code, 'environment-unprotected');
  const noToken = runPreflight({ version: undefined, bumpPolicy: 'patch-only', notes: undefined, mode: 'release', context: 'workflow', pushToken: 'absent' }, dependencies(newWorld()));
  assert.ok(!noToken.ok);
  assert.equal(noToken.error.code, 'push-token-missing');
  const unreadable = newWorld();
  unreadable.environment = fail('command-failed', 'HTTP 500');
  const refusedUnreadable = runPreflight({ version: undefined, bumpPolicy: 'patch-only', notes: undefined, mode: 'dry-run', context: 'workflow', pushToken: 'present' }, dependencies(unreadable));
  assert.ok(!refusedUnreadable.ok, 'an unreadable environment is never read as fine');
});

test('preflight: in the workflow the checkout must be the exact tip of main', () => {
  const world = newWorld();
  world.remoteMain = 'b'.repeat(40);
  const result = runPreflight({ version: undefined, bumpPolicy: 'patch-only', notes: undefined, mode: 'dry-run', context: 'workflow', pushToken: 'present' }, dependencies(world));
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'main-moved');
});

test('tag: a dry run commits, tags and pushes nothing', () => {
  const world = newWorld();
  const before = new Map(world.files);
  const deps = dependencies(world);
  const result = runTag({ ...TAG_INPUT, mode: 'dry-run', pushToken: 'absent' }, deps);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.kind, 'dry-run');
  assert.deepEqual(world.writes, []);
  assert.deepEqual(world.files, before);
  reportTag(result.value, deps.reporter);
  assert.equal(deps.report.outputs.get('pushed'), 'no');
  assert.match(deps.report.summaries.join('\n'), /Nothing was committed, tagged or pushed/);
});

test('tag: a real run commits, tags, pushes main and the tag atomically, and reads them back', () => {
  const world = newWorld();
  const result = runTag(TAG_INPUT, dependencies(world));
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.value.kind, 'pushed');
  const pushes = world.writes.filter((write) => write.argumentsList.includes('push'));
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0]?.argumentsList, ['push', '--atomic', 'origin', `${BUMP_SHA}:refs/heads/main`, 'refs/tags/v1.4.4:refs/tags/v1.4.4']);
  assert.ok(world.writes.some((write) => write.argumentsList.join(' ') === `tag v1.4.4 ${BUMP_SHA}`));
  assert.equal(world.remoteMain, BUMP_SHA);
  assert.ok(world.tags.includes('v1.4.4'));
});

test('tag: the local button pushes with the flowtricks credential helper and streams the hook', () => {
  const world = newWorld();
  const result = runTag({ ...TAG_INPUT, context: 'local', pushToken: 'not-needed' }, dependencies(world));
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  const push = world.writes.find((write) => write.argumentsList.includes('push'));
  assert.deepEqual(push?.argumentsList.slice(0, 4), ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']);
  assert.equal(push?.output, 'inherit');
  assert.ok(!push?.argumentsList.includes('--no-verify'));
});

test('tag: main moving after the preflight stops the release before any write', () => {
  const world = newWorld();
  world.remoteMain = 'b'.repeat(40);
  const result = runTag(TAG_INPUT, dependencies(world));
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'main-moved');
  assert.deepEqual(world.writes, []);
});

test('tag: the approval gate is checked again before the push', () => {
  const world = newWorld();
  world.environment = MISSING;
  const result = runTag(TAG_INPUT, dependencies(world));
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'environment-missing');
  assert.deepEqual(world.writes, []);
});

test('tag: a version that differs from the preflight is refused', () => {
  const result = runTag({ ...TAG_INPUT, version: '1.4.5' }, dependencies(newWorld()));
  assert.ok(!result.ok);
});

test('arguments: locally a dry run is the default; the workflow names its stage and mode', () => {
  const local = parseGoArguments([]);
  assert.ok(local.ok);
  assert.equal(local.value.mode, 'dry-run');
  const confirmed = parseGoArguments(['--confirm', '1.4.4']);
  assert.ok(confirmed.ok);
  assert.equal(confirmed.value.mode, 'release');
  assert.equal(confirmed.value.confirm, '1.4.4');
  const workflow = parseGoArguments(['--stage=preflight', '--dry-run=false', '--version=', '--allow-minor=false', '--notes=']);
  assert.ok(workflow.ok);
  assert.equal(workflow.value.mode, 'release');
  assert.equal(workflow.value.version, undefined);
  assert.equal(workflow.value.notes, undefined);
  const refused = [
    ['--stage=preflight'],
    ['--stage=preflight', '--dry-run=yes'],
    ['--stage=tag', '--dry-run=true'],
    ['--stage=tag', '--dry-run=true', '--expected-sha=abc', '--version=1.4.4'],
    ['--stage=preflight', '--dry-run=false', '--confirm=1.4.4'],
    ['--dry-run=false'],
    ['--stage=ship'],
    ['--force'],
  ];
  for (const argumentsList of refused) {
    assert.ok(!parseGoArguments(argumentsList).ok, argumentsList.join(' '));
  }
});

test('every refusal code has a concrete next step', () => {
  for (const code of ['not-green', 'tag-exists', 'bump-minor', 'environment-missing', 'push-token-missing', 'main-moved', 'command-failed', 'something-new']) {
    assert.ok(nextStepFor(code).length > 20, code);
  }
  assert.match(nextStepFor('environment-unprotected'), /Required reviewers/);
  assert.match(nextStepFor('push-token-missing'), /Contents: Read and write/);
});
