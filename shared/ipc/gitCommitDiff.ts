import { assert } from '../core/assert';
import { boolean, optional, pathText, record, text } from '../core/boundary';
import { parseOptionalMessageRef, type MessageRef } from '../core/i18n/messageReference';

export const COMMIT_DIFF_LIMITS = { charactersMax: 500_000, linesMax: 10_000 } as const;
/**
 * The diff text, or why there is none. `error` is the English sentence (git's own wording when git refused); `errorRef` names our own
 * sentence so the renderer shows it in the person's language, and is absent for git's raw text.
 */
export type CommitDiffResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string; readonly errorRef?: MessageRef | undefined };

export interface CommitDiffRequest {
  readonly projectPath: string;
  readonly commit: string;
  readonly path: string;
  readonly from: string | undefined;
}

export function parseCommitDiffRequest(input: unknown): CommitDiffRequest {
  const value = record(input);
  const commit = text(value['commit']);
  assert(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit), 'Commit diff: expected full commit hash');
  const projectPath = pathText(value['projectPath']);
  assert(projectPath.length > 0, 'Commit diff: project path is required');
  return {
    projectPath,
    commit,
    path: parseCommitDiffPath(value['path']),
    from: optional(parseCommitDiffPath)(value['from']),
  };
}

export function parseCommitDiffResult(input: unknown): CommitDiffResult {
  const value = record(input);
  if (boolean(value['ok'])) {
    const patch = text(value['value']);
    assert(patch.length <= COMMIT_DIFF_LIMITS.charactersMax, 'Commit diff: character limit exceeded');
    assert(patch.split('\n').length <= COMMIT_DIFF_LIMITS.linesMax, 'Commit diff: line limit exceeded');
    return { ok: true, value: patch };
  }
  const errorRef = parseOptionalMessageRef(value['errorRef']);
  return errorRef === undefined ? { ok: false, error: text(value['error']) } : { ok: false, error: text(value['error']), errorRef };
}

function parseCommitDiffPath(input: unknown): string {
  const value = pathText(input);
  assert(value.length > 0, 'Commit diff: file path is required');
  assert(!value.startsWith('/'), 'Commit diff: expected repository-relative path');
  assert(!value.startsWith('\\'), 'Commit diff: absolute network path');
  assert(!/^[A-Za-z]:/.test(value), 'Commit diff: drive path');
  assert(!value.split(/[\\/]/).includes('..'), 'Commit diff: path escapes repository');
  return value;
}
