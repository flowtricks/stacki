// Pushes must run the same clean build and regression gate as CI. Compiling
// the runner first avoids relying on stale dist/ output after a checkout. A
// release tag also runs the Linux preflight, so the check cannot be forgotten.
//
// The full gate is skipped only when it would repeat a verdict already reached
// for the same inputs (decidePushGate): every pushed commit's tree passed the
// full gate here (gateMarker.ts), or a tag names a commit origin/main already
// holds and check.yml passed on every platform. The static checks still run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { flowtricksEnvironment, systemCommandRunner } from '../release/releaseCommands.mts';
import { exactCheckProblem, readExactCheckRun } from '../release/releaseStatus.mts';
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

/**
 * What the hook may rely on instead of running the full gate for one pushed commit. Each answers
 * with the reason it holds, or undefined. Injected so tests decide without git, gh or a gate run.
 */
export interface PushEvidence {
  // The commit's tree passed the full gate on this machine with this gate (gateMarker.ts).
  readonly marker: (commit: string) => string | undefined;
  // A tag's commit is already on origin/main and check.yml is green on exactly that commit.
  readonly taggedOnGreenMain: (commit: string) => string | undefined;
}

export const NO_PUSH_EVIDENCE: PushEvidence = { marker: () => undefined, taggedOnGreenMain: () => undefined };

export interface PushedRef {
  readonly localObject: string;
  readonly remoteRef: string;
}

/** The pushed refs that carry an object (deletions carry none and need no check). */
export function parsePushedRefs(pushedRefs: string): readonly PushedRef[] {
  const refs: PushedRef[] = [];
  for (const line of pushedRefs.split('\n')) {
    // From the end: the local ref is free text and may hold spaces.
    const match = / ([0-9a-f]{40,64}) (\S+) [0-9a-f]{40,64}$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined || /^0+$/.test(match[1])) {
      continue;
    }
    refs.push({ localObject: match[1], remoteRef: match[2] });
  }
  return refs;
}

export type PushGateDecision = { readonly kind: 'full'; readonly reason: string } | { readonly kind: 'skip'; readonly reasons: readonly string[] };

/**
 * The full gate is skipped only when every pushed object is already proven: its tree has a valid
 * marker, or it is a tag on a commit that origin/main already holds and check.yml passed. One
 * unproven object, or nothing to judge (a hand-run hook), runs the full gate as before.
 */
export function decidePushGate(pushedRefs: string, evidence: PushEvidence): PushGateDecision {
  const refs = parsePushedRefs(pushedRefs);
  if (refs.length === 0) {
    return { kind: 'full', reason: 'no pushed object to match against a passed gate' };
  }
  const reasons: string[] = [];
  for (const ref of refs) {
    const marker = evidence.marker(ref.localObject);
    if (marker !== undefined) {
      reasons.push(`${ref.remoteRef}: ${marker}`);
      continue;
    }
    if (ref.remoteRef.startsWith('refs/tags/')) {
      const proven = evidence.taggedOnGreenMain(ref.localObject);
      if (proven !== undefined) {
        reasons.push(`${ref.remoteRef}: ${proven}`);
        continue;
      }
    }
    return { kind: 'full', reason: `${ref.remoteRef} (${ref.localObject.slice(0, 12)}) has no passed gate for its tree` };
  }
  return { kind: 'skip', reasons };
}

/** The evidence a real push reads: the marker through the compiled gate, the tag through git and gh. */
export function systemPushEvidence(root: string, environment: NodeJS.ProcessEnv): PushEvidence {
  const readOnly = systemCommandRunner(process.env);
  return {
    marker: (commit) => {
      const result = spawnSync(process.execPath, [path.join(root, 'dist/scripts/gate/gateMarker.js'), 'check', commit], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        shell: false,
        timeout: 120_000,
        windowsHide: true,
      });
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
    taggedOnGreenMain: (object) => {
      const commit = readOnly({ command: 'git', argumentsList: ['rev-parse', '--verify', `${object}^{commit}`] });
      const main = readOnly({ command: 'git', argumentsList: ['ls-remote', 'origin', 'refs/heads/main'] });
      if (!commit.ok || !main.ok) {
        return undefined;
      }
      const commitSha = commit.value.trim();
      const mainSha = main.value.split('\t')[0]?.trim() ?? '';
      const onMain = readOnly({ command: 'git', argumentsList: ['merge-base', '--is-ancestor', commitSha, mainSha] });
      if (!onMain.ok) {
        return undefined;
      }
      const runner = systemCommandRunner(flowtricksEnvironment(process.env, readOnly));
      const evidence = readExactCheckRun(commitSha, runner);
      if (!evidence.ok || exactCheckProblem(evidence.value) !== undefined || evidence.value === undefined) {
        return undefined;
      }
      return `the tagged commit is on origin/main and check.yml passed it: ${evidence.value.run.url}`;
    },
  };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  // Desktop agent terminals can inherit this variable. Electron probes need
  // the real browser process, so the gate always clears it in its children.
  const environment = { ...process.env };
  delete environment['ELECTRON_RUN_AS_NODE'];
  for (const key of GIT_HOOK_VARIABLES) {
    delete environment[key];
  }
  return environment;
}

function runCommands(root: string, environment: NodeJS.ProcessEnv, commands: readonly (readonly string[])[]): number {
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

export function runPushChecks(root: string, pushedRefs: string, evidence?: PushEvidence): number {
  const environment = cleanEnvironment();
  const releaseTag = RELEASE_TAG_LINE.test(pushedRefs);
  // The runner is compiled first in every case: the marker check runs the compiled gate code.
  const compile = [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', 'scripts/tsconfig.build.json'];
  if (runCommands(root, environment, [compile]) !== 0) {
    return 1;
  }
  const decision = decidePushGate(pushedRefs, evidence ?? systemPushEvidence(root, environment));
  if (decision.kind === 'skip') {
    for (const reason of decision.reasons) {
      console.log(`pre-push: ${reason}`);
    }
    console.log('pre-push: skipping the full gate for an already-proven tree; the static checks still run.');
    // The static checks are cheap and cover what a marker cannot: the tools on this machine now.
    // A release tag's Linux preflight runs its static half, since its probes need a fresh build.
    return runCommands(root, environment, [
      [path.join(root, 'scripts/policy/checkLocal.mts')],
      ...(releaseTag ? [[path.join(root, 'dist/scripts/release/linuxPreflight.js'), '--static']] : []),
    ]);
  }
  // The preflight runs last because its probes use the dist/ the gate rebuilt.
  console.log(`pre-push: running the full CI gate locally (${decision.reason}); this can take several minutes.`);
  return runCommands(root, environment, [
    [path.join(root, 'dist/scripts/gate/runTests.js')],
    ...(releaseTag ? [[path.join(root, 'dist/scripts/release/linuxPreflight.js')]] : []),
  ]);
}
