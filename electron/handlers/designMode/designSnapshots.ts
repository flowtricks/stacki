// Design mode (experimental, removable: docs/design-mode/REMOVE.md): each frame's snapshot, kept beside its draft.
//
// A snapshot is the document a frame shows on the canvas (shared/ipc/designSnapshot.ts). The renderer holds the
// ones on screen; main keeps each as a file in the project's draft folder, readable by the person only, and holds
// none in memory. So every frame shows at once when the mode begins again, before the copy's dev server is up.
// Reads and writes are asynchronous: a document is large, and main must keep answering.
import fs from 'node:fs';
import path from 'node:path';
import type { DesignFrameId } from '../../../shared/ipc/designSession';
import { DESIGN_SNAPSHOT_LIMITS, parseDesignSnapshot, type DesignSnapshot } from '../../../shared/ipc/designSnapshot';
import { ensurePrivateDirectory } from './designSandbox';
import { draftFolder } from './designDrafts';

/** A snapshot file's bytes: its characters, escaped as JSON and written as UTF-8. */
const FILE_BYTES_MAX = DESIGN_SNAPSHOT_LIMITS.htmlCharsMax * 4;

export interface SnapshotPlace {
  readonly appDataRoot: string;
  readonly realRoot: string;
  readonly frame: DesignFrameId;
}

function snapshotFile(place: SnapshotPlace): string {
  return path.join(draftFolder(place.appDataRoot, place.realRoot), `${place.frame}.snapshot.json`);
}

export async function saveSnapshot(place: SnapshotPlace, snapshot: DesignSnapshot): Promise<void> {
  const file = snapshotFile(place);
  ensurePrivateDirectory(path.dirname(path.dirname(file)));
  ensurePrivateDirectory(path.dirname(file));
  await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.promises.rename(`${file}.tmp`, file);
}

/** The frame's kept snapshot, or undefined when there is none this version can read. */
export async function readSnapshot(place: SnapshotPlace): Promise<DesignSnapshot | undefined> {
  const file = snapshotFile(place);
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > FILE_BYTES_MAX) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return parseDesignSnapshot(parsed);
  } catch {
    // Missing, or not a snapshot: the frame is drawn again from the copy when it is next shown.
    return undefined;
  }
}

/** Gives frame `to` the snapshot frame `from` has, when it has one: a duplicate is drawn at once, here and next time. */
export async function copySnapshot(place: Omit<SnapshotPlace, 'frame'>, from: DesignFrameId, to: DesignFrameId): Promise<void> {
  const snapshot = await readSnapshot({ ...place, frame: from });
  if (snapshot !== undefined) {
    await saveSnapshot({ ...place, frame: to }, snapshot);
  }
}

export async function removeSnapshot(place: SnapshotPlace): Promise<void> {
  await fs.promises.rm(snapshotFile(place), { force: true });
}
