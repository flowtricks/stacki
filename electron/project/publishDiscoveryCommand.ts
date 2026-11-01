import { execFile } from 'node:child_process';
import { DISCOVERY_LIMITS } from '../../shared/properties/publishDiscovery';
import { resolvePublishExecutable } from './publishExecutable';
import { publishEnvironment } from './publishCommands';

/** Only fixed read commands reach this runner; credentials never reach renderer diagnostics. */
export async function discoveryCommand(root: string, executable: 'wrangler' | 'vercel' | 'gh', argumentsList: readonly string[]): Promise<unknown> {
  const resolved =
    executable === 'gh'
      ? { executable: 'gh', arguments: argumentsList }
      : resolvePublishExecutable(root, { executable, arguments: argumentsList, environment: {} });
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
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not read ${executable} accounts. Install the latest CLI and sign in.`));
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
