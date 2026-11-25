// What a failed request to a CMS server means, in words a person can act on.
// fetch reports every network failure as `TypeError: fetch failed` and puts the
// real reason in `error.cause.code`; "check your internet connection" is wrong
// for a CMS on localhost that is not running, or a certificate Node does not trust.
import { described, type Described } from '../../shared/properties/i18n/messageRef';

const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** The code Node's network stack gave, from the error or its cause. */
export function networkCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code: unknown = Reflect.get(error, 'code');
  if (typeof code === 'string') {
    return code;
  }
  const cause: unknown = Reflect.get(error, 'cause');
  if (typeof cause === 'object' && cause !== null) {
    const inner: unknown = Reflect.get(cause, 'code');
    return typeof inner === 'string' ? inner : undefined;
  }
  return undefined;
}

/**
 * A request that never got an answer, as a sentence and its reference (the renderer translates the reference).
 * `address` names the server when known; without one the failure can only say the CMS was not reached.
 */
export function cmsNetworkProblem(error: unknown, address: string | undefined): Described {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return described('settings.cms.payload.error.timeout');
  }
  const code = networkCode(error);
  if (address !== undefined && code !== undefined) {
    if (code === 'ECONNREFUSED') {
      return described('settings.cms.payload.error.refused', { address });
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return described('settings.cms.payload.error.unresolved', { address });
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return described('settings.cms.payload.error.cutOff', { address });
    }
    if (CERTIFICATE_CODES.has(code)) {
      return described('settings.cms.payload.error.certificate', { address, code });
    }
    if (code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
      return described('settings.cms.payload.error.wrongProtocol', { address });
    }
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return described('settings.cms.payload.error.network');
  }
  if (error instanceof Error && error.message.length > 0) {
    // The system's own words are not ours to translate.
    return { message: error.message };
  }
  return described('cmsBackend.network.failed');
}

/** The English sentence of `cmsNetworkProblem`: logs, tests and callers that predate references. */
export function cmsNetworkFailure(error: unknown, address: string | undefined): string {
  return cmsNetworkProblem(error, address).message;
}
