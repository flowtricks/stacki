import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { ok, err, type Result } from '../../../vendor/stacki/shared/core/result';
import { stopPublishProcess } from '../../../vendor/stacki/electron/project/publishCommands';
import { STUDIO_PUBLISH_LIMITS as limits } from './publishLimits';
import { finishGitInput } from './publishGitInput';

import type { PublishGit } from '../../shared/publishSource';
export type { PublishGit } from '../../shared/publishSource';

/** No inherited Git config, filters, hooks, helpers or trace output can access publish credentials. */
export function publishGitEnvironment(context: PublishGit): NodeJS.ProcessEnv {
  assert(context.directory.length > 0, 'Git directory is required');
  assert(context.root.length > 0, 'Git worktree is required');
  return {
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    HOME: context.directory,
    TMPDIR: process.env['TMPDIR'],
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_DIR: context.directory,
    GIT_WORK_TREE: context.root,
    GIT_CONFIG_COUNT: context.authorization ? '6' : '5',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_KEY_2: 'pack.threads',
    GIT_CONFIG_VALUE_2: '1',
    GIT_CONFIG_KEY_3: 'pack.windowMemory',
    GIT_CONFIG_VALUE_3: '64m',
    GIT_CONFIG_KEY_4: 'pack.deltaCacheSize',
    GIT_CONFIG_VALUE_4: '16m',
    ...(context.authorization
      ? {
          GIT_CONFIG_KEY_5: 'http.https://github.com/.extraHeader',
          GIT_CONFIG_VALUE_5: 'Authorization: Basic ' + Buffer.from('x-access-token:' + context.authorization).toString('base64'),
        }
      : {}),
    GIT_AUTHOR_NAME: 'Stacki Studio',
    GIT_AUTHOR_EMAIL: 'studio@stacki.local',
    GIT_COMMITTER_NAME: 'Stacki Studio',
    GIT_COMMITTER_EMAIL: 'studio@stacki.local',
  };
}

export function publishGit(
  context: PublishGit,
  args: readonly string[],
  input = '',
  options: { readonly output?: 'trimmed' | 'verbatim' } = {},
): Promise<Result<string>> {
  assert(args.length > 0, 'Git command is required');
  assert(input.length <= 64 * 1024 ** 2, 'Git input is bounded');
  assert(args.length <= 100, 'Git arguments are bounded');
  const environment = publishGitEnvironment(context);
  if (args[0] === 'init') {
    delete environment['GIT_WORK_TREE'];
  }
  const child = spawn('git', [...args], {
    cwd: context.root,
    env: environment,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return collectPublishCommand(child, path.dirname(context.directory), args[0] ?? 'command', input, options.output ?? 'trimmed');
}

function collectPublishCommand(
  child: ChildProcessWithoutNullStreams,
  root: string,
  command: string,
  input: string,
  output: 'trimmed' | 'verbatim',
): Promise<Result<string>> {
  const monitor = monitorPublishCommand(child, root);
  return new Promise((resolve) => {
    let stdout = '';
    let bytes = 0;
    const collect = (chunk: Buffer, destination: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > limits.commandOutputBytesMax) {
        monitor.stop('Git exceeded the 1 MiB output limit.');
      } else if (destination === 'stdout') {
        stdout += chunk.toString('utf8');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.once('error', () => monitor.stop('Could not start Git. Install Git and retry.'));
    child.once('close', (code) => {
      monitor.dispose();
      const message = monitor.failure();
      resolve(
        code === 0 && !message
          ? ok(output === 'verbatim' ? stdout : stdout.trim())
          : err({
              code: 'git',
              message:
                command === 'push'
                  ? 'Git push was not confirmed. Check GitHub before retrying.'
                  : message || `Git ${command} failed. Check repository access and retry.`,
            }),
      );
    });
    finishGitInput(child.stdin, input, () => monitor.stop('Could not write to Git.'));
  });
}

function monitorPublishCommand(child: ChildProcessWithoutNullStreams, root: string) {
  let message = '';
  let checking = false;
  let finished = false;
  const stop = (failure: string) => {
    if (finished) {
      return;
    }
    if (!message) {
      message = failure;
    }
    stopPublishProcess(child.pid);
    child.kill('SIGKILL');
  };
  const timeout = setTimeout(() => stop('Git exceeded the ten-minute time limit.'), limits.commandTimeoutMs);
  // At most one disk request is outstanding, even if the filesystem is slow.
  const timer = setInterval(() => {
    if (checking) {
      return;
    }
    checking = true;
    void statfs(root)
      .then(
        (space) => {
          if (space.bavail * space.bsize < limits.diskReserveBytes) {
            stop('Not enough disk space. Use a larger Studio container and retry.');
          }
        },
        () => stop('Could not inspect available disk space.'),
      )
      .finally(() => {
        checking = false;
      });
  }, 1000);
  return {
    stop,
    failure: () => message,
    dispose: () => {
      finished = true;
      clearTimeout(timeout);
      clearInterval(timer);
    },
  };
}

export function publishObject(value: string): Result<string> {
  return /^[a-f0-9]{40}$/.test(value) ? ok(value) : err({ code: 'git-object', message: 'Git returned an invalid object identifier.' });
}
