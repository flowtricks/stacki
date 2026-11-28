// Setting a site up for Cloudflare Workers: what Add Worker and the Publish dialog's fix send, and what comes back.
// Both callers run the same main-side setup, and that setup ends with the very readiness check Publish runs, so the
// two can never disagree about whether a site is ready. Desktop carries this over IPC, Studio over HTTP.
import { assert } from '../core/assert';
import { object, record, text } from '../core/boundary';
import { parseMessageRef, type MessageRef } from '../core/i18n/messageReference';
import type { Hosting } from './publishConfig';
import type { DesktopPublishState } from './publishState';

export type WorkerHosting = Extract<Hosting, { readonly provider: 'cloudflare-workers' }>;

export interface WorkerSetupRequest {
  readonly accountId: string;
  readonly project: string;
}

export type WorkerSetupResult =
  | { readonly kind: 'ready'; readonly hosting: WorkerHosting }
  | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef | undefined };

/** Cloudflare's rule for a Worker name: lowercase letters, digits and hyphens, at most 63, never starting with a hyphen. */
export const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,99}$/;

/** The one sentence a publish fails with when the site is not ready for Workers; the Publish dialog offers setup for it. */
export const WORKER_SETUP_NEEDED_KEY = 'publish.worker.setup.needed';

export function parseWorkerSetupRequest(input: unknown): WorkerSetupRequest {
  const value = object({ accountId: text, project: text })(input);
  if (!ACCOUNT_ID_PATTERN.test(value.accountId)) {
    throw new Error('Worker setup needs a Cloudflare account.');
  }
  if (!WORKER_NAME_PATTERN.test(value.project)) {
    throw new Error('Worker names use lowercase letters, numbers and hyphens.');
  }
  return { accountId: value.accountId, project: value.project };
}

export function parseWorkerSetupResult(input: unknown): WorkerSetupResult {
  const value = record(input);
  switch (value['kind']) {
    case 'ready': {
      const hosting = record(value['hosting']);
      if (hosting['provider'] !== 'cloudflare-workers') {
        throw new Error('Worker setup returned another hosting provider.');
      }
      return {
        kind: 'ready',
        hosting: { provider: 'cloudflare-workers', ...parseWorkerSetupRequest({ accountId: hosting['accountId'], project: hosting['project'] }) },
      };
    }
    case 'failed': {
      const message = text(value['message']);
      if (message.length === 0) {
        throw new Error('A failed Worker setup says why.');
      }
      const reference = value['messageRef'] === undefined ? undefined : parseMessageRef(value['messageRef']);
      // A reference that does not parse is dropped: the English sentence beside it is always shown instead.
      return reference?.ok === true ? { kind: 'failed', message, messageRef: reference.value } : { kind: 'failed', message };
    }
    default:
      throw new Error('Invalid Worker setup result.');
  }
}

/** Whether a failed publish is the one that Worker setup fixes. */
export function publishNeedsWorkerSetup(state: DesktopPublishState): boolean {
  if (state.kind === 'failed') {
    // Setup writes production's Worker settings, so it is never offered for what stopped a staging publish.
    return state.destination === undefined && state.messageRef?.key === WORKER_SETUP_NEEDED_KEY;
  }
  return false;
}

/** The saved hosting a Worker setup request names. */
export function workerHosting(request: WorkerSetupRequest): WorkerHosting {
  const hosting: WorkerHosting = { provider: 'cloudflare-workers', accountId: request.accountId, project: request.project };
  assert(WORKER_NAME_PATTERN.test(hosting.project), 'A Worker hosting has a valid name');
  assert(hosting.accountId.length > 0, 'A Worker hosting has an account');
  return hosting;
}
