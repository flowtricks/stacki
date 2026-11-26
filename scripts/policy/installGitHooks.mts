#!/usr/bin/env node
// Keeps the blame ignore list and retires Stacki's old local hook setting.
// Preserve hook paths that contributors configured themselves.

import path from 'node:path';
import { assert } from './assert.mts';
import { runChild } from './child.mts';

function main(): number {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const inside = runChild('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    console.log('hooks:install: not a git work tree; skipped.');
    return 0;
  }
  const hooksPath = runChild('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root });
  if (hooksPath.status === 0 && hooksPath.stdout.trim() === '.githooks') {
    const removed = runChild('git', ['config', '--local', '--fixed-value', '--unset', 'core.hooksPath', '.githooks'], { cwd: root });
    assert(removed.status === 0, `hooks:install: could not retire Stacki's local hook setting: ${removed.stderr}`);
  }
  const blame = runChild('git', ['config', '--local', 'blame.ignoreRevsFile', '.git-blame-ignore-revs'], { cwd: root });
  assert(blame.status === 0, `hooks:install: could not configure the blame ignore list: ${blame.stderr}`);
  return 0;
}

process.exitCode = main();
