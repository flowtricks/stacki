// The version of an installed Claude Code, read from where it is installed, without running it.
//
// Why: the AI panel's model list is whatever the person's own Claude Code reports, so an old copy shows old models.
// Two things need its version: choosing between several installed copies (findCli, agentRegistry.ts) and saying that
// the one in use is too old (agentHost.ts `availability`). Both are asked often and synchronously, so no process
// starts here. An install this cannot read (the native Windows .exe, a wrapper script) has no known version here.
//
// What is read, from the file `findCli` resolved through links:
// - Anthropic's native installer: the file is named by its version (…/claude/versions/2.1.332).
// - Homebrew: the version is a folder (…/Caskroom/claude-code/2.1.332/claude).
// - npm, pnpm, Bun and the old ~/.claude/local install: the package's package.json, either around the file or in
//   the node_modules folder beside a wrapper (a .cmd shim, ~/.claude/local/claude).
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { toRecord } from '../../../shared/core/record';

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}/;
const VERSIONED_PATH = /\/(?:claude\/versions|Caskroom\/claude-code(?:@latest)?)\/(\d{1,6}\.\d{1,6}\.\d{1,6})(?:\/|$)/;
const PACKAGE_FOLDER = /^(.*\/node_modules\/@anthropic-ai\/claude-code)\//;

/** The `X.Y.Z` a version text starts with ("2.1.332 (Claude Code)" is "2.1.332"), or undefined. */
export function versionIn(text: string): string | undefined {
  return VERSION.exec(text.trim())?.[0];
}

/** Whether version `left` is older than `right`; both are `X.Y.Z`. */
export function isOlderVersion(left: string, right: string): boolean {
  assert(VERSION.test(left), 'isOlderVersion: a version');
  assert(VERSION.test(right), 'isOlderVersion: a version to compare with');
  const parts = (version: string): readonly number[] => version.split('.').map((part) => Number.parseInt(part, 10));
  const [mine, theirs] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index++) {
    const difference = (mine[index] ?? 0) - (theirs[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

/** The version of the Claude Code at `file`; `readText` answers undefined for a file that cannot be read. */
export function claudeInstalledVersion(file: string, readText: (file: string) => string | undefined): string | undefined {
  const slashed = file.replaceAll('\\', '/');
  const named = VERSIONED_PATH.exec(slashed)?.[1];
  if (named !== undefined) {
    return named;
  }
  const inside = PACKAGE_FOLDER.exec(slashed)?.[1];
  const folder = inside ?? `${slashed.slice(0, slashed.lastIndexOf('/'))}/node_modules/@anthropic-ai/claude-code`;
  const manifest = file.includes('\\') ? path.win32.join(folder, 'package.json') : path.posix.join(folder, 'package.json');
  const source = readText(manifest);
  if (source === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  const version = toRecord(parsed)?.['version'];
  return typeof version === 'string' ? versionIn(version) : undefined;
}
