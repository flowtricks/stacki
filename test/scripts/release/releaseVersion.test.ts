// Goal: the patch-only versioning rule (docs/release-runbook.md) cannot be broken by a typo, a
// habit of bumping the minor, or a stray tag, because every release helper shares one function.
// Methodology: the happy path (1.4.3 -> 1.4.4) first, then the negative space: minor and major
// bumps, repeats, downgrades, skipped numbers, malformed text, the numeric limit, and tag lists
// with noise, each pinned by its stable error code rather than its prose.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Result } from '../../../scripts/release/releaseResult.mts';
import { formatVersion, latestReleasedVersion, nextPatchVersion, parseVersion, validatePatchBump } from '../../../scripts/release/releaseVersion.mts';

function code(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

test('nextPatchVersion adds one to the patch and nothing else', () => {
  assert.deepEqual(nextPatchVersion('1.4.3'), { ok: true, value: '1.4.4' });
  assert.deepEqual(nextPatchVersion('1.4.9'), { ok: true, value: '1.4.10' });
  assert.deepEqual(nextPatchVersion('0.0.0'), { ok: true, value: '0.0.1' });
});

test('nextPatchVersion fails on text that is not a version and at the patch limit', () => {
  for (const bad of ['', '1.4', '1.4.3.1', 'v1.4.3', '1.4.3-beta', '01.4.3', '1.4.x', ' 1.4.3', '1.4.3\n', '1.4.1000000']) {
    assert.equal(code(nextPatchVersion(bad)), 'version-malformed', `"${bad}" is rejected`);
  }
  assert.equal(code(nextPatchVersion('1.4.999999')), 'version-patch-limit');
});

test('validatePatchBump accepts exactly the next patch', () => {
  assert.deepEqual(validatePatchBump('1.4.3', '1.4.4'), { ok: true, value: '1.4.4' });
  assert.deepEqual(validatePatchBump('1.4.9', '1.4.10'), { ok: true, value: '1.4.10' });
});

test('validatePatchBump rejects minor and major bumps, naming the rule', () => {
  assert.equal(code(validatePatchBump('1.4.3', '1.5.0')), 'bump-minor');
  assert.equal(code(validatePatchBump('1.4.3', '1.5.4')), 'bump-minor');
  assert.equal(code(validatePatchBump('1.4.3', '2.0.0')), 'bump-major');
  const rejected = validatePatchBump('1.4.3', '1.5.0');
  assert.ok(!rejected.ok);
  assert.match(rejected.error.message, /after 1\.4\.3 comes 1\.4\.4/);
});

test('validatePatchBump rejects a repeat, a downgrade and a skipped number', () => {
  assert.equal(code(validatePatchBump('1.4.3', '1.4.3')), 'bump-same');
  assert.equal(code(validatePatchBump('1.4.3', '1.4.2')), 'bump-downgrade');
  assert.equal(code(validatePatchBump('1.4.3', '1.4.5')), 'bump-skipped');
});

test('validatePatchBump passes malformed input through as a failure value, never a throw', () => {
  assert.equal(code(validatePatchBump('nope', '1.4.4')), 'version-malformed');
  assert.equal(code(validatePatchBump('1.4.3', '1.4')), 'version-malformed');
});

test('parseVersion and formatVersion round-trip', () => {
  const parsed = parseVersion('12.0.345');
  assert.ok(parsed.ok);
  assert.equal(formatVersion(parsed.value), '12.0.345');
});

test('latestReleasedVersion compares numerically and ignores everything that is not a release tag', () => {
  assert.deepEqual(latestReleasedVersion(['v1.4.2', 'v1.4.10', 'v1.4.9', 'v1.3.0']), { ok: true, value: '1.4.10' });
  assert.deepEqual(latestReleasedVersion(['junk', 'v1.4', 'v1.4.3-rc1', 'v1.4.1', 'release-2']), { ok: true, value: '1.4.1' });
  assert.equal(code(latestReleasedVersion([])), 'tags-none');
  assert.equal(code(latestReleasedVersion(['latest', 'v1'])), 'tags-none');
  assert.equal(code(latestReleasedVersion(Array.from({ length: 10_001 }, () => 'v1.0.0'))), 'tags-limit');
});
