// Windows readers can briefly deny an atomic replacement. Retry only a reply
// proving this request did not write; uncertain writes and conflicts stay manual.
import type { EditBatchRequest, EditRequest } from '../../shared/engine/editRequest';
import type { PageEdited, PageEditError } from '../../shared/ipc/pageSave';
import type { Result } from '../../shared/core/result';

const RETRY_DELAYS_MS = [100, 250, 500] as const;
type EditReply = Result<PageEdited, PageEditError>;

interface SaveRetryDependencies<Request> {
  readonly send: (request: Request) => Promise<EditReply>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

// A batch (page:editBatch) is retried the same way: refused before writing, it wrote nothing.
export async function sendPageEditWithRetry<Request extends EditRequest | EditBatchRequest>(
  request: Request,
  { send, wait = waitForSaveRetry }: SaveRetryDependencies<Request>,
): Promise<EditReply> {
  let reply = await send(request);
  // Four attempts at most, retaining the original checksum on every request.
  // The actor rechecks disk and witnesses each time; a later conflict stops here.
  for (const delay of RETRY_DELAYS_MS) {
    if (reply.ok) {
      return reply;
    }
    if (reply.error.code !== 'filesystem') {
      return reply;
    }
    if (!/\b(?:EPERM|EACCES|EBUSY)\b/.test(reply.error.message)) {
      return reply;
    }
    await wait(delay);
    reply = await send(request);
  }
  return reply;
}

function waitForSaveRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
