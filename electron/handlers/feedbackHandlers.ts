// The Feedback panel's IPC: reading and writing `.stacki/feedback.json`, each
// item's `file:line` trail resolved fresh from disk on the way in and out, so
// the agent that reads the file lands on the lines as they are now.

import * as fs from 'fs';
import * as path from 'path';
import { assert } from '../../shared/core/assert';
import {
  FEEDBACK_FILE_VERSION,
  parseFeedbackFile,
  type FeedbackItem,
  type TrailedFeedbackItem,
} from '../../shared/ipc/feedback';
import { writeProjectText } from '../documents/documentWrites';
import { selectionTrail } from '../documents/pageRequests';
import { readJson } from '../lib/mainHelpers';
import { ensureExcluded } from '../preview/previewWorktree';
import type { MainHost } from './mainHost';

const FEEDBACK_FILE = path.join('.stacki', 'feedback.json');

export function registerFeedbackHandlers({
  ipcMain,
  assertInProject,
}: Pick<MainHost, 'assertInProject' | 'ipcMain'>): void {
  ipcMain.handle('feedback:read', (_event, { projectPath }) => {
    const file = assertInProject(path.join(projectPath, FEEDBACK_FILE));
    if (!fs.existsSync(file)) {
      return { items: [] };
    }
    // A malformed file throws: the renderer shows why rather than emptying it.
    return { items: withTrails(projectPath, parseFeedbackFile(readJson(file)).items) };
  });
  ipcMain.handle('feedback:write', (_event, { projectPath, items }) => {
    const file = assertInProject(path.join(projectPath, FEEDBACK_FILE));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ensureExcluded(projectPath);
    const trailed = withTrails(projectPath, items);
    const text = JSON.stringify({ version: FEEDBACK_FILE_VERSION, items: trailed }, undefined, 2);
    writeProjectText(file, text + '\n');
    return { items: trailed };
  });
}

// A key whose node is gone resolves to its file alone; one outside the
// project resolves to nothing, so its trail is empty.
export function withTrails(
  projectPath: string,
  items: readonly FeedbackItem[],
): readonly TrailedFeedbackItem[] {
  const trailed = items.map((item) => ({
    ...item,
    trail: selectionTrail({ projectPath, keys: [...item.keys] }) ?? [],
  }));
  assert(trailed.length === items.length, 'Every feedback item keeps its place');
  assert(
    trailed.every((item) => item.trail.length <= item.keys.length),
    'A trail has at most one entry per key',
  );
  return trailed;
}
