// Goal: a candidate is built only when its version is unreleased (or for a rehearsal), and a
// folder counts as a complete release only when every installer, blockmap, update feed and the
// Studio bundle is there by exact name, each feed names this version, and every file a feed names
// is present with the size the feed states. An update feed naming a missing or different file
// would break every updater on that platform, so that boundary gets the near misses.
// Methodology: decideCandidate, requiredAssetNames, updateFeedProblems and candidateAssetProblems
// are pure; readAssetFolder runs on a temporary folder built with path.join (Windows-safe); the
// plan stage runs against a scripted git; the argument parser gets good and bad flags.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { recordingReporter } from '../../../scripts/release/actionsReport.mts';
import {
  candidateAssetProblems,
  decideCandidate,
  normalizeAssetFolder,
  parseCandidateArguments,
  releaseAssetName,
  readAssetFolder,
  readCheckoutVersion,
  requiredAssetNames,
  runAssetsStage,
  runPlanStage,
  updateFeedProblems,
  type AssetFile,
} from '../../../scripts/release/candidate.mts';
import type { CommandRunner } from '../../../scripts/release/releaseCommands.mts';
import { ok } from '../../../scripts/release/releaseResult.mts';

const VERSION = '1.4.8';

function feed(name: string, sizeBytes: number): string {
  return `version: ${VERSION}\nfiles:\n  - url: ${name}\n    sha512: abc==\n    size: ${sizeBytes}\npath: ${name}\nsha512: abc==\nreleaseDate: '2026-11-17T00:00:00.000Z'\n`;
}

function completeRelease(): Map<string, AssetFile> {
  const files = new Map<string, AssetFile>();
  for (const name of requiredAssetNames(VERSION)) {
    files.set(name, { sizeBytes: 10, feedText: undefined });
  }
  files.set('latest.yml', { sizeBytes: 10, feedText: feed(`Stacki-Setup-${VERSION}.exe`, 10) });
  files.set('latest-mac.yml', { sizeBytes: 10, feedText: feed(`Stacki-${VERSION}-arm64.zip`, 10) });
  files.set('latest-linux.yml', { sizeBytes: 10, feedText: feed(`Stacki-${VERSION}.AppImage`, 10) });
  return files;
}

test('a candidate builds for an unreleased version or a rehearsal, never for a released one', () => {
  assert.deepEqual(decideCandidate({ version: VERSION, tagExists: false, rehearsal: false }), { kind: 'build', version: VERSION, mode: 'candidate' });
  assert.deepEqual(decideCandidate({ version: VERSION, tagExists: true, rehearsal: true }), { kind: 'build', version: VERSION, mode: 'rehearsal' });
  assert.equal(decideCandidate({ version: VERSION, tagExists: true, rehearsal: false }).kind, 'skip');
  assert.throws(() => decideCandidate({ version: '1.4', tagExists: false, rehearsal: false }), /Assertion failed: decideCandidate: the version is X.Y.Z/);
});

test('the required list is the 1.4.5 release: every platform, its blockmaps, the feeds and Studio', () => {
  const names = requiredAssetNames(VERSION);
  assert.equal(names.length, 16);
  assert.ok(names.includes('latest-mac.yml'));
  assert.ok(names.includes(`Stacki-${VERSION}-arm64.dmg`));
  assert.ok(names.includes(`Stacki-Setup-${VERSION}.exe.blockmap`));
  assert.ok(names.includes(`stacki_${VERSION}_amd64.deb`));
  assert.ok(names.includes(`stacki-studio-${VERSION}.json`));
  assert.ok(!names.some((name) => name.startsWith('stacki-demo-')), 'the demo is optional');
});

test('a complete release has no problems', () => {
  assert.deepEqual(candidateAssetProblems(VERSION, completeRelease()), []);
});

test('each missing file, an empty file, a wrong feed version, a missing or resized feed target fails', () => {
  for (const name of requiredAssetNames(VERSION)) {
    const files = completeRelease();
    files.delete(name);
    assert.ok(
      candidateAssetProblems(VERSION, files).some((problem) => problem.includes(name)),
      `missing ${name} is reported`,
    );
  }
  const empty = completeRelease();
  empty.set(`Stacki-${VERSION}-x64.zip`, { sizeBytes: 0, feedText: undefined });
  assert.deepEqual(candidateAssetProblems(VERSION, empty), [`Stacki-${VERSION}-x64.zip is empty`]);
  const files = completeRelease();
  assert.deepEqual(updateFeedProblems('latest.yml', feed(`Stacki-Setup-${VERSION}.exe`, 10).replace(`version: ${VERSION}`, 'version: 1.4.7'), VERSION, files), [
    'latest.yml: version 1.4.7, expected 1.4.8',
  ]);
  assert.deepEqual(updateFeedProblems('latest.yml', feed('Stacki-Setup-1.4.7.exe', 10), VERSION, files), [
    'latest.yml: names Stacki-Setup-1.4.7.exe, which is not in the release',
    'latest.yml: names Stacki-Setup-1.4.7.exe, which is not in the release',
  ]);
  assert.deepEqual(updateFeedProblems('latest.yml', feed(`Stacki-Setup-${VERSION}.exe`, 11), VERSION, files), [`latest.yml: says Stacki-Setup-${VERSION}.exe is 11 bytes, the file is 10`]);
  assert.deepEqual(updateFeedProblems('latest.yml', 'files: []\n', VERSION, files), ['latest.yml: no version line', 'latest.yml: names no file']);
});

test('the folder reader finds files in nested artifact folders and refuses a name seen twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-candidate-test-'));
  try {
    fs.mkdirSync(path.join(root, 'candidate-mac'));
    fs.mkdirSync(path.join(root, 'candidate-windows'));
    fs.writeFileSync(path.join(root, 'candidate-mac', 'latest-mac.yml'), feed(`Stacki-${VERSION}-arm64.zip`, 3));
    fs.writeFileSync(path.join(root, 'candidate-mac', `Stacki-${VERSION}-arm64.zip`), 'zip');
    const read = readAssetFolder(root);
    assert.ok(read.ok);
    assert.equal(read.value.get(`Stacki-${VERSION}-arm64.zip`)?.sizeBytes, 3);
    assert.ok(read.value.get('latest-mac.yml')?.feedText?.startsWith(`version: ${VERSION}`));
    fs.writeFileSync(path.join(root, 'candidate-windows', 'latest-mac.yml'), 'x');
    const twice = readAssetFolder(root);
    assert.equal(twice.ok, false);
    assert.ok(!twice.ok && twice.error.code === 'assets-duplicate');
    const missing = readAssetFolder(path.join(root, 'absent'));
    assert.ok(!missing.ok && missing.error.code === 'assets-unreadable');
    const { reporter, report } = recordingReporter();
    fs.rmSync(path.join(root, 'candidate-windows'), { recursive: true, force: true });
    assert.equal(runAssetsStage(VERSION, root, reporter), 1);
    assert.ok(report.messages.some((message) => message.includes('missing latest.yml')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the plan stage reads the checkout version and the tag on origin', () => {
  const answers = new Map([
    ['1.4.8', ''],
    ['1.4.7', `${'a'.repeat(40)}\trefs/tags/v1.4.7\n`],
  ]);
  const runner: CommandRunner = (request) => {
    const target = request.argumentsList[3] ?? '';
    return ok(answers.get(target.replace('refs/tags/v', '')) ?? '');
  };
  const unreleased = recordingReporter();
  assert.equal(runPlanStage({ rehearsal: false, packageJsonText: '{"version":"1.4.8"}' }, runner, unreleased.reporter), 0);
  assert.equal(unreleased.report.outputs.get('build'), 'true');
  assert.equal(unreleased.report.outputs.get('mode'), 'candidate');
  const released = recordingReporter();
  assert.equal(runPlanStage({ rehearsal: false, packageJsonText: '{"version":"1.4.7"}' }, runner, released.reporter), 0);
  assert.equal(released.report.outputs.get('build'), 'false');
  const broken = recordingReporter();
  assert.equal(runPlanStage({ rehearsal: false, packageJsonText: '{"version":"next"}' }, runner, broken.reporter), 2);
  assert.equal(readCheckoutVersion('[]').ok, false);
});

test('the Windows installer takes the dashed name its update feed gives it (rehearsal 44206405239)', () => {
  assert.equal(releaseAssetName('Stacki Setup 1.4.8.exe'), 'Stacki-Setup-1.4.8.exe');
  assert.equal(releaseAssetName('Stacki Setup 1.4.8.exe.blockmap'), 'Stacki-Setup-1.4.8.exe.blockmap');
  assert.equal(releaseAssetName('Stacki-1.4.8-arm64.dmg'), 'Stacki-1.4.8-arm64.dmg');
  assert.throws(() => releaseAssetName(''), /Assertion failed: releaseAssetName: a file name/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-candidate-normalize-'));
  try {
    fs.writeFileSync(path.join(root, 'Stacki Setup 1.4.8.exe'), 'exe');
    fs.writeFileSync(path.join(root, 'latest.yml'), feed('Stacki-Setup-1.4.8.exe', 3));
    assert.deepEqual(normalizeAssetFolder(root), ok(['Stacki Setup 1.4.8.exe -> Stacki-Setup-1.4.8.exe']));
    assert.deepEqual(fs.readdirSync(root).sort(), ['Stacki-Setup-1.4.8.exe', 'latest.yml']);
    const read = readAssetFolder(root);
    assert.ok(read.ok);
    assert.deepEqual(updateFeedProblems('latest.yml', read.value.get('latest.yml')?.feedText ?? '', VERSION, read.value), [], 'the feed now names a present file');
    fs.writeFileSync(path.join(root, 'Stacki Setup 1.4.8.exe'), 'again');
    const clash = normalizeAssetFolder(root);
    assert.ok(!clash.ok && clash.error.code === 'assets-duplicate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('arguments: each stage needs its own flags', () => {
  assert.deepEqual(parseCandidateArguments(['--stage=normalize', '--directory=release']), ok({ stage: 'normalize', directory: 'release' }));
  assert.equal(parseCandidateArguments(['--stage=normalize']).ok, false);
  assert.deepEqual(parseCandidateArguments(['--stage=plan', '--rehearsal=true']), ok({ stage: 'plan', rehearsal: true }));
  assert.deepEqual(parseCandidateArguments(['--stage=assets', '--version=1.4.8', '--directory=out']), ok({ stage: 'assets', version: '1.4.8', directory: 'out' }));
  for (const bad of [[], ['--stage=publish'], ['--stage=plan', '--rehearsal=yes'], ['--stage=assets', '--directory=out'], ['--stage=assets', '--version=1.4.8'], ['--force']]) {
    assert.equal(parseCandidateArguments(bad).ok, false, bad.join(' '));
  }
});
