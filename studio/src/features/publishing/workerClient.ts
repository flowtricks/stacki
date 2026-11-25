import {
  parseWorkerSetupRequest,
  parseWorkerSetupResult,
  type WorkerSetupRequest,
  type WorkerSetupResult,
} from '../../../vendor/stacki/shared/properties/publishWorkerSetup';
import { request } from '../project/projectClient';

// Studio's stand-in for Desktop's Worker setup bridge: the same request and result, over HTTP to the Studio server.
export async function setUpPublishWorker(_project: string, worker: WorkerSetupRequest): Promise<WorkerSetupResult> {
  return parseWorkerSetupResult(
    await request('/studio/api/publish/worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parseWorkerSetupRequest(worker)),
    }),
  );
}
