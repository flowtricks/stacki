// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the fence that keeps it from writing to the
// project.
//
// While Design mode is on, the window has a copy of the project open (the sandbox, in Stacki's own data folder),
// and every panel works on that copy for real. Two checks hold the guarantee that nothing reaches past it, each
// enough on its own for the paths it covers:
//
//   1. Requests. Every invoke channel goes through the IPC registrar (ipcRegistrar.ts), which asks
//      `checkDesignFence` first. Only channels named in DESIGN_CHANNELS run; any other, including every channel
//      added after this list was written, is refused. A channel that runs must name the sandbox as its project,
//      and may not climb out of it with `..`.
//   2. Writes. `guardDesignWrites` wraps the main process's file system calls that create, change or remove a
//      file. While the fence is up, each one must land inside the sandbox, Stacki's own data folder or the
//      temporary folder; any other target fails with EACCES before the call runs. This catches a write no request
//      check foresaw: a handler that resolves a path its own way, a symlink, a helper deep in a panel's code path.
//
// Why both: the request list is what keeps git, publishing, the terminal, the AI agent and remote services out
// (they act through child processes and the network, which no file check sees), and the write check is what
// makes "nothing touches the project" true of every path in this process, not just the ones that were reviewed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathWithin } from '../platform';

export type DesignFenceState =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'on';
      readonly sandboxRoot: string;
      /** The project itself: never written while the fence is up. */
      readonly realRoot: string;
      /** What a refused request answers, in the person's language. */
      readonly refusal: string;
      /** Where Stacki keeps its own data; writes there are the app's, not the project's. */
      readonly appDataRoot: string;
    };

/** Channels that run while Design mode is on. Anything not here is refused. Why each is safe: DESIGN_CHANNEL_REASONS. */
export const DESIGN_CHANNELS: ReadonlySet<string> = new Set([
  'design:session',
  // Opening the copy, and leaving it (project:close only records which folder to open and reloads the window).
  'watch:start',
  'project:close',
  'project:pending',
  'project:takeOpenedFolders',
  'project:scan',
  'project:classes',
  'project:injectedRoutes',
  'project:inspectFolder',
  'project:metadata',
  'project:writeMetadata',
  'project:resolveImport',
  'project:checkAstroCopy',
  'project:createDefaultsCanvas',
  'project:removeDefaultsCanvas',
  'recents:list',
  // The canvas and its dev server, which runs on the copy.
  'dev:start',
  'dev:stop',
  'dev:probe',
  'dev:diagnose',
  'dev:inspect',
  'dev:network',
  // The canvas's check that what it shows is what the copy's files say (read only).
  'preview:check',
  'audit:measure',
  'audit:render',
  // Pages, the navigator, settings and props: the page write path, on the copy's files.
  ...['page:applySettings', 'page:create', 'page:delete', 'page:dynamicPaths', 'page:edit', 'page:editBatch', 'page:importPathFor'],
  ...['page:move', 'page:parse', 'page:planRemoveMany', 'page:planSettings', 'page:previewEdit', 'page:read', 'page:readTemplate'],
  ...['page:rebaseImport', 'page:removeMany', 'page:retargetTemplate', 'page:revertSettings'],
  ...['pageTemplate:create', 'pageTemplate:plan', 'pageTemplate:sample', 'pagefolder:create', 'pagefolder:delete', 'pagefolder:rename'],
  // Styles, selectors and variables.
  ...['style:listAstroStyles', 'style:listFiles', 'style:readFile', 'style:removeSelectors', 'style:restoreSelectors'],
  ...['style:selectorUsage', 'style:writeFile', 'styleMove:clear', 'styleMove:pending', 'styleMove:record', 'styleMove:resolve'],
  ...['css:addSection', 'css:addVariables', 'css:moveHeading', 'css:moveVariables', 'css:removeSection', 'css:renameVariables'],
  ...['css:setSectionTitle', 'css:setVariable', 'css:variables', 'breakpointSync:apply', 'breakpointSync:restore'],
  ...['breakpointSync:scan', 'breakpointSync:usage'],
  // Components.
  ...['component:classUsage', 'component:create', 'component:discard', 'component:duplicate', 'component:editProperties'],
  ...['component:planRemove', 'component:planRename', 'component:previewPropertyRemoval', 'component:properties', 'component:remove'],
  ...['component:rename', 'component:restoreRemoved', 'component:revertProperties', 'component:revertRename', 'component:usage'],
  // Assets, source text and the Files panel, inside the copy.
  ...['assets:convert', 'assets:delete', 'assets:dimensions', 'assets:list', 'assets:mkdir', 'assets:move', 'assets:pickUpload'],
  ...['assets:readText', 'assets:rename', 'assets:replace', 'assets:upload', 'assets:writeText'],
  ...['src:readSymbol', 'src:readText', 'src:resolvePath', 'src:writeText'],
  ...['files:allowClose', 'files:create', 'files:find', 'files:guardClose', 'files:import', 'files:list', 'files:read'],
  ...['files:rename', 'files:transfer', 'files:trash', 'files:watch', 'files:write'],
  // Local content: collections and their files are part of the copy.
  ...['cms:assetRef', 'cms:constants', 'cms:create', 'cms:delete', 'cms:editConstants', 'cms:list', 'cms:meta', 'cms:read'],
  ...['cms:setMeta', 'cms:usage', 'cms:write', 'content:collections', 'content:config', 'content:entries', 'content:remoteRead'],
  ...['content:rename', 'content:renamePlan', 'content:sampleEntry', 'content:sampleValue', 'content:targets', 'content:validate'],
  ...['content:writeEntry', 'emdash:project', 'emdash:adminUrl', 'cmsConnections:list'],
  // Remote content, read only.
  ...['cmsRemote:collections', 'cmsRemote:documents', 'cmsRemote:document', 'cmsRemote:template', 'cmsRemote:history'],
  ...['cmsRemote:references', 'cmsRemote:linkPreview', 'mediaHosting:connections', 'mediaHosting:list'],
  // Instructions are files in the copy; reading the AI panel's chats and taking a canvas picture write nothing.
  ...['instructions:list', 'instructions:read', 'instructions:create', 'instructions:createFolder', 'instructions:write'],
  ...['ai:screenshot', 'ai:chats', 'ai:chatRead', 'ai:mentions', 'ai:sections', 'ai:pinsRead', 'ai:autoCompactGet', 'agents:list'],
  // The AI panel's chat list and comment pins live in Stacki's own data folder. The agent itself (prompt, steer,
  // setup, compact, review, remember) is refused: it runs programs that could write anywhere.
  ...['ai:chatCreate', 'ai:chatUpdate', 'ai:chatDelete', 'ai:chatFork', 'ai:chatMove', 'ai:cancel', 'ai:setOption', 'ai:record', 'ai:pinsWrite'],
  ...['mcp:read', 'mcp:readCodex', 'mcp:readText'],
  // The window's own edit commands, the clipboard, the app's settings read, the language and the updater's state.
  ...['native:copy', 'native:paste', 'native:redo', 'native:undo', 'selection:copy', 'settings:get', 'locale:set'],
  ...['update:read', 'roles:identity', 'studio:status', 'microphone:status', 'dictation:status', 'dictation:cancel'],
  'shell:openExternal',
  // What the shell polls as it opens a project, read only: answered from the copy, so no refusal reaches the
  // person as a toast for something they never asked for. Their panels are out of reach (designRole.ts).
  ...['apps:list', 'apps:folders', 'apps:checkUpdates', 'apps:storageWatch', 'publish:state', 'publish:availability', 'secrets:list'],
]);

/**
 * What the fence answers itself, for a channel the shell asks as it opens a project and whose real answer would
 * reach past the copy. git's: the copy is not a repository (git would otherwise look for one in the folders above
 * it), so the branch chip shows none instead of a refusal.
 */
const DESIGN_ANSWERS: ReadonlyMap<string, unknown> = new Map([['git:info', { isRepo: false }]]);

export type DesignFenceVerdict = { readonly kind: 'run' } | { readonly kind: 'answer'; readonly value: unknown };

const RUN: DesignFenceVerdict = { kind: 'run' };

/** Keys whose values are files picked outside the project to copy in: reading them is not a write. */
const SOURCE_KEYS: ReadonlyMap<string, string> = new Map([
  ['assets:upload', 'filePaths'],
  ['files:import', 'sources'],
]);

/** Keys that hold a path inside the project, relative or absolute. */
const PATH_KEYS: ReadonlySet<string> = new Set(['rel', 'path', 'paths', 'target', 'destRel', 'from', 'to', 'file', 'filePath', 'dir', 'newRel', 'oldRel']);

const FENCE_LIMITS = {
  /** Values visited in one payload; a page edit batch is the widest. */
  payloadValuesMax: 200_000,
  payloadDepthMax: 24,
  /** Directories climbed to find the part of a path that exists. */
  ancestorsMax: 256,
} as const satisfies Record<string, number>;

let state: DesignFenceState = { kind: 'off' };
let observer: ((channel: string, payload: unknown) => void) | undefined = undefined;

/** Tells `listener` of every request the fence lets through while it is up (the session follows the window's opens). */
export function observeDesignFence(listener: ((channel: string, payload: unknown) => void) | undefined): void {
  observer = listener;
}

export function designFenceState(): DesignFenceState {
  return state;
}

/** Raises the fence. The roots are resolved through symlinks once, here, so every later check compares real paths. */
export function raiseDesignFence(input: {
  readonly sandboxRoot: string;
  readonly realRoot: string;
  readonly refusal: string;
  readonly appDataRoot: string;
}): void {
  if (state.kind !== 'off') {
    throw new Error('Assertion failed: raiseDesignFence: one Design mode session at a time');
  }
  const sandboxRoot = fs.realpathSync(input.sandboxRoot);
  const realRoot = fs.realpathSync(input.realRoot);
  if (isPathWithin(realRoot, sandboxRoot)) {
    throw new Error('Assertion failed: raiseDesignFence: the sandbox is outside the project');
  }
  if (isPathWithin(sandboxRoot, realRoot)) {
    throw new Error('Assertion failed: raiseDesignFence: the project is outside the sandbox');
  }
  state = { kind: 'on', sandboxRoot, realRoot, refusal: input.refusal, appDataRoot: fs.realpathSync(input.appDataRoot) };
}

export function lowerDesignFence(): void {
  state = { kind: 'off' };
}

/**
 * Throws (the request is refused, and the renderer's caller shows the message) unless `channel` may run with
 * `payload` while the fence is up; for a channel the fence answers itself, says so. Lets everything run while it is down.
 */
export function checkDesignFence(channel: string, payload: unknown): DesignFenceVerdict {
  const current = state;
  if (current.kind === 'off') {
    return RUN;
  }
  const answer = DESIGN_ANSWERS.get(channel);
  if (answer !== undefined) {
    return { kind: 'answer', value: answer };
  }
  if (!DESIGN_CHANNELS.has(channel)) {
    throw refusalError(current.refusal);
  }
  if (channel === 'project:close') {
    // Only names the folder the window opens next, and reloads; the next open is checked like any other.
    observer?.(channel, payload);
    return RUN;
  }
  if (channel === 'shell:openExternal') {
    // A web page opened in the browser; a file URL or path could name the project, so only the web is let through.
    if (typeof payload !== 'string' || !/^https?:\/\//i.test(payload)) {
      throw refusalError(current.refusal);
    }
    return RUN;
  }
  if (channel === 'watch:start' && typeof payload === 'string') {
    // The folder the window opens: while the fence is up, only the copy.
    requireInside(current, payload);
  } else if (typeof payload === 'string') {
    requireNotProject(current, payload);
  } else {
    visitPayload(current, payload, SOURCE_KEYS.get(channel));
  }
  observer?.(channel, payload);
  return RUN;
}

function visitPayload(current: Exclude<DesignFenceState, { kind: 'off' }>, payload: unknown, sourceKey: string | undefined): void {
  let visited = 0;
  const pending: { value: unknown; key: string; depth: number }[] = [{ value: payload, key: '', depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    visited += 1;
    if (visited > FENCE_LIMITS.payloadValuesMax) {
      throw refusalError(current.refusal);
    }
    if (next.depth > FENCE_LIMITS.payloadDepthMax) {
      throw refusalError(current.refusal);
    }
    if (next.key === sourceKey) {
      continue;
    }
    if (typeof next.value === 'string') {
      checkString(current, next.key, next.value);
    } else if (Array.isArray(next.value)) {
      for (const item of next.value) {
        pending.push({ value: item, key: next.key, depth: next.depth + 1 });
      }
    } else if (next.value && typeof next.value === 'object') {
      for (const [key, value] of Object.entries(next.value)) {
        pending.push({ value, key, depth: next.depth + 1 });
      }
    }
  }
}

function checkString(current: Exclude<DesignFenceState, { kind: 'off' }>, key: string, value: string): void {
  if (key === 'projectPath') {
    requireInside(current, value);
    return;
  }
  if (!PATH_KEYS.has(key)) {
    return;
  }
  if (path.isAbsolute(value)) {
    // Also a route (`/blog`) in some requests: what is refused is a path into the project or another folder of
    // the person's, never the copy, Stacki's own data or a page address.
    requireNotProject(current, value);
    return;
  }
  // A relative path that climbs is refused outright: the request names files inside the copy, and nothing in it
  // needs to step out of a folder to say so.
  if (value.split(/[\\/]/).includes('..')) {
    throw refusalError(current.refusal);
  }
}

function requireNotProject(current: Exclude<DesignFenceState, { kind: 'off' }>, candidate: string): void {
  if (!path.isAbsolute(candidate)) {
    return;
  }
  const real = realTarget(path.resolve(candidate));
  if (isPathWithin(current.realRoot, real)) {
    throw refusalError(current.refusal);
  }
  if (isPathWithin(current.sandboxRoot, real) || isPathWithin(current.appDataRoot, real)) {
    return;
  }
  if (isPathWithin(realTarget(os.homedir()), real)) {
    throw refusalError(current.refusal);
  }
}

function requireInside(current: Exclude<DesignFenceState, { kind: 'off' }>, candidate: string): void {
  if (!isPathWithin(current.sandboxRoot, realTarget(path.resolve(candidate)))) {
    throw refusalError(current.refusal);
  }
}

/** `target` with the part of it that exists resolved through symlinks, so a link cannot carry a write out. */
export function realTarget(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (let climbed = 0; climbed < FENCE_LIMITS.ancestorsMax; climbed += 1) {
    try {
      const real = fs.realpathSync.native(existing);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        return target;
      }
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
  throw new Error('Assertion failed: realTarget: a path has fewer ancestors than the bound');
}

function refusalError(message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code: 'EACCES' });
  return error;
}

/** Whether a write to `target` may go ahead now. */
export function designWriteAllowed(target: string): boolean {
  const current = state;
  if (current.kind === 'off') {
    return true;
  }
  const real = realTarget(path.resolve(target));
  if (isPathWithin(current.realRoot, real)) {
    return false;
  }
  if (isPathWithin(current.sandboxRoot, real)) {
    return true;
  }
  if (isPathWithin(current.appDataRoot, real)) {
    return true;
  }
  return isPathWithin(realTarget(os.tmpdir()), real);
}

/** The refusal a blocked write throws. */
export function designWriteRefusal(target: string): Error {
  const current = state;
  const error = new Error(`${current.kind === 'off' ? '' : current.refusal} (${path.basename(target)})`);
  Object.assign(error, { code: 'EACCES', path: target });
  return error;
}
