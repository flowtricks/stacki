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
    return step['if'] === "runner.os == 'Linux'";
  });
  const commands = setup.map(command).join('\n');
  assert.ok(commands.includes('sudo chown root:root node_modules/electron/dist/chrome-sandbox'));
  assert.ok(commands.includes('sudo chmod 4755 node_modules/electron/dist/chrome-sandbox'));
  assert.doesNotMatch(command(steps[probe] ?? {}), /--no-sandbox/);
}

test('Check and Release prepare the Linux sandbox after install and before Electron tests', () => {
  const check = workflowJobs('.github/workflows/check.yml');
  const release = workflowJobs('.github/workflows/release.yml');
  for (const job of [check['test'], release['build-linux']]) {
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
  const jobs = workflowJobs('.github/workflows/release.yml');
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
  const jobs = workflowJobs('.github/workflows/release.yml');
  const commands = jobSteps(jobs['build-windows']).map(command).join('\n');
  assert.match(commands, /electron-builder --win/);
  assert.doesNotMatch(commands, /IsNullOrWhiteSpace|WIN_CSC_\w+ is missing|forceCodeSigning=true/);
});

test('Windows checkouts preserve source LF endings before formatting checks', () => {
  const attributes = readFileSync('.gitattributes', 'utf8');
  assert.match(attributes, /^\*\s+text=auto\s+eol=lf\s*$/m);
});

test('every job that uploads to the release waits for the single draft job', () => {
  // Three parallel electron-builder jobs once each created a draft (v1.2.2): uploads need one target.
  const jobs = workflowJobs('.github/workflows/release.yml');
  const draftCommands = jobSteps(jobs['draft']).map(command).join('\n');
  assert.match(draftCommands, /gh release view "\$TAG" --repo flowtricks\/stacki-releases/);
  assert.match(draftCommands, /gh release create "\$TAG"[\s\S]*--draft/);
  for (const name of ['build-mac', 'build-windows', 'build-linux', 'build-studio', 'publish']) {
    const needs = record(jobs[name])['needs'];
    const names = typeof needs === 'string' ? [needs] : list(text)(needs);
    assert.ok(names.includes('draft'), `${name} must need the draft job`);
  }
});
