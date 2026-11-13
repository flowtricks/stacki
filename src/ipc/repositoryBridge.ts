import { parseGitHubRepositories } from '../../shared/ipc/githubRepository';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import type { Parser } from '../../shared/core/boundary';
import { failureOf, type Failure } from '../lib/cleanError';
import { parseCloneResult } from '../../shared/ipc/githubRepository';
import { boolean, object, optional, text } from '../../shared/core/boundary';
const parsePublication = object({ ok: boolean, url: optional(text), output: text });
function parseGitPublish(input: unknown) {
  const value = parsePublication(input);
  if (!value.ok) {
    throw new Error('Repository publication response must declare success.');
  }
  return value;
}

async function request<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>) {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return failureOf(error);
  }
  return { ok: true, value: parse(response) } satisfies { readonly ok: true; readonly value: Value } | Failure;
}

export function readRepositories() {
  return request(parseGitHubRepositories, () => window.avb.gitRepositories());
}

export function cloneRepository(repository: string) {
  const payload = parseIpcPayload('git:clone', { repository });
  return request(parseCloneResult, () => window.avb.gitClone(payload));
}

export function connectRepository(projectPath: string, repository: string) {
  const payload = parseIpcPayload('git:connect', { projectPath, repository });
  return request(parseGitPublish, () => window.avb.gitConnect(payload));
}
