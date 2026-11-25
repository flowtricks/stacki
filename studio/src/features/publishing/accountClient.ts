import {
  parseAccountRequest,
  GITHUB_DEVICE_URL,
  parseAccountState,
  parseSignInURL,
  type AccountRequest,
  type AccountState,
} from '../../../vendor/stacki/shared/ipc/publishAccount';
import { described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
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
    return { kind: 'failed', ...described('publish.studio.accountUnreachable') };
  }
  return parseAccountState(result);
}

export function openAccountSignIn(url: string = GITHUB_DEVICE_URL): Promise<void> {
  const target = url === GITHUB_DEVICE_URL ? url : parseSignInURL(url);
  window.open(target, '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}
