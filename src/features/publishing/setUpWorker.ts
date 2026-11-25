import { createContext } from 'react';
import { err, ok, type Result } from '../../../shared/core/result';
import { assert } from '../../../shared/core/assert';
import type { Described } from '../../../shared/properties/i18n/messageRef';
import { parsePublishConfig, parsePublishSource } from '../../../shared/properties/publishConfig';
import type { WorkerHosting, WorkerSetupRequest } from '../../../shared/properties/publishWorkerSetup';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { setUpPublishWorker } from '../../ipc/publishWorkerBridge';

export interface WorkerSetupDone {
  readonly hosting: WorkerHosting;
  /** The publish settings as saved now: an open settings form takes it as its new base, so its own Save does not conflict. */
  readonly settings: string;
}

/**
 * Add Worker and the Publish dialog's "Set up Cloudflare": set the site up (the host's setup ends with Publish's own
 * readiness check), then save the Worker as the hosting destination through the witnessed metadata transport. A refusal
 * the setup explains comes back as its sentence; a failed transport throws, as every metadata write does.
 */
export async function setUpWorker(projectPath: string, worker: WorkerSetupRequest): Promise<Result<WorkerSetupDone, Described>> {
  const result = await setUpPublishWorker(projectPath, worker);
  if (result.kind === 'failed') {
    return err(result.messageRef === undefined ? { message: result.message } : { message: result.message, messageRef: result.messageRef });
  }
  assert(result.hosting.project === worker.project, 'Setup selects the Worker it was asked for');
  const file = await readMetadata(projectPath, 'publish');
  const config = parsePublishSource(file.source);
  const next = parsePublishConfig({ ...config, hosting: result.hosting });
  const source = JSON.stringify(next, undefined, 2) + '\n';
  if (file.source === source) {
    return ok({ hosting: result.hosting, settings: source });
  }
  const written = await writeMetadata(projectPath, { kind: 'publish', source, ...(file.source === undefined ? {} : { base: file.source }) });
  assert(written.source !== undefined, 'Saved publish settings read back');
  return ok({ hosting: result.hosting, settings: written.source });
}

/** An open Publish settings form's rebase: Add Worker saves the settings itself, and the form must keep that save as its base. */
export const PublishSettingsRebaseContext = createContext<((settings: string) => void) | undefined>(undefined);
