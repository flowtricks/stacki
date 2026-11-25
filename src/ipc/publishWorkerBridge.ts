import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseWorkerSetupResult, type WorkerSetupRequest, type WorkerSetupResult } from '../../shared/properties/publishWorkerSetup';

// Desktop sets a site up for Cloudflare Workers in main; Studio replaces this module with its HTTP client.
export async function setUpPublishWorker(projectPath: string, worker: WorkerSetupRequest): Promise<WorkerSetupResult> {
  const input = parseIpcPayload('publish:workerSetup', { projectPath, worker });
  return parseWorkerSetupResult(await window.avb.setUpPublishWorker(input));
}
