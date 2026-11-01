import { open } from 'node:fs/promises';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';

// Astro's logs command requires a running daemon. Read its bounded log tail
// directly after startup failure, when that command can no longer help.
export async function readDevServerLog(projectPath: string, startedAtMs: number): Promise<string | undefined> {
  assert(projectPath.length > 0, 'Dev server logs require a project path');
  assert(Number.isFinite(startedAtMs), 'Dev server logs require a start time');
  try {
    const file = await open(path.join(projectPath, '.astro', 'dev.log'), 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile()) {
        return undefined;
      }
      // Filesystems may round modification times to a whole second.
      if (stats.mtimeMs < startedAtMs - 1000) {
        return undefined;
      }
      const length = Math.min(stats.size, 16_384);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, stats.size - length);
      const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
      return text.length > 0 ? text : undefined;
    } finally {
      await file.close();
    }
  } catch {
    // Older Astro versions may not create a daemon log at all.
    return undefined;
  }
}
