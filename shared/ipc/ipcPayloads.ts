import { parseMergeResolution } from './mergeResolution';
import { parseAccountRequest } from './publishAccount';
import { parseRepositoryRequest } from '../ipc/publishRepository';
import { parseCanvasCreate, defaultsCanvasFile } from '../properties/defaultsCanvas';
import { parseDiscoveryRequest } from '../properties/publishDiscovery';
import { parsePublishCommitMessage, parsePublishTarget } from '../properties/publishConfig';
import { metadataKind, parseMetadataWrite } from '../properties/projectMetadata';
import { parseCreatePackageManager } from '../properties/packageManager';
import { parseImageFormat, parseImagePath } from './assetConversion';
import { parseGitHubRepository } from './githubRepository';
import { parseCommitDiffRequest } from './gitCommitDiff';
import { parsePreferenceName } from './preferences';
import { parseStudioSource } from './studioSetup';
import { parseStudioRequestId } from './studioProgress';
import { parsePropertyChange, propertySource } from '../properties/propertyEditing';
import { parseEdit, parseEditRequest } from '../engine/editRequest';
import { parsePreviewRender } from '../page/previewToken';
// Complete invoke-channel inventory. Every main-process listener receives the
// parsed shape below; payload field names retain the existing renderer protocol.
import {
  object,
  text,
  pathText,
  boolean,
  count,
  optional,
  nullable,
  list,
  dictionary,
  data,
  digest,
} from '../core/boundary';
import type { Parsed } from '../core/boundary';
import { toArray } from '../core/record';

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
const strings = list(text);
const project = { projectPath: pathText };
const relative = { ...project, rel: pathText };
const source = { ...project, fromFile: pathText, spec: text };
const named = { ...project, name: text };
const reference = { ...project, ref: text };
const branch = { ...project, branch: text };
const location = (input: unknown): string | number =>
  typeof input === 'number' ? count(input) : text(input);
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

export const IPC_PAYLOADS = {
  'project:metadata': object({ ...project, kind: metadataKind }),
  'project:createDefaultsCanvas': object({ ...project, canvas: parseCanvasCreate }),
  'project:removeDefaultsCanvas': object({ ...project, file: defaultsCanvasFile }),
  'project:writeMetadata': object({ ...project, write: parseMetadataWrite }),
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
    imports: optional(list(object({ name: optional(text), path: optional(text) }))),
    props: optional(list(data)),
  }),
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
  'content:renamePlan': object({ ...named, from: text, to: text }),
  'content:sampleEntry': object({ devUrl: maybeText, name: text, id: maybeText }),
  'content:targets': object({ ...named }),
  'content:validate': object({ ...project, collection: text, data }),
  'content:writeEntry': object({ ...project, entry, edits: optional(edits), body: optional(text) }),
  'css:addSection': object({
    ...project,
    ...cssFile,
    title: optional(text),
    before: cssTarget,
    at: optional(count),
  }),
  'css:addVariables': object({
    ...project,
    adds: optional(
      list(object({ ...cssFile, name: text, value: optional(text), after: cssTarget })),
    ),
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
  'native:copy': nothing,
  'native:paste': nothing,
  'native:redo': nothing,
  'native:undo': nothing,
  'page:create': object({
    ...named,
    layout: optional(nullable(object({ name: text, path: pathText }))),
  }),
  'page:delete': pathText,
  'page:dynamicPaths': object({ ...project, pagePath: pathText, devUrl: maybeText }),
  // A visual edit in the renderer's terms, authored against the checksum of
  // the page it shows; main turns it into an intent (step 6).
  'page:edit': parseEditRequest,
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
  'style:writeFile': object({ filePath: pathText, css: text }),
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
