import { execFile } from 'node:child_process';
import { assert } from '../../shared/core/assert';
import type { Result } from '../../shared/core/result';
import { ensureToolPath } from '../lib/nodeTools';
import { commandNeedsShell } from '../lib/platform';

const COMMAND_TIMEOUT_MS_MAX = 180_000;
const COMMAND_OUTPUT_BYTES_MAX = 2 * 1024 * 1024;
interface StudioCommand {
  readonly command: string;
  readonly argumentsList: readonly string[];
  readonly directory: string;
  readonly project: string;
  readonly timeoutMs: number;
}

export function runStudioCommand(options: StudioCommand, onOutput: (output: string) => void): Promise<Result<void, string>> {
  assert(Number.isSafeInteger(options.timeoutMs), 'Studio command timeout is an integer');
  assert(options.timeoutMs > 0, 'Studio command timeout is positive');
  assert(options.timeoutMs <= COMMAND_TIMEOUT_MS_MAX, 'Studio command timeout stays bounded');
  ensureToolPath();
  return new Promise((resolve) => {
    const child = execFile(
      options.command,
      [...options.argumentsList],
      {
        cwd: options.directory,
        timeout: options.timeoutMs,
        maxBuffer: COMMAND_OUTPUT_BYTES_MAX,
        encoding: 'utf8',
        shell: commandNeedsShell(options.command),
        env: {
          ...process.env,
          STUDIO_PROJECT_ROOT: options.project,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          npm_config_progress: 'false',
        },
      },
      (error) => {
        resolve(error ? { ok: false, error: error.message } : { ok: true, value: undefined });
      },
    );
    const receive = (input: unknown) => {
      assert(typeof input === 'string', 'Studio command streams decode UTF-8');
      onOutput(input);
    };
    child.stdout?.setEncoding('utf8').on('data', receive);
    child.stderr?.setEncoding('utf8').on('data', receive);
  });
}
