// The on-disk journal of a "Move styles" (Create component), kept by main in the app's data folder, never in the
// project. It holds the plan, not the progress: every file the move touches with its exact text before and after
// (a component's "before" is absent). Where a move stopped is read from the disk against it, at any time, so the
// journal cannot disagree with what is there: a file holding its "before" text is not done, one holding its "after"
// text is done, and one holding neither was changed by someone. A crash while the journal itself is written leaves
// the previous, still-true journal, since it is written durably and replaced whole.
//
// The move is copy first, delete last (StepFiles, src/app/appTypes.ts): the component, then the page, then the
// stylesheets. So any stop leaves a rule twice, never nowhere, and the journal says exactly which files are left.

import { assert } from '../core/assert';
import { list, record, text } from '../core/boundary';

export const STYLE_MOVE_LIMITS = {
  /** Stylesheets one move edits: the sheets of one project's style folders that held the moved rules. */
  sheetsMax: 64,
  /** Characters of one file's text, before or after. */
  textCharsMax: 4_000_000,
  /** Characters of the whole journal: every text it holds together. */
  journalCharsMax: 32_000_000,
  /** Characters of an id or a path. */
  nameCharsMax: 4_096,
} as const satisfies Record<string, number>;

/** Which part of the move a file is: the order in which the move writes them, and the reverse for going back. */
export const STYLE_MOVE_ROLES = ['component', 'page', 'sheet'] as const;
export type StyleMoveRole = (typeof STYLE_MOVE_ROLES)[number];

/**
 * One file of a move. `before` undefined: the file did not exist (the new component). `after` undefined: not known
 * yet when the journal was written (the component's text before main has written it, the page's before it is saved).
 */
export interface StyleMoveFile {
  readonly role: StyleMoveRole;
  /** Absolute path, inside the project. */
  readonly path: string;
  /** Project-relative path, for the words. */
  readonly rel: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

export interface StyleMoveJournal {
  readonly version: 1;
  readonly id: string;
  readonly startedAt: number;
  /** The component's name, for the words. */
  readonly component: string;
  readonly files: readonly StyleMoveFile[];
}

/** How far one file got: still as before, done, or changed by someone since. */
export type StyleMoveProgress = 'before' | 'after' | 'changed';

/** Where a journalled move stands, read from the disk. */
export type StyleMoveState =
  /** Nothing was written: the journal can go. */
  | { readonly kind: 'untouched' }
  /** Every file is done: the journal can go. */
  | { readonly kind: 'done' }
  /** Stopped part way: what is done and what is left, file by file. */
  | { readonly kind: 'interrupted'; readonly done: readonly string[]; readonly left: readonly string[] }
  /** A file holds neither text: someone edited it since, so neither finishing nor undoing can be exact. */
  | { readonly kind: 'changed'; readonly changed: readonly string[] };

/** Where a stopped move goes when the person chooses: finished, or exactly as before it. */
export type StyleMoveTarget = 'moved' | 'original';

/** A journal and where it stands on disk now (styleMove:pending); `canFinish` is styleMoveCanFinish's answer. */
export interface PendingStyleMove {
  readonly journal: StyleMoveJournal;
  readonly state: StyleMoveState;
  readonly canFinish: boolean;
}

/** What resolving did (styleMove:resolve): done, or refused because these files changed since, with nothing written. */
export type StyleMoveResolution = { readonly ok: true } | { readonly ok: false; readonly changed: readonly string[] };

export function parseStyleMoveTarget(input: unknown): StyleMoveTarget {
  if (input === 'moved' || input === 'original') {
    return input;
  }
  throw new Error('Style move: expected moved or original');
}

/** styleMove:pending's answer: no journal, or the journal with its state. */
export function parsePendingStyleMove(input: unknown): PendingStyleMove | undefined {
  const value = record(input);
  if (value['pending'] === undefined) {
    return undefined;
  }
  const pending = record(value['pending']);
  const journal = parseStyleMoveJournal(pending['journal']);
  const state = parseStyleMoveState(pending['state']);
  const named = new Set(journal.files.map((file) => file.rel));
  assert(
    stateFiles(state).every((rel) => named.has(rel)),
    'parsePendingStyleMove: the state names only journalled files',
  );
  const canFinish = pending['canFinish'];
  if (typeof canFinish !== 'boolean') {
    throw new Error('Style move: expected whether it can be finished');
  }
  return { journal, state, canFinish };
}

export function parseStyleMoveResolution(input: unknown): StyleMoveResolution {
  const value = record(input);
  if (value['ok'] === true) {
    return { ok: true };
  }
  if (value['ok'] === false) {
    return { ok: false, changed: list(name)(value['changed']) };
  }
  throw new Error('Style move: expected a resolution');
}

function parseStyleMoveState(input: unknown): StyleMoveState {
  const value = record(input);
  switch (value['kind']) {
    case 'untouched':
      return { kind: 'untouched' };
    case 'done':
      return { kind: 'done' };
    case 'interrupted':
      return { kind: 'interrupted', done: list(name)(value['done']), left: list(name)(value['left']) };
    case 'changed':
      return { kind: 'changed', changed: list(name)(value['changed']) };
    default:
      throw new Error('Style move: unknown state');
  }
}

function stateFiles(state: StyleMoveState): readonly string[] {
  switch (state.kind) {
    case 'untouched':
    case 'done':
      return [];
    case 'interrupted':
      return [...state.done, ...state.left];
    case 'changed':
      return state.changed;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Whether a stopped move can be finished. Not while its page is still as before and the journal never learnt its
 * saved text: finishing would take the rules out of the stylesheets while the page does not use the component yet.
 * Undoing is always possible from an interrupted state; this only takes "finish" away.
 */
export function styleMoveCanFinish(journal: StyleMoveJournal, disks: readonly (string | undefined)[]): boolean {
  assert(disks.length === journal.files.length, 'styleMoveCanFinish: one disk text per journalled file');
  const blocked = journal.files.some((file, index) => file.role === 'page' && file.after === undefined && disks[index] === file.before);
  assert(
    journal.files.some((file) => file.role === 'page'),
    'styleMoveCanFinish: a journal has its page',
  );
  return !blocked;
}

/** The progress of `file`, given its text on disk now (undefined: the file is absent). */
export function styleMoveProgress(file: StyleMoveFile, disk: string | undefined): StyleMoveProgress {
  if (disk === file.before) {
    return 'before';
  }
  if (disk === undefined) {
    return 'changed'; // Absent where it should exist: removed by someone.
  }
  if (file.after === undefined) {
    // Written, but the journal did not learn its text yet: the move's own write, since nothing else ran in between.
    return 'after';
  }
  return disk === file.after ? 'after' : 'changed';
}

/** Where `journal` stands, given each file's text on disk now, in the journal's order. */
export function styleMoveState(journal: StyleMoveJournal, disks: readonly (string | undefined)[]): StyleMoveState {
  assert(disks.length === journal.files.length, 'styleMoveState: one disk text per journalled file');
  const progress = journal.files.map((file, index) => styleMoveProgress(file, disks[index]));
  const changed = journal.files.filter((_, index) => progress[index] === 'changed').map((file) => file.rel);
  if (changed.length > 0) {
    return { kind: 'changed', changed };
  }
  const done = journal.files.filter((_, index) => progress[index] === 'after').map((file) => file.rel);
  const left = journal.files.filter((_, index) => progress[index] === 'before').map((file) => file.rel);
  assert(done.length + left.length === journal.files.length, 'styleMoveState: every file is done or left');
  if (done.length === 0) {
    return { kind: 'untouched' };
  }
  return left.length === 0 ? { kind: 'done' } : { kind: 'interrupted', done, left };
}

/**
 * The files in the order a resolution writes them. Towards the move: component, page, sheets, so a rule is copied
 * before it is deleted. Back to the original: the reverse, so the rules are back in the sheets before the page stops
 * using the component, and the component goes last.
 */
export function styleMoveOrder(files: readonly StyleMoveFile[], target: StyleMoveTarget): readonly StyleMoveFile[] {
  const rank = (file: StyleMoveFile): number => STYLE_MOVE_ROLES.indexOf(file.role);
  const ordered = [...files].sort((left, right) => (target === 'moved' ? rank(left) - rank(right) : rank(right) - rank(left)));
  assert(ordered.length === files.length, 'styleMoveOrder: every file is written once');
  return ordered;
}

/** A journal from IPC or disk, checked whole: one component, one page, the sheets, and every bound. */
export function parseStyleMoveJournal(input: unknown): StyleMoveJournal {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Style move journal: unknown version');
  }
  const startedAt = value['startedAt'];
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error('Style move journal: expected a start time');
  }
  const files = list(styleMoveFile)(value['files']);
  const roles = files.map((file) => file.role);
  if (roles.filter((role) => role === 'component').length !== 1 || roles.filter((role) => role === 'page').length !== 1) {
    throw new Error('Style move journal: expected one component and one page');
  }
  if (roles.length - 2 > STYLE_MOVE_LIMITS.sheetsMax) {
    throw new Error('Style move journal: too many stylesheets');
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('Style move journal: a file is listed twice');
  }
  const chars = files.reduce((sum, file) => sum + (file.before?.length ?? 0) + (file.after?.length ?? 0), 0);
  if (chars > STYLE_MOVE_LIMITS.journalCharsMax) {
    throw new Error('Style move journal: too large');
  }
  return { version: 1, id: name(value['id']), startedAt, component: name(value['component']), files };
}

function styleMoveFile(input: unknown): StyleMoveFile {
  const value = record(input);
  const role = styleMoveRole(value['role']);
  const file: StyleMoveFile = {
    role,
    path: name(value['path']),
    rel: name(value['rel']),
    before: maybeText(value['before']),
    after: maybeText(value['after']),
  };
  if (role === 'component' && file.before !== undefined) {
    throw new Error('Style move journal: a new component did not exist before');
  }
  if (role !== 'component' && file.before === undefined) {
    throw new Error('Style move journal: a page or stylesheet existed before');
  }
  if (role === 'sheet' && file.after === undefined) {
    throw new Error('Style move journal: a stylesheet’s new text is known before it is written');
  }
  return file;
}

function styleMoveRole(input: unknown): StyleMoveRole {
  const role = STYLE_MOVE_ROLES.find((known) => known === input);
  if (role === undefined) {
    throw new Error('Style move journal: unknown file role');
  }
  return role;
}

function name(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > STYLE_MOVE_LIMITS.nameCharsMax) {
    throw new Error('Style move journal: a name or path is 1 to 4096 characters');
  }
  return value;
}

function maybeText(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = text(input);
  if (value.length > STYLE_MOVE_LIMITS.textCharsMax) {
    throw new Error('Style move journal: a file text is over the limit');
  }
  return value;
}
