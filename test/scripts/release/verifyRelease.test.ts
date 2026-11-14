// Goal: `verifyRelease` reports PASS only for a release a user could really install and update to,
// and reports each way it can be wrong as a FAIL row instead of crashing or passing silently.
// Methodology: the parsers get good, malformed and incomplete gh, YAML and npm JSON; the pure
// evaluators get a complete release and then each single defect (draft, missing asset, wrong
// version, size mismatch, missing demo, wrong redirect); verifyRelease runs end to end with a
// scripted command runner, a scripted HTTP fetcher and an instant sleeper, including registry lag
// that clears on a retry and one that never clears. No test reaches the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandRunner, HttpFetcher } from '../../../scripts/release/releaseCommands.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';
import {
  evaluateNpm,
  evaluateRelease,
  evaluateSite,
  evaluateUpdateMetadata,
  exitCodeFor,
  parseArguments,
  parseNpmPack,
  parseReleaseView,
  parseUpdateMetadata,
  renderTable,
  requiredAssetNames,
  verifyRelease,
  type ReleaseAsset,
} from '../../../scripts/release/verifyRelease.mts';

const VERSION = '1.4.4';
const assets: readonly ReleaseAsset[] = [...requiredAssetNames(VERSION), 'stacki-demo-studio.js'].map((name, index) => ({ name, sizeBytes: 100 + index }));
const viewText = JSON.stringify({ tagName: `v${VERSION}`, isDraft: false, assets: assets.map((asset) => ({ name: asset.name, size: asset.sizeBytes })) });

function updateYaml(version: string, file: string, sizeBytes: number): string {
  return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: abc\n    size: ${sizeBytes}\npath: ${file}\n`;
}

test('parseReleaseView reads gh JSON and turns bad shapes into failure values', () => {
  assert.ok(parseReleaseView(viewText).ok);
  const bad = ['', 'null', '{}', '{"tagName":"v1","isDraft":"no","assets":[]}', '{"tagName":"v1","isDraft":false}', '{"tagName":"v1","isDraft":false,"assets":[{"name":"a"}]}', '{"tagName":"v1","isDraft":false,"assets":["x"]}'];
  for (const text of bad) {
    assert.ok(!parseReleaseView(text).ok, text);
  }
});

test('parseUpdateMetadata reads electron-builder YAML and rejects the malformed and the oversized', () => {
  const parsed = parseUpdateMetadata(updateYaml(VERSION, 'a.zip', 5));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.files[0]?.sizeBytes, 5);
  for (const text of ['', 'just text', 'version: 1.4.4\n', 'files: []\n', 'version: 1.4.4\nfiles:\n  - size: 3\n', 'a: [unclosed', `version: ${'x'.repeat(300_000)}`]) {
    assert.ok(!parseUpdateMetadata(text).ok, text.slice(0, 30));
  }
  assert.ok(!parseUpdateMetadata('a: &x 1\nb: *x\nversion: 1\nfiles: []\n').ok, 'aliases are refused');
});

test('parseNpmPack reads npm pack --dry-run --json and rejects incomplete answers', () => {
  const good = parseNpmPack(JSON.stringify([{ version: VERSION, shasum: 'ff', files: [{ path: 'dist/cli.mjs' }, { path: 'dist/demo/a.js' }] }]));
  assert.ok(good.ok);
  assert.deepEqual(good.value.tarballPaths, ['dist/cli.mjs', 'dist/demo/a.js']);
  for (const text of ['', '{}', '[]', '[{"version":"1"}]', '[{"version":"1","shasum":"a"}]', '[{"version":"1","shasum":"a","files":[{}]}]']) {
    assert.ok(!parseNpmPack(text).ok, text);
  }
});

test('evaluateRelease passes a complete release and names each single defect', () => {
  const complete = parseReleaseView(viewText);
  assert.ok(complete.ok);
  assert.ok(evaluateRelease(VERSION, complete.value).every((row) => row.verdict === 'pass'));
  const draft = evaluateRelease(VERSION, { ...complete.value, isDraft: true });
  assert.equal(draft.find((row) => row.name === 'published')?.verdict, 'fail');
  const missing = evaluateRelease(VERSION, { ...complete.value, assets: complete.value.assets.filter((asset) => asset.name !== `Stacki-${VERSION}.AppImage`) });
  assert.match(missing.find((row) => row.name === 'required assets')?.detail ?? '', /Stacki-1\.4\.4\.AppImage/);
  const noDemo = evaluateRelease(VERSION, { ...complete.value, assets: complete.value.assets.filter((asset) => !asset.name.startsWith('stacki-demo-')) });
  assert.equal(noDemo.find((row) => row.name === 'demo assets')?.verdict, 'warn');
  assert.equal(exitCodeFor(noDemo), 0, 'a missing demo warns and does not fail');
  const wrongTag = evaluateRelease(VERSION, { ...complete.value, tagName: 'v1.4.3' });
  assert.equal(wrongTag.find((row) => row.name === 'tag')?.verdict, 'fail');
});

test('evaluateUpdateMetadata checks version, listed files and sizes', () => {
  const file = `Stacki-${VERSION}-x64.zip`;
  const size = assets.find((asset) => asset.name === file)?.sizeBytes ?? 0;
  const parse = (text: string) => {
    const parsed = parseUpdateMetadata(text);
    assert.ok(parsed.ok);
    return parsed.value;
  };
  assert.equal(evaluateUpdateMetadata(VERSION, 'latest-mac.yml', parse(updateYaml(VERSION, file, size)), assets).verdict, 'pass');
  assert.match(evaluateUpdateMetadata(VERSION, 'latest-mac.yml', parse(updateYaml('1.4.3', file, size)), assets).detail, /names version 1\.4\.3/);
  assert.match(evaluateUpdateMetadata(VERSION, 'latest-mac.yml', parse(updateYaml(VERSION, file, size + 1)), assets).detail, /size/);
  assert.match(evaluateUpdateMetadata(VERSION, 'latest-mac.yml', parse(updateYaml(VERSION, 'ghost.zip', 1)), assets).detail, /not a release asset/);
  assert.match(evaluateUpdateMetadata(VERSION, 'latest-mac.yml', { version: VERSION, files: [] }, assets).detail, /no files/);
});

test('evaluateNpm and evaluateSite flag each wrong value', () => {
  const good = { latestTag: VERSION, tarballVersion: VERSION, shasum: 's', tarballPaths: ['dist/cli.mjs', 'dist/demo/a.js'] };
  assert.ok(evaluateNpm(VERSION, good).every((row) => row.verdict === 'pass'));
  assert.equal(evaluateNpm(VERSION, { ...good, latestTag: '1.4.3' })[0]?.verdict, 'fail');
  assert.equal(evaluateNpm(VERSION, { ...good, tarballPaths: ['dist/cli.mjs'] }).find((row) => row.name === 'tarball dist/demo')?.verdict, 'fail');

  const site = { home: ok(200), studio: ok(200), builtFrom: ok('1.4.4\n'), admin: ok({ status: 302, location: 'https://x.cloudflareaccess.com/login' }) };
  assert.ok(evaluateSite(VERSION, site).every((row) => row.verdict === 'pass'));
  assert.equal(evaluateSite(VERSION, { ...site, builtFrom: ok('1.4.3') })[2]?.verdict, 'fail');
  assert.equal(evaluateSite(VERSION, { ...site, admin: ok({ status: 200, location: undefined }) })[3]?.verdict, 'fail');
  assert.equal(evaluateSite(VERSION, { ...site, admin: ok({ status: 302, location: 'https://evil.test/' }) })[3]?.verdict, 'fail');
  assert.equal(evaluateSite(VERSION, { ...site, home: fail('http-failed', 'down'), studio: ok(404) }).filter((row) => row.verdict === 'fail').length, 2);
});

test('renderTable ends with PASS or FAIL and the exit code follows', () => {
  const pass = [{ group: 'npm', name: 'x', verdict: 'pass', detail: 'd' }] as const;
  const failing = [{ group: 'npm', name: 'x', verdict: 'fail', detail: 'd' }] as const;
  assert.match(renderTable(pass).split('\n').at(-1) ?? '', /^VERIFY PASS$/);
  assert.match(renderTable(failing).split('\n').at(-1) ?? '', /^VERIFY FAIL: 1 check/);
  assert.equal(exitCodeFor(pass), 0);
  assert.equal(exitCodeFor(failing), 1);
});

test('parseArguments accepts a version with known flags and rejects everything else', () => {
  const parsed = parseArguments(['1.4.4', '--only=npm,site', '--wait-minutes=15']);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.groups, ['npm', 'site']);
  assert.equal(parsed.value.waitMinutes, 15);
  for (const bad of [[], ['1.5'], ['1.4.4', '--only=nope'], ['1.4.4', '--only='], ['1.4.4', '--wait-minutes=31'], ['1.4.4', '--wait-minutes=-1'], ['1.4.4', '--wait-minutes=x'], ['1.4.4', '--force']]) {
    assert.ok(!parseArguments(bad).ok, bad.join(' '));
  }
});

const instantSleeper = (): Promise<void> => Promise.resolve();

function scriptedFetcher(): HttpFetcher {
  return (request) => {
    if (request.url.endsWith('/stacki-release.txt')) {
      return Promise.resolve(ok({ status: 200, body: VERSION, location: undefined }));
    }
    if (request.url.endsWith('/marketplace/admin')) {
      return Promise.resolve(ok({ status: 302, body: '', location: 'https://t.cloudflareaccess.com/x' }));
    }
    if (request.url.includes('/releases/download/')) {
      const name = request.url.split('/').at(-1) ?? '';
      const asset = name === 'latest.yml' ? `Stacki-Setup-${VERSION}.exe` : name === 'latest-mac.yml' ? `Stacki-${VERSION}-x64.zip` : `Stacki-${VERSION}.AppImage`;
      const size = assets.find((candidate) => candidate.name === asset)?.sizeBytes ?? 0;
      return Promise.resolve(ok({ status: 200, body: updateYaml(VERSION, asset, size), location: undefined }));
    }
    return Promise.resolve(ok({ status: 200, body: '', location: undefined }));
  };
}

function scriptedRunner(npmLatest: () => string): CommandRunner {
  return (request) => {
    if (request.command === 'gh') {
      return ok(viewText);
    }
    if (request.argumentsList[0] === 'view') {
      return ok(npmLatest());
    }
    return ok(JSON.stringify([{ version: VERSION, shasum: 's', files: [{ path: 'dist/cli.mjs' }, { path: 'dist/demo/a.js' }] }]));
  };
}

test('verifyRelease passes end to end on a complete release', async () => {
  const rows = await verifyRelease({ version: VERSION, groups: ['release', 'npm', 'site'], waitMinutes: 0 }, scriptedRunner(() => VERSION), scriptedFetcher(), instantSleeper);
  assert.equal(exitCodeFor(rows), 0, renderTable(rows));
});

test('verifyRelease retries registry lag within its bound and then passes', async () => {
  let calls = 0;
  const runner = scriptedRunner(() => (++calls < 3 ? '1.4.3' : VERSION));
  const rows = await verifyRelease({ version: VERSION, groups: ['npm'], waitMinutes: 5 }, runner, scriptedFetcher(), instantSleeper);
  assert.equal(exitCodeFor(rows), 0);
  assert.equal(calls, 3);
});

test('verifyRelease gives up at its bound when the registry never catches up, and does not retry without a wait', async () => {
  let calls = 0;
  const runner = scriptedRunner(() => {
    calls += 1;
    return '1.4.3';
  });
  const waited = await verifyRelease({ version: VERSION, groups: ['npm'], waitMinutes: 1 }, runner, scriptedFetcher(), instantSleeper);
  assert.equal(exitCodeFor(waited), 1);
  assert.equal(calls, 3, 'one try plus one per 30 seconds of a one minute wait');
  calls = 0;
  await verifyRelease({ version: VERSION, groups: ['npm'], waitMinutes: 0 }, runner, scriptedFetcher(), instantSleeper);
  assert.equal(calls, 1);
});

test('verifyRelease turns gh and network failures into FAIL rows', async () => {
  const brokenRunner: CommandRunner = () => fail('command-failed', 'gh: not logged in');
  const brokenFetcher: HttpFetcher = () => Promise.resolve(fail('http-failed', 'offline'));
  const rows = await verifyRelease({ version: VERSION, groups: ['release', 'npm', 'site'], waitMinutes: 0 }, brokenRunner, brokenFetcher, instantSleeper);
  assert.equal(exitCodeFor(rows), 1);
  assert.ok(rows.every((row) => row.verdict === 'fail'));
  assert.match(rows[0]?.detail ?? '', /not logged in/);
});

test('verifyRelease crashes on a version or wait it must never be given', async () => {
  await assert.rejects(verifyRelease({ version: '1.5', groups: [], waitMinutes: 0 }, scriptedRunner(() => ''), scriptedFetcher(), instantSleeper), /MAJOR\.MINOR\.PATCH/);
  await assert.rejects(verifyRelease({ version: VERSION, groups: [], waitMinutes: 31 }, scriptedRunner(() => ''), scriptedFetcher(), instantSleeper), /wait is bounded/);
});
