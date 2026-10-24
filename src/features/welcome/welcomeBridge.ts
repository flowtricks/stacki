import type { IpcResults } from '../../../shared/ipc/ipcResults';
import type { Parser } from '../../../shared/core/boundary';
import {
  boolean,
  count,
  list,
  optional,
  pathText,
  record,
  text,
} from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { Result } from '../../../shared/core/result';
import { cleanError } from '../../lib/cleanError';

export type RecentProject = IpcResults['recents:list'][number];
export type ProjectDialog = IpcResults['project:openDialog'];
export type ParentDialog =
  { readonly canceled: true } | { readonly canceled: false; readonly parentPath: string };
export type ProjectTemplate = 'basics' | 'blog' | 'starlight' | 'minimal';

export interface AstroProjectOptions {
  readonly parentPath: string;
  readonly name: string;
  readonly template: ProjectTemplate;
  readonly install: boolean;
  readonly git: boolean;
  readonly ai: boolean;
}

export function parseRecentProjects(input: unknown): readonly RecentProject[] {
  const projects = list(parseRecentProject)(input);
  const paths = new Set(projects.map((project) => project.path));
  if (paths.size !== projects.length) {
    throw new Error('Recent projects: duplicate path');
  }
  return projects;
}

export function parseRefreshThumb(input: unknown): IpcResults['recents:refreshThumb'] {
  const value = record(input);
  const common = {
    thumb: optional(text)(value['thumb']),
    stale: boolean(value['stale']),
  };
  if (boolean(value['ok'])) {
    return { ok: true, ...common };
  }
  return { ok: false, error: text(value['error']), ...common };
}

export function parseProjectDialog(input: unknown): ProjectDialog {
  const value = record(input);
  if (boolean(value['canceled'])) {
    return { canceled: true };
  }
  if (value['error'] !== undefined) {
    return { canceled: false, error: text(value['error']) };
  }
  return { canceled: false, projectPath: pathText(value['projectPath']) };
}

export function parseParentDialog(input: unknown): ParentDialog {
  const value = record(input);
  if (boolean(value['canceled'])) {
    return { canceled: true };
  }
  return { canceled: false, parentPath: pathText(value['parentPath']) };
}

export function listRecentProjects() {
  const payload = parseIpcPayload('recents:list', undefined);
  return welcomeRequest(parseRecentProjects, () => window.avb.listRecents(payload));
}

export function refreshRecentThumbnail(projectPath: string) {
  const payload = parseIpcPayload('recents:refreshThumb', projectPath);
  return welcomeRequest(parseRefreshThumb, () => window.avb.refreshThumb(payload));
}

export function removeRecentProject(projectPath: string) {
  const payload = parseIpcPayload('recents:remove', projectPath);
  return welcomeRequest(parseSuccess, () => window.avb.removeRecent(payload));
}

export function chooseExistingProject() {
  const payload = parseIpcPayload('project:openDialog', undefined);
  return welcomeRequest(parseProjectDialog, () => window.avb.openProjectDialog(payload));
}

export function chooseStarterParent() {
  const payload = parseIpcPayload('project:parentDialog', undefined);
  return welcomeRequest(parseParentDialog, () => window.avb.parentDialog(payload));
}

export function createStarterProject(parentPath: string, name: string) {
  const payload = parseIpcPayload('project:createStarter', {
    starter: 'lumos',
    parentPath,
    name,
  });
  return welcomeRequest(parseStarterResult, () => window.avb.createStarter(payload));
}

export function createAstroProject(options: AstroProjectOptions) {
  const payload = parseIpcPayload('project:createAstro', {
    parentPath: options.parentPath,
    name: options.name,
    template: options.template,
    install: options.install,
    git: options.git,
    ai: options.ai,
  });
  return welcomeRequest(parseAstroResult, () => window.avb.createAstroProject(payload));
}

export function subscribeCreateLog(append: (chunk: string) => void): () => void {
  return window.avb.onCreateLog((input) => append(text(input)));
}

function parseRecentProject(input: unknown): RecentProject {
  const value = record(input);
  return {
    thumb: optional(text)(value['thumb']),
    stale: boolean(value['stale']),
    canRefresh: boolean(value['canRefresh']),
    path: pathText(value['path']),
    name: text(value['name']),
    openedAt: count(value['openedAt']),
  };
}

function parseSuccess(input: unknown): { readonly ok: true } {
  if (!boolean(record(input)['ok'])) {
    throw new Error('Welcome operation: expected success');
  }
  return { ok: true };
}

function parseStarterResult(input: unknown): IpcResults['project:createStarter'] {
  const value = record(input);
  return { ok: boolean(value['ok']), projectPath: pathText(value['projectPath']) };
}

function parseAstroResult(input: unknown): IpcResults['project:createAstro'] {
  const value = record(input);
  if (!boolean(value['ok'])) {
    throw new Error('Create Astro project: expected success');
  }
  return {
    ok: true,
    installed: boolean(value['installed']),
    projectPath: pathText(value['projectPath']),
  };
}

async function welcomeRequest<Value>(
  parse: Parser<Value>,
  invoke: () => Promise<unknown>,
): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parse(response) };
}
