// Proves the approval gate is real before a release can publish. The controller's `approve` job
// runs in the GitHub Environment named `release`; its required reviewers are the human click that
// lets a release through. GitHub creates an environment the first time a job names it, with no
// protection at all, so a missing environment would not stop anything: the job would simply run.
// This reads the environment through the API and accepts it only when it exists and requires at
// least one reviewer. The preflight, the approve job and the tag job each check it, so one
// misconfigured step cannot publish.

import { assert } from '../policy/assert.mts';
import type { CommandRunner } from './releaseCommands.mts';
import { parseRecord, readList, readRecord, readOptionalString, type JsonRecord } from './releaseJson.mts';
import { fail, ok, type Result } from './releaseResult.mts';

export const RELEASE_ENVIRONMENT = 'release';

export const ENVIRONMENT_SETUP_STEPS =
  'Settings > Environments > New environment > name it "release" > tick "Required reviewers" > add yourself > ' +
  'leave "Prevent self-review" unticked (you approve your own releases) > Save protection rules.';

export type EnvironmentVerdict =
  | { readonly kind: 'protected'; readonly reviewers: readonly string[]; readonly warnings: readonly string[] }
  | { readonly kind: 'missing'; readonly text: string }
  | { readonly kind: 'unprotected'; readonly text: string };

function reviewerName(entry: unknown): string | undefined {
  const record = readRecord(entry, 'reviewer');
  if (!record.ok) {
    return undefined;
  }
  const reviewer = readRecord(record.value['reviewer'], 'reviewer.reviewer');
  if (!reviewer.ok) {
    return undefined;
  }
  return readOptionalString(reviewer.value, 'login') ?? readOptionalString(reviewer.value, 'name') ?? readOptionalString(reviewer.value, 'slug');
}

/** The verdict for one environment's API record. */
export function assessEnvironment(record: JsonRecord): Result<EnvironmentVerdict> {
  const rules = readList(record['protection_rules'] ?? [], 'environment protection_rules');
  if (!rules.ok) {
    return rules;
  }
  const reviewers: string[] = [];
  const warnings: string[] = [];
  for (const entry of rules.value) {
    const rule = readRecord(entry, 'environment protection rule');
    if (!rule.ok) {
      return rule;
    }
    if (rule.value['type'] !== 'required_reviewers') {
      continue;
    }
    const listed = readList(rule.value['reviewers'] ?? [], 'required_reviewers reviewers');
    if (!listed.ok) {
      return listed;
    }
    for (const reviewer of listed.value) {
      const name = reviewerName(reviewer);
      if (name !== undefined) {
        reviewers.push(name);
      }
    }
    if (rule.value['prevent_self_review'] === true) {
      warnings.push('"Prevent self-review" is on: a release you start yourself can only be approved by another reviewer.');
    }
  }
  if (reviewers.length === 0) {
    return ok({
      kind: 'unprotected',
      text: `the "${RELEASE_ENVIRONMENT}" environment exists but requires no reviewer, so it would not stop a release. ${ENVIRONMENT_SETUP_STEPS}`,
    });
  }
  const branchPolicy = record['deployment_branch_policy'];
  if (typeof branchPolicy === 'object' && branchPolicy !== null && !Array.isArray(branchPolicy)) {
    const policy = Object.fromEntries(Object.entries(branchPolicy));
    if (policy['protected_branches'] === true) {
      warnings.push('Deployment branches are limited to protected branches, and main is not protected: the approve job would be refused. Choose "No restriction" or "Selected branches: main".');
    }
  }
  assert(reviewers.length > 0, 'assessEnvironment: a protected verdict names a reviewer');
  return ok({ kind: 'protected', reviewers, warnings });
}

/** Reads the environment; a 404 is a verdict (missing), any other failure is a failure value. */
export function readEnvironmentVerdict(runner: CommandRunner, repository: string): Result<EnvironmentVerdict> {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'readEnvironmentVerdict: owner/name');
  const text = runner({ command: 'gh', argumentsList: ['api', `repos/${repository}/environments/${RELEASE_ENVIRONMENT}`] });
  if (!text.ok) {
    if (text.error.message.includes('HTTP 404') || text.error.message.includes('Not Found')) {
      return ok({ kind: 'missing', text: `no "${RELEASE_ENVIRONMENT}" environment exists, so nothing would stop a release. ${ENVIRONMENT_SETUP_STEPS}` });
    }
    return fail('environment-read', `could not read the ${RELEASE_ENVIRONMENT} environment: ${text.error.message}`);
  }
  const record = parseRecord(text.value, 'gh api environment');
  return record.ok ? assessEnvironment(record.value) : record;
}
