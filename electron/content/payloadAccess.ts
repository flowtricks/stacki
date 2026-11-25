// How a saved Payload connection becomes a request target, and how a failure becomes the words the
// person reads. The IPC handlers (cmsConnectionHandlers.ts) call these; keeping them here keeps the
// handlers about channels and this about Payload.

import { assert } from '../../shared/core/assert';
import type { CmsCheckResult, CmsConnection, CmsConnectionDraft } from '../../shared/properties/cmsConnections';
import type { MessageRef } from '../../shared/core/i18n/messageReference';
import { PayloadError, type PayloadTarget } from './payloadClient';
import { checkPayloadAccount } from './payloadService';

type PayloadConnection = Extract<CmsConnection, { readonly kind: 'payload' }>;
type PayloadDraft = Extract<CmsConnectionDraft, { readonly kind: 'payload' }>;

/** The address, account and secret of a connection: a key sent as the API-key header, or a password logged in with. */
export function payloadTargetOf(connection: Pick<PayloadConnection, 'baseUrl' | 'collection' | 'auth' | 'email'>, secret: string): PayloadTarget {
  assert(secret.length > 0, 'A Payload connection has a secret');
  if (connection.auth === 'password') {
    assert(connection.email !== undefined, 'A login connection names its email');
    return { baseUrl: connection.baseUrl, collection: connection.collection, auth: { kind: 'password', email: connection.email, password: secret } };
  }
  return { baseUrl: connection.baseUrl, collection: connection.collection, auth: { kind: 'apiKey', key: secret } };
}

/** Tries a connection against its server: the account, and what it can reach. Used by Test connection, Detect and Save. */
export async function checkPayload(connection: PayloadConnection | PayloadDraft, secret: string): Promise<CmsCheckResult> {
  try {
    return { ok: true, summary: await checkPayloadAccount(payloadTargetOf(connection, secret), connection.collections) };
  } catch (error: unknown) {
    return payloadFailure(error);
  }
}

/** A failure as `{ ok: false, message, messageRef }`; a programmer error is not caught here. */
export function payloadFailure(error: unknown): { readonly ok: false; readonly message: string; readonly messageRef: MessageRef } {
  if (error instanceof PayloadError) {
    return { ok: false, message: error.message.slice(0, 900), messageRef: error.messageRef };
  }
  throw error;
}
