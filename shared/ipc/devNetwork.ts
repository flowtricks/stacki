// The preview on the local network: the contract of `dev:network` (read) and `dev:setNetwork`
// (turn on or off), so a phone on the same Wi-Fi can open the page the canvas shows.
//
// The state lives in the main process, beside the dev server it describes (electron/handlers/devServers.ts),
// and only for this run of the app: it is off at every launch and when the project closes, and it is never
// written anywhere. The canvas keeps its loopback address either way; only the phone uses the network one.
//
// What crosses: the port the server answers on, the machine's IPv4 addresses on the network, best first, and
// who may open it. All are checked here, at the boundary, in both directions (main builds them, the renderer
// reads them).
//
// Who may open it: only the devices that scanned the code, which is how the app turns the preview on every time,
// or anyone on the network, chosen in the card's setting. For the first, main makes a random key when it is turned on and keeps it in memory only, never
// in settings or `.stacki`; the dev server gets it in its environment (PREVIEW_KEY_ENV). The code carries
// it as a query parameter; the dev server answers that request with a cookie and a redirect to the page
// without it, and from then on the cookie is the device's way in (electron/previewServer/loopbackGuard.ts).
// Every device that scans the code gets in; a new key, made each time the option is turned on, locks out
// the ones that scanned an older code.
import { record, pathText, text } from '../core/boundary';
import { assert } from '../core/assert';
import type { Brand } from '../core/brand';
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

/** Who may open the preview from the network: anyone on it, or only the devices that scanned the code. */
export const DEV_NETWORK_ACCESSES = ['open', 'key'] as const;
export type DevNetworkAccess = (typeof DEV_NETWORK_ACCESSES)[number];

/** The key a device scans: 32 random bytes in base64url, 43 characters. Built only by toPreviewKey. */
export type PreviewKey = Brand<string, 'PreviewKey'>;
const PREVIEW_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** The query parameter the code carries the key in, the cookie a device keeps it in, and the dev server's variable. */
export const PREVIEW_KEY_PARAM = 'stacki-key';
export const PREVIEW_KEY_COOKIE = 'stacki-preview-key';
export const PREVIEW_KEY_ENV = 'STACKI_PREVIEW_KEY';

export function toPreviewKey(value: string): PreviewKey {
  if (!PREVIEW_KEY_RE.test(value)) {
    throw new Error('PreviewKey: expected 43 base64url characters');
  }
  return value as PreviewKey;
}

/** Who may open it, as the state carries it: with the key, which the code must hold, when only scanned devices may. */
export type NetworkAccess = { readonly kind: 'open' } | { readonly kind: 'key'; readonly key: PreviewKey };

export const NETWORK_ACCESS_OPEN: NetworkAccess = { kind: 'open' };

/** Off: the server answers on 127.0.0.1 only. On: it answers on every interface, at `port`, to whom `access` lets in. */
export type DevNetworkState =
  { readonly kind: 'off' } | { readonly kind: 'on'; readonly port: number; readonly addresses: readonly LanAddress[]; readonly access: NetworkAccess };

/** Why turning it on or off did not happen. Each code is a toast in the renderer. */
export const DEV_NETWORK_FAILURES = ['no-address', 'no-server', 'external', 'busy', 'restart-failed'] as const;
export type DevNetworkFailure = (typeof DEV_NETWORK_FAILURES)[number];

export type DevNetworkReply = Result<DevNetworkState, DevNetworkFailure>;

/** Back to this computer only, or open on the network to whom `access` names. */
export type DevNetworkRequest =
  { readonly projectPath: string; readonly mode: 'local' } | { readonly projectPath: string; readonly mode: 'network'; readonly access: DevNetworkAccess };

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
  if (mode === 'local') {
    return { projectPath, mode };
  }
  if (mode !== 'network') {
    throw new Error('DevNetworkRequest.mode: expected local or network');
  }
  const access = DEV_NETWORK_ACCESSES.find((known) => known === fields['access']);
  if (access === undefined) {
    throw new Error('DevNetworkRequest.access: expected open or key');
  }
  return { projectPath, mode, access };
}

export function parseNetworkAccess(input: unknown): NetworkAccess {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'open') {
    return NETWORK_ACCESS_OPEN;
  }
  if (kind !== 'key') {
    throw new Error('NetworkAccess.kind: expected open or key');
  }
  return { kind, key: toPreviewKey(text(fields['key'])) };
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
  return { kind: 'on', port, addresses: parsed, access: parseNetworkAccess(fields['access']) };
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
 * The address a phone opens: the network address, the server's port and the page the canvas shows, with the
 * key when only scanned devices may open it. `route` is the canvas's own path (`/`, `/blog/post`), never a
 * full URL.
 */
export function networkPageURL(address: LanAddress, port: number, route: string, access: NetworkAccess): string {
  assert(isIPv4Address(address.address), 'networkPageURL: the address is IPv4');
  assert(route.startsWith('/'), 'networkPageURL: the route is a path');
  const url = new URL(route, `http://${address.address}:${port}`);
  assert(url.hostname === address.address, 'networkPageURL: the route keeps the host');
  if (access.kind === 'key') {
    url.searchParams.set(PREVIEW_KEY_PARAM, access.key);
  }
  return url.href;
}
