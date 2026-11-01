// Pushes must run the same clean build and regression gate as CI. Compiling
// the runner first avoids relying on stale dist/ output after a checkout.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PUSH_TIMEOUT_MS = 30 * 60 * 1_000;
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

export function runPushChecks(root: string): number {
  // Desktop agent terminals can inherit this variable. Electron probes need
  // the real browser process, so the gate always clears it in its children.
  const environment = { ...process.env };
  delete environment['ELECTRON_RUN_AS_NODE'];
  for (const key of GIT_HOOK_VARIABLES) {
    delete environment[key];
  }
  const commands: readonly (readonly string[])[] = [
    [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', 'scripts/tsconfig.build.json'],
    [path.join(root, 'dist/scripts/gate/runTests.js')],
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
