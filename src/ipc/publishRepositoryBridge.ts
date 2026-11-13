import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseRepositoryResult, type RepositoryRequest } from '../../shared/ipc/publishRepository';

export async function publishingRepositories(projectPath: string, request: RepositoryRequest) {
  const input = parseIpcPayload('publish:repository', { projectPath, request });
  if (typeof window.avb.publishingRepositories !== 'function') {
    // i18n-ignore: developer hint for a stale preload bridge during development.
    throw new Error('Use View → Reload All Code to enable repository connections.');
  }
  return parseRepositoryResult(await window.avb.publishingRepositories(input));
}
