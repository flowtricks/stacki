// The command line the project's dev server starts with, and the address the app reaches it at.
//
// `--host` decides who can reach it. 127.0.0.1 is this computer only, and the default: Astro's own
// default (localhost) can resolve to ::1 first and leave a 127.0.0.1 client waiting. With the preview
// open on the local network it is 0.0.0.0, every IPv4 interface, so a phone on the same Wi-Fi can open
// it. Either way the app's own address stays 127.0.0.1 (0.0.0.0 includes loopback), so the canvas,
// the thumbnails and every request main makes behave exactly as before.
//
// The flag on the command line overrides `server.host` in the project's own config, which is why a
// project that set `host: true` still could not be reached from a phone before this mode existed.
import { assert } from '../../shared/core/assert';
import type { DevNetworkMode } from '../../shared/ipc/devNetwork';

export const DEV_HOSTS = { local: '127.0.0.1', network: '0.0.0.0' } as const satisfies Record<DevNetworkMode, string>;

/** The host the app itself reaches the dev server at, in every mode. */
export const DEV_LOOPBACK_HOST = '127.0.0.1';

export interface DevServerArgsInput {
  readonly port: number;
  readonly mode: DevNetworkMode;
  /** The generated config, relative to the project (Astro rejects an absolute --config); undefined runs the project's own. */
  readonly configPath: string | undefined;
  /** Replace a daemon a lock file says is running. */
  readonly force: boolean;
}

/** `astro dev`'s arguments, after the CLI's own path. */
export function devServerArgs(input: DevServerArgsInput): readonly string[] {
  assert(Number.isSafeInteger(input.port), 'devServerArgs: the port is an integer');
  assert(input.port > 0, 'devServerArgs: the port is positive');
  assert(input.port <= 65_535, 'devServerArgs: the port is at most 65535');
  const args = ['dev', '--port', String(input.port), '--host', DEV_HOSTS[input.mode]];
  if (input.configPath !== undefined) {
    assert(!input.configPath.startsWith('/'), 'devServerArgs: --config is relative to the project');
    args.push('--config', input.configPath);
  }
  if (input.force) {
    args.push('--force');
  }
  assert(args.filter((arg) => arg === '--host').length === 1, 'devServerArgs: exactly one --host');
  return args;
}

/** The address the app reaches the dev server at: loopback whatever the mode. */
export function devServerURL(port: number): string {
  assert(Number.isSafeInteger(port), 'devServerURL: the port is an integer');
  const url = `http://${DEV_LOOPBACK_HOST}:${port}`;
  assert(new URL(url).hostname === DEV_LOOPBACK_HOST, 'devServerURL: the app uses loopback');
  return url;
}

/** The hosts Vite is told it may answer to in network mode: loopback names and the network addresses. */
export function networkAllowedHosts(addresses: readonly string[]): readonly string[] {
  const hosts = ['localhost', DEV_LOOPBACK_HOST, ...addresses];
  return [...new Set(hosts)];
}
