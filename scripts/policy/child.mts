// Bounded child processes for the policy tooling. Every child has a time budget
// and an output cap (AGENTS.md §10); a child that cannot start reports that as
// a failed status with the reason, so callers handle one shape.

import { spawnSync } from 'node:child_process';
import { POLICY_LIMITS } from './limits.mts';
import { assert } from './assert.mts';

export interface ChildResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ChildOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs?: number;
}

// Status reported when the child never produced one (spawn failure, timeout,
// signal): distinct from any real exit code.
export const CHILD_STATUS_FAILED_TO_RUN = -1;

export function runChild(command: string, argumentsList: readonly string[], options: ChildOptions): ChildResult {
  const timeoutMs = options.timeoutMs ?? POLICY_LIMITS.childTimeoutMsMax;
  assert(timeoutMs > 0, 'runChild: timeout must be positive');
  assert(timeoutMs <= POLICY_LIMITS.childTimeoutMsMax, 'runChild: timeout exceeds limit');
  const result = spawnSync(command, [...argumentsList], {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: POLICY_LIMITS.childOutputBytesMax,
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    const stderr = `${command}: ${result.error.message}`;
    return { status: CHILD_STATUS_FAILED_TO_RUN, stdout: result.stdout ?? '', stderr };
  }
  if (result.status === null) {
    const stderr = `${command}: stopped by ${result.signal ?? 'an unknown signal'}`;
    return { status: CHILD_STATUS_FAILED_TO_RUN, stdout: result.stdout, stderr };
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
