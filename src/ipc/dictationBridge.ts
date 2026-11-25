// The renderer's side of the dictation model channels (docs/contracts.md, "Dictation model"): each
// reply is parsed before a component reads it. The renderer names a model id and nothing else; the
// addresses, the hashes and the folder are fixed in the main process.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import {
  parseDictationStatus,
  parseDownloadOutcome,
  parseDownloadProgress,
  parseModelRemoved,
  type DictationStatus,
  type DownloadOutcome,
  type DownloadProgress,
} from '../../shared/properties/voice/dictationModel';
import type { WhisperModelId } from '../../shared/properties/voice/whisperModels';

/** Whether this window has the dictation channels (Desktop does; a test page or Studio does not). */
export function hasDictationChannels(): boolean {
  return typeof window !== 'undefined' && typeof window.avb === 'object' && typeof window.avb.dictationStatus === 'function';
}

export function readDictationStatus(): Promise<DictationStatus> {
  return window.avb.dictationStatus(parseIpcPayload('dictation:status', undefined)).then(parseDictationStatus);
}

/** Starts the download the person agreed to; resolves when it ends, whichever way. */
export function downloadDictationModel(modelId: WhisperModelId): Promise<DownloadOutcome> {
  return window.avb.dictationDownload(parseIpcPayload('dictation:download', { modelId })).then((reply) => parseDownloadOutcome(reply, modelId));
}

export function cancelDictationDownload(modelId: WhisperModelId): Promise<void> {
  return window.avb.dictationCancel(parseIpcPayload('dictation:cancel', { modelId })).then(() => undefined);
}

export function removeDictationModel(modelId: WhisperModelId): Promise<void> {
  return window.avb.dictationRemove(parseIpcPayload('dictation:remove', { modelId })).then((reply) => void parseModelRemoved(reply));
}

/** Progress events of the download in flight; the result unsubscribes. */
/** Shows the model's folder in the file manager (Finder, Explorer); nothing happens until the model has been downloaded. */
export function revealDictationModel(modelId: WhisperModelId): Promise<void> {
  return window.avb.dictationReveal(parseIpcPayload('dictation:reveal', { modelId })).then(() => undefined);
}

export function onDictationProgress(listener: (progress: DownloadProgress) => void): () => void {
  return window.avb.onDictationProgress((data) => listener(parseDownloadProgress(data)));
}
