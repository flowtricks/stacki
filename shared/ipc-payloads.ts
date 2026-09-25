import { parsePropertyChange, propertySource } from './component-properties';
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
} from './boundary';
import type { Parsed } from './boundary';
import { toArray } from './record';

const nothing = (input: unknown): undefined => {
  if (input !== undefined) {
    throw new Error('Expected no payload');
  }
  return undefined;
};
const maybeText = optional(nullable(text));
const maybePath = optional(nullable(pathText));
const cssTarget = (input: unknown) => (input == null ? undefined : text(input));
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
  'assets:delete': object({ ...relative }),
  'assets:dimensions': object({ ...relative }),
  'assets:list': pathText,
  'assets:mkdir': object({ ...project, parentRel: pathText, name: text }),
  'assets:move': object({ ...project, fromRel: pathText, toDirRel: pathText }),
  'assets:pickUpload': object({ ...project, destRel: pathText }),
  'assets:readText': object({ ...relative }),
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
  'component:editProperties': object({ ...project, file: pathText,
    source: propertySource, change: parsePropertyChange }),
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
  'git:commitFiles': object({ ...reference }),
  'git:deleteBranch': object({ ...branch, force: maybeFlag }),
  'git:fileAt': object({ ...reference, path: pathText }),
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
  'git:publish': object({ ...project, repoName: text, isPrivate: boolean }),
  'git:push': object({ ...branch }),
  'git:resolveMerge': object({ ...branch, choices: optional(dictionary(data)) }),
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
  'page:importPathFor': object({
    pagePath: pathText,
    targetPath: pathText,
    projectPath: maybePath,
  }),
  'page:move': object({ ...project, from: pathText, to: pathText }),
  'page:parse': object({ pagePath: pathText, source: text }),
  'page:read': pathText,
  'page:rebaseImport': object({ fromPagePath: maybePath, toPagePath: maybePath, spec: text }),
  'page:write': object({ pagePath: pathText, model: (input: unknown) => input }),
  'page:writeRaw': object({ pagePath: pathText, source: text }),
  'pagefolder:create': object({ ...project, dir: pathText }),
  'pagefolder:delete': object({ ...project, dir: pathText }),
  'pagefolder:rename': object({ ...project, from: pathText, to: pathText }),
  'preview:atCommit': object({ ...reference }),
  'preview:stop': object({ ...project }),
  'project:classes': pathText,
  'project:close': maybePath,
  'project:createAstro': object({
    dir: pathText,
    template: optional(text),
    install: maybeFlag,
    git: maybeFlag,
    ai: maybeFlag,
  }),
  'project:createStarter': object({ starter: optional(text), parentPath: pathText, name: text }),
  'project:hasNodeModules': pathText,
  'project:injectedRoutes': object({ ...project }),
  'project:install': pathText,
  'project:newDialog': nothing,
  'project:openDialog': nothing,
  'project:parentDialog': nothing,
  'project:pending': nothing,
  'project:resolveImport': object({ ...source }),
  'project:scaffold': object({ dir: pathText, name: text }),
  'project:scan': pathText,
  'recents:add': pathText,
  'recents:list': nothing,
  'recents:refreshThumb': pathText,
  'recents:remove': pathText,
  'selection:copy': object({ ...project, keys: strings }),
  'settings:get': nothing,
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
  'terminal:resize': object({ id: text, cols: count, rows: count }),
  'terminal:start': object({ id: text, cwd: pathText, autoLaunch: optional(text) }),
  'watch:start': pathText,
} as const;

export type IpcChannel = keyof typeof IPC_PAYLOADS;
export type IpcPayloads = { readonly [K in IpcChannel]: Parsed<(typeof IPC_PAYLOADS)[K]> };

export function parseIpcPayload<K extends IpcChannel>(channel: K, input: unknown): IpcPayloads[K] {
  // The channel indexes the same map used to derive IpcPayloads. Each parser
  // validates its own fields; this assertion preserves that key correlation.
  return IPC_PAYLOADS[channel](input) as IpcPayloads[K];
}
