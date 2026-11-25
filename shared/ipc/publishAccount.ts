import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parseOptionalMessageRef, type MessageRef } from '../core/i18n/messageReference';

export const ACCOUNT_PROVIDERS = ['github', 'cloudflare', 'vercel'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
export interface AccountRequest {
  readonly provider?: AccountProvider;
  readonly action: 'start' | 'status' | 'cancel';
  readonly id: string;
}
export type AccountState =
  | { readonly kind: 'installing' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting'; readonly code: string }
  | { readonly kind: 'browser'; readonly url: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string; readonly messageRef?: MessageRef | undefined };

export const ACCOUNT_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const ACCOUNT_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const GITHUB_DEVICE_URL = 'https://github.com/login/device';

export function parseAccountRequest(input: unknown): AccountRequest {
  const value = record(input);
  const provider = value['provider'] === undefined ? undefined : ACCOUNT_PROVIDERS.find((entry) => entry === value['provider']);
  if (value['provider'] !== undefined && provider === undefined) {
    throw new Error('Unknown sign-in provider.');
  }
  const action = value['action'];
  if (action !== 'start' && action !== 'status' && action !== 'cancel') {
    throw new Error('Unknown GitHub sign-in action.');
  }
  const id = text(value['id']);
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id), 'Invalid GitHub sign-in session.');
  return { action, id, ...(provider === undefined ? {} : { provider }) };
}

export function parseAccountState(input: unknown): AccountState {
  const value = record(input);
  switch (value['kind']) {
    case 'installing':
    case 'starting':
    case 'complete':
    case 'cancelled':
      return { kind: value['kind'] };
    case 'waiting': {
      const code = text(value['code']);
      assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), 'Invalid GitHub sign-in code.');
      return { kind: 'waiting', code };
    }
    case 'browser':
      return { kind: 'browser', url: parseSignInURL(value['url']) };
    case 'failed': {
      const message = text(value['message']);
      if (message.length === 0 || message.length > 1000) {
        throw new Error('Invalid GitHub sign-in message.');
      }
      const messageRef = parseOptionalMessageRef(value['messageRef']);
      return messageRef === undefined ? { kind: 'failed', message } : { kind: 'failed', message, messageRef };
    }
    default:
      throw new Error('Invalid GitHub sign-in state.');
  }
}

// Whether a sign-in process is still running: the renderer keeps polling it, and the
// service refuses a second sign-in until it ends. Adding a state must decide this here.
export function accountSignInPending(state: AccountState): boolean {
  switch (state.kind) {
    case 'installing':
    case 'starting':
    case 'waiting':
    case 'browser':
      return true;
    case 'complete':
    case 'cancelled':
    case 'failed':
      return false;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * A sign-in page a provider CLI printed: Cloudflare's OAuth authorization page, or Vercel's
 * device-authorization page (`vercel login` prints `https://vercel.com/oauth/device?user_code=…`).
 * Any other address is refused, so a CLI's output can never open an arbitrary page.
 */
export function parseSignInURL(input: unknown): string {
  const value = text(input);
  assert(value.length <= 4096, 'A sign-in URL stays bounded');
  const url = new URL(value);
  assert(url.username === '', 'A sign-in URL has no username');
  assert(url.password === '', 'A sign-in URL has no password');
  assert(url.hash === '', 'A sign-in URL has no fragment');
  if (url.origin === 'https://vercel.com') {
    assert(url.pathname === '/oauth/device', 'Vercel sign-in uses the device authorization page');
    return value;
  }
  assert(url.origin === 'https://dash.cloudflare.com', 'Cloudflare sign-in uses its dashboard');
  assert(url.pathname === '/oauth2/auth', 'Cloudflare sign-in uses the OAuth authorization page');
  return value;
}
