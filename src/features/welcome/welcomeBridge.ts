import type { IpcResults } from '../../../shared/ipc/ipcResults';
import type { Parser } from '../../../shared/core/boundary';
import { boolean, count, list, optional, pathText, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { Result } from '../../../shared/core/result';
import type { CreatePackageManager } from '../../../shared/properties/packageManager';
import { cleanError } from '../../lib/cleanError';
import { parseAstroCopyCheck, parseAstroCopyReply, parseSiteFolderChoice, type AstroCopyRequest } from '../../../shared/ipc/astroCopy';
import { parseFolderOpenChoice, parseFolderOpenChoices, type FolderOpenChoice } from '../../../shared/ipc/folderOpen';

export type RecentProject = IpcResults['recents:list'][number];
export type ProjectDialog = IpcResults['project:openDialog'];
export type ParentDialog = { readonly canceled: true } | { readonly canceled: false; readonly parentPath: string };
export type ProjectTemplate = 'basics' | 'blog' | 'starlight' | 'minimal';

export interface AstroProjectOptions {
  readonly parentPath: string;
  readonly name: string;
  readonly template: ProjectTemplate;
  readonly install: boolean;
  readonly git: boolean;
  readonly ai: boolean;
  readonly packageManager: CreatePackageManager;
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

/** "Open from folder": the folder the person picks, and whether it is an Astro project, a plain website or neither. */
export function chooseSiteFolder() {
  const payload = parseIpcPayload('project:openSiteDialog', undefined);
  return welcomeRequest(parseSiteFolderChoice, () => window.avb.openSiteDialog(payload));
}

/** A folder dropped on the window: what main finds at `folderPath`, which came from the drag and is checked there. */
export function inspectFolder(folderPath: string) {
  const payload = parseIpcPayload('project:inspectFolder', folderPath);
  return welcomeRequest(parseFolderOpenChoice, () => window.avb.inspectFolder(payload));
}

/** The folders the app's icon or the command line handed over before the window listened; main sends later ones itself. */
export function takeOpenedFolders() {
  const payload = parseIpcPayload('project:takeOpenedFolders', undefined);
  return welcomeRequest(parseFolderOpenChoices, () => window.avb.takeOpenedFolders(payload));
}

/** A folder the app's icon or a second launch handed over while the window listens. */
export function subscribeOpenedFolders(receive: (choice: FolderOpenChoice) => void): () => void {
  return window.avb.onFolderOpened((input) => receive(parseFolderOpenChoice(input)));
}

/** Whether an Astro copy may go at `request`: the dialog's live check of its name and location. */
export function checkAstroCopy(request: AstroCopyRequest) {
  const payload = parseIpcPayload('project:checkAstroCopy', request);
  return welcomeRequest(parseAstroCopyCheck, () => window.avb.checkAstroCopy(payload));
}

/** Makes the Astro copy, installs it and starts its history; the log streams on `create:log`. */
export function createAstroCopy(request: AstroCopyRequest) {
  const payload = parseIpcPayload('project:createAstroCopy', request);
  return welcomeRequest(parseAstroCopyReply, () => window.avb.createAstroCopy(payload));
}

export function chooseStarterParent() {
  const payload = parseIpcPayload('project:parentDialog', undefined);
  return welcomeRequest(parseParentDialog, () => window.avb.parentDialog(payload));
}

export function createStarterProject(parentPath: string, name: string, packageManager: CreatePackageManager) {
  const payload = parseIpcPayload('project:createStarter', {
    starter: 'lumos',
    parentPath,
    name,
    packageManager,
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
    packageManager: options.packageManager,
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

async function welcomeRequest<Value>(parse: Parser<Value>, invoke: () => Promise<unknown>): Promise<Result<Value, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parse(response) };
}
