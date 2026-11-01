import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseOkResult } from '../../shared/ipc/ipcContract';
import { GITHUB_DEVICE_URL } from '../../shared/ipc/publishAccount';
import { parseAccountState, parseCloudflareSignInURL, type AccountRequest, type AccountState } from '../../shared/ipc/publishAccount';

export async function publishingAccount(projectPath: string, request: AccountRequest): Promise<AccountState> {
  const input = parseIpcPayload('publish:account', { projectPath, request });
  let result: unknown;
  try {
    result = await window.avb.publishingAccount(input);
  } catch {
    return { kind: 'failed', message: 'Could not reach account sign-in. Please try again.' };
  }
  return parseAccountState(result);
}

export async function openAccountSignIn(url: string = GITHUB_DEVICE_URL): Promise<void> {
  const target = url === GITHUB_DEVICE_URL ? url : parseCloudflareSignInURL(url);
  const input = parseIpcPayload('shell:openExternal', target);
  parseOkResult(await window.avb.openExternal(input));
}
