// The dictation model's channels (docs/contracts.md, "Dictation model"): its status, a download
// with consent (the renderer asks only after the person pressed Download in the setup dialog),
// cancelling it, and removing the model. One download runs at a time; its progress reaches the
// window as `dictation:progress`, at most `progressEventsPerSecondMax` times a second.
import { rm } from 'node:fs/promises';
import { assert } from '../../shared/core/assert';
import { DICTATION_LIMITS } from '../../shared/properties/voice/dictationLimits';
import type { DictationStatus, DownloadOutcome, DownloadProgress } from '../../shared/properties/voice/dictationModel';
import {
  isModelHost,
  modelFileURL,
  modelTotalBytes,
  WHISPER_MODEL_IDS,
  WHISPER_MODELS,
  type WhisperModelId,
} from '../../shared/properties/voice/whisperModels';
import { downloadModel, type DownloadDeps } from '../app/dictationDownload';
import { modelDirectory, readInstall, removeModel, removeStrayFiles, staleRevisions } from '../app/dictationStore';
import type { MainHost } from './mainHost';

export interface DictationOptions {
  /** `<userData>/models/whisper`. */
  readonly root: () => string;
  readonly fetch: DownloadDeps['fetch'];
}

interface ActiveDownload {
  readonly id: WhisperModelId;
  readonly abort: AbortController;
  receivedBytes: number;
  readonly totalBytes: number;
}

export function registerDictationHandlers({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>, options: DictationOptions): void {
  // The one download in flight; its byte count is kept here so a status read during it is current.
  let active: ActiveDownload | undefined;

  const status = async (): Promise<DictationStatus> => {
    const root = options.root();
    const models = await Promise.all(
      WHISPER_MODEL_IDS.map(async (id) => {
        const model = WHISPER_MODELS[id];
        if (active?.id === id) {
          return { id, install: { kind: 'downloading' as const, receivedBytes: active.receivedBytes, totalBytes: active.totalBytes } };
        }
        return { id, install: await readInstall(root, model) };
      }),
    );
    assert(models.length === WHISPER_MODEL_IDS.length, 'dictation:status: one entry per model');
    return { models, directory: root };
  };

  ipcMain.handle('dictation:status', () => status());

  ipcMain.handle('dictation:download', async (_event, { modelId }): Promise<DownloadOutcome> => {
    if (active !== undefined) {
      return { kind: 'failed', failure: 'busy' };
    }
    const model = WHISPER_MODELS[modelId];
    const root = options.root();
    const current: ActiveDownload = { id: modelId, abort: new AbortController(), receivedBytes: 0, totalBytes: modelTotalBytes(model) };
    active = current;
    let lastSentMs = 0;
    const progressIntervalMs = Math.ceil(1000 / DICTATION_LIMITS.progressEventsPerSecondMax);
    try {
      const outcome = await downloadModel(model, modelDirectory(root, model), current.abort.signal, {
        fetch: options.fetch,
        isAllowedURL: isModelHost,
        urlOf: (file) => modelFileURL(model, file),
        setTimer: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
        onProgress: (receivedBytes, total) => {
          current.receivedBytes = receivedBytes;
          const nowMs = Date.now();
          // The first and the last byte always reach the window; in between, a bounded rate.
          if (nowMs - lastSentMs >= progressIntervalMs || receivedBytes === total) {
            lastSentMs = nowMs;
            const progress: DownloadProgress = { id: modelId, receivedBytes, totalBytes: total };
            send('dictation:progress', progress);
          }
        },
      });
      if (outcome.kind === 'installed') {
        // An older revision left by an earlier Stacki is dead weight once the pinned one is in.
        for (const stale of await staleRevisions(root, model)) {
          await removeStale(stale);
        }
        // A file the manifest stopped naming (an older encoder) is dead weight too.
        await removeStrayFiles(root, model);
      }
      return outcome;
    } finally {
      active = undefined;
    }
  });

  ipcMain.handle('dictation:cancel', (_event, { modelId }) => {
    if (active?.id === modelId) {
      active.abort.abort();
    }
    return { ok: true as const };
  });

  ipcMain.handle('dictation:remove', async (_event, { modelId }) => {
    // A removal during its own download cancels it first; the parts go with the folder.
    if (active?.id === modelId) {
      active.abort.abort();
    }
    await removeModel(options.root(), modelId);
    return { kind: 'removed' as const };
  });
}

async function removeStale(directory: string): Promise<void> {
  assert(/[\\/][0-9a-f]{40}$/u.test(directory), 'removeStale: only a revision folder');
  await rm(directory, { recursive: true, force: true });
}
