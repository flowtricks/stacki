import { parseRepositoryRequest, parseRepositoryResult, type RepositoryRequest } from '../../../vendor/stacki/shared/ipc/publishRepository';
import { request } from '../project/projectClient';

export async function publishingRepositories(_project: string, input: RepositoryRequest) {
  return parseRepositoryResult(
    await request('/studio/api/publish/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parseRepositoryRequest(input)),
    }),
  );
}
