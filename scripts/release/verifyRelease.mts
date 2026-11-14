#!/usr/bin/env node
// Usage (the file is .mts so Node runs it directly, as it runs scripts/policy):
//
//   node --experimental-strip-types scripts/release/verifyRelease.mts <version> [--only=release,npm,site] [--wait-minutes=15]
//
// Checks a finished release from the outside, as a user would meet it, and prints a PASS/FAIL
// table. Exit status 0 only when every check passes; warnings (the optional demo assets) do not
// fail it. Read-only: gh GETs, `npm view`, `npm pack --dry-run`, and HTTP GET/HEAD.
//
//   release  the GitHub release is published (not a draft), every installer and update file is
//            there, and each latest*.yml names this version and matches its assets' sizes
//   npm      create-stacki's latest tag and tarball are this version, and the tarball has dist/demo
//   site     stacki.build serves, built from this version, and /marketplace/admin still redirects
//            to Cloudflare Access
//
// Registry and CDN lag are normal after a publish, so `--wait-minutes=N` retries the checks that
// still fail every 30 seconds for up to N minutes (at most 30). Without it each check runs once.

import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { assert } from '../policy/assert.mts';
import {
  flowtricksEnvironment,
  pollUntil,
  systemCommandRunner,
  systemHttpFetcher,
  systemSleeper,
  type CommandRunner,
  type HttpFetcher,
  type Sleeper,
} from './releaseCommands.mts';
import { parseJson, parseRecord, readBoolean, readInteger, readList, readOptionalString, readRecord, readString } from './releaseJson.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { parseVersion } from './releaseVersion.mts';

export const VERIFY_LIMITS = {
  waitMinutesMax: 30,
  retryDelayMs: 30_000,
  rowsMax: 200,
} as const satisfies Record<string, number>;

export const RELEASES_REPOSITORY = 'flowtricks/stacki-releases';
export const SITE_ORIGIN = 'https://stacki.build';
const UPDATE_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'] as const;
const DEMO_ASSET_PREFIX = 'stacki-demo-';

export type CheckGroup = 'release' | 'npm' | 'site';
export const CHECK_GROUPS: readonly CheckGroup[] = ['release', 'npm', 'site'];

export interface CheckRow {
  readonly group: CheckGroup;
  readonly name: string;
  readonly verdict: 'pass' | 'fail' | 'warn';
  readonly detail: string;
}

export interface ReleaseAsset {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface ReleaseView {
  readonly tagName: string;
  readonly isDraft: boolean;
  readonly assets: readonly ReleaseAsset[];
}

export interface UpdateFile {
  readonly url: string;
  readonly sha512: string | undefined;
  readonly sizeBytes: number | undefined;
}

export interface UpdateMetadata {
  readonly version: string;
  readonly files: readonly UpdateFile[];
}

export interface NpmFacts {
  readonly latestTag: string;
  readonly tarballVersion: string;
  readonly shasum: string;
  readonly tarballPaths: readonly string[];
}

/** The assets every release must carry; the demo files are optional and only warn. */
export function requiredAssetNames(version: string): readonly string[] {
  const installers = [
    `Stacki-${version}-arm64.dmg`,
    `Stacki-${version}-x64.dmg`,
    `Stacki-${version}-arm64.zip`,
    `Stacki-${version}-x64.zip`,
    `Stacki-Setup-${version}.exe`,
  ];
  return [
    ...UPDATE_FILES,
    ...installers,
    ...installers.map((name) => `${name}.blockmap`),
    `Stacki-${version}.AppImage`,
    `stacki_${version}_amd64.deb`,
    `stacki-studio-${version}.json`,
  ];
}

export function parseReleaseView(text: string): Result<ReleaseView> {
  const record = parseRecord(text, 'gh release view');
  if (!record.ok) {
    return record;
  }
  const tagName = readString(record.value, 'tagName', 'gh release view');
  const isDraft = readBoolean(record.value, 'isDraft', 'gh release view');
  const assetList = readList(record.value['assets'], 'gh release view assets');
  if (!tagName.ok) {
    return tagName;
  }
  if (!isDraft.ok) {
    return isDraft;
  }
  if (!assetList.ok) {
    return assetList;
  }
  const assets: ReleaseAsset[] = [];
  for (const entry of assetList.value) {
    const asset = readRecord(entry, 'gh release view asset');
    if (!asset.ok) {
      return asset;
    }
    const name = readString(asset.value, 'name', 'gh release view asset');
    const sizeBytes = readInteger(asset.value, 'size', 'gh release view asset');
    if (!name.ok) {
      return name;
    }
    if (!sizeBytes.ok) {
      return sizeBytes;
    }
    assets.push({ name: name.value, sizeBytes: sizeBytes.value });
  }
  return ok({ tagName: tagName.value, isDraft: isDraft.value, assets });
}

const UPDATE_YAML_CHARS_MAX = 256 * 1024;

export function parseUpdateMetadata(text: string): Result<UpdateMetadata> {
  if (text.length > UPDATE_YAML_CHARS_MAX) {
    return fail('yaml-too-large', 'update metadata exceeds the size limit.');
  }
  let parsed: unknown;
  try {
    parsed = parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error: unknown) {
    return fail('yaml-malformed', `update metadata is not valid YAML (${error instanceof Error ? error.message : String(error)}).`);
  }
  const record = readRecord(parsed, 'update metadata');
  if (!record.ok) {
    return record;
  }
  const version = readString(record.value, 'version', 'update metadata');
  const fileList = readList(record.value['files'], 'update metadata files');
  if (!version.ok) {
    return version;
  }
  if (!fileList.ok) {
    return fileList;
  }
  const files: UpdateFile[] = [];
  for (const entry of fileList.value) {
    const file = readRecord(entry, 'update metadata file');
    if (!file.ok) {
      return file;
    }
    const url = readString(file.value, 'url', 'update metadata file');
    if (!url.ok) {
      return url;
    }
    const size = readInteger(file.value, 'size', 'update metadata file');
    files.push({ url: url.value, sha512: readOptionalString(file.value, 'sha512'), sizeBytes: size.ok ? size.value : undefined });
  }
  return ok({ version: version.value, files });
}

export function parseNpmPack(text: string): Result<Pick<NpmFacts, 'tarballVersion' | 'shasum' | 'tarballPaths'>> {
  const packs = parseJson(text, 'npm pack');
  if (!packs.ok) {
    return packs;
  }
  const list = readList(packs.value, 'npm pack');
  if (!list.ok) {
    return list;
  }
  const first = readRecord(list.value[0], 'npm pack[0]');
  if (!first.ok) {
    return first;
  }
  const version = readString(first.value, 'version', 'npm pack[0]');
  const shasum = readString(first.value, 'shasum', 'npm pack[0]');
  const files = readList(first.value['files'], 'npm pack[0].files');
  if (!version.ok) {
    return version;
  }
  if (!shasum.ok) {
    return shasum;
  }
  if (!files.ok) {
    return files;
  }
  const tarballPaths: string[] = [];
  for (const entry of files.value) {
    const file = readRecord(entry, 'npm pack file');
    const path = file.ok ? readString(file.value, 'path', 'npm pack file') : file;
    if (!path.ok) {
      return path;
    }
    tarballPaths.push(path.value);
  }
  return ok({ tarballVersion: version.value, shasum: shasum.value, tarballPaths });
}

export function evaluateRelease(version: string, view: ReleaseView): readonly CheckRow[] {
  assert(parseVersion(version).ok, 'evaluateRelease: version is MAJOR.MINOR.PATCH');
  const rows: CheckRow[] = [];
  const row = (name: string, verdict: CheckRow['verdict'], detail: string): void => {
    rows.push({ group: 'release', name, verdict, detail });
  };
  row('tag', view.tagName === `v${version}` ? 'pass' : 'fail', `release tag is ${view.tagName}`);
  row('published', view.isDraft ? 'fail' : 'pass', view.isDraft ? 'still a DRAFT: release.yml publish job did not run' : 'public, not a draft');
  const names = new Set(view.assets.map((asset) => asset.name));
  const missing = requiredAssetNames(version).filter((name) => !names.has(name));
  row('required assets', missing.length === 0 ? 'pass' : 'fail', missing.length === 0 ? `all ${requiredAssetNames(version).length} present` : `missing: ${missing.join(', ')}`);
  const demoCount = view.assets.filter((asset) => asset.name.startsWith(DEMO_ASSET_PREFIX)).length;
  row('demo assets', demoCount > 0 ? 'pass' : 'warn', demoCount > 0 ? `${demoCount} present` : 'none: the optional demo upload failed; the site keeps its last copy');
  return rows;
}

/** One update file: its version, and every file it lists exists as an asset with the same size. */
export function evaluateUpdateMetadata(version: string, fileName: string, metadata: UpdateMetadata, assets: readonly ReleaseAsset[]): CheckRow {
  const name = `${fileName} contents`;
  if (metadata.version !== version) {
    return { group: 'release', name, verdict: 'fail', detail: `names version ${metadata.version}, expected ${version}` };
  }
  if (metadata.files.length === 0) {
    return { group: 'release', name, verdict: 'fail', detail: 'lists no files' };
  }
  const problems: string[] = [];
  for (const file of metadata.files) {
    const asset = assets.find((candidate) => candidate.name === file.url);
    if (asset === undefined) {
      problems.push(`${file.url}: not a release asset`);
    } else if (file.sizeBytes !== asset.sizeBytes) {
      problems.push(`${file.url}: size ${String(file.sizeBytes)} in the yml, ${asset.sizeBytes} on the release`);
    } else if (file.sha512 === undefined) {
      problems.push(`${file.url}: no sha512`);
    }
  }
  return {
    group: 'release',
    name,
    verdict: problems.length === 0 ? 'pass' : 'fail',
    detail: problems.length === 0 ? `version ${version}, ${metadata.files.length} file(s) match their asset sizes` : problems.join('; '),
  };
}

export function evaluateNpm(version: string, facts: NpmFacts): readonly CheckRow[] {
  const demoCount = facts.tarballPaths.filter((path) => path.startsWith('dist/demo/')).length;
  const hasCli = facts.tarballPaths.includes('dist/cli.mjs');
  return [
    { group: 'npm', name: 'latest tag', verdict: facts.latestTag === version ? 'pass' : 'fail', detail: `create-stacki@latest is ${facts.latestTag}` },
    { group: 'npm', name: 'tarball version', verdict: facts.tarballVersion === version ? 'pass' : 'fail', detail: `${facts.tarballVersion}, shasum ${facts.shasum}` },
    { group: 'npm', name: 'tarball dist/demo', verdict: demoCount > 0 ? 'pass' : 'fail', detail: `${demoCount} file(s) under dist/demo/` },
    { group: 'npm', name: 'tarball dist/cli.mjs', verdict: hasCli ? 'pass' : 'fail', detail: hasCli ? 'present' : 'missing' },
  ];
}

interface SiteFacts {
  readonly home: Result<number>;
  readonly studio: Result<number>;
  readonly builtFrom: Result<string>;
  readonly admin: Result<{ readonly status: number; readonly location: string | undefined }>;
}

export function evaluateSite(version: string, facts: SiteFacts): readonly CheckRow[] {
  const statusRow = (name: string, result: Result<number>): CheckRow =>
    result.ok
      ? { group: 'site', name, verdict: result.value === 200 ? 'pass' : 'fail', detail: `HTTP ${result.value}` }
      : { group: 'site', name, verdict: 'fail', detail: result.error.message };
  const rows: CheckRow[] = [statusRow('/', facts.home), statusRow('/demo/app/studio.js', facts.studio)];
  if (facts.builtFrom.ok) {
    const builtFrom = facts.builtFrom.value.trim();
    rows.push({ group: 'site', name: '/stacki-release.txt', verdict: builtFrom === version ? 'pass' : 'fail', detail: `built from ${builtFrom}` });
  } else {
    rows.push({ group: 'site', name: '/stacki-release.txt', verdict: 'fail', detail: facts.builtFrom.error.message });
  }
  if (facts.admin.ok) {
    const toAccess = facts.admin.value.status === 302 && (facts.admin.value.location ?? '').includes('cloudflareaccess.com');
    rows.push({
      group: 'site',
      name: '/marketplace/admin',
      verdict: toAccess ? 'pass' : 'fail',
      detail: toAccess ? '302 to Cloudflare Access' : `HTTP ${facts.admin.value.status}, location ${facts.admin.value.location ?? 'none'}`,
    });
  } else {
    rows.push({ group: 'site', name: '/marketplace/admin', verdict: 'fail', detail: facts.admin.error.message });
  }
  return rows;
}

export function renderTable(rows: readonly CheckRow[]): string {
  assert(rows.length <= VERIFY_LIMITS.rowsMax, 'renderTable: rows are bounded');
  const label = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' } as const;
  const lines = rows.map((row) => `${label[row.verdict]}  ${row.group.padEnd(8)}${row.name.padEnd(30)}${row.detail}`);
  const failures = rows.filter((row) => row.verdict === 'fail').length;
  lines.push(failures === 0 ? 'VERIFY PASS' : `VERIFY FAIL: ${failures} check(s) failed`);
  return lines.join('\n');
}

export function exitCodeFor(rows: readonly CheckRow[]): number {
  return rows.some((row) => row.verdict === 'fail') ? 1 : 0;
}

async function releaseRows(version: string, runner: CommandRunner, fetcher: HttpFetcher): Promise<readonly CheckRow[]> {
  const viewText = runner({
    command: 'gh',
    argumentsList: ['release', 'view', `v${version}`, '--repo', RELEASES_REPOSITORY, '--json', 'tagName,isDraft,assets'],
  });
  if (!viewText.ok) {
    return [{ group: 'release', name: 'gh release view', verdict: 'fail', detail: viewText.error.message }];
  }
  const view = parseReleaseView(viewText.value);
  if (!view.ok) {
    return [{ group: 'release', name: 'gh release view', verdict: 'fail', detail: view.error.message }];
  }
  const rows: CheckRow[] = [...evaluateRelease(version, view.value)];
  for (const fileName of UPDATE_FILES) {
    const response = await fetcher({
      url: `https://github.com/${RELEASES_REPOSITORY}/releases/download/v${version}/${fileName}`,
      method: 'GET',
      redirect: 'follow',
    });
    if (!response.ok || response.value.status !== 200) {
      const detail = response.ok ? `HTTP ${response.value.status}` : response.error.message;
      rows.push({ group: 'release', name: `${fileName} contents`, verdict: 'fail', detail });
      continue;
    }
    const metadata = parseUpdateMetadata(response.value.body);
    rows.push(
      metadata.ok
        ? evaluateUpdateMetadata(version, fileName, metadata.value, view.value.assets)
        : { group: 'release', name: `${fileName} contents`, verdict: 'fail', detail: metadata.error.message },
    );
  }
  return rows;
}

async function npmRows(version: string, runner: CommandRunner): Promise<readonly CheckRow[]> {
  const latest = runner({ command: 'npm', argumentsList: ['view', 'create-stacki', 'dist-tags.latest'], timeoutMs: 60_000 });
  if (!latest.ok) {
    return [{ group: 'npm', name: 'npm view', verdict: 'fail', detail: latest.error.message }];
  }
  const pack = runner({ command: 'npm', argumentsList: ['pack', `create-stacki@${version}`, '--dry-run', '--json'], timeoutMs: 120_000 });
  if (!pack.ok) {
    return [{ group: 'npm', name: 'latest tag', verdict: latest.value.trim() === version ? 'pass' : 'fail', detail: `create-stacki@latest is ${latest.value.trim()}` }, { group: 'npm', name: 'tarball', verdict: 'fail', detail: pack.error.message }];
  }
  const facts = parseNpmPack(pack.value);
  if (!facts.ok) {
    return [{ group: 'npm', name: 'tarball', verdict: 'fail', detail: facts.error.message }];
  }
  return evaluateNpm(version, { latestTag: latest.value.trim(), ...facts.value });
}

async function siteRows(version: string, fetcher: HttpFetcher): Promise<readonly CheckRow[]> {
  const status = async (path: string, method: 'GET' | 'HEAD'): Promise<Result<number>> => {
    const response = await fetcher({ url: `${SITE_ORIGIN}${path}`, method, redirect: 'follow' });
    return response.ok ? ok(response.value.status) : response;
  };
  const release = await fetcher({ url: `${SITE_ORIGIN}/stacki-release.txt`, method: 'GET', redirect: 'follow' });
  const admin = await fetcher({ url: `${SITE_ORIGIN}/marketplace/admin`, method: 'HEAD', redirect: 'manual' });
  return evaluateSite(version, {
    home: await status('/', 'GET'),
    studio: await status('/demo/app/studio.js', 'HEAD'),
    builtFrom: release.ok ? ok(release.value.body) : release,
    admin: admin.ok ? ok({ status: admin.value.status, location: admin.value.location }) : admin,
  });
}

export interface VerifyOptions {
  readonly version: string;
  readonly groups: readonly CheckGroup[];
  readonly waitMinutes: number;
}

export async function verifyRelease(options: VerifyOptions, runner: CommandRunner, fetcher: HttpFetcher, sleeper: Sleeper): Promise<readonly CheckRow[]> {
  assert(parseVersion(options.version).ok, 'verifyRelease: version is MAJOR.MINOR.PATCH');
  assert(options.waitMinutes >= 0, 'verifyRelease: wait is not negative');
  assert(options.waitMinutes <= VERIFY_LIMITS.waitMinutesMax, 'verifyRelease: wait is bounded');
  const attemptsMax = 1 + Math.ceil((options.waitMinutes * 60_000) / VERIFY_LIMITS.retryDelayMs);
  const plan = { attemptsMax, delayMs: VERIFY_LIMITS.retryDelayMs, sleeper };
  const rows: CheckRow[] = [];
  for (const group of options.groups) {
    const attempt = (): Promise<readonly CheckRow[]> => {
      switch (group) {
        case 'release':
          return releaseRows(options.version, runner, fetcher);
        case 'npm':
          return npmRows(options.version, runner);
        case 'site':
          return siteRows(options.version, fetcher);
        default: {
          const exhaustive: never = group;
          return exhaustive;
        }
      }
    };
    rows.push(...(await pollUntil(plan, attempt, (groupRows) => groupRows.every((candidate) => candidate.verdict !== 'fail'))));
  }
  return rows;
}

/** Arguments to options, or the reason they are wrong. */
export function parseArguments(argumentsList: readonly string[]): Result<VerifyOptions> {
  const [version, ...flags] = argumentsList;
  if (version === undefined) {
    return fail('usage', 'usage: verifyRelease.mts <version> [--only=release,npm,site] [--wait-minutes=15]');
  }
  const parsed = parseVersion(version);
  if (!parsed.ok) {
    return parsed;
  }
  let groups: readonly CheckGroup[] = CHECK_GROUPS;
  let waitMinutes = 0;
  for (const flag of flags) {
    if (flag.startsWith('--only=')) {
      const wanted = flag.slice('--only='.length).split(',');
      const chosen = CHECK_GROUPS.filter((group) => wanted.includes(group));
      if (chosen.length === 0 || chosen.length !== wanted.length) {
        return fail('usage', `--only takes a comma list of ${CHECK_GROUPS.join(', ')}.`);
      }
      groups = chosen;
    } else if (flag.startsWith('--wait-minutes=')) {
      waitMinutes = Number(flag.slice('--wait-minutes='.length));
      if (!Number.isSafeInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > VERIFY_LIMITS.waitMinutesMax) {
        return fail('usage', `--wait-minutes takes a whole number from 0 to ${VERIFY_LIMITS.waitMinutesMax}.`);
      }
    } else {
      return fail('usage', `unknown argument ${flag}`);
    }
  }
  return ok({ version, groups, waitMinutes });
}

async function main(argumentsList: readonly string[]): Promise<number> {
  const options = parseArguments(argumentsList);
  if (!options.ok) {
    console.error(options.error.message);
    return 2;
  }
  const bootstrap = systemCommandRunner(process.env);
  const runner = systemCommandRunner(flowtricksEnvironment(process.env, bootstrap));
  const rows = await verifyRelease(options.value, runner, systemHttpFetcher(), systemSleeper);
  console.log(renderTable(rows));
  return exitCodeFor(rows);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
