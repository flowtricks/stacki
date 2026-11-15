// Goal: prepare.mts turns "release the next version" into one deterministic commit: the next
// patch after the last tag, written into every manifest file and proven by reading it back, the
// release notes generated from the log, and a refusal (with nothing written) for every state that
// must not be released from. Running it twice changes nothing the second time.
// Methodology: a scripted repository and GitHub (test/helpers/releaseWorld.ts) answer git and gh,
// files live in a map, and writes are recorded. Each test changes one fact and checks the plan,
// the files and the recorded writes; the manifest's text edits are checked against real-shaped
// package.json and lockfile layouts, including layouts the edit must refuse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEAD_SHA, newWorld, worldFiles, worldRunner, worldWriter, type World } from '../../helpers/releaseWorld.ts';
import { changedPaths, executePlan, parsePrepareArguments, planRelease, renderPlan, type PrepareOptions } from '../../../scripts/release/prepare.mts';
import { ok } from '../../../scripts/release/releaseResult.mts';
import { RELEASE_BUMP_PATHS, readVersions, VERSION_FILES, writeVersion } from '../../../scripts/release/versionManifest.mts';

const DEFAULTS: PrepareOptions = { version: undefined, bumpPolicy: 'patch-only', notesOverride: undefined, expectedSha: undefined };

function plan(world: World, options: PrepareOptions = DEFAULTS) {
  return planRelease(options, worldRunner(world), worldFiles(world));
}

test('the next patch after the last tag on origin, in every manifest file, proven on disk and in the commit', () => {
  const world = newWorld();
  const planned = plan(world);
  assert.ok(planned.ok, planned.ok ? '' : planned.error.message);
  assert.equal(planned.value.version, '1.4.4');
  assert.equal(planned.value.previous, '1.4.3');
  assert.deepEqual(changedPaths(planned.value), RELEASE_BUMP_PATHS);
  assert.equal(planned.value.commitSubject, 'chore(release): version 1.4.4');
  assert.ok(planned.value.commitSubject.length <= 72);
  const outcome = executePlan(planned.value, worldRunner(world), worldWriter(world), worldFiles(world));
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.error.message);
  assert.equal(outcome.value.kind, 'committed');
  for (const file of VERSION_FILES) {
    const versions = readVersions(file, world.files.get(file.path) ?? '');
    assert.ok(versions.ok);
    assert.ok(versions.value.every((version) => version === '1.4.4'), file.path);
  }
  assert.match(world.files.get('docs/releases.md') ?? '', /Intro text\.\n\n## 1\.4\.4\n\n- Desktop, .* aligned at 1\.4\.4\.\n- \*\*Features\*\*\n  - release: one-button releases\n- \*\*Fixes\*\*\n  - picker: reveal the arrowed row\n\n## 1\.4\.3 the last one/);
  const commit = world.writes.find((write) => write.argumentsList[0] === 'commit');
  assert.deepEqual(commit?.argumentsList.slice(0, 2), ['commit', '-m']);
  assert.equal(world.writes.filter((write) => write.argumentsList.includes('push') || write.argumentsList[0] === 'tag').length, 0, 'prepare never tags or pushes');
});

test('running it twice gives no second diff and no second commit', () => {
  const world = newWorld();
  const first = plan(world);
  assert.ok(first.ok);
  assert.ok(executePlan(first.value, worldRunner(world), worldWriter(world), worldFiles(world)).ok);
  const filesAfterFirst = new Map(world.files);
  const commitsAfterFirst = world.commits.length;
  const second = plan(world);
  assert.ok(second.ok, second.ok ? '' : second.error.message);
  assert.deepEqual(changedPaths(second.value), []);
  const outcome = executePlan(second.value, worldRunner(world), worldWriter(world), worldFiles(world));
  assert.ok(outcome.ok);
  assert.equal(outcome.value.kind, 'already-prepared');
  assert.deepEqual(world.files, filesAfterFirst);
  assert.equal(world.commits.length, commitsAfterFirst);
  assert.match(renderPlan(second.value), /nothing to commit/);
});

test('a dry run is the plan alone: planning writes nothing and runs no write command', () => {
  const world = newWorld();
  const before = new Map(world.files);
  const planned = plan(world);
  assert.ok(planned.ok);
  const text = renderPlan(planned.value);
  assert.match(text, /package-lock\.json\s+1\.4\.3, 1\.4\.3 -> 1\.4\.4/);
  assert.match(text, /--- docs\/releases\.md entry ---\n## 1\.4\.4/);
  assert.deepEqual(world.files, before);
  assert.deepEqual(world.writes, []);
  const parsed = parsePrepareArguments(['--dry-run'], () => ok(''));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.mode, 'dry-run');
});

test('every refusal happens before anything is written', () => {
  const cases: readonly (readonly [string, (world: World) => World, PrepareOptions, string])[] = [
    ['dirty tree', (world) => ({ ...world, status: ' M src/app.ts\n' }), DEFAULTS, 'dirty-tree'],
    ['wrong branch', (world) => ({ ...world, branch: 'feature' }), DEFAULTS, 'wrong-branch'],
    ['wrong commit in the workflow', (world) => world, { ...DEFAULTS, expectedSha: 'b'.repeat(40) }, 'wrong-commit'],
    ['tag already on origin', (world) => ({ ...world, tags: [...world.tags, 'v1.4.4'] }), { ...DEFAULTS, version: '1.4.4' }, 'bump-'],
    ['tag left locally by a failed push', (world) => ({ ...world, localTags: ['v1.4.4'] }), DEFAULTS, 'tag-exists-locally'],
    ['a minor bump without the override', (world) => world, { ...DEFAULTS, version: '1.5.0' }, 'bump-minor'],
    ['a skipped patch', (world) => world, { ...DEFAULTS, version: '1.4.5' }, 'bump-skipped'],
    ['a red Check on the exact commit', (world) => ({ ...world, checkRuns: [{ id: 7, headSha: HEAD_SHA, status: 'completed', conclusion: 'failure', jobs: [] }] }), DEFAULTS, 'not-green'],
    ['no Check at all', (world) => ({ ...world, checkRuns: [] }), DEFAULTS, 'not-green'],
    ['a heading in the notes override', (world) => world, { ...DEFAULTS, notesOverride: '## sneaky' }, 'notes-heading'],
  ];
  for (const [name, change, options, code] of cases) {
    const world = change(newWorld());
    const before = new Map(world.files);
    const planned = plan(world, options);
    assert.ok(!planned.ok, name);
    assert.ok(planned.error.code.startsWith(code), `${name}: ${planned.error.code}`);
    assert.deepEqual(world.files, before, name);
    assert.deepEqual(world.writes, [], name);
  }
});

test('--allow-minor admits exactly the next minor or major, never a skip', () => {
  assert.ok(plan(newWorld(), { ...DEFAULTS, version: '1.5.0', bumpPolicy: 'minor-or-major' }).ok);
  assert.ok(plan(newWorld(), { ...DEFAULTS, version: '2.0.0', bumpPolicy: 'minor-or-major' }).ok);
  const skipped = plan(newWorld(), { ...DEFAULTS, version: '1.6.0', bumpPolicy: 'minor-or-major' });
  assert.ok(!skipped.ok);
  assert.equal(skipped.error.code, 'bump-not-next');
});

test('a disk that drops a write fails the read-back and commits nothing', () => {
  const world = newWorld();
  world.droppedWrites.add('studio/package-lock.json');
  const planned = plan(world);
  assert.ok(planned.ok);
  const outcome = executePlan(planned.value, worldRunner(world), worldWriter(world), worldFiles(world));
  assert.ok(!outcome.ok);
  assert.equal(outcome.error.code, 'manifest-readback');
  assert.match(outcome.error.message, /studio\/package-lock\.json/);
  assert.equal(world.commits.length, 0);
});

test('a commit that holds other paths than planned is reported, not trusted', () => {
  const world = newWorld();
  world.committedPathsOverride = [...RELEASE_BUMP_PATHS, 'src/other.ts'];
  const planned = plan(world);
  assert.ok(planned.ok);
  const outcome = executePlan(planned.value, worldRunner(world), worldWriter(world), worldFiles(world));
  assert.ok(!outcome.ok);
  assert.equal(outcome.error.code, 'commit-paths');
});

test('the manifest edit changes only version lines and refuses unknown layouts', () => {
  const lockFile = VERSION_FILES[1];
  const lock = newWorld().files.get('package-lock.json') ?? '';
  const written = writeVersion(lockFile, lock, '1.4.4');
  assert.ok(written.ok);
  const changed = written.value.split('\n').filter((line, index) => line !== lock.split('\n')[index]);
  assert.deepEqual(changed, ['  "version": "1.4.4",', '      "version": "1.4.4",']);
  assert.ok(written.value.includes('"node_modules/dep": {\n      "version": "1.2.3"'), 'a dependency version is never touched');
  assert.ok(!writeVersion(VERSION_FILES[0], '{"version":"1.4.3"}', '1.4.4').ok, 'minified JSON is not a layout npm writes');
  assert.ok(!writeVersion(lockFile, '{\n  "version": "1.4.3",\n  "packages": {}\n}\n', '1.4.4').ok);
  assert.ok(!readVersions(lockFile, '{"version":"1"}').ok);
  assert.ok(!readVersions(VERSION_FILES[0], 'not json').ok);
});

test('the manifest names the six version files and the notes, and nothing else', () => {
  assert.deepEqual(RELEASE_BUMP_PATHS, [
    'package.json',
    'package-lock.json',
    'packages/create-stacki/package.json',
    'studio/package.json',
    'studio/package-lock.json',
    'studio/src/shared/release.json',
    'docs/releases.md',
  ]);
});
