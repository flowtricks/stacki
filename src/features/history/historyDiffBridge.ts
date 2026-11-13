import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseCommitDiffResult } from '../../../shared/ipc/gitCommitDiff';
import type { CommitDiffRequest, CommitDiffResult } from '../../../shared/ipc/gitCommitDiff';
import { failureOf } from '../../lib/cleanError';
import { historyTransport } from '../../ipc/editorEnvironment';

export async function readHistoryDiff(request: CommitDiffRequest): Promise<CommitDiffResult> {
  const payload = parseIpcPayload('git:commitDiff', request);
  let response: unknown;
  try {
    response = await historyTransport.diff(payload);
  } catch (error: unknown) {
    return failureOf(error);
  }
  return parseCommitDiffResult(response);
}
