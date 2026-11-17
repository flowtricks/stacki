// Goal: catch release setup regressions on any host before GitHub allocates runners.
// Method: parse the actual workflows and package configuration, check sandbox ordering,
// AppImage launch context, signing policy, and Windows checkout line endings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { list, record, text } from '#dist/shared/core/boundary.js';

function workflowJobs(file: string): Record<string, unknown> {
  const source = readFileSync(file, 'utf8');
  assert.ok(source.length < 100000, 'Workflow exceeds input limit');
  const input: unknown = parse(source, { maxAliasCount: 0, uniqueKeys: true });
  return record(record(input)['jobs']);
}

function jobSteps(job: unknown): readonly Record<string, unknown>[] {
  const steps = list(record)(record(job)['steps']);
  assert.ok(steps.length <= 100, 'Workflow step count exceeds limit');
  return steps;
}

function command(step: Readonly<Record<string, unknown>>): string {
  return text(step['run'] ?? '');
}

function verifySandboxSteps(steps: readonly Record<string, unknown>[]): void {
  const probe = steps.findIndex((step) =>
    command(step).includes('xvfb-run --auto-servernum npm test'),
  );
  assert.ok(probe >= 0, 'Linux tests must run under a virtual display');
  const install = steps.findIndex((step) => command(step) === 'npm ci');
  assert.ok(install >= 0, 'Linux installs dependencies before configuring the sandbox');
  const setup = steps.slice(install + 1, probe).filter((step) => {
    if (step['if'] === undefined) {
      return true;
    }
    // The release `tests` job also gates each step on the plan; the platform clause must still name Linux.
    return text(step['if']).includes("runner.os == 'Linux'");
  });
  const commands = setup.map(command).join('\n');
  assert.ok(commands.includes('sudo chown root:root node_modules/electron/dist/chrome-sandbox'));
  assert.ok(commands.includes('sudo chmod 4755 node_modules/electron/dist/chrome-sandbox'));
  assert.doesNotMatch(command(steps[probe] ?? {}), /--no-sandbox/);
}

test('Check prepares the Linux sandbox after install and before Electron tests', () => {
  const check = workflowJobs('.github/workflows/check.yml');
  for (const job of [check['shard'], check['static'], check['studio']]) {
    const steps = jobSteps(job);
    verifySandboxSteps(steps);
    // Reproduce the missing setup, wrong runner guard, and wrong-order regressions.
    const setup = steps.filter((step) => command(step).includes('sudo chmod 4755'));
    const withoutSetup = steps.filter((step) => !setup.includes(step));
    assert.throws(() => verifySandboxSteps(withoutSetup));
    assert.throws(() => verifySandboxSteps([...withoutSetup, ...setup]));
    assert.throws(() =>
      verifySandboxSteps(
        steps.map((step) =>
          setup.includes(step) ? { ...step, if: "runner.os == 'Windows'" } : step,
        ),
      ),
    );
  }
});

test('extracted AppImage smoke launches with APPDIR supplied by the missing FUSE runtime', () => {
  const jobs = workflowJobs('.github/workflows/candidate.yml');
  const launch = jobSteps(jobs['build-linux']).find((step) =>
    command(step).includes('squashfs-root/AppRun'),
  );
  assert.ok(launch, 'The extracted AppImage launcher must be exercised');
  const source = command(launch);
  const environment = source.indexOf('export APPDIR="$(realpath squashfs-root)"');
  assert.ok(environment >= 0, 'Extraction bypasses FUSE: export APPDIR before launching AppRun');
  assert.ok(environment < source.indexOf('linuxSmoke.js'), 'APPDIR must precede the smoke launch');
  assert.match(source, /export APPIMAGE=/);
});

test('Windows certificates remain optional while Mac signing stays required', () => {
  const input: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
  const build = record(record(input)['build']);
  assert.equal(record(build['win'])['forceCodeSigning'], false);
  assert.equal(record(build['mac'])['forceCodeSigning'], true);
  assert.equal(record(build['mac'])['notarize'], true);
  const jobs = workflowJobs('.github/workflows/candidate.yml');
  const commands = jobSteps(jobs['build-windows']).map(command).join('\n');
  assert.match(commands, /electron-builder --win/);
  assert.doesNotMatch(commands, /IsNullOrWhiteSpace|WIN_CSC_\w+ is missing|forceCodeSigning=true/);
});

test('Windows checkouts preserve source LF endings before formatting checks', () => {
  const attributes = readFileSync('.gitattributes', 'utf8');
  assert.match(attributes, /^\*\s+text=auto\s+eol=lf\s*$/m);
});

test('only the promotion uploads, and it creates the draft before its single upload step', () => {
  // Three parallel electron-builder jobs once each created a draft (v1.2.2): uploads need one target.
  // Now the candidate builds never upload, and one promotion step creates the draft, then uploads.
  const candidate = workflowJobs('.github/workflows/candidate.yml');
  for (const [name, job] of Object.entries(candidate)) {
    assert.doesNotMatch(jobSteps(job).map(command).join('\n'), /gh release (create|upload|edit)|--publish always/, `${name} must not publish`);
  }
  const promote = jobSteps(workflowJobs('.github/workflows/release.yml')['publish']);
  const uploads = promote.filter((step) => command(step).includes('gh release upload'));
  assert.equal(uploads.length, 1, 'one upload step');
  const upload = command(uploads[0] ?? {});
  assert.ok(upload.indexOf('gh release view "$TAG" --repo flowtricks/stacki-releases') >= 0);
  assert.ok(upload.indexOf('--draft') < upload.indexOf('gh release upload'), 'the draft exists before the upload');
});

test('create-stacki publishing checks npm trusted publishing before the long test run', () => {
  const steps = jobSteps(workflowJobs('.github/workflows/publish-create-stacki.yml')['publish']);
  const probe = steps.findIndex((step) => command(step).includes('/-/npm/v1/oidc/token/exchange/package/create-stacki'));
  const tests = steps.findIndex((step) => command(step).includes('npm test'));
  assert.ok(probe >= 0, 'The OIDC exchange probe must exist');
  assert.ok(probe < tests, 'The probe must fail before ten minutes of tests');
  assert.doesNotMatch(command(steps[probe] ?? {}), /cat "\$\{?jwt|echo "\$\{?jwt\}"(?!.*add-mask)/);
});
