// The files the custom audit editor counts matches in: every page and component the panel searches, and the project's own
// stylesheets, read once when the editor opens and kept while it is open, so each keystroke reruns only the bounded matcher
// (shared/page/auditCustom.ts scanCustomFiles), never the disk. Bounded in files and in characters: a project past either is
// counted in part, and the count says it stopped early.
import { assert } from '../../../shared/core/assert';
import { record, text } from '../../../shared/core/boundary';
import { toArray, toRecord } from '../../../shared/core/record';
import { CUSTOM_MATCH_LIMITS } from '../../../shared/page/auditCustom';
import { readText } from '../../ipc/bridge';
import { styleTransport } from '../../ipc/editorEnvironment';

export const LIVE_FILE_LIMITS = {
  filesMax: 600,
  charsMax: 8_000_000,
} as const satisfies Record<string, number>;

export interface LiveFile {
  /** Project-relative, `/`-separated. */
  readonly file: string;
  readonly source: string;
}

export interface LiveFiles {
  readonly files: readonly LiveFile[];
  /** Whether the bounds left files out. */
  readonly partial: boolean;
}

/** Reads the pages and components (`sources`, project-relative) and the stylesheets, within LIVE_FILE_LIMITS. */
export async function readLiveFiles(projectPath: string, sources: readonly string[]): Promise<LiveFiles> {
  assert(projectPath.length > 0, 'readLiveFiles: a project');
  const files: LiveFile[] = [];
  let chars = 0;
  let partial = false;
  const keep = (file: string, source: string | undefined): void => {
    if (source === undefined || source.length > CUSTOM_MATCH_LIMITS.textCharsMax) {
      return;
    }
    if (files.length >= LIVE_FILE_LIMITS.filesMax || chars + source.length > LIVE_FILE_LIMITS.charsMax) {
      partial = true;
      return;
    }
    chars += source.length;
    files.push({ file, source });
  };
  for (const file of sources) {
    keep(file, await readText(projectPath, file).catch(() => undefined));
  }
  const listed = toArray(record(await styleTransport.listStyleFiles(projectPath).catch(() => ({})))['files']) ?? [];
  for (const entry of listed) {
    const value = toRecord(entry);
    const rel = value?.['rel'];
    const path = value?.['path'];
    if (typeof rel === 'string' && typeof path === 'string' && !/(^|\/)(node_modules|dist|\.astro|\.stacki)\//.test(rel)) {
      const css = await styleTransport
        .readStyleFile(path)
        .then((answer) => text(record(answer)['css']))
        .catch(() => undefined);
      keep(rel.split('\\').join('/'), css);
    }
  }
  assert(files.length <= LIVE_FILE_LIMITS.filesMax, 'readLiveFiles: the files are bounded');
  return { files, partial };
}
