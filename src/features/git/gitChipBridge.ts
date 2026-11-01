import { gitTransport } from '../../ipc/gitTransport';
import type { IpcResults, WireFileKind, WireGitInfo } from '../../../shared/ipc/ipcResults';
import type { Result } from '../../../shared/core/result';
import type { Parser } from '../../../shared/core/boundary';
import { boolean, count, list, object, optional, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { cleanError } from '../../lib/cleanError';
import { parseMergeResult } from './gitBridge';

const repository = object({
  branch: text,
  branches: list(text),
  dirty: boolean,
  ahead: count,
  parked: list(text),
  head: optional(text),
  userEmail: optional(text),
  trunk: optional(text),
  dirtyFiles: optional(list(pathText)),
  hasUpstream: optional(boolean),
});
function fileKind(input: unknown): WireFileKind {
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
      throw new Error('Git status: unknown file kind');
  }
}
const statusFileFields = object({
  path: pathText,
  status: text,
  staged: boolean,
  untracked: boolean,
  kind: fileKind,
  label: text,
});
function statusFile(input: unknown) {
  const value = record(input);
  return { ...statusFileFields(value), from: optional(pathText)(value['from']) };
}
export function parseGitInfo(input: unknown): IpcResults['git:info'] {
  const value = record(input);
  return boolean(value['isRepo'])
    ? ({
        isRepo: true,
        remote: optional(text)(value['remote']),
        ...repository(value),
      } satisfies WireGitInfo)
    : { isRepo: false };
}
export function parseGitCommit(input: unknown): IpcResults['git:commit'] {
  const value = record(input);
  parseGitSuccess(value);
  return { ok: true, files: optional(count)(value['files']) };
}
export function parseGitPublish(input: unknown): IpcResults['git:publish'] {
  const value = record(input);
  parseGitSuccess(value);
  return { ok: true, url: optional(text)(value['url']), output: text(value['output']) };
}
export function parseGitSuccess(input: unknown): void {
  if (!boolean(record(input)['ok'])) {
    throw new Error('Git response: expected success');
  }
}
export function parseGitStatus(input: unknown): IpcResults['git:status'] {
  return list(statusFile)(input);
}
export function parseGitCheckout(input: unknown): IpcResults['git:checkout'] {
  const value = record(input);
  const ok = boolean(value['ok']);
  if (!ok) {
    if (!boolean(value['blocked'])) {
      throw new Error('Git checkout: failure must be blocked');
    }
    return {
      ok: false,
      blocked: true,
      from: text(value['from']),
      branch: text(value['branch']),
      files: list(pathText)(value['files']),
    };
  }
  const common = {
    restored: boolean(value['restored']),
    parkedFrom: optional(text)(value['parkedFrom']),
    from: text(value['from']),
    parked: boolean(value['parked']),
  };
  const error = optional(text)(value['error']);
  return error === undefined ? { ok: true, ...common } : { ok: true, ...common, error };
}
async function gitRequest<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  // Contract bugs remain loud; only transport failures use the operating channel.
  return { ok: true, value: parse(response) };
}
export function readGitInfo(projectPath: string) {
  const payload = parseIpcPayload('git:info', projectPath);
  return gitRequest(parseGitInfo, () => gitTransport.gitInfo(payload));
}
export function readGitStatus(projectPath: string) {
  const payload = parseIpcPayload('git:status', { projectPath });
  return gitRequest(parseGitStatus, () => gitTransport.gitStatus(payload));
}
export function commitGitChanges(projectPath: string, message: string, paths?: readonly string[]) {
  const input = paths === undefined ? { projectPath, message } : { projectPath, message, paths };
  const payload = parseIpcPayload('git:commit', input);
  return gitRequest(parseGitCommit, () => gitTransport.gitCommit(payload));
}
export function createGitHubRepository(projectPath: string, repoName: string, options: { readonly isPrivate: boolean }) {
  const payload = parseIpcPayload('git:publish', {
    projectPath,
    repoName,
    isPrivate: options.isPrivate,
  });
  return gitRequest(parseGitPublish, () => gitTransport.gitPublish(payload));
}
export type CheckoutMode = { readonly kind: 'switch' } | { readonly kind: 'create' } | { readonly kind: 'park' };
export function checkoutGitBranch(projectPath: string, branch: string, mode: CheckoutMode) {
  const input =
    mode.kind === 'create' ? { projectPath, branch, create: true } : mode.kind === 'park' ? { projectPath, branch, parkFirst: true } : { projectPath, branch };
  const payload = parseIpcPayload('git:checkout', input);
  return gitRequest(parseGitCheckout, () => gitTransport.gitCheckout(payload));
}
export function initializeGit(projectPath: string) {
  const payload = parseIpcPayload('git:init', projectPath);
  return gitRequest(parseGitSuccess, () => gitTransport.gitInit(payload));
}
export function pushGitBranch(projectPath: string, branch: string) {
  const payload = parseIpcPayload('git:push', { projectPath, branch });
  return gitRequest(parseGitSuccess, () => gitTransport.gitPush(payload));
}
export function readIncomingGitCommits(projectPath: string, branch: string) {
  const payload = parseIpcPayload('git:incoming', { projectPath, branch });
  return gitRequest(count, () => gitTransport.gitIncoming(payload));
}
export function pullGitBranch(projectPath: string, branch: string) {
  const payload = parseIpcPayload('git:pull', { projectPath, branch });
  return gitRequest(parseMergeResult, () => gitTransport.gitPull(payload));
}
export function resolveGitMerge(projectPath: string, branch: string, choices: unknown) {
  const payload = parseIpcPayload('git:resolveMerge', { projectPath, branch, choices });
  return gitRequest(parseMergeResult, () => gitTransport.gitResolveMerge(payload));
}
