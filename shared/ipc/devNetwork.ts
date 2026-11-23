// The preview on the local network: the contract of `dev:network` (read) and `dev:setNetwork`
// (turn on or off), so a phone on the same Wi-Fi can open the page the canvas shows.
//
// The state lives in the main process, beside the dev server it describes (electron/handlers/devServers.ts),
// and only for this run of the app: it is off at every launch and when the project closes, and it is never
// written anywhere. The canvas keeps its loopback address either way; only the phone uses the network one.
//
// What crosses: the port the server answers on and the machine's IPv4 addresses on the network, best first.
// Both are checked here, at the boundary, in both directions (main builds them, the renderer reads them).
import { record, pathText, text } from '../core/boundary';
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';

export const DEV_NETWORK_LIMITS = {
  /** Addresses offered to the phone: the best one and a few others. */
  addressesMax: 8,
  /** An operating system's interface name, as `os.networkInterfaces()` keys it. */
  interfaceNameCharsMax: 64,
  /** The highest TCP port. */
  portMax: 65_535,
} as const satisfies Record<string, number>;

/** Whether the dev server listens on loopback only, or on every interface. */
export const DEV_NETWORK_MODES = ['local', 'network'] as const;
export type DevNetworkMode = (typeof DEV_NETWORK_MODES)[number];

/** One IPv4 address of this machine on a network, and the interface it belongs to. */
export interface LanAddress {
  readonly address: string;
  readonly interfaceName: string;
}

/** Off: the server answers on 127.0.0.1 only. On: it answers on every interface, at `port`. */
export type DevNetworkState = { readonly kind: 'off' } | { readonly kind: 'on'; readonly port: number; readonly addresses: readonly LanAddress[] };

/** Why turning it on or off did not happen. Each code is a toast in the renderer. */
export const DEV_NETWORK_FAILURES = ['no-address', 'no-server', 'external', 'busy', 'restart-failed'] as const;
export type DevNetworkFailure = (typeof DEV_NETWORK_FAILURES)[number];

export type DevNetworkReply = Result<DevNetworkState, DevNetworkFailure>;

export interface DevNetworkRequest {
  readonly projectPath: string;
  readonly mode: DevNetworkMode;
}

export const DEV_NETWORK_OFF: DevNetworkState = { kind: 'off' };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A dotted-quad IPv4 address with no leading zeros, the form `os.networkInterfaces()` reports. */
export function isIPv4Address(input: string): boolean {
  return input.length <= 15 && IPV4.test(input);
}

export function parseDevNetworkRequest(input: unknown): DevNetworkRequest {
  const fields = record(input);
  const projectPath = pathText(fields['projectPath']);
  const mode = fields['mode'];
  if (mode === 'local' || mode === 'network') {
    return { projectPath, mode };
  }
  throw new Error('DevNetworkRequest.mode: expected local or network');
}

export function parseLanAddress(input: unknown): LanAddress {
  const fields = record(input);
  const address = text(fields['address']);
  const interfaceName = text(fields['interfaceName']);
  if (!isIPv4Address(address)) {
    throw new Error('LanAddress.address: expected an IPv4 address');
  }
  if (interfaceName.length === 0) {
    throw new Error('LanAddress.interfaceName: expected a name');
  }
  if (interfaceName.length > DEV_NETWORK_LIMITS.interfaceNameCharsMax) {
    throw new Error('LanAddress.interfaceName: exceeds limit');
  }
  return { address, interfaceName };
}

export function parseDevNetworkState(input: unknown): DevNetworkState {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'off') {
    return DEV_NETWORK_OFF;
  }
  if (kind !== 'on') {
    throw new Error('DevNetworkState.kind: expected off or on');
  }
  const port = fields['port'];
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > DEV_NETWORK_LIMITS.portMax) {
    throw new Error('DevNetworkState.port: expected a TCP port');
  }
  const addresses = fields['addresses'];
  if (!Array.isArray(addresses)) {
    throw new Error('DevNetworkState.addresses: expected a list');
  }
  if (addresses.length > DEV_NETWORK_LIMITS.addressesMax) {
    throw new Error('DevNetworkState.addresses: exceeds limit');
  }
  const parsed = addresses.map(parseLanAddress);
  return { kind: 'on', port, addresses: parsed };
}

export function parseDevNetworkReply(input: unknown): DevNetworkReply {
  const fields = record(input);
  if (fields['ok'] === true) {
    return ok(parseDevNetworkState(fields['value']));
  }
  if (fields['ok'] !== false) {
    throw new Error('DevNetworkReply.ok: expected a boolean');
  }
  const code = fields['error'];
  const failure = DEV_NETWORK_FAILURES.find((known) => known === code);
  if (failure === undefined) {
    throw new Error('DevNetworkReply.error: unknown failure');
  }
  return err(failure);
}

/**
 * The address a phone opens: the network address, the server's port and the page the canvas shows.
 * `route` is the canvas's own path (`/`, `/blog/post`), never a full URL.
 */
export function networkPageURL(address: LanAddress, port: number, route: string): string {
  assert(isIPv4Address(address.address), 'networkPageURL: the address is IPv4');
  assert(route.startsWith('/'), 'networkPageURL: the route is a path');
  const url = new URL(route, `http://${address.address}:${port}`);
  assert(url.hostname === address.address, 'networkPageURL: the route keeps the host');
  return url.href;
}
