// The one request a deploy link publish sends. It is a POST with no body: that is what Netlify build hooks,
// Cloudflare deploy hooks, Vercel deploy hooks and Render deploy hooks accept.
//
// It is sent once. Nothing here retries, because a retry after a lost answer could deploy twice. A redirect is
// followed only when it is a 307 or 308 (the server says it did not act, and the method is kept) to the same
// https origin, so the link's secret never reaches another host. Only the status is read; the body is dropped.
//
// The link is a secret, so no failure carries the transport's own error, which can quote the address.
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { parseDeployLink } from '../../shared/properties/publishDeployLink';

export const DEPLOY_REQUEST_LIMITS = {
  timeoutMs: 30_000,
  redirectsMax: 3,
} as const satisfies Record<string, number>;

/** All a deploy request reads of an answer. */
export interface DeployResponse {
  readonly status: number;
  readonly location: string | undefined;
}

/** `fetch`, narrowed to what is used, so a test can stand in for the network without weakening the https rule. */
export type DeployTransport = (
  address: string,
  options: {
    readonly method: 'POST';
    readonly redirect: 'manual';
    readonly credentials: 'omit';
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
  },
) => Promise<DeployResponse>;

export const DEPLOY_TRANSPORT: DeployTransport = (address, options) => fetch(address, options).then(deployResponse);

/** Keeps the status and a redirect's address, and drops the body unread, however large the host makes it. */
export async function deployResponse(response: Response): Promise<DeployResponse> {
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, location: response.headers.get('location') ?? undefined };
}

export async function sendDeployRequest(
  link: string,
  transport: DeployTransport = DEPLOY_TRANSPORT,
  timeoutMs: number = DEPLOY_REQUEST_LIMITS.timeoutMs,
): Promise<Result<undefined, Described>> {
  const checked = parseDeployLink(link);
  assert(checked.ok, 'Only a checked deploy link is sent');
  assert(timeoutMs > 0, 'A deploy request has a deadline');
  assert(timeoutMs <= DEPLOY_REQUEST_LIMITS.timeoutMs, 'A deploy request is time limited');
  // One deadline covers every hop.
  const signal = AbortSignal.timeout(timeoutMs);
  const origin = new URL(checked.value).origin;
  let address = checked.value;
  for (let hop = 0; hop <= DEPLOY_REQUEST_LIMITS.redirectsMax; hop++) {
    const answered = await sendOnce(address, transport, signal);
    if (!answered.ok) {
      return answered;
    }
    const { status, location } = answered.value;
    if (status >= 200 && status < 300) {
      return ok(undefined);
    }
    if (status < 300 || status >= 400) {
      return err(described('publish.custom.request.refused', { status: String(status) }));
    }
    const next = status === 307 || status === 308 ? redirectTarget(location, address, origin) : undefined;
    if (next === undefined) {
      return err(described('publish.custom.request.redirected'));
    }
    address = next;
  }
  return err(described('publish.custom.request.redirected'));
}

async function sendOnce(
  address: string,
  transport: DeployTransport,
  signal: AbortSignal,
): Promise<Result<{ readonly status: number; readonly location: string | undefined }, Described>> {
  try {
    const response = await transport(address, {
      method: 'POST',
      redirect: 'manual',
      credentials: 'omit',
      headers: { 'user-agent': 'Stacki' },
      signal,
    });
    return ok(response);
  } catch {
    return err(described(signal.aborted ? 'publish.custom.request.timedOut' : 'publish.custom.request.unreachable'));
  }
}

function redirectTarget(location: string | undefined, from: string, origin: string): string | undefined {
  if (location === undefined || location.length > 2_048) {
    return undefined;
  }
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return undefined;
  }
  const checked = parseDeployLink(next.href);
  if (!checked.ok || next.origin !== origin) {
    return undefined;
  }
  return checked.value;
}
