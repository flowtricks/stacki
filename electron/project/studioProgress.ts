import { stripVTControlCharacters } from 'node:util';
import {
  parseStudioInstallProgress,
  STUDIO_LOG_CHARS_MAX,
  type StudioInstallProgress,
  type StudioInstallStage,
  type StudioInstallUpdate,
} from '../../shared/ipc/studioProgress';

// One pending snapshot bounds IPC traffic and memory independently of npm output volume.
const PROGRESS_INTERVAL_MS = 150;

export function createStudioProgress(identity: Pick<StudioInstallProgress, 'projectPath' | 'requestId'>, send: (progress: StudioInstallProgress) => void) {
  let stage: StudioInstallStage = 'release';
  let output = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    send(parseStudioInstallProgress({ ...identity, stage, output }));
  };
  return {
    update(update: StudioInstallUpdate): void {
      if (closed) {
        return;
      }
      if (update.kind === 'stage') {
        stage = update.stage;
        flush();
      } else {
        // Treat output as text, never executable terminal control sequences or HTML.
        output = (output + stripVTControlCharacters(update.text)).slice(-STUDIO_LOG_CHARS_MAX);
        if (timer === undefined) {
          timer = setTimeout(flush, PROGRESS_INTERVAL_MS);
        }
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      flush();
    },
  };
}
