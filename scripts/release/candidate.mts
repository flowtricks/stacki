#!/usr/bin/env node
// The release candidate: build once, test once, promote. candidate.yml builds, signs, notarizes and
// smoke-tests every installer for one commit and keeps them as that run's artifacts; release.yml
// later promotes exactly those files, so nothing is rebuilt or retested after a tag exists.
//
//   node --experimental-strip-types scripts/release/candidate.mts --stage=plan --rehearsal=<true|false>
//   node --experimental-strip-types scripts/release/candidate.mts --stage=normalize --directory=DIR
//   node --experimental-strip-types scripts/release/candidate.mts --stage=assets --version=X.Y.Z --directory=DIR
//
// plan    reads the version the checkout carries and whether its tag already exists on origin. A
//         released version has nothing to promote, so the build is skipped (outputs build=false),
//         unless this is a rehearsal, which builds, tests and keeps artifacts but can never be
//         promoted (promote.mts refuses a rehearsal run).
// assets  proves a folder holds the complete release, by exact file name, and that each update
//         feed (latest*.yml) names this version and only files that are present. An update feed
//         that names a missing file would 404 every updater on that platform.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter, type Reporter } from './actionsReport.mts';
import { systemCommandRunner, type CommandRunner } from './releaseCommands.mts';
import { parseRecord, readString } from './releaseJson.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { parseTagNames } from './releaseStatus.mts';
import { parseVersion } from './releaseVersion.mts';

export const CANDIDATE_LIMITS = {
  assetCountMax: 200,
  feedCharsMax: 64 * 1024,
  directoryDepthMax: 4,
} as const satisfies Record<string, number>;

export type CandidateMode = 'candidate' | 'rehearsal';

export type CandidatePlan =
  | { readonly kind: 'build'; readonly version: string; readonly mode: CandidateMode }
  | { readonly kind: 'skip'; readonly version: string; readonly reason: string };

/** Whether this commit needs a candidate build. */
export function decideCandidate(input: { readonly version: string; readonly tagExists: boolean; readonly rehearsal: boolean }): CandidatePlan {
  assert(parseVersion(input.version).ok, 'decideCandidate: the version is X.Y.Z');
  if (input.rehearsal) {
    return { kind: 'build', version: input.version, mode: 'rehearsal' };
  }
  if (input.tagExists) {
    return { kind: 'skip', version: input.version, reason: `v${input.version} is already released; bump the version (npm run release:ship) to start a candidate.` };
  }
  return { kind: 'build', version: input.version, mode: 'candidate' };
}

/**
 * Every file a public release must hold, by exact name. Derived from the assets of v1.4.5, the
 * last release every platform updated from. The Studio demo files are optional and left out.
 */
export function requiredAssetNames(version: string): readonly string[] {
  assert(parseVersion(version).ok, 'requiredAssetNames: the version is X.Y.Z');
  const names = [
    'latest.yml',
    'latest-mac.yml',
    'latest-linux.yml',
    `Stacki-${version}-arm64.dmg`,
    `Stacki-${version}-arm64.dmg.blockmap`,
    `Stacki-${version}-arm64.zip`,
    `Stacki-${version}-arm64.zip.blockmap`,
    `Stacki-${version}-x64.dmg`,
    `Stacki-${version}-x64.dmg.blockmap`,
    `Stacki-${version}-x64.zip`,
    `Stacki-${version}-x64.zip.blockmap`,
    `Stacki-${version}.AppImage`,
    `Stacki-Setup-${version}.exe`,
    `Stacki-Setup-${version}.exe.blockmap`,
    `stacki_${version}_amd64.deb`,
    `stacki-studio-${version}.json`,
  ];
  assert(new Set(names).size === names.length, 'requiredAssetNames: no name twice');
  return names;
}

export const UPDATE_FEEDS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'] as const;

/** One file of a candidate: its size, and its text when it is an update feed. */
export interface AssetFile {
  readonly sizeBytes: number;
  readonly feedText: string | undefined;
}

/**
 * The problems with one update feed: a wrong version, a file it names that is not present, or a
 * size that differs from the file's (a feed left over from another build of the same version).
 */
export function updateFeedProblems(feed: string, text: string, version: string, files: ReadonlyMap<string, AssetFile>): readonly string[] {
  assert(text.length <= CANDIDATE_LIMITS.feedCharsMax, `updateFeedProblems: ${feed} is bounded`);
  assert(parseVersion(version).ok, 'updateFeedProblems: the version is X.Y.Z');
  const problems: string[] = [];
  const versionLine = /^version: ['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
  if (versionLine === null) {
    problems.push(`${feed}: no version line`);
  } else if (versionLine[1] !== version) {
    problems.push(`${feed}: version ${String(versionLine[1])}, expected ${version}`);
  }
  const referenced = [...text.matchAll(/^\s*(?:-\s+)?(?:url|path): ['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1] ?? '');
  if (referenced.length === 0) {
    problems.push(`${feed}: names no file`);
  }
  for (const name of referenced) {
    if (!files.has(name)) {
      problems.push(`${feed}: names ${name}, which is not in the release`);
    }
  }
  // Each `- url:` entry is followed, within its entry, by `size: N`.
  for (const entry of text.matchAll(/^\s*-\s+url: ['"]?([^'"\s]+)['"]?\s*\n(?:\s{4,}\S.*\n)*?\s{4,}size: (\d+)\s*$/gm)) {
    const name = entry[1] ?? '';
    const sizeBytes = Number(entry[2]);
    const file = files.get(name);
    if (file !== undefined && file.sizeBytes !== sizeBytes) {
      problems.push(`${feed}: says ${name} is ${sizeBytes} bytes, the file is ${file.sizeBytes}`);
    }
  }
  return problems;
}

/** Every reason this set of files is not a complete release of `version`; empty when it is. */
export function candidateAssetProblems(version: string, files: ReadonlyMap<string, AssetFile>): readonly string[] {
  assert(files.size <= CANDIDATE_LIMITS.assetCountMax, 'candidateAssetProblems: the asset count is bounded');
  const problems = requiredAssetNames(version)
    .filter((name) => !files.has(name))
    .map((name) => `missing ${name}`);
  for (const [name, file] of files) {
    if (file.sizeBytes === 0) {
      problems.push(`${name} is empty`);
    }
  }
  for (const feed of UPDATE_FEEDS) {
    const text = files.get(feed)?.feedText;
    if (text !== undefined) {
      problems.push(...updateFeedProblems(feed, text, version, files));
    }
  }
  return problems;
}

/** The files under a folder by base name, with the text of each update feed. A name seen twice is a failure. */
export function readAssetFolder(directory: string): Result<ReadonlyMap<string, AssetFile>> {
  const files = new Map<string, AssetFile>();
  const pending: { readonly folder: string; readonly depth: number }[] = [{ folder: directory, depth: 0 }];
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert(visited <= CANDIDATE_LIMITS.assetCountMax, 'readAssetFolder: the walk is bounded');
    const next = pending.pop();
    assert(next !== undefined, 'readAssetFolder: the queue was not empty');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(next.folder, { withFileTypes: true });
    } catch (error: unknown) {
      return fail('assets-unreadable', `${next.folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of entries) {
      const full = path.join(next.folder, entry.name);
      if (entry.isDirectory()) {
        if (next.depth < CANDIDATE_LIMITS.directoryDepthMax) {
          pending.push({ folder: full, depth: next.depth + 1 });
        }
        continue;
      }
      if (files.has(entry.name)) {
        return fail('assets-duplicate', `${entry.name} appears twice under ${directory}; one release cannot hold both.`);
      }
      if (files.size >= CANDIDATE_LIMITS.assetCountMax) {
        return fail('assets-too-many', `more than ${CANDIDATE_LIMITS.assetCountMax} files under ${directory}.`);
      }
      const isFeed = UPDATE_FEEDS.some((feed) => feed === entry.name);
      const sizeBytes = fs.statSync(full).size;
      files.set(entry.name, { sizeBytes, feedText: isFeed ? fs.readFileSync(full, 'utf8').slice(0, CANDIDATE_LIMITS.feedCharsMax) : undefined });
    }
  }
  return ok(files);
}

/**
 * The name GitHub gives an uploaded file, which every update feed already uses: electron-builder
 * names the Windows installer "Stacki Setup X.Y.Z.exe" but writes `url: Stacki-Setup-X.Y.Z.exe`
 * into latest.yml, because its own uploader replaced spaces with dashes. The candidate is uploaded
 * by release.yml instead, so the files take that name before they are kept (the first rehearsal,
 * run 44206405239, failed on exactly this).
 */
export function releaseAssetName(fileName: string): string {
  assert(fileName.length > 0, 'releaseAssetName: a file name');
  assert(!fileName.includes('/'), 'releaseAssetName: a base name, not a path');
  return fileName.replace(/ +/g, '-');
}

/** Renames every file in the folder whose name differs from its release asset name. */
export function normalizeAssetFolder(directory: string): Result<readonly string[]> {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error: unknown) {
    return fail('assets-unreadable', `${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(names.length <= CANDIDATE_LIMITS.assetCountMax * 10, 'normalizeAssetFolder: the folder is bounded');
  const renamed: string[] = [];
  for (const name of names) {
    const target = releaseAssetName(name);
    if (target === name) {
      continue;
    }
    if (names.includes(target)) {
      return fail('assets-duplicate', `${name} and ${target} would both be ${target}.`);
    }
    fs.renameSync(path.join(directory, name), path.join(directory, target));
    renamed.push(`${name} -> ${target}`);
  }
  return ok(renamed);
}

export function readCheckoutVersion(packageJsonText: string): Result<string> {
  const record = parseRecord(packageJsonText, 'package.json');
  if (!record.ok) {
    return record;
  }
  const version = readString(record.value, 'version', 'package.json');
  if (!version.ok) {
    return version;
  }
  return parseVersion(version.value).ok ? version : fail('version-shape', `package.json version ${version.value} is not X.Y.Z.`);
}

export function readTagExists(runner: CommandRunner, version: string): Result<boolean> {
  const tags = runner({ command: 'git', argumentsList: ['ls-remote', '--tags', 'origin', `refs/tags/v${version}`] });
  return tags.ok ? ok(parseTagNames(tags.value).includes(`v${version}`)) : tags;
}

export type CandidateArguments =
  | { readonly stage: 'plan'; readonly rehearsal: boolean }
  | { readonly stage: 'normalize'; readonly directory: string }
  | { readonly stage: 'assets'; readonly version: string; readonly directory: string };

export function parseCandidateArguments(argumentsList: readonly string[]): Result<CandidateArguments> {
  const values = new Map<string, string>();
  for (const argument of argumentsList) {
    const match = /^--(stage|rehearsal|version|directory)=(.*)$/.exec(argument);
    if (match === null) {
      return fail('usage', `unknown argument ${argument}`);
    }
    values.set(match[1] ?? '', match[2] ?? '');
  }
  const stage = values.get('stage');
  if (stage === 'plan') {
    const rehearsal = values.get('rehearsal') ?? 'false';
    if (rehearsal !== 'true' && rehearsal !== 'false') {
      return fail('usage', '--rehearsal is true or false');
    }
    return ok({ stage, rehearsal: rehearsal === 'true' });
  }
  if (stage === 'normalize') {
    const directory = values.get('directory') ?? '';
    return directory.length === 0 ? fail('usage', '--directory is required') : ok({ stage, directory });
  }
  if (stage === 'assets') {
    const version = values.get('version') ?? '';
    const directory = values.get('directory') ?? '';
    if (!parseVersion(version).ok) {
      return fail('usage', '--version=X.Y.Z is required');
    }
    if (directory.length === 0) {
      return fail('usage', '--directory is required');
    }
    return ok({ stage, version, directory });
  }
  return fail('usage', '--stage is plan, normalize or assets');
}

export function runPlanStage(options: { readonly rehearsal: boolean; readonly packageJsonText: string }, runner: CommandRunner, reporter: Reporter): number {
  const { rehearsal, packageJsonText } = options;
  const version = readCheckoutVersion(packageJsonText);
  if (!version.ok) {
    reporter.error(version.error.message);
    return 2;
  }
  const tagExists = readTagExists(runner, version.value);
  if (!tagExists.ok) {
    reporter.error(tagExists.error.message);
    return 2;
  }
  const plan = decideCandidate({ version: version.value, tagExists: tagExists.value, rehearsal });
  reporter.output('version', plan.version);
  reporter.output('build', plan.kind === 'build' ? 'true' : 'false');
  reporter.output('mode', plan.kind === 'build' ? plan.mode : 'none');
  reporter.summary(plan.kind === 'build' ? `Candidate build of ${plan.version} (${plan.mode}).` : `No candidate: ${plan.reason}`);
  return 0;
}

export function runAssetsStage(version: string, directory: string, reporter: Reporter): number {
  const files = readAssetFolder(directory);
  if (!files.ok) {
    reporter.error(files.error.message);
    return 1;
  }
  const problems = candidateAssetProblems(version, files.value);
  const rows = requiredAssetNames(version).map((name) => `| ${name} | ${files.value.has(name) ? 'present' : '**MISSING**'} |`);
  reporter.summary([`### Release ${version}: ${problems.length === 0 ? 'complete' : 'INCOMPLETE'}`, '', '| File | State |', '|---|---|', ...rows].join('\n'));
  for (const problem of problems) {
    reporter.error(problem);
  }
  return problems.length === 0 ? 0 : 1;
}

function main(argumentsList: readonly string[]): number {
  const reporter = systemReporter(process.env);
  const parsed = parseCandidateArguments(argumentsList);
  if (!parsed.ok) {
    reporter.error(parsed.error.message);
    return 2;
  }
  switch (parsed.value.stage) {
    case 'plan':
      return runPlanStage({ rehearsal: parsed.value.rehearsal, packageJsonText: fs.readFileSync('package.json', 'utf8') }, systemCommandRunner(process.env), reporter);
    case 'normalize': {
      const renamed = normalizeAssetFolder(parsed.value.directory);
      if (!renamed.ok) {
        reporter.error(renamed.error.message);
        return 1;
      }
      for (const line of renamed.value) {
        reporter.notice(`renamed ${line}`);
      }
      return 0;
    }
    case 'assets':
      return runAssetsStage(parsed.value.version, parsed.value.directory, reporter);
    default: {
      const exhaustive: never = parsed.value;
      return exhaustive;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
