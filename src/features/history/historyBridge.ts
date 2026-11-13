import type { IpcResults, WireCommitInfo, WireFileKind, WireWorktreeInfo } from '../../../shared/ipc/ipcResults';
import type { Parser } from '../../../shared/core/boundary';
import { boolean, list, optional, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { failureOf, type Failure } from '../../lib/cleanError';
import { historyTransport } from '../../ipc/editorEnvironment';

export type HistoryFile = IpcResults['git:allFiles'][number];
export type HistoryCommitFile = NonNullable<WireCommitInfo['files']>[number];
export interface HistoryCommit {
  readonly files: readonly HistoryCommitFile[] | undefined;
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly email: string;
  readonly when: string;
  readonly subject: string;
  readonly parents: readonly string[];
  readonly refs: readonly string[];
  readonly isMerge: boolean;
}
export interface HistoryLog {
  readonly commits: readonly HistoryCommit[];
  readonly atEnd: boolean;
}

export function parseHistoryLog(input: unknown): HistoryLog {
  const value = record(input);
  const commits = list(parseCommit)(value['commits']);
  const hashes = new Set(commits.map((commit) => commit.hash));
  if (hashes.size !== commits.length) {
    throw new Error('History log: duplicate commit hash');
  }
  return { commits, atEnd: boolean(value['atEnd']) };
}

export function parseHistoryFiles(input: unknown): readonly HistoryFile[] {
  const files = list(parseHistoryFile)(input);
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) {
    throw new Error('History files: duplicate path');
  }
  return files;
}

export function parseHistoryWorktrees(input: unknown): readonly WireWorktreeInfo[] {
  const worktrees = list(parseWorktree)(input);
  const paths = new Set(worktrees.map((worktree) => worktree.path));
  if (paths.size !== worktrees.length) {
    throw new Error('History worktrees: duplicate path');
  }
  return worktrees;
}

export function readHistoryLog(projectPath: string, skip: number, ref?: string) {
  const payload = parseIpcPayload('git:log', {
    projectPath,
    limit: 30,
    skip,
    withFiles: true,
    ...(ref === undefined ? {} : { ref }),
  });
  return historyRequest(parseHistoryLog, () => historyTransport.log(payload));
}

export function readHistoryFiles(projectPath: string) {
  const payload = parseIpcPayload('git:allFiles', { projectPath });
  return historyRequest(parseHistoryFiles, () => window.avb.gitAllFiles(payload));
}

export function readHistoryWorktrees(projectPath: string) {
  const payload = parseIpcPayload('git:worktrees', { projectPath });
  return historyRequest(parseHistoryWorktrees, () => window.avb.gitWorktrees(payload));
}

function parseCommit(input: unknown): HistoryCommit {
  const value = record(input);
  return {
    files: optional(list(parseCommitFile))(value['files']),
    hash: text(value['hash']),
    shortHash: text(value['shortHash']),
    author: text(value['author']),
    email: text(value['email']),
    when: text(value['when']),
    subject: text(value['subject']),
    parents: list(text)(value['parents']),
    refs: list(text)(value['refs']),
    isMerge: boolean(value['isMerge']),
  };
}

function parseCommitFile(input: unknown): HistoryCommitFile {
  const value = record(input);
  return {
    status: text(value['status']),
    path: pathText(value['path']),
    from: optional(pathText)(value['from']),
    kind: parseFileKind(value['kind']),
    label: text(value['label']),
  };
}

function parseHistoryFile(input: unknown): HistoryFile {
  const value = record(input);
  return {
    path: pathText(value['path']),
    status: optional(text)(value['status']),
    staged: boolean(value['staged']),
    from: optional(pathText)(value['from']),
    kind: parseFileKind(value['kind']),
    label: text(value['label']),
  };
}

function parseWorktree(input: unknown): WireWorktreeInfo {
  const value = record(input);
  return {
    path: pathText(value['path']),
    head: optional(text)(value['head']),
    branch: optional(text)(value['branch']),
    detached: boolean(value['detached']),
    bare: boolean(value['bare']),
  };
}

function parseFileKind(input: unknown): WireFileKind {
  const value = text(input);
  switch (value) {
    case 'content':
    case 'asset':
    case 'layout':
    case 'page':
    case 'component':
    case 'file':
    case 'style':
    case 'config':
    case 'script':
    case 'doc':
      return value;
    default:
      throw new Error('History file: unknown kind');
  }
}

async function historyRequest<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<{ readonly ok: true; readonly value: Value } | Failure> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return failureOf(error);
  }
  return { ok: true, value: parse(response) };
}
