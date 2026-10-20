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
import { readSource } from '../lib/mainLimits';
import { ensureExcluded } from '../preview/previewWorktree';
import type { MainHost } from './mainHost';

const FEEDBACK_FILE = path.join('.stacki', 'feedback.json');

// What a project's agent instructions say, so an agent started there without
// the handoff paste still finds the notes. The file name is also the mark that
// the note is already in.
const AGENT_NOTE_MARK = '.stacki/feedback.json';
const AGENT_NOTE = [
  '## Stacki feedback',
  '',
  'Visual feedback left in the Stacki editor is in `.stacki/feedback.json`. Open items',
  'have `"done": false`. Each item\'s `trail` lists `file:line` pointers relative to this',
  'folder: the last entry is the element, the earlier ones the page and the component',
  'instances around it. When an item is addressed, set its `"done"` to `true` and leave',
  'everything else in the file as it is.',
  '',
].join('\n');

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
    ensureAgentNote(projectPath, assertInProject);
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

// CLAUDE.md is what Claude Code reads, so it gets the note, created when
// missing; AGENTS.md gets it only when the project keeps one. A CLAUDE.md that
// imports AGENTS.md already has it from there.
function ensureAgentNote(projectPath: string, inProject: (file: string) => string): void {
  const agents = inProject(path.join(projectPath, 'AGENTS.md'));
  const claude = inProject(path.join(projectPath, 'CLAUDE.md'));
  const hasAgents = fs.existsSync(agents);
  if (hasAgents) {
    appendAgentNote(agents);
  }
  const claudeText = fs.existsSync(claude) ? readSource(claude) : '';
  if (hasAgents) {
    if (claudeText.includes('@AGENTS.md')) {
      return;
    }
  }
  appendAgentNote(claude);
}

function appendAgentNote(file: string): void {
  const text = fs.existsSync(file) ? readSource(file) : '';
  if (text.includes(AGENT_NOTE_MARK)) {
    return;
  }
  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeProjectText(file, text + separator + AGENT_NOTE);
  assert(readSource(file).includes(AGENT_NOTE_MARK), 'The agent note is in the file');
}
