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
import { CHECK_OPERATING_SYSTEMS, CHECK_SHARD_COUNT, REQUIRED_CHECK_JOBS, shardJobName, STATIC_CHECK_OPERATING_SYSTEMS, staticJobName, studioJobName } from '../../../scripts/release/releaseStatus.mts';

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

test('the post chain runs only scripts, and passes inputs through the environment', () => {
  for (const run of runs(workflow('release-post.yml'))) {
    const allowed = /^node --experimental-strip-types scripts\/release\/\w+\.mts( .*)?$/.test(run) || run === 'npm ci --ignore-scripts';
    assert.ok(allowed, `release-post.yml: "${run}" is logic in YAML; put it in a script`);
    assert.doesNotMatch(run, /\$\{\{/, 'release-post.yml: interpolate nothing into a shell line; pass it as an env variable');
  }
  assert.equal(existsSync('.github/workflows/release-go.yml'), false, 'the Release button needed settings that never existed; npm run release:ship replaced it');
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

test('candidate.yml: the plan gates every build; nothing is published or retested; the final job needs every build', () => {
  const file = workflow('candidate.yml');
  assert.deepEqual(file['concurrency'], { group: 'candidate-${{ github.ref }}', 'cancel-in-progress': true }, 'a newer push supersedes an older candidate');
  assert.match(String(file['run-name']), /\(rehearsal\)/, 'promote.mts tells a rehearsal by its title');
  const candidate = jobs(file);
  for (const name of ['build-mac', 'build-windows', 'build-linux', 'build-studio']) {
    const job = asNode(candidate[name], name);
    assert.equal(job['if'], "needs.plan.outputs.build == 'true'", `${name} runs only for an unreleased version or a rehearsal`);
    const commands = steps(job).map((step) => String(step['run'] ?? ''));
    assert.ok(!commands.some((command) => /\bnpm test\b/.test(command)), `${name}: the suite lives in check.yml`);
    assert.ok(!commands.some((command) => /gh release|--publish (always|onTag)/.test(command)), `${name}: a candidate never publishes`);
    assert.ok(Number(job['timeout-minutes']) > 0, `${name} has a time bound`);
  }
  for (const name of ['build-mac', 'build-windows', 'build-linux']) {
    const commands = steps(candidate[name]).map((step) => String(step['run'] ?? ''));
    assert.ok(commands.includes('npm run build'), `${name} builds what it packages`);
    assert.ok(commands.some((command) => /^npx electron-builder --(mac|win|linux) --publish never$/.test(command)), `${name} packages without publishing`);
  }
  const windows = steps(candidate['build-windows']);
  const normalize = windows.findIndex((step) => String(step['run'] ?? '').includes('candidate.mts --stage=normalize --directory=release'));
  assert.ok(normalize >= 0, 'the Windows installer takes the dashed name latest.yml gives it');
  assert.ok(
    normalize < windows.findIndex((step) => step['uses'] === 'actions/upload-artifact@v6'),
    'renamed before it is kept',
  );
  const linux = steps(candidate['build-linux']).map((step) => String(step['run'] ?? '')).join('\n');
  assert.match(linux, /linuxSmoke\.js \/opt\/Stacki\/stacki/, 'the deb install smoke test stays');
  assert.match(linux, /squashfs-root\/AppRun/, 'the AppImage smoke test stays');
  const final = asNode(candidate['candidate'], 'candidate');
  assert.deepEqual(final['needs'], ['plan', 'build-mac', 'build-windows', 'build-linux', 'test-linux-install', 'build-studio']);
  assert.equal(final['if'], undefined, 'skipped builds skip the final job, which is what promote.mts reads');
  assert.ok(steps(final).some((step) => String(step['run'] ?? '').includes('candidate.mts --stage=assets')));
});

test('release.yml: proves the candidate first, rebuilds and retests nothing, and uploads only on a tag push', () => {
  const file = workflow('release.yml');
  const on = asNode(file['on'], 'on');
  assert.deepEqual(asNode(on['push'], 'push'), { tags: ['v*'] });
  const publish = steps(asNode(jobs(file)['publish'], 'publish'));
  const commands = publish.map((step) => String(step['run'] ?? ''));
  assert.ok(!commands.some((command) => /\bnpm (test|ci|run build)\b|electron-builder/.test(command)), 'promotion never rebuilds or retests');
  const prove = publish.findIndex((step) => step['id'] === 'prove');
  const firstDownload = publish.findIndex((step) => step['uses'] === 'actions/download-artifact@v7');
  const firstUpload = publish.findIndex((step) => String(step['run'] ?? '').includes('gh release upload'));
  assert.ok(prove >= 0);
  assert.ok(prove < firstDownload, 'the proof comes before any download');
  assert.ok(firstDownload < firstUpload, 'the files come from the candidate run');
  assert.match(String(publish[prove]?.['run']), /^node --experimental-strip-types scripts\/release\/promote\.mts /);
  for (const step of publish.filter((candidate) => candidate['uses'] === 'actions/download-artifact@v7')) {
    assert.equal(asNode(step['with'], 'with')['run-id'], '${{ steps.prove.outputs.candidate_run_id }}');
  }
  for (const step of publish.filter((candidate) => /gh release (upload|edit|create)|gh workflow run/.test(String(candidate['run'] ?? '')))) {
    assert.equal(step['if'], "steps.target.outputs.dry_run == 'false'", `${String(step['name'])} is skipped in a dry run`);
  }
  const target = String(publish.find((step) => step['id'] === 'target')?.['run']);
  assert.match(target, /if \[ "\$EVENT" = push \]/, 'only a tag push is a real promotion');
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
  const checks = asNode(check['static'], 'static');
  assert.equal(String(checks['name']).replace('${{ matrix.os }}', 'ubuntu-latest'), staticJobName('ubuntu-latest'));
  assert.deepEqual(asNode(asNode(checks['strategy'], 'strategy')['matrix'], 'matrix')['os'], [...STATIC_CHECK_OPERATING_SYSTEMS], 'static checks on Linux only');
  assert.ok(steps(checks).some((step) => String(step['run'] ?? '').endsWith('npm test -- --checks=desktop')));
  const studio = asNode(check['studio'], 'studio');
  assert.equal(String(studio['name']).replace('${{ matrix.os }}', 'windows-latest'), studioJobName('windows-latest'));
  assert.ok(steps(studio).some((step) => String(step['run'] ?? '').endsWith('npm test -- --checks=studio')));
  assert.ok(Number(studio['timeout-minutes']) >= 25, 'Studio verify has room above its 25-minute gate limit');
  const aggregate = asNode(check['test'], 'test');
  assert.deepEqual(aggregate['needs'], ['static', 'studio', 'shard'], 'the aggregate waits for the checks and every shard');
  assert.equal(aggregate['name'], 'test (${{ matrix.os }})');
  assert.equal(aggregate['if'], '${{ !cancelled() }}');
  assert.deepEqual(asNode(asNode(aggregate['strategy'], 'strategy')['matrix'], 'matrix')['os'], [...CHECK_OPERATING_SYSTEMS]);
  assert.deepEqual(REQUIRED_CHECK_JOBS, ['policy', ...CHECK_OPERATING_SYSTEMS.map((os) => `test (${os})`)]);
  const shardRuns = steps(shard).map((step) => String(step['run'] ?? ''));
  assert.ok(shardRuns.some((run) => run.endsWith('npm test -- --shard=${{ matrix.shard }}/4')));
  assert.equal(CHECK_SHARD_COUNT, 4, 'the `/4` in check.yml and this count change together');
});
