#!/usr/bin/env node
// Runs Prettier over the whole repository the way git sees it: tracked files, plus new
// files that no ignore list hides, `.git/info/exclude` and the global excludes file
// included. `prettier --check .` walks the folder instead and reads only `.gitignore`
// and `.prettierignore`, so a contributor's local notes folder failed the gate (issue
// #78). Prettier still applies `.gitignore` and `.prettierignore` to the files named
// here, so a clean checkout is checked exactly as before.
//
// Every argument is Prettier's own (`--check`, `--cache`, …); the files are added last, in
// batches that keep each command line under the operating system's limit (about 32,000
// characters on Windows).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChild } from './child.mts';
import { repositoryRoot } from './checks.mts';
import { repositoryFiles } from './scan.mts';

const COMMAND_CHARS_MAX = 20_000;
const BATCH_FILES_MAX = 400;

/** Splits files into batches bounded by count and by total characters. */
export function batchFiles(files: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const file of files) {
    const full = characters + file.length + 1 > COMMAND_CHARS_MAX || current.length >= BATCH_FILES_MAX;
    if (full && current.length > 0) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(file);
    characters += file.length + 1;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** Prettier over every file git considers part of the repository; the worst status wins. */
export function formatTree(root: string, prettierArguments: readonly string[]): number {
  const prettier = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
  const files = repositoryFiles(root).filter((file) => fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() === true);
  let status = 0;
  for (const batch of batchFiles(files)) {
    const result = runChild(process.execPath, [prettier, ...prettierArguments, '--ignore-unknown', ...batch], { cwd: root });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      status = result.status;
    }
  }
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = formatTree(repositoryRoot(), process.argv.slice(2));
}
