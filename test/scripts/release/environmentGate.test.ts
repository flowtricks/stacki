// Goal: the release controller treats the approval gate as real only when the `release`
// environment exists and requires a reviewer: GitHub silently creates an unprotected environment
// on first use, which would let a release through with no click at all.
// Methodology: assessEnvironment gets API records shaped like GitHub's (protected, wait timer only,
// empty reviewers, self-review prevented, protected-branches policy); readEnvironmentVerdict gets a
// scripted gh that answers 404, a server error and malformed JSON.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessEnvironment, readEnvironmentVerdict } from '../../../scripts/release/environmentGate.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';

const reviewers = (options: { readonly preventSelfReview: boolean }) => ({ type: 'required_reviewers', prevent_self_review: options.preventSelfReview, reviewers: [{ type: 'User', reviewer: { login: 'maintainer' } }] });

test('only an environment with a required reviewer is protected', () => {
  const protectedVerdict = assessEnvironment({ protection_rules: [reviewers({ preventSelfReview: false })] });
  assert.ok(protectedVerdict.ok);
  assert.deepEqual(protectedVerdict.value, { kind: 'protected', reviewers: ['maintainer'], warnings: [] });
  for (const record of [{}, { protection_rules: [] }, { protection_rules: [{ type: 'wait_timer', wait_timer: 10 }] }, { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }]) {
    const verdict = assessEnvironment(record);
    assert.ok(verdict.ok);
    assert.equal(verdict.value.kind, 'unprotected', JSON.stringify(record));
  }
  assert.ok(!assessEnvironment({ protection_rules: 'yes' }).ok);
});

test('settings that would deadlock or refuse the approve job are warned about', () => {
  const verdict = assessEnvironment({ protection_rules: [reviewers({ preventSelfReview: true })], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } });
  assert.ok(verdict.ok);
  assert.ok(verdict.value.kind === 'protected' && verdict.value.warnings.length === 2);
});

test('a 404 is a missing environment; any other failure stays a failure', () => {
  const missing = readEnvironmentVerdict(() => fail('command-failed', 'gh api ... exited 1: Not Found (HTTP 404)'), 'flowtricks/stacki');
  assert.ok(missing.ok);
  assert.equal(missing.value.kind, 'missing');
  assert.ok(!readEnvironmentVerdict(() => fail('command-failed', 'HTTP 502'), 'flowtricks/stacki').ok);
  assert.ok(!readEnvironmentVerdict(() => ok('<html>'), 'flowtricks/stacki').ok);
  assert.throws(() => readEnvironmentVerdict(() => ok('{}'), 'not a repository'), /Assertion failed/);
});
