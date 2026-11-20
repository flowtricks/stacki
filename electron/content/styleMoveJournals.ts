// Main's keeper of "Move styles" journals (shared/properties/styleMoveJournal.ts): one per project, in the app's
// data folder, so a move stopped by a crash or a power cut is found when the project opens again, and finished or
// undone exactly. Never in the project: it is the app's memory of an operation, not the site's content.
//
// Written durably: the bytes go to a temporary file that is flushed (`fsync`), renamed over the journal, and the
// folder is flushed so the rename survives a power loss. A reader sees the previous journal or the new one.
//
// Resolving reads every file against the journal first and refuses unless each holds its "before" or its "after"
// text: a file someone edited is never overwritten. Then it writes in the order styleMoveOrder gives, each write
// refused by the file's actor unless the file still holds what was just read, and deletes the journal last. A stop
// in the middle leaves a journal that still tells the truth, and resolving again finishes the rest.

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  STYLE_MOVE_LIMITS,
  parseStyleMoveJournal,
  styleMoveCanFinish,
  styleMoveOrder,
  styleMoveState,
  type PendingStyleMove,
  type StyleMoveFile,
  type StyleMoveJournal,
  type StyleMoveResolution,
  type StyleMoveTarget,
} from '../../shared/properties/styleMoveJournal';
import { digestOf } from '../documents/atomicWrite';
import { createProjectText, writeProjectText } from '../documents/documentWrites';
import { discardComponentFile } from '../documents/componentFile';

// The app's logs folder, shared with whatever else Stacki records about its own work; each file's name says what it is.
const LOGS_FOLDER = 'logs';
const JOURNAL_SUFFIX = 'style-move.json';
// Characters of the project's name kept in a file name: enough to recognise it, short of any path limit.
const NAME_CHARS_MAX = 48;

export class StyleMoveJournals {
  constructor(
    private readonly dataPath: () => string,
    private readonly componentFolders: (projectRoot: string) => readonly string[],
  ) {}

  /** Writes `journal` for the project, replacing the one there, durably. */
  record(projectRoot: string, journal: StyleMoveJournal): void {
    assert(
      journal.files.every((file) => isInside(projectRoot, file.path)),
      'StyleMoveJournals.record: every file is inside the project',
    );
    const body = JSON.stringify(journal);
    assert(body.length <= STYLE_MOVE_LIMITS.journalCharsMax * 2, 'StyleMoveJournals.record: the journal is within its bound');
    const file = this.file(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    durableWrite(file, body);
  }

  /** The project's journal, or undefined when there is none. A journal that does not parse is reported, never trusted. */
  read(projectRoot: string): StyleMoveJournal | undefined {
    let body: string;
    try {
      body = fs.readFileSync(this.file(projectRoot), 'utf8');
    } catch {
      return undefined;
    }
    const input: unknown = JSON.parse(body);
    const journal = parseStyleMoveJournal(input);
    assert(
      journal.files.every((file) => isInside(projectRoot, file.path)),
      'StyleMoveJournals.read: every file is inside the project',
    );
    return journal;
  }

  /** Removes the project's journal when it is the one named `id`; a newer one is left. */
  clear(projectRoot: string, id: string): void {
    const journal = this.read(projectRoot);
    if (journal?.id === id) {
      fs.rmSync(this.file(projectRoot), { force: true });
      flushFolder(path.dirname(this.file(projectRoot)));
    }
  }

  /** The project's journal and where it stands on disk now, or undefined when there is none. */
  pending(projectRoot: string): PendingStyleMove | undefined {
    const journal = this.read(projectRoot);
    if (journal === undefined) {
      return undefined;
    }
    const disks = journal.files.map((file) => readOrAbsent(file.path));
    return { journal, state: styleMoveState(journal, disks), canFinish: styleMoveCanFinish(journal, disks) };
  }

  /**
   * Brings the journalled move to `target`: finished, or exactly as before it. Refused, writing nothing, when a file
   * changed since; otherwise every file not yet at the target is written, in the safe order, and the journal goes.
   */
  resolve(projectRoot: string, id: string, target: StyleMoveTarget): StyleMoveResolution {
    const pending = this.pending(projectRoot);
    assert(pending !== undefined, 'StyleMoveJournals.resolve: there is a journal to resolve');
    assert(pending.journal.id === id, 'StyleMoveJournals.resolve: the journal resolved is the one shown');
    if (pending.state.kind === 'changed') {
      return { ok: false, changed: pending.state.changed };
    }
    // A page saved before the journal learnt its text cannot be told from the person's later edits, so it is never
    // written back over: undoing is refused for it, finishing leaves it as it is.
    const unknown = pending.journal.files.filter((file) => file.role === 'page' && file.after === undefined && readOrAbsent(file.path) !== file.before);
    if (target === 'original' && unknown.length > 0) {
      return { ok: false, changed: unknown.map((file) => file.rel) };
    }
    // A page still as before whose new text the journal never learnt cannot be finished: the window offers only undo,
    // and this refuses a finish all the same, so the stylesheets never lose rules the page does not yet take elsewhere.
    if (target === 'moved' && !pending.canFinish) {
      return { ok: false, changed: pending.journal.files.filter((file) => file.role === 'page').map((file) => file.rel) };
    }
    for (const file of styleMoveOrder(pending.journal.files, target)) {
      this.write(projectRoot, file, target);
    }
    this.clear(projectRoot, id);
    return { ok: true };
  }

  // One file to its side of the move, from what it holds now; a file already there is left as it is.
  private write(projectRoot: string, file: StyleMoveFile, target: StyleMoveTarget): void {
    const now = readOrAbsent(file.path);
    const wanted = target === 'moved' ? file.after : file.before;
    if (now === wanted) {
      return;
    }
    if (file.role === 'component') {
      if (target === 'original') {
        assert(now !== undefined, 'StyleMoveJournals: a component to take back is there');
        const outcome = discardComponentFile({
          projectPath: projectRoot,
          path: file.path,
          checksum: digestOf(now),
          force: false,
          componentFolders: this.componentFolders(projectRoot),
        });
        assert(outcome !== 'edited', 'StyleMoveJournals: the component holds the bytes just read');
        return;
      }
      // Finishing needs the component's text; a journal that never learnt it found the file there (progress 'after').
      assert(wanted !== undefined, 'StyleMoveJournals: a component to write has its text');
      createProjectText(file.path, wanted);
      return;
    }
    assert(now !== undefined, 'StyleMoveJournals: a page or stylesheet to write is there');
    // A page whose saved text the journal never learnt is already saved: finishing leaves it.
    if (wanted === undefined) {
      return;
    }
    writeProjectText(file.path, wanted, now);
  }

  // `<project>-<8 hex of its full path>-style-move.json`: the name to recognise it by, the hash because two
  // projects can share a folder name, and only letters, digits and dashes so the name is valid on every system.
  private file(projectRoot: string): string {
    const resolved = path.resolve(projectRoot);
    const key = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
    const name = path
      .basename(resolved)
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, NAME_CHARS_MAX);
    const file = `${name === '' ? 'project' : name}-${key}-${JOURNAL_SUFFIX}`;
    assert(/^[A-Za-z0-9-]+\.json$/.test(file), 'StyleMoveJournals: a journal file name is plain letters, digits and dashes');
    return path.join(this.dataPath(), LOGS_FOLDER, file);
  }
}

/** A fresh journal id. */
export function newStyleMoveId(): string {
  return randomUUID();
}

function readOrAbsent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Temporary file, flushed, renamed over the target, then the folder flushed: the target holds the old bytes or the new.
function durableWrite(file: string, body: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, body, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  flushFolder(path.dirname(file));
}

// Windows cannot open a folder to flush it; NTFS journals the rename, which is that platform's whole promise.
function flushFolder(folder: string): void {
  let descriptor: number | undefined = undefined;
  try {
    descriptor = fs.openSync(folder, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // A folder that cannot be flushed (Windows, some filesystems) keeps the rename the OS already recorded.
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}
