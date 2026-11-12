import { parseMergeResolution } from './mergeResolution';
import { parseAccountRequest } from './publishAccount';
import { parseCmsConnectionDraft, parseConnectionId, parseSanityLoginRequest } from '../properties/cmsConnections';
import {
  parseRemoteCollectionName,
  parseRemoteColumns,
  parseRemoteConnection,
  parseRemoteDocumentId,
  parseRemoteIds,
  parseRemoteMove,
  parseRemoteWrite,
  parseRemoteTypes,
  parseRemoteAssetKind,
  parseRemoteDocumentAction,
  parseRemoteRevisionId,
} from '../properties/cmsRemote';
import { parseVideoLinkURL } from '../properties/linkPreview';
import { parseMediaAccountConnect, parseMediaAccountKey } from '../properties/mediaAccounts';
import { parseAppId, parseAppVersion, parseGitHubSource, parseReleaseTag, parseStagedToken } from '../properties/apps';
import { parseAppFolderName } from '../properties/appFolders';
import { parseGitHubLogin } from '../properties/projectRoles';
import {
  parseAppRepositoryRef,
  parseAppScanTarget,
  parseAppShareRequest,
  parseMarketplaceSubmission,
  parseSharedReleaseSource,
} from '../properties/appPublish';
import { parseAppSettingValuesReply } from '../properties/appSettings';
import { parseAppFileOperation, type AppFileOperation } from '../properties/appFiles';
import { parseAuthProviderId } from '../properties/appAuth';
import { parseAppNetRequest } from '../properties/appNet';
import { parseAppStorageKey, parseAppStorageScope, parseAppStorageValue, parseAppStorageWriter } from '../properties/appStorage';
import {
  MEDIA_HOSTING_LIMITS,
  parseMediaConnectionDraft,
  parseMediaConnectionId,
  parseMediaFolder,
  parseMediaName,
  parseMediaOrder,
} from '../properties/mediaHosting';
import { parseSecretReadIndex, parseSecretsChange, parseSecretsRevision } from '../properties/secrets';
import { parseMcpChange, parseMcpCodexChange, parseMcpRevision, parseMcpServerName, parseMcpTextInput } from '../properties/mcp';
import { parseConnectionKeyCopy, parseDataSampleRequest, parseEnvPayloadName, parsePageTemplateDraft, parseSecretValue } from '../properties/pageTemplate';
import { parseAstroRemoteEdit, parseAstroRemoteRead } from '../properties/astroContent';
import { parseRepositoryRequest } from '../ipc/publishRepository';
import { parseCanvasCreate, defaultsCanvasFile } from '../properties/defaultsCanvas';
import { parseDiscoveryRequest } from '../properties/publishDiscovery';
import { parsePublishCommitMessage, parsePublishTarget } from '../properties/publishConfig';
import { metadataKind, parseMetadataWrite } from '../properties/projectMetadata';
import { parseInstructionFilePath, parseInstructionPath } from '../properties/instructions';
import { parseGitHubLoginQuery } from '../properties/projectRoles';
import { parseSelectorFileChanges, parseSelectorFileDigests, parseSelectorIds } from '../properties/selectorUsage';
import { parseCreatePackageManager } from '../properties/packageManager';
import { parseImageFormat, parseImagePath } from './assetConversion';
import { parseGitHubRepository } from './githubRepository';
import { parseCommitDiffRequest } from './gitCommitDiff';
import { parseCommitAvatarRequest } from './commitAvatars';
import { parsePreferenceName } from './preferences';
import { parseStudioSource } from './studioSetup';
import { parseStudioRequestId } from './studioProgress';
import { parsePropertyChange, propertySource } from '../properties/propertyEditing';
import { parseEdit, parseEditBatchRequest, parseEditRequest } from '../engine/editRequest';
import { parsePreviewRender } from '../page/previewToken';
import { AI_PAYLOADS } from './aiChat';
// Complete invoke-channel inventory. Every main-process listener receives the
// parsed shape below; payload field names retain the existing renderer protocol.
import { object, text, pathText, boolean, count, optional, nullable, list, dictionary, data, digest, record } from '../core/boundary';
import type { Parsed } from '../core/boundary';
import { toArray } from '../core/record';

// The files one `apps:fileStamps` batch may name: APP_RPC_LIMITS.indexFilesMax (shared/properties/appsRpc.ts).
export const APP_FILE_STAMPS_MAX = 2000;
function appFileList(input: unknown): string[] {
  const rels = list(pathText)(input);
  if (rels.length > APP_FILE_STAMPS_MAX) {
    throw new Error(`An app stamps at most ${APP_FILE_STAMPS_MAX} files at once`);
  }
  return rels;
}

// Native terminal dimensions use positive signed 16-bit coordinates on Windows.
export const TERMINAL_DIMENSION_MAX = 32_767;
function terminalDimension(input: unknown): number {
  const value = count(input);
  if (value === 0) {
    throw new Error('Terminal dimension must be positive');
  }
  if (value > TERMINAL_DIMENSION_MAX) {
    throw new Error('Terminal dimension exceeds native limit');
  }
  return value;
}

const nothing = (input: unknown): undefined => {
  if (input !== undefined) {
    throw new Error('Expected no payload');
  }
  return undefined;
};
const maybeText = optional(nullable(text));
// `cached` answers at once from what earlier searches of installed packages
// found; `search` reads the packages for anything not yet answered.
function packageSearch(input: unknown): 'cached' | 'search' {
  if (input === 'cached' || input === 'search') {
    return input;
  }
  throw new Error('Unknown package search mode');
}
// `cleanup` (the default) honours every lock; `chosen` is the user deleting one
// selector by hand, which a stylesheet or folder lock does not stop (a name
// lock still does: the row's own lock must be lifted first).
function removalReach(input: unknown): 'cleanup' | 'chosen' {
  if (input === 'cleanup' || input === 'chosen') {
    return input;
  }
  throw new Error('Unknown selector removal reach');
}
// Undo writes a cleanup's `before` text back; redo writes its `after` again.
function restoreDirection(input: unknown): 'before' | 'after' {
  if (input === 'before' || input === 'after') {
    return input;
  }
  throw new Error('Unknown restore direction');
}
// What the binding picker asks the dev server to sample from a page: one of
// its imports called as the page calls it (`await getCampusPastors()`), or the
// values the page's own last render computed, filed no earlier than `sinceMs`
// (a wall-clock time in milliseconds; 0 takes any render).
export type SampleValueSource = { readonly kind: 'call'; readonly spec: string; readonly name: string } | { readonly kind: 'scope'; readonly sinceMs: number };
export function sampleValueSource(input: unknown): SampleValueSource {
  const source = record(input);
  const kind = source['kind'];
  if (kind === 'call') {
    return { kind, spec: pathText(source['spec']), name: text(source['name']) };
  }
  if (kind === 'scope') {
    return { kind, sinceMs: count(source['sinceMs']) };
  }
  throw new Error('Unknown sample source');
}
const maybePath = optional(nullable(pathText));
// The renderer sends no target as a missing field or as `null`.
const cssTarget = (input: unknown): string | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (input === null) {
    return undefined;
  }
  return text(input);
};
const maybeFlag = optional(boolean);
// All of an import, or `{ a }` would print as `a`, a default import of something else.
const componentImport = object({
  name: optional(text),
  path: optional(text),
  quote: optional(text),
  named: maybeFlag,
  imported: optional(text),
  typeOnly: maybeFlag,
});
const strings = list(text);
const project = { projectPath: pathText };
// The Audits panel's rendered pass: a page of the project's own dev server, which
// main fetches (the renderer's origin cannot). Only a loopback http origin is
// accepted, so the channel can never be pointed at another host.
function loopbackOrigin(input: unknown): string {
  const value = text(input);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Expected a dev server URL');
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Expected a loopback http dev server URL');
  }
  return url.origin;
}
function routePath(input: unknown): string {
  const value = pathText(input);
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 2_048) {
    throw new Error('Expected a site-relative route');
  }
  return value;
}

// An app's file operation: its paths are checked against the app's own refusals, so the id is read first.
/** Window pixels a canvas snapshot may cover each way: larger than any screen, so a rect past it is not one. */
export const CANVAS_SNAPSHOT_PX_MAX = 16_384;
/** The widest PNG a canvas snapshot returns (APP_RPC_LIMITS.snapshotWidthPxMax). */
export const CANVAS_SNAPSHOT_WIDTH_MAX = 800;

// A region of the editor window to photograph for `canvas.snapshot`, and the widest image to return.
function canvasSnapshotRequest(input: unknown): {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly widthMax: number;
} {
  const value = object({ rect: object({ x: count, y: count, width: count, height: count }), widthMax: count })(input);
  const { rect } = value;
  for (const side of [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]) {
    if (side > CANVAS_SNAPSHOT_PX_MAX) {
      throw new Error('A snapshot lies within the window');
    }
  }
  if (rect.width < 1 || rect.height < 1) {
    throw new Error('A snapshot covers at least a pixel each way');
  }
  if (value.widthMax < 1 || value.widthMax > CANVAS_SNAPSHOT_WIDTH_MAX) {
    throw new Error(`A snapshot is at most ${CANVAS_SNAPSHOT_WIDTH_MAX} pixels wide`);
  }
  return value;
}

function appFileRequest(input: unknown): { readonly projectPath: string; readonly id: string; readonly operation: AppFileOperation } {
  const value = record(input);
  const id = parseAppId(value['id']);
  return { projectPath: pathText(value['projectPath']), id, operation: parseAppFileOperation(value['operation'], id) };
}
const relative = { ...project, rel: pathText };
// A folder of one saved media hosting connection (mediaHosting.ts).
const mediaFolder = { ...project, connectionId: parseMediaConnectionId, folder: parseMediaFolder };
function mediaEntry(input: unknown): 'file' | 'folder' {
  if (input === 'file' || input === 'folder') {
    return input;
  }
  throw new Error('Expected a media entry kind');
}
// Files dropped from the system onto a hosted folder, a bounded batch.
function uploadPaths(input: unknown): string[] {
  const paths = list(pathText)(input);
  if (paths.length === 0 || paths.length > MEDIA_HOSTING_LIMITS.uploadFilesMax) {
    throw new Error('Expected 1 to ' + String(MEDIA_HOSTING_LIMITS.uploadFilesMax) + ' files to upload');
  }
  return paths;
}
const source = { ...project, fromFile: pathText, spec: text };
const named = { ...project, name: text };
const reference = { ...project, ref: text };
const branch = { ...project, branch: text };
const location = (input: unknown): string | number => (typeof input === 'number' ? count(input) : text(input));
// ContentView sends a storage locator, not the full display entry.
const entry = object({ file: pathText, locator: optional(list(location)) });
const edits = list(object({ path: list(location), value: data, rename: optional(text) }));
const cssFile = { file: pathText, selector: text };
const cssRange = { file: pathText, start: count, end: count, expect: optional(text) };
const cssMove = (input: unknown) => {
  const section = object({ ...cssFile, names: optional(strings), target: cssTarget })(input);
  return section.names === undefined
    ? object({ ...cssFile, name: text, target: cssTarget, at: optional(count) })(input)
    : object({ ...cssFile, names: strings, target: cssTarget })(input);
};

// A clipboard image can legitimately exceed the general collection limit.
// Bound bytes separately and reject out-of-range values before Buffer coerces them.
export const CLIPBOARD_BYTES_MAX = 20 * 1024 * 1024;
function imageBytes(input: unknown): number[] {
  const values = input instanceof Uint8Array ? input : toArray(input);
  if (!values) {
    throw new Error('Expected image bytes');
  }
  if (values.length > CLIPBOARD_BYTES_MAX) {
    throw new Error('Image exceeds byte limit');
  }
  return Array.from(values, (value) => {
    const byte = count(value);
    if (byte > 255) {
      throw new Error('Expected byte in range 0..255');
    }
    return byte;
  });
}

function parsePickTarget(input: unknown): 'file' {
  if (input === 'file') {
    return input;
  }
  throw new Error('Expected pick target file');
}

export const IPC_PAYLOADS = {
  // The AI chat panel's channels (shared/ipc/aiChat.ts).
  ...AI_PAYLOADS,
  'instructions:create': object({ ...project, file: parseInstructionFilePath, source: text }),
  'instructions:createFolder': object({ ...project, folder: parseInstructionPath }),
  'instructions:list': object({ ...project }),
  'instructions:read': object({ ...project, file: parseInstructionFilePath }),
  'instructions:reveal': object({ ...project, file: parseInstructionPath }),
  'instructions:write': object({ ...project, file: parseInstructionFilePath, source: text, base: text }),
  'project:metadata': object({ ...project, kind: metadataKind }),
  'project:createDefaultsCanvas': object({ ...project, canvas: parseCanvasCreate }),
  'project:removeDefaultsCanvas': object({ ...project, file: defaultsCanvasFile }),
  'project:writeMetadata': object({ ...project, write: parseMetadataWrite }),
  // `target: 'file'` picks one file (Settings → Folders, CMS data files); absent picks a folder.
  'project:pickFolder': object({ ...project, target: optional(parsePickTarget) }),
  // Who the signed-in GitHub user is, for the project's roles (shared/properties/projectRoles.ts).
  'roles:identity': object({ ...project }),
  // The Roles tab's member picker: the typed start of a GitHub username, nothing else (shared/ipc/githubUserSearch.ts).
  'github:searchUsers': object({ ...project, query: parseGitHubLoginQuery }),
  'studio:status': pathText,
  'studio:install': object({
    ...project,
    source: parseStudioSource,
    requestId: parseStudioRequestId,
  }),
  'assets:delete': object({ ...relative }),
  'assets:dimensions': object({ ...relative }),
  'assets:list': pathText,
  'assets:mkdir': object({ ...project, parentRel: pathText, name: text }),
  'assets:move': object({ ...project, fromRel: pathText, toDirRel: pathText }),
  'assets:pickUpload': object({ ...project, destRel: pathText }),
  'assets:readText': object({ ...relative }),
  'assets:convert': object({ ...project, rel: parseImagePath, format: parseImageFormat }),
  'assets:rename': object({ ...relative, newName: text }),
  'assets:replace': object({ ...relative }),
  'assets:upload': object({ ...project, destRel: pathText, filePaths: optional(list(pathText)) }),
  'assets:writeText': object({ ...relative, text }),
  'cms:assetRef': object({ ...relative, assetRel: pathText }),
  'cms:create': object({ ...named }),
  'cms:delete': object({ ...relative }),
  'cms:list': pathText,
  'cms:meta': pathText,
  'cms:read': object({ ...relative }),
  'cms:setMeta': object({ ...relative, fields: optional(nullable(dictionary(data))) }),
  'cms:usage': object({ ...relative }),
  'cms:write': object({ ...relative, data }),
  'component:create': object({
    ...named,
    pagePath: pathText,
    nodes: list(data),
    imports: optional(list(componentImport)),
    props: optional(list(data)),
    frontmatter: optional(object({ imports: list(componentImport), code: text })),
  }),
  'component:discard': object({ ...project, path: pathText, checksum: digest, force: maybeFlag }),
  'component:properties': object({ ...project, file: pathText }),
  // Undo of a property batch (step 6): the token its edit returned. Main
  // holds the inverse batch; the renderer can apply only what an edit wrote.
  'component:revertProperties': object({ token: text }),
  'component:editProperties': object({
    ...project,
    file: pathText,
    source: propertySource,
    change: parsePropertyChange,
  }),
  'component:usage': object({ ...named, exclude: optional(text) }),
  'content:collections': pathText,
  'content:config': object({ ...project, force: maybeFlag }),
  'content:entries': object({ ...named }),
  'content:rename': object({ ...named, from: text, to: text }),
  // The CMS panel's reads and edits of content collections, as a connected CMS's (astroContent.ts).
  'content:remoteEdit': object({ ...project, request: parseAstroRemoteEdit }),
  'content:remoteRead': object({ ...project, request: parseAstroRemoteRead }),
  'content:renamePlan': object({ ...named, from: text, to: text }),
  // `index` is a position in getCollection's own order: the picker's entry pager
  // reads `stats[2]` as the page's code would.
  'content:sampleEntry': object({ devUrl: maybeText, name: text, id: maybeText, index: optional(count) }),
  'content:sampleValue': object({
    ...project,
    devUrl: maybeText,
    pagePath: pathText,
    source: sampleValueSource,
  }),
  'content:targets': object({ ...named }),
  'content:validate': object({ ...project, collection: text, data }),
  'content:writeEntry': object({
    ...project,
    entry,
    edits: optional(edits),
    body: optional(text),
    expected: optional(object({ data, body: optional(text) })),
  }),
  'css:addSection': object({
    ...project,
    ...cssFile,
    title: optional(text),
    before: cssTarget,
    at: optional(count),
  }),
  'css:addVariables': object({
    ...project,
    adds: optional(list(object({ ...cssFile, name: text, value: optional(text), after: cssTarget }))),
  }),
  'css:moveHeading': object({ ...project, ...cssRange, selector: text, before: cssTarget }),
  'css:moveVariables': object({ ...project, moves: optional(list(cssMove)) }),
  'css:removeSection': object({ ...project, ...cssRange }),
  'css:renameVariables': object({ ...project, renames: list(object({ from: text, to: text })) }),
  'css:setSectionTitle': object({ ...project, ...cssRange, title: optional(text) }),
  'css:setVariable': object({
    ...project,
    file: pathText,
    valueStart: count,
    valueEnd: count,
    expect: optional(text),
    value: text,
  }),
  'css:variables': pathText,
  'dev:diagnose': pathText,
  'dev:probe': pathText,
  'dev:start': pathText,
  'dev:stop': nothing,
  'git:allFiles': object({ ...project }),
  'git:checkout': object({ ...branch, create: maybeFlag, parkFirst: maybeFlag }),
  'git:commit': object({ ...project, message: text, paths: optional(list(pathText)) }),
  'git:commitDiff': parseCommitDiffRequest,
  'git:avatars': parseCommitAvatarRequest,
  'git:deleteBranch': object({ ...branch, force: maybeFlag }),
  'git:ghStatus': pathText,
  'git:info': pathText,
  'git:init': pathText,
  'git:log': object({
    ...project,
    ref: optional(text),
    limit: optional(count),
    skip: optional(count),
    withFiles: optional(boolean),
  }),
  'git:merge': object({ ...branch }),
  'git:park': object({ ...project }),
  'git:repositories': nothing,
  'git:clone': object({ repository: parseGitHubRepository }),
  'git:connect': object({ ...project, repository: parseGitHubRepository }),
  'publish:start': object({
    ...project,
    target: parsePublishTarget,
    commitMessage: optional(parsePublishCommitMessage),
  }),
  'publish:state': pathText,
  'publish:availability': pathText,
  'publish:siteURL': pathText,
  'publish:repository': object({ ...project, request: parseRepositoryRequest }),
  'publish:discover': object({ ...project, request: parseDiscoveryRequest }),
  'publish:account': object({ ...project, request: parseAccountRequest }),
  'cmsConnections:list': object({ ...project }),
  'cmsConnections:save': object({ ...project, draft: parseCmsConnectionDraft }),
  'cmsConnections:remove': object({ ...project, id: parseConnectionId }),
  'cmsConnections:sanityLogin': object({ ...project, request: parseSanityLoginRequest }),
  'cmsRemote:collections': object({ ...project, connectionId: parseRemoteConnection }),
  'cmsRemote:documents': object({
    ...project,
    connectionId: parseRemoteConnection,
    collection: parseRemoteCollectionName,
    columns: optional(parseRemoteColumns),
  }),
  'cmsRemote:template': object({
    ...project,
    connectionId: parseRemoteConnection,
    collection: parseRemoteCollectionName,
  }),
  'cmsRemote:document': object({
    ...project,
    connectionId: parseRemoteConnection,
    id: parseRemoteDocumentId,
  }),
  'cmsRemote:create': object({
    ...project,
    connectionId: parseRemoteConnection,
    collection: parseRemoteCollectionName,
  }),
  'cmsRemote:delete': object({
    ...project,
    connectionId: parseRemoteConnection,
    ids: parseRemoteIds,
  }),
  'cmsRemote:move': object({
    ...project,
    connectionId: parseRemoteConnection,
    move: parseRemoteMove,
  }),
  'cmsRemote:write': object({
    ...project,
    connectionId: parseRemoteConnection,
    write: parseRemoteWrite,
  }),
  'cmsRemote:act': object({
    ...project,
    connectionId: parseRemoteConnection,
    id: parseRemoteDocumentId,
    action: parseRemoteDocumentAction,
  }),
  'cmsRemote:history': object({
    ...project,
    connectionId: parseRemoteConnection,
    id: parseRemoteDocumentId,
  }),
  'cmsRemote:restore': object({
    ...project,
    connectionId: parseRemoteConnection,
    id: parseRemoteDocumentId,
    revision: parseRemoteRevisionId,
  }),
  'cmsRemote:references': object({
    ...project,
    connectionId: parseRemoteConnection,
    types: parseRemoteTypes,
  }),
  'cmsRemote:upload': object({
    ...project,
    connectionId: parseRemoteConnection,
    kind: parseRemoteAssetKind,
  }),
  'cmsRemote:linkPreview': object({ url: parseVideoLinkURL }),
  // Stacki Apps (shared/properties/apps.ts). Install is staged, then committed once an admin confirms it.
  'apps:list': object({ ...project }),
  'apps:pickFile': object({ ...project }),
  'apps:stageGitHub': object({ ...project, source: parseGitHubSource, tag: optional(parseReleaseTag) }),
  'apps:githubRepositories': object({ ...project, account: parseGitHubLogin }),
  'apps:githubReleases': object({ ...project, source: parseGitHubSource }),
  'apps:commit': object({ ...project, token: parseStagedToken }),
  'apps:discard': object({ ...project, token: parseStagedToken }),
  'apps:uninstall': object({ ...project, id: parseAppId }),
  'apps:checkUpdates': object({ ...project, force: maybeFlag }),
  'apps:applyUpdate': object({ ...project, id: parseAppId }),
  // Apps added as a folder (shared/properties/appFolders.ts): the folders that do not read as an app,
  // and showing one in the file manager.
  'apps:folders': object({ ...project }),
  'apps:revealFolder': object({ ...project, folder: parseAppFolderName }),
  // The official marketplace (shared/properties/appMarketplace.ts): browse its index, install an approved version.
  'apps:marketplace': object({ ...project, refresh: maybeFlag }),
  'apps:installMarketplace': object({ ...project, id: parseAppId, version: parseAppVersion }),
  'apps:setAutoUpdate': object({ ...project, id: parseAppId, autoUpdate: boolean }),
  // Where an installed app lives (shared/properties/appPlace.ts): its GitHub repository's visibility, read in main.
  'apps:repositoryVisibility': object({ ...project, id: parseAppId }),
  // Sharing and publishing apps (shared/properties/appPublish.ts). Every GitHub call runs in main with the account's token.
  'apps:scanSecrets': object({ ...project, target: parseAppScanTarget }),
  'apps:repositoryStatus': object({ ...project, repository: parseAppRepositoryRef }),
  'apps:makePublic': object({ ...project, repository: parseAppRepositoryRef }),
  'apps:addLicense': object({ ...project, repository: parseAppRepositoryRef }),
  'apps:share': object({ ...project, share: parseAppShareRequest }),
  'apps:switchSource': object({ ...project, id: parseAppId, source: parseSharedReleaseSource }),
  'apps:checkMarketplace': object({ ...project, repository: parseAppRepositoryRef }),
  'apps:submitMarketplace': object({ ...project, submission: parseMarketplaceSubmission }),
  // App settings (shared/properties/appSettings.ts): main checks the values against the app's own declarations.
  'apps:readSettings': object({ ...project, id: parseAppId }),
  'apps:writeSettings': object({ ...project, id: parseAppId, values: parseAppSettingValuesReply }),
  // Pages and components an app reads (`page.findByAttribute`): stamped in one batch, at most the files an app may read.
  'apps:fileStamps': object({ ...project, rels: appFileList }),
  // App storage (shared/properties/appStorage.ts) and who the person is (appsRpc.ts AppPerson). A write
  // carries the window's writer token, so the change notice tells the window its own write.
  'apps:storageGet': object({ ...project, id: parseAppId, scope: parseAppStorageScope, key: parseAppStorageKey }),
  'apps:storageSet': object({
    ...project,
    id: parseAppId,
    scope: parseAppStorageScope,
    key: parseAppStorageKey,
    value: optional(parseAppStorageValue),
    writer: parseAppStorageWriter,
  }),
  'apps:storageKeys': object({ ...project, id: parseAppId, scope: parseAppStorageScope }),
  'apps:storageWatch': object({ ...project }),
  'apps:person': object({ ...project }),
  'apps:people': object({ ...project }),
  'apps:hostVersion': nothing,
  // `canvas.snapshot`: main photographs this region of the sender's window (the canvas, cropped to an element).
  'apps:canvasSnapshot': canvasSnapshotRequest,
  // Project files an app reads and writes (shared/properties/appFiles.ts): each path checked for the app that asks.
  'apps:files': appFileRequest,
  // OAuth sign-ins (shared/properties/appAuth.ts): main runs the flow and keeps the tokens; the renderer gets an access token only.
  'apps:authConnect': object({ ...project, id: parseAppId, provider: parseAuthProviderId }),
  'apps:authStatus': object({ ...project, id: parseAppId }),
  'apps:authToken': object({ ...project, id: parseAppId, provider: parseAuthProviderId }),
  'apps:authDisconnect': object({ ...project, id: parseAppId, provider: parseAuthProviderId }),
  // A request main makes for an app (shared/properties/appNet.ts), to the hosts its manifest declares only.
  'apps:netFetch': object({ ...project, id: parseAppId, request: parseAppNetRequest }),
  'mediaHosting:connections': object({ ...project }),
  'mediaHosting:save': object({ ...project, draft: parseMediaConnectionDraft }),
  'mediaHosting:remove': object({ ...project, id: parseMediaConnectionId }),
  'mediaHosting:discover': object({ ...project, key: parseMediaAccountKey }),
  'mediaHosting:connectAccount': object({ ...project, connect: parseMediaAccountConnect }),
  'mediaHosting:list': object({ ...mediaFolder }),
  'mediaHosting:pickUpload': object({ ...mediaFolder }),
  'mediaHosting:upload': object({ ...mediaFolder, filePaths: uploadPaths }),
  'mediaHosting:createFolder': object({ ...mediaFolder, name: parseMediaName }),
  'mediaHosting:rename': object({ ...mediaFolder, entry: mediaEntry, from: parseMediaName, to: parseMediaName }),
  'mediaHosting:delete': object({ ...mediaFolder, entry: mediaEntry, name: parseMediaName }),
  'mediaHosting:reorder': object({ ...mediaFolder, order: parseMediaOrder }),
  'mediaHosting:replace': object({ ...mediaFolder, name: parseMediaName }),
  'git:publish': object({ ...project, repoName: text, isPrivate: boolean }),
  'git:push': object({ ...branch }),
  'git:pull': object({ ...branch }),
  'git:incoming': object({ ...branch }),
  'git:resolveMerge': object({ ...branch, choices: optional(dictionary(parseMergeResolution)) }),
  'git:restoreFile': object({ ...reference, path: pathText }),
  'git:restoreProject': object({ ...reference }),
  'git:status': object({ ...project }),
  'git:unpark': object({ ...project }),
  'git:worktrees': object({ ...project }),
  'microphone:openSettings': nothing,
  'microphone:request': nothing,
  'microphone:status': nothing,
  'native:copy': nothing,
  'native:paste': nothing,
  'native:redo': nothing,
  'native:undo': nothing,
  'page:create': object({
    ...named,
    layout: optional(nullable(object({ name: text, path: pathText }))),
  }),
  'page:delete': pathText,
  'pageTemplate:create': object({ ...project, draft: parsePageTemplateDraft, devUrl: maybeText, keyCopy: optional(parseConnectionKeyCopy) }),
  'pageTemplate:plan': object({ ...project, draft: parsePageTemplateDraft }),
  'pageTemplate:sample': object({ ...project, request: parseDataSampleRequest }),
  'project:setEnv': object({ ...project, name: parseEnvPayloadName, value: parseSecretValue }),
  // The Settings panel's Secrets tab (shared/properties/secrets.ts): names listed, one value read on request, one change applied against a revision.
  'secrets:list': object({ ...project }),
  'secrets:read': object({ ...project, revision: parseSecretsRevision, index: parseSecretReadIndex }),
  'secrets:apply': object({ ...project, revision: parseSecretsRevision, change: parseSecretsChange }),
  'secrets:ignore': object({ ...project }),
  // The Settings panel's MCP tab (shared/properties/mcp.ts): the project's .mcp.json listed, read as text, one server revealed, a change or the whole text saved against a revision, and Codex's file.
  'mcp:read': object({ ...project }),
  'mcp:readText': object({ ...project }),
  'mcp:reveal': object({ ...project, revision: parseMcpRevision, name: parseMcpServerName }),
  'mcp:apply': object({ ...project, revision: parseMcpRevision, change: parseMcpChange }),
  'mcp:saveText': object({ ...project, revision: parseMcpRevision, text: parseMcpTextInput }),
  'mcp:readCodex': object({ ...project }),
  'mcp:revealCodex': object({ ...project, revision: parseMcpRevision, name: parseMcpServerName }),
  'mcp:applyCodex': object({ ...project, revision: parseMcpRevision, projectRevision: parseMcpRevision, change: parseMcpCodexChange }),
  'audit:render': object({ ...project, devUrl: loopbackOrigin, route: routePath }),
  'audit:measure': object({ ...project, devUrl: loopbackOrigin, route: routePath }),
  'page:dynamicPaths': object({ ...project, pagePath: pathText, devUrl: maybeText }),
  // A visual edit in the renderer's terms, authored against the checksum of
  // the page it shows; main turns it into an intent (step 6).
  'page:edit': parseEditRequest,
  // Several edits of one gesture, planned in memory and written once.
  'page:editBatch': parseEditBatchRequest,
  'page:importPathFor': object({
    pagePath: pathText,
    targetPath: pathText,
    projectPath: maybePath,
  }),
  'page:move': object({ ...project, from: pathText, to: pathText }),
  'page:parse': object({ pagePath: pathText, source: text }),
  // An edit request planned against `source` (the bytes at authoredChecksum)
  // and never written: reviewing an .astro page's unsaved gestures in code.
  'page:previewEdit': object({
    pagePath: pathText,
    authoredChecksum: digest,
    edit: parseEdit,
    source: text,
  }),
  'page:read': pathText,
  'page:rebaseImport': object({ fromPagePath: maybePath, toPagePath: maybePath, spec: text }),
  'pagefolder:create': object({ ...project, dir: pathText }),
  'pagefolder:delete': object({ ...project, dir: pathText }),
  'pagefolder:rename': object({ ...project, from: pathText, to: pathText }),
  'preview:atCommit': object({ ...reference }),
  // A canvas rendering's manifest and token, checked against the disk (step 7).
  'preview:check': object({ ...project, render: parsePreviewRender }),
  'preview:stop': object({ ...project }),
  'project:classes': pathText,
  'project:close': maybePath,
  'project:createAstro': object({
    parentPath: pathText,
    name: text,
    template: optional(text),
    install: maybeFlag,
    git: maybeFlag,
    ai: maybeFlag,
    packageManager: optional(parseCreatePackageManager),
  }),
  'project:createStarter': object({
    starter: optional(text),
    parentPath: pathText,
    name: text,
    packageManager: optional(parseCreatePackageManager),
  }),
  'project:injectedRoutes': object({ ...project }),
  'project:openDialog': nothing,
  'project:parentDialog': nothing,
  'project:pending': nothing,
  'project:resolveImport': object({ ...source }),
  'project:scan': pathText,
  'recents:add': pathText,
  'recents:list': nothing,
  'recents:refreshThumb': pathText,
  'recents:remove': pathText,
  'selection:copy': object({ ...project, keys: strings }),
  'settings:get': nothing,
  'settings:set': object({ setting: parsePreferenceName, enabled: boolean }),
  'shell:openExternal': pathText,
  'src:readSymbol': object({ ...source, name: text }),
  'src:readText': object({ ...relative }),
  'src:resolvePath': object({ ...source }),
  'src:writeText': object({ ...relative, text }),
  'style:listAstroStyles': pathText,
  'style:listFiles': pathText,
  'style:readFile': pathText,
  'style:writeFile': object({ filePath: pathText, css: text, announce: maybeFlag }),
  'style:selectorUsage': object({ ...project, packages: optional(packageSearch) }),
  'style:removeSelectors': object({ ...project, ids: parseSelectorIds, files: parseSelectorFileDigests, reach: optional(removalReach) }),
  'style:restoreSelectors': object({ ...project, changes: parseSelectorFileChanges, to: restoreDirection }),
  'terminal:clipboardImage': object({ bytes: imageBytes, mime: text }),
  'terminal:close': object({ id: text }),
  'terminal:resize': object({ id: text, cols: terminalDimension, rows: terminalDimension }),
  'terminal:start': object({
    id: text,
    cwd: pathText,
    cols: terminalDimension,
    rows: terminalDimension,
    autoLaunch: optional(text),
  }),
  'watch:start': pathText,
} as const;

export type IpcChannel = keyof typeof IPC_PAYLOADS;
export type IpcPayloads = { readonly [K in IpcChannel]: Parsed<(typeof IPC_PAYLOADS)[K]> };

export function parseIpcPayload<K extends IpcChannel>(channel: K, input: unknown): IpcPayloads[K] {
  // The channel indexes the same map used to derive IpcPayloads. Each parser
  // validates its own fields; this assertion preserves that key correlation.
  return IPC_PAYLOADS[channel](input) as IpcPayloads[K];
}

// One-way `send` channels. They need no reply, so they stay out of the invoke
// inventory above, but their payloads cross the same boundary: a keystroke is
// bounded text, and an acknowledgement is a count — never NaN or negative,
// which would switch the terminal's backpressure off for good.
export const parseTerminalInput = object({ id: text, data: text });
export const parseTerminalAck = object({ id: text, count });
export type TerminalInput = Parsed<typeof parseTerminalInput>;
export type TerminalAck = Parsed<typeof parseTerminalAck>;
