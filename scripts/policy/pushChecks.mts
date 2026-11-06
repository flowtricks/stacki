// Pushes must run the same clean build and regression gate as CI. Compiling
// the runner first avoids relying on stale dist/ output after a checkout. A
// release tag also runs the Linux preflight, so the check cannot be forgotten.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { POLICY_LIMITS } from './limits.mts';

const PUSH_TIMEOUT_MS = 30 * 60 * 1_000;
// One line of git's "<local ref> <local object> <remote ref> <remote object>".
// The match runs from the line's end because the local ref is the push's source
// text, which can hold spaces (HEAD^{/a fix}:refs/tags/v1). Deleting a ref
// reports an all-zero local object, and nothing is released by that.
const RELEASE_TAG_LINE = / (?!0+ )[0-9a-f]+ refs\/tags\/v\d\S* [0-9a-f]+$/m;
// Git's local environment variables (git rev-parse --local-env-vars) bind child
// commands to the repository being pushed. Tests must own their scratch repositories.
const GIT_HOOK_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
] as const;

/**
 * The ref lines git writes to the hook, or undefined past the size bound. The
 * caller refuses that case: a truncated list could hide a release tag.
 */
export function readPushedRefs(descriptor: number): string | undefined {
  // A person running the hook by hand has a terminal here, and reading it would
  // wait for an end-of-file that never comes.
  if (tty.isatty(descriptor)) {
    return '';
  }
  const buffer = Buffer.alloc(POLICY_LIMITS.hookPayloadBytesMax + 1);
  let sizeBytes = 0;
  // Each pass adds at least one byte or returns, so the buffer bounds the loop.
  while (sizeBytes < buffer.length) {
    const readBytes = fs.readSync(descriptor, buffer, { offset: sizeBytes, length: buffer.length - sizeBytes });
    if (readBytes === 0) {
      return buffer.toString('utf8', 0, sizeBytes);
    }
    sizeBytes += readBytes;
  }
  return undefined;
}

export function runPushChecks(root: string, pushedRefs: string): number {
  // Desktop agent terminals can inherit this variable. Electron probes need
  // the real browser process, so the gate always clears it in its children.
  const environment = { ...process.env };
  delete environment['ELECTRON_RUN_AS_NODE'];
  for (const key of GIT_HOOK_VARIABLES) {
    delete environment[key];
  }
  // The preflight runs last because its probes use the dist/ the gate rebuilt.
  const releaseTag = RELEASE_TAG_LINE.test(pushedRefs);
  const commands: readonly (readonly string[])[] = [
    [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', 'scripts/tsconfig.build.json'],
    [path.join(root, 'dist/scripts/gate/runTests.js')],
    ...(releaseTag ? [[path.join(root, 'dist/scripts/release/linuxPreflight.js')]] : []),
  ];
  console.log('pre-push: running the full CI gate locally; this can take several minutes.');
  for (const argumentsList of commands) {
    const result = spawnSync(process.execPath, argumentsList, {
      cwd: root,
      env: environment,
      stdio: 'inherit',
      shell: false,
      timeout: PUSH_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      console.error(`pre-push: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      console.error('pre-push: fix the failed local gate before pushing.');
      return 1;
    }
  }
  return 0;
}
