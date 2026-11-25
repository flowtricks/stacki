import { execFile } from 'node:child_process';
import { assert } from '../../shared/core/assert';
import { DISCOVERY_LIMITS, type ConnectionFailure } from '../../shared/properties/publishDiscovery';
import { resolvePublishExecutable } from './publishExecutable';
import { publishEnvironment } from './publishCommands';

/** A failed read command, reduced to why it failed. The CLI's output stays in this process. */
export class DiscoveryCommandError extends Error {
  constructor(
    readonly reason: ConnectionFailure,
    executable: string,
  ) {
    super(`Could not read ${executable} accounts (${reason}).`);
  }
}

// Only this much of a failed command's error output is classified; the rest is discarded unread.
const FAILURE_CHARS_MAX = 8192;

/** Only fixed read commands reach this runner; credentials never reach renderer diagnostics. */
export async function discoveryCommand(root: string, executable: 'wrangler' | 'vercel' | 'gh', argumentsList: readonly string[]): Promise<unknown> {
  let resolved: { readonly executable: string; readonly arguments: readonly string[] };
  try {
    resolved =
      executable === 'gh'
        ? { executable: 'gh', arguments: argumentsList }
        : resolvePublishExecutable(root, { executable, arguments: argumentsList, environment: {} });
  } catch {
    // Windows resolves the CLI's entry before starting it, so a missing tool is found here.
    throw new DiscoveryCommandError('missing-cli', executable);
  }
  const args = [...resolved.arguments];
  if (executable === 'vercel' && process.env['VERCEL_TOKEN']) {
    args.push('--token', process.env['VERCEL_TOKEN']);
  }
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      resolved.executable,
      args,
      {
        cwd: root,
        env: { ...publishEnvironment(), CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
        shell: false,
        encoding: 'utf8',
        timeout: DISCOVERY_LIMITS.timeoutMs,
        maxBuffer: 1_048_576,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new DiscoveryCommandError(
              classifyCommandFailure(error, `${stderr.slice(0, FAILURE_CHARS_MAX)}\n${stdout.slice(0, FAILURE_CHARS_MAX)}`),
              executable,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end();
  });
  const value: unknown = JSON.parse(output);
  return value;
}

/**
 * Why a provider CLI failed, from its exit and what it printed. Vercel prints "No existing
 * credentials found" when signed out and "The specified token is not valid" for an expired or
 * revoked login; Wrangler and gh print "not authenticated" / "not logged in" phrases.
 */
export function classifyCommandFailure(error: { readonly code?: unknown; readonly killed?: boolean }, output: string): ConnectionFailure {
  assert(output.length <= 2 * FAILURE_CHARS_MAX + 1, 'Classified output stays bounded');
  if (error.code === 'ENOENT') {
    return 'missing-cli';
  }
  if (error.killed === true) {
    // The discovery timeout killed it: the provider did not answer in time.
    return 'network';
  }
  if (/token[^\n]{0,80}\b(?:not valid|invalid|expired|revoked)\b|\b(?:invalid|expired) token\b|NOT_AUTHORIZED|\((?:401|403)\)/i.test(output)) {
    return 'expired';
  }
  if (/no existing credentials|not (?:logged|signed) in|not authenticated|run [`'"]?(?:vercel|wrangler) login/i.test(output)) {
    return 'signed-out';
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|could not be resolved|internet connectivity|fetch failed/i.test(output)) {
    return 'network';
  }
  return 'unknown';
}
