import type { Data } from '../shared/boundary';
import type {
  IpcResults,
  WireDataRecord,
  WireInjectedRoute,
  WireRouteParams,
  WireUsageFile,
} from '../shared/ipc-results';
import {
  boolean,
  count,
  data,
  dictionary,
  list,
  nullable,
  optional,
  pathText,
  record,
  text,
} from '../shared/boundary';
import { parseIpcPayload } from '../shared/ipc-payloads';
import { parseOkResult } from '../shared/ipc';
import { parsePageReadResult, type ParsePageResult } from '../shared/page-node';

export interface PageChangeEvent {
  readonly external: boolean;
}

export interface FileChangeEvent {
  readonly files: readonly string[];
}

export interface ImportPaths {
  readonly relative: string;
  readonly srcRelative: string | null;
}

export interface AppCollection {
  readonly name: string;
  readonly count?: number;
}

interface CreateComponentInput {
  readonly projectPath: string;
  readonly pagePath: string;
  readonly name: string;
  readonly nodes: unknown;
  readonly imports: readonly { readonly name?: string; readonly path?: string }[];
  readonly props: readonly string[];
}

export function diagnoseProject(projectPath: string): Promise<IpcResults['dev:diagnose']> {
  const payload = parseIpcPayload('dev:diagnose', projectPath);
  return window.avb.diagnoseDev(payload).then(parseDevDiagnosis);
}

export function startProjectPreview(projectPath: string): Promise<IpcResults['dev:start']> {
  const payload = parseIpcPayload('dev:start', projectPath);
  return window.avb.startDevServer(payload).then(parseDevStart);
}

export function probeProjectPreview(url: string): Promise<IpcResults['dev:probe']> {
  const payload = parseIpcPayload('dev:probe', url);
  return window.avb.probeDevPage(payload).then(parseDevProbe);
}

export function readProjectClasses(projectPath: string): Promise<readonly string[]> {
  const payload = parseIpcPayload('project:classes', projectPath);
  return window.avb.listProjectClasses(payload).then(list(text));
}

export function projectHasNodeModules(projectPath: string): Promise<boolean> {
  const payload = parseIpcPayload('project:hasNodeModules', projectPath);
  return window.avb.hasNodeModules(payload).then(boolean);
}

export function pendingProject(): Promise<string | null> {
  return window.avb.pendingProject().then((input) =>
    input === null ? null : pathText(input),
  );
}

export function openProject(): Promise<IpcResults['project:openDialog']> {
  return window.avb.openProjectDialog().then(parseProjectDialog);
}

export function readAppSettings(): Promise<{ readonly sound: boolean }> {
  return window.avb.settings().then((input) => {
    const sound = record(input)['sound'];
    return { sound: sound === undefined ? false : boolean(sound) };
  });
}

export function addRecentProject(projectPath: string): Promise<void> {
  const payload = parseIpcPayload('recents:add', projectPath);
  return window.avb.addRecent(payload).then((input) => void parseOkResult(input));
}

export function installProjectDependencies(projectPath: string): Promise<void> {
  const payload = parseIpcPayload('project:install', projectPath);
  return window.avb.installDeps(payload).then((input) => void parseOkResult(input));
}

export function watchProject(projectPath: string): Promise<boolean> {
  const payload = parseIpcPayload('watch:start', projectPath);
  return window.avb.watchProject(payload).then((input) => boolean(record(input)['ok']));
}

export function writeProjectPage(
  pagePath: string,
  model: unknown,
): Promise<(ParsePageResult & { readonly source: string }) | undefined> {
  const payload = parseIpcPayload('page:write', { pagePath, model });
  return window.avb.writePage(payload).then(parseWrittenPage);
}

export function writeProjectPageRaw(
  pagePath: string,
  source: string,
): Promise<(ParsePageResult & { readonly source: string }) | undefined> {
  const payload = parseIpcPayload('page:writeRaw', { pagePath, source });
  return window.avb.writePageRaw(payload).then(parseWrittenPage);
}

function parseWrittenPage(
  input: unknown,
): (ParsePageResult & { readonly source: string }) | undefined {
  parseOkResult(input);
  if (typeof input !== 'object' || input === null || !('source' in input)) {
    // Older development bridges only acknowledge the write. The production
    // bridge returns the parsed file so source ranges stay current.
    return undefined;
  }
  return parsePageReadResult(input);
}

export function closeProject(nextProjectPath: string | null): Promise<void> {
  const payload = parseIpcPayload('project:close', nextProjectPath);
  return window.avb.closeProject(payload).then((input) => void parseOkResult(input));
}

export function stopProjectCommitPreview(projectPath: string): Promise<void> {
  const payload = parseIpcPayload('preview:stop', { projectPath });
  return window.avb.previewStop(payload).then((input) => void parseOkResult(input));
}

export function copyEditorSelection(
  projectPath: string,
  keys: readonly string[],
): Promise<boolean> {
  const payload = parseIpcPayload('selection:copy', { projectPath, keys });
  return window.avb.copySelection(payload).then((input) => boolean(record(input)['ok']));
}

export function writeProjectFile(
  area: 'src' | 'public',
  projectPath: string,
  rel: string,
  value: string,
): Promise<void> {
  const channel = area === 'src' ? 'src:writeText' : 'assets:writeText';
  const payload = parseIpcPayload(channel, { projectPath, rel, text: value });
  const request =
    area === 'src'
      ? window.avb.writeSourceText(payload)
      : window.avb.writeAssetText(payload);
  return request.then((input) => void parseOkResult(input));
}

export function openExternalURL(url: string): Promise<void> {
  const payload = parseIpcPayload('shell:openExternal', url);
  return window.avb.openExternal(payload).then((input) => void parseOkResult(input));
}

export function onSoundSettingChanged(callback: (enabled: boolean) => void): () => void {
  return window.avb.onMenu('sound', (input) => callback(boolean(input)));
}

export function onCmsInventoryChanged(callback: () => void): () => void {
  return window.avb.onCmsChanged(callback);
}

export function runNativeEdit(command: 'copy' | 'paste' | 'redo' | 'undo'): void {
  const methods = {
    copy: window.avb.nativeCopy,
    paste: window.avb.nativePaste,
    redo: window.avb.nativeRedo,
    undo: window.avb.nativeUndo,
  } as const;
  const method = methods[command];
  if (typeof method === 'function') {
    void method().then(parseOkResult);
  }
}

export function resolveProjectImport(
  projectPath: string,
  fromFile: string,
  spec: string,
): Promise<string | null> {
  const payload = parseIpcPayload('project:resolveImport', { projectPath, fromFile, spec });
  return window.avb.resolveImport(payload).then((input) => nullable(pathText)(record(input)['path']));
}

export function readInjectedRoutes(projectPath: string): Promise<readonly WireInjectedRoute[]> {
  const payload = parseIpcPayload('project:injectedRoutes', { projectPath });
  return window.avb.injectedRoutes(payload).then((input) =>
    list(parseInjectedRoute)(record(input)['routes']),
  );
}

export function readDynamicPaths(
  projectPath: string,
  pagePath: string,
  devUrl: string,
): Promise<IpcResults['page:dynamicPaths']> {
  const payload = parseIpcPayload('page:dynamicPaths', { projectPath, pagePath, devUrl });
  return window.avb.dynamicPaths(payload).then(parseDynamicPaths);
}

export function readContentCollections(projectPath: string): Promise<readonly AppCollection[]> {
  const payload = parseIpcPayload('content:collections', projectPath);
  return window.avb.contentCollections(payload).then((input) =>
    list(parseAppCollection)(record(input)['collections']),
  );
}

export function readSampleEntry(
  devUrl: string,
  name: string,
  id?: string,
): Promise<Data | null> {
  const raw = id === undefined ? { devUrl, name } : { devUrl, name, id };
  const payload = parseIpcPayload('content:sampleEntry', raw);
  return window.avb.sampleEntry(payload).then((input) => {
    const entry = record(input)['entry'];
    return entry === null ? null : data(entry);
  });
}

export function createProjectPage(
  projectPath: string,
  name: string,
  layout: unknown,
): Promise<string> {
  const payload = parseIpcPayload('page:create', { projectPath, name, layout });
  return window.avb.createPage(payload).then((input) => pathText(record(input)['pagePath']));
}

export function moveProjectPage(
  projectPath: string,
  from: string,
  to: string,
): Promise<string> {
  const payload = parseIpcPayload('page:move', { projectPath, from, to });
  return window.avb.movePage(payload).then((input) => pathText(record(input)['newPath']));
}

export function createProjectPageFolder(projectPath: string, dir: string): Promise<void> {
  const payload = parseIpcPayload('pagefolder:create', { projectPath, dir });
  return window.avb.createPageFolder(payload).then((input) => void parseOkResult(input));
}

export function renameProjectPageFolder(
  projectPath: string,
  from: string,
  to: string,
): Promise<void> {
  const payload = parseIpcPayload('pagefolder:rename', { projectPath, from, to });
  return window.avb.renamePageFolder(payload).then((input) => void parseOkResult(input));
}

export function deleteProjectPageFolder(projectPath: string, dir: string): Promise<void> {
  const payload = parseIpcPayload('pagefolder:delete', { projectPath, dir });
  return window.avb.deletePageFolder(payload).then((input) => void parseOkResult(input));
}

export function deleteProjectPage(path: string): Promise<void> {
  const payload = parseIpcPayload('page:delete', path);
  return window.avb.deletePage(payload).then((input) => void parseOkResult(input));
}

export function readProjectAsset(projectPath: string, rel: string): Promise<string> {
  const payload = parseIpcPayload('assets:readText', { projectPath, rel });
  return window.avb.readAssetText(payload).then((input) => text(record(input)['text']));
}

export function findImportPath(
  projectPath: string,
  pagePath: string,
  targetPath: string,
): Promise<ImportPaths> {
  const payload = parseIpcPayload('page:importPathFor', { projectPath, pagePath, targetPath });
  return window.avb.importPathFor(payload).then((input) => {
    const value = record(input);
    return {
      relative: text(value['relative']),
      srcRelative: nullableText(value['srcRelative']),
    };
  });
}

export function rebaseProjectImport(
  fromPagePath: string,
  toPagePath: string | null,
  spec: string,
): Promise<IpcResults['page:rebaseImport']> {
  const payload = parseIpcPayload('page:rebaseImport', {
    fromPagePath,
    toPagePath,
    spec,
  });
  return window.avb.rebaseImport(payload).then((input) => ({
    path: text(record(input)['path']),
  }));
}

export function createProjectComponent(
  input: CreateComponentInput,
): Promise<IpcResults['component:create']> {
  const payload = parseIpcPayload('component:create', {
    projectPath: input.projectPath,
    pagePath: input.pagePath,
    name: input.name,
    nodes: [data(input.nodes)],
    imports: input.imports,
    props: input.props.map(data),
  });
  return window.avb.createComponent(payload).then((raw) => {
    const value = record(raw);
    return {
      path: pathText(value['path']),
      rel: pathText(value['rel']),
      name: text(value['name']),
    };
  });
}

export function readComponentUsage(
  projectPath: string,
  name: string,
  exclude: string,
): Promise<IpcResults['component:usage']> {
  const payload = parseIpcPayload('component:usage', { projectPath, name, exclude });
  return window.avb.componentUsage(payload).then((input) => {
    const value = record(input);
    return {
      files: list(parseUsageFile)(value['files']),
      total: count(value['total']),
    };
  });
}

export function previewProjectCommit(
  projectPath: string,
  reference: string,
): Promise<IpcResults['preview:atCommit']> {
  const payload = parseIpcPayload('preview:atCommit', { projectPath, ref: reference });
  return window.avb.previewAtCommit(payload).then((input) => {
    const value = record(input);
    return {
      url: text(value['url']),
      ref: text(value['ref']),
      reused: boolean(value['reused']),
    };
  });
}

export function restoreProjectFile(
  projectPath: string,
  reference: string,
  path: string,
): Promise<IpcResults['git:restoreFile']> {
  const payload = parseIpcPayload('git:restoreFile', { projectPath, ref: reference, path });
  return window.avb.gitRestoreFile(payload).then((input) => {
    const value = record(input);
    const ok = boolean(value['ok']);
    const missing = optional(boolean)(value['missing']);
    const message = optional(text)(value['message']);
    return {
      ok,
      ...(missing === undefined ? {} : { missing }),
      ...(message === undefined ? {} : { message }),
    };
  });
}

export function restoreProjectVersion(
  projectPath: string,
  reference: string,
): Promise<IpcResults['git:restoreProject']> {
  const payload = parseIpcPayload('git:restoreProject', { projectPath, ref: reference });
  return window.avb.gitRestoreProject(payload).then((input) => {
    const value = record(input);
    return { ok: boolean(value['ok']), parked: boolean(value['parked']) };
  });
}

export function onAppProgress(callback: (message: string | null) => void): () => void {
  return window.avb.onProgress((input) => callback(nullableText(record(input)['message'])));
}

export function onDevExit(callback: (log: string) => void): () => void {
  return window.avb.onDevExit((input) => callback(text(record(input)['log'])));
}

export function onDevLog(callback: (chunk: string) => void): () => void {
  return window.avb.onDevLog((input) => callback(text(input)));
}

export function onPageMaybeChanged(callback: (event: PageChangeEvent) => void): () => void {
  return window.avb.onPageMaybeChanged((input) => {
    const external = record(input)['external'];
    callback({ external: external === undefined ? false : boolean(external) });
  });
}

export function onFilesChanged(callback: (event: FileChangeEvent) => void): () => void {
  return window.avb.onFsChanged((input) => {
    callback({ files: list(pathText)(record(input)['files']) });
  });
}

function parseDevDiagnosis(input: unknown): IpcResults['dev:diagnose'] {
  const value = record(input);
  return {
    kind: text(value['kind']),
    nodePath: nullableText(value['nodePath']),
    nodeVersion: nullableText(value['nodeVersion']),
    astroVersion: nullableText(value['astroVersion']),
    requires: nullableText(value['requires']),
    launchedFromGui: boolean(value['launchedFromGui']),
  };
}

function parseDevStart(input: unknown): IpcResults['dev:start'] {
  const value = record(input);
  const result = {
    // Older preload/main pairs omitted this field; an empty value keeps the
    // renderer's existing project setting until the next scan supplies it.
    trailingSlash: value['trailingSlash'] === undefined ? '' : text(value['trailingSlash']),
    url: text(value['url']),
  };
  if (value['bare'] !== undefined) {
    return { ...result, bare: boolean(value['bare']) };
  }
  if (value['external'] !== undefined) {
    return { ...result, external: boolean(value['external']) };
  }
  return result;
}

function parseDevProbe(input: unknown): IpcResults['dev:probe'] {
  const value = record(input);
  const status = value['status'];
  if (!Number.isSafeInteger(status)) {
    throw new Error('Dev probe status must be an integer');
  }
  return { ok: boolean(value['ok']), status: Number(status) };
}

function parseProjectDialog(input: unknown): IpcResults['project:openDialog'] {
  // Legacy bridges returned null when the native dialog was cancelled.
  if (input === null) {
    return { canceled: true };
  }
  const value = record(input);
  if (value['canceled'] === true) {
    return { canceled: true };
  }
  if (value['projectPath'] !== undefined) {
    return { canceled: false, projectPath: pathText(value['projectPath']) };
  }
  if (value['error'] !== undefined) {
    return { canceled: false, error: text(value['error']) };
  }
  throw new Error('Project dialog result must contain a project path, error, or cancellation');
}

function parseUsageFile(input: unknown): WireUsageFile {
  const value = record(input);
  const kind = text(value['kind']);
  if (kind !== 'layout' && kind !== 'page' && kind !== 'component' && kind !== 'file') {
    throw new Error(`Unknown component usage kind: ${kind}`);
  }
  return {
    rel: pathText(value['rel']),
    path: pathText(value['path']),
    kind,
    count: count(value['count']),
  };
}

function parseInjectedRoute(input: unknown): WireInjectedRoute {
  const value = record(input);
  return {
    route: text(value['route']),
    entrypoint: nullable(pathText)(value['entrypoint']),
    from: nullable(pathText)(value['from']),
    params: list(data)(value['params']),
  };
}

function parseDynamicPaths(input: unknown): IpcResults['page:dynamicPaths'] {
  const value = record(input);
  const entries = list(parseDynamicEntry)(value['entries']);
  if (entries.length === 0 && value['error'] === undefined) {
    return { entries: [] };
  }
  return { entries, error: nullable(text)(value['error']) };
}

function parseDynamicEntry(
  input: unknown,
): IpcResults['page:dynamicPaths']['entries'][number] {
  const value = record(input);
  return {
    params: parseRouteParams(value['params']),
    props: parseDynamicProps(value['props']),
    route: text(value['route']),
    label: text(value['label']),
  };
}

function parseRouteParams(input: unknown): WireRouteParams {
  return dictionary(data)(input);
}

function parseDynamicProps(
  input: unknown,
): null | string | number | true | readonly Data[] | WireDataRecord {
  const value = data(input);
  if (value === undefined || value === false) {
    throw new Error('Dynamic route props have an invalid value');
  }
  return value;
}

function parseAppCollection(input: unknown): AppCollection {
  const value = record(input);
  const collectionCount = optional(count)(value['count']);
  return collectionCount === undefined
    ? { name: text(value['name']) }
    : { name: text(value['name']), count: collectionCount };
}

function nullableText(input: unknown): string | null {
  return input === null ? null : text(input);
}
