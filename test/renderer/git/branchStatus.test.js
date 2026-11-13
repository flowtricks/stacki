// Goal: the branch chip and the publish warning agree on what "somewhere unexpected" means, and the "don't warn again"
// answers are stored per project and branch, bounded, and never trusted when read back.
// Methodology: the pure model (src/features/git/branchStatus.ts) is fed every shape git:info can take, valid and not:
// default branch from the remote, from main or master, unknown, other branches, a detached HEAD, a repository with no
// commits, no repository and nothing read yet. The stored answers (branchWarningPreference.ts) are parsed from good and
// malformed storage text, and the bounds and the per-project separation are pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const status = require('../../helpers/rendererModule')('src/features/git/branchStatus.ts');
const preference = require('../../helpers/rendererModule')('src/features/git/branchWarningPreference.ts');

const repo = (overrides) => ({
  isRepo: true,
  branch: 'main',
  branches: ['main'],
  remote: undefined,
  dirty: false,
  ahead: 0,
  parked: [],
  head: 'abc123',
  trunk: 'main',
  defaultBranch: 'main',
  ...overrides,
});

test('on the default branch the chip is quiet and nothing is asked', () => {
  const result = status.branchStatusOf(repo({}));
  assert.deepEqual(result, { kind: 'default', name: 'main' });
  assert.equal(status.needsBranchWarning(result), false);
});

test('any other branch is a warning that names the default', () => {
  const result = status.branchStatusOf(repo({ branch: 'feature/x', branches: ['main', 'feature/x'] }));
  assert.deepEqual(result, { kind: 'other', name: 'feature/x', defaultName: 'main' });
  assert.equal(status.needsBranchWarning(result), true);
});

test("the remote's default wins over main: develop is quiet, main is the odd one out", () => {
  const develop = repo({ branch: 'develop', branches: ['main', 'develop'], defaultBranch: 'develop' });
  assert.equal(status.branchStatusOf(develop).kind, 'default');
  const main = repo({ branch: 'main', branches: ['main', 'develop'], defaultBranch: 'develop' });
  assert.deepEqual(status.branchStatusOf(main), { kind: 'other', name: 'main', defaultName: 'develop' });
});

test('without a remote default it falls back to the trunk (main or master)', () => {
  const result = status.branchStatusOf(repo({ branch: 'topic', defaultBranch: undefined, trunk: 'master', branches: ['master', 'topic'] }));
  assert.deepEqual(result, { kind: 'other', name: 'topic', defaultName: 'master' });
});

test('with no default known at all no branch is called unexpected', () => {
  const result = status.branchStatusOf(repo({ branch: 'solo', defaultBranch: undefined, trunk: undefined, branches: ['solo'] }));
  assert.deepEqual(result, { kind: 'default', name: 'solo' });
});

test('a detached HEAD is always a warning, and offers a switch only to a branch that exists', () => {
  const withMain = status.branchStatusOf(repo({ branch: 'HEAD', branches: ['main'] }));
  assert.deepEqual(withMain, { kind: 'detached', defaultName: 'main', canSwitch: true });
  assert.equal(status.needsBranchWarning(withMain), true);
  const lonely = status.branchStatusOf(repo({ branch: 'HEAD', branches: [], trunk: undefined, defaultBranch: undefined }));
  assert.deepEqual(lonely, { kind: 'detached', defaultName: 'main', canSwitch: false });
  const remoteOnly = status.branchStatusOf(repo({ branch: 'HEAD', branches: ['topic'], trunk: undefined, defaultBranch: 'develop' }));
  assert.deepEqual(remoteOnly, { kind: 'detached', defaultName: 'develop', canSwitch: false });
});

test('no repository, no commits and nothing read yet each draw their own thing', () => {
  assert.deepEqual(status.branchStatusOf({ isRepo: false }), { kind: 'hidden' });
  assert.deepEqual(status.branchStatusOf(repo({ head: undefined, branch: '(no commits yet)' })), { kind: 'hidden' });
  assert.deepEqual(status.branchStatusOf(repo({ branch: '' })), { kind: 'hidden' });
  assert.deepEqual(status.branchStatusOf(undefined), { kind: 'unknown' });
  for (const quiet of [{ kind: 'hidden' }, { kind: 'unknown' }, { kind: 'default', name: 'main' }]) {
    assert.equal(status.needsBranchWarning(quiet), false);
  }
});

test('a stored answer belongs to one project and one branch', () => {
  const first = preference.branchWarningEntry('/sites/a', 'feature/x');
  assert.notEqual(first, preference.branchWarningEntry('/sites/b', 'feature/x'));
  assert.notEqual(first, preference.branchWarningEntry('/sites/a', 'feature/y'));
  assert.throws(() => preference.branchWarningEntry('', 'x'), /a project has a path/);
  assert.throws(() => preference.branchWarningEntry('/p', ''), /a branch has a name/);
  assert.throws(() => preference.branchWarningEntry('/p', 'a\nb'), /no line break/);
});

test('stored answers are parsed like any input: bad storage means "ask"', () => {
  const good = preference.branchWarningEntry('/p', 'topic');
  assert.deepEqual(preference.parseStoredBranchWarnings(JSON.stringify([good])), [good]);
  for (const raw of [undefined, 42, '', 'not json', '{}', '"x"', 'null', JSON.stringify({ a: 1 }), 'x'.repeat(10_000_000)]) {
    assert.deepEqual(preference.parseStoredBranchWarnings(raw), [], String(raw).slice(0, 20));
  }
  // Entries that are not strings, are empty, have no separator or are too long are dropped; the good one survives.
  // The null entry is spliced into the text, because the lint bans a `null` literal and storage can hold one.
  const mixed = JSON.stringify([1, '', 'no-separator', 'x\n'.repeat(1) + 'y'.repeat(100_000), good, ['x']]).replace(',["x"]', ',null,["x"]');
  assert.deepEqual(preference.parseStoredBranchWarnings(mixed), [good]);
});

test('the list is bounded, the newest answers are kept and adding twice moves, not repeats', () => {
  const max = preference.BRANCH_WARNING_ENTRIES_MAX;
  let entries = [];
  for (let index = 0; index < max + 10; index += 1) {
    entries = preference.withBranchWarningSilenced(entries, preference.branchWarningEntry('/p', `b${index}`));
  }
  assert.equal(entries.length, max);
  assert.equal(entries.at(-1), preference.branchWarningEntry('/p', `b${max + 9}`));
  assert.equal(entries.includes(preference.branchWarningEntry('/p', 'b0')), false, 'the oldest is forgotten');
  const again = preference.withBranchWarningSilenced(entries, entries[0]);
  assert.equal(again.length, max);
  assert.equal(again.at(-1), entries[0]);
  assert.equal(new Set(again).size, max);
  assert.equal(preference.parseStoredBranchWarnings(JSON.stringify(Array(max + 50).fill(preference.branchWarningEntry('/p', 'x')))).length, max);
});

test('without browser storage the answer is "ask" and saving does not throw', () => {
  assert.equal(preference.isBranchWarningSilenced('/p', 'topic'), false);
  assert.doesNotThrow(() => preference.silenceBranchWarning('/p', 'topic'));
});

test('git:info carries the default branch as an optional bounded string, and nothing else new', () => {
  const bridge = require('../../helpers/rendererModule')('src/features/git/gitChipBridge.ts');
  const base = { isRepo: true, branch: 'main', branches: ['main'], dirty: false, ahead: 0, parked: [] };
  assert.equal(bridge.parseGitInfo({ ...base, defaultBranch: 'develop' }).defaultBranch, 'develop');
  assert.equal(bridge.parseGitInfo(base).defaultBranch, undefined, 'older producers send none');
  for (const bad of [5, true, ['main'], {}, 'x'.repeat(require('../../helpers/rendererModule')('shared/core/boundary.ts').BOUNDARY_LIMITS.textLengthMax + 1)]) {
    assert.throws(() => bridge.parseGitInfo({ ...base, defaultBranch: bad }), typeof bad);
  }
});
