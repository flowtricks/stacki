import {
  parseAccountRequest,
  GITHUB_DEVICE_URL,
  parseAccountState,
  parseCloudflareSignInURL,
  type AccountRequest,
  type AccountState,
} from '../../../vendor/stacki/shared/ipc/publishAccount';
import { request } from '../project/projectClient';

export async function publishingAccount(_project: string, input: AccountRequest): Promise<AccountState> {
  const body = JSON.stringify(parseAccountRequest(input));
  let result: unknown;
  try {
    result = await request('/studio/api/publish/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    return { kind: 'failed', message: 'Could not reach account sign-in. Please try again.' };
  }
  return parseAccountState(result);
}

export function openAccountSignIn(url: string = GITHUB_DEVICE_URL): Promise<void> {
  const target = url === GITHUB_DEVICE_URL ? url : parseCloudflareSignInURL(url);
  window.open(target, '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}
