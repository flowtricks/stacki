// Goal: the release workflows only orchestrate. Every script they name exists and runs as
// `node --experimental-strip-types scripts/...mts`; the controller and the post chain run nothing
// else, and never interpolate an input into a shell line; the gates are wired as documented (the
// approval environment, the concurrency group, the dry-run default, the plan output that is the
// only switch for skipping tests, the shard matrix the release scripts count on).
// Methodology: parse the real workflow files with the YAML parser and assert on their structure,
// plus negative checks (each forbidden shape is described by the assertion that would catch it).
// actionlint is the syntax check; this test pins the repository's own rules.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { CHECK_OPERATING_SYSTEMS, CHECK_SHARD_COUNT, REQUIRED_CHECK_JOBS, shardJobName } from '../../../scripts/release/releaseStatus.mts';

type Node = Readonly<Record<string, unknown>>;

function asNode(value: unknown, label: string): Node {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${label} is a mapping`);
  return Object.fromEntries(Object.entries(value));
}

function asList(value: unknown, label: string): readonly unknown[] {
  assert.ok(Array.isArray(value), `${label} is a list`);
  const list: readonly unknown[] = value;
  assert.ok(list.length <= 200, `${label} is bounded`);
  return list;
}

function workflow(name: string): Node {
  const source = readFileSync(`.github/workflows/${name}`, 'utf8');
  assert.ok(source.length < 100_000, `${name} exceeds the input limit`);
  return asNode(parse(source, { maxAliasCount: 0, uniqueKeys: true }), name);
}

function jobs(file: Node): Node {
  return asNode(file['jobs'], 'jobs');
}

function steps(job: unknown): readonly Node[] {
  return asList(asNode(job, 'job')['steps'], 'steps').map((step) => asNode(step, 'step'));
}

function runs(file: Node): readonly string[] {
  return Object.values(jobs(file)).flatMap((job) => steps(job).map((step) => step['run'])).filter((run): run is string => typeof run === 'string');
}

const WORKFLOWS = readdirSync('.github/workflows').filter((name) => name.endsWith('.yml'));

test('the workflows folder holds only workflow files', () => {
  assert.deepEqual(
    readdirSync('.github/workflows').filter((name) => !name.endsWith('.yml')),
    [],
    'stray files (such as sed backups) are not workflows',
  );
});

test('every script a workflow names exists, and TypeScript scripts run under type stripping', () => {
  for (const name of WORKFLOWS) {
    for (const run of runs(workflow(name))) {
      for (const match of run.matchAll(/(?:\.\.\/)?(?:dist\/)?scripts\/[\w/.-]+\.(?:mts|ts|js)/g)) {
        const reference = match[0];
        if (reference.includes('dist/')) {
          const source = reference.replace(/^(?:\.\.\/)?dist\//, '').replace(/\.js$/, '.ts');
          assert.ok(existsSync(source), `${name}: ${reference} has no source ${source}`);
        } else {
          assert.ok(existsSync(reference), `${name}: ${reference} does not exist`);
        }
      }
      for (const match of run.matchAll(/(\S+\s+)?(\S+\s+)?scripts\/[\w/.-]+\.mts/g)) {
        assert.match(match[0], /^node --experimental-strip-types scripts\//, `${name}: run .mts scripts as node --experimental-strip-types (${match[0]})`);
      }
    }
  }
});

test('the controller and the post chain run only scripts, and pass inputs through the environment', () => {
  for (const name of ['release-go.yml', 'release-post.yml']) {
    for (const run of runs(workflow(name))) {
      const allowed = /^node --experimental-strip-types scripts\/release\/\w+\.mts( .*)?$/.test(run) || run === 'npm ci --ignore-scripts';
      assert.ok(allowed, `${name}: "${run}" is logic in YAML; put it in a script`);
      assert.doesNotMatch(run, /\$\{\{/, `${name}: interpolate nothing into a shell line; pass it as an env variable`);
    }
  }
});

test('the controller: dry run by default, one release at a time, approval before the push', () => {
  const file = workflow('release-go.yml');
  assert.notEqual(file['name'], 'Release', 'release-post.yml listens for the workflow named Release (release.yml)');
  const dispatch = asNode(asNode(file['on'], 'on')['workflow_dispatch'], 'workflow_dispatch');
  const inputs = asNode(dispatch['inputs'], 'inputs');
  assert.equal(asNode(inputs['dry_run'], 'dry_run')['default'], true);
  assert.equal(asNode(inputs['allow_minor'], 'allow_minor')['default'], false);
  assert.deepEqual(file['concurrency'], { group: 'release', 'cancel-in-progress': false });
  const controller = jobs(file);
  const approve = asNode(controller['approve'], 'approve');
  assert.equal(approve['environment'], 'release');
  assert.equal(approve['needs'], 'preflight');
  const tag = asNode(controller['prepare-and-tag'], 'prepare-and-tag');
  assert.deepEqual(tag['needs'], ['preflight', 'approve']);
  assert.match(String(tag['if']), /needs\.approve\.result == 'success' \|\| needs\.preflight\.outputs\.mode == 'dry-run'/);
  const checkout = steps(tag).find((step) => step['uses'] === 'actions/checkout@v6');
  assert.match(String(asNode(checkout?.['with'], 'with')['token']), /secrets\.RELEASE_PUSH_TOKEN/);
  assert.equal(asNode(checkout?.['with'], 'with')['ref'], '${{ needs.preflight.outputs.sha }}');
});

test('the post chain follows release.yml by name and never calls the npm publish as a reusable workflow', () => {
  assert.equal(workflow('release.yml')['name'], 'Release');
  const post = workflow('release-post.yml');
  const on = asNode(post['on'], 'on');
  assert.deepEqual(asNode(on['workflow_run'], 'workflow_run'), { workflows: ['Release'], types: ['completed'] });
  assert.deepEqual(post['concurrency'], { group: 'release-post', 'cancel-in-progress': false });
  for (const job of Object.values(jobs(post))) {
    assert.equal(asNode(job, 'job')['uses'], undefined, 'npm trusted publishing checks the top-level workflow: dispatch it, never `uses:` it');
  }
});

test('release.yml: one plan output switches the suite; every build, package and install step stays', () => {
  const release = jobs(workflow('release.yml'));
  const plan = asNode(release['plan'], 'plan');
  assert.deepEqual(plan['outputs'], { run_tests: '${{ steps.plan.outputs.run_tests }}' });
  const testsJob = asNode(release['tests'], 'tests');
  assert.equal(testsJob['needs'], 'plan');
  for (const step of steps(testsJob)) {
    assert.match(String(step['if']), /needs\.plan\.outputs\.run_tests (==|!=) 'true'/, 'every tests step is switched by the plan output alone');
  }
  const testRuns = steps(testsJob).map((step) => String(step['run'] ?? ''));
  assert.ok(testRuns.includes('xvfb-run --auto-servernum npm test'));
  assert.ok(testRuns.includes('npm test'));
  for (const name of ['build-mac', 'build-windows', 'build-linux']) {
    const commands = steps(release[name]).map((step) => String(step['run'] ?? ''));
    assert.ok(commands.includes('npm run build'), `${name} builds what it packages`);
    assert.ok(commands.some((command) => command.includes('electron-builder')), `${name} still packages`);
    assert.ok(!commands.some((command) => /\bnpm test\b/.test(command)), `${name}: the suite lives in the tests job`);
  }
  const linux = steps(release['build-linux']).map((step) => String(step['run'] ?? '')).join('\n');
  assert.match(linux, /linuxSmoke\.js \/opt\/Stacki\/stacki/, 'the deb install smoke test stays');
  assert.match(linux, /squashfs-root\/AppRun/, 'the AppImage smoke test stays');
  const publish = asNode(release['publish'], 'publish');
  const needs = asList(publish['needs'], 'publish needs');
  for (const required of ['plan', 'tests', 'build-mac', 'build-windows', 'build-linux', 'test-linux-install', 'build-studio']) {
    assert.ok(needs.includes(required), `publish needs ${required}`);
  }
  const planRun = String(steps(plan).find((step) => step['id'] === 'plan')?.['run']);
  assert.match(planRun, /--sha="\$GITHUB_SHA"/);
});

test('publish-create-stacki: the plan switches only the suite; build, pack and publish always run', () => {
  const publish = steps(jobs(workflow('publish-create-stacki.yml'))['publish']);
  const planIndex = publish.findIndex((step) => step['id'] === 'plan');
  const testIndex = publish.findIndex((step) => String(step['run'] ?? '').includes('npm test'));
  assert.ok(planIndex >= 0);
  assert.ok(planIndex < testIndex);
  assert.equal(publish[testIndex]?.['if'], "steps.plan.outputs.run_tests == 'true'");
  for (const command of ['npm run create-stacki:build', 'npm pack --dry-run', 'npm publish --access public']) {
    const step = publish.find((candidate) => candidate['run'] === command);
    assert.ok(step !== undefined, command);
    assert.equal(step['if'], undefined, `${command} is never skipped`);
  }
});

test('check.yml: the shard matrix is the count the release scripts expect, under the aggregate names they read', () => {
  const check = jobs(workflow('check.yml'));
  const shard = asNode(check['shard'], 'shard');
  const matrix = asNode(asNode(shard['strategy'], 'strategy')['matrix'], 'matrix');
  assert.deepEqual(matrix['shard'], Array.from({ length: CHECK_SHARD_COUNT }, (_, index) => index + 1));
  assert.deepEqual(matrix['os'], [...CHECK_OPERATING_SYSTEMS]);
  assert.equal(String(shard['name']).replace('${{ matrix.os }}', 'ubuntu-latest').replace('${{ matrix.shard }}', '2'), shardJobName('ubuntu-latest', 2));
  const aggregate = asNode(check['test'], 'test');
  assert.equal(aggregate['name'], 'test (${{ matrix.os }})');
  assert.equal(aggregate['if'], '${{ !cancelled() }}');
  assert.deepEqual(asNode(asNode(aggregate['strategy'], 'strategy')['matrix'], 'matrix')['os'], [...CHECK_OPERATING_SYSTEMS]);
  assert.deepEqual(REQUIRED_CHECK_JOBS, ['policy', ...CHECK_OPERATING_SYSTEMS.map((os) => `test (${os})`)]);
  const shardRuns = steps(shard).map((step) => String(step['run'] ?? ''));
  assert.ok(shardRuns.some((run) => run.endsWith('npm test -- --shard=${{ matrix.shard }}/4')));
  assert.equal(CHECK_SHARD_COUNT, 4, 'the `/4` in check.yml and this count change together');
});
