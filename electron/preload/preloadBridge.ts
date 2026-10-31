// The app's API on window.avb: every call the renderer makes to the main
// process, exposed to the app's own frame only — a previewed site never sees
// it. Each section returns its part of the API; exposeBridge joins them, and
// `satisfies PreloadBridge` holds the whole to the shared contract.
import type { PreloadBridge } from '../../shared/ipc/preloadApi';
import type { IpcChannel, IpcPayloads } from '../../shared/ipc/ipcPayloads';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Types erase here: sandboxed preload cannot require arbitrary local modules.
// Main parses every payload before it reaches a handler.
const invoke =
  <K extends IpcChannel>(channel: K) =>
  (
    ...args: undefined extends IpcPayloads[K]
      ? [payload?: IpcPayloads[K]]
      : [payload: IpcPayloads[K]]
  ): Promise<unknown> =>
    ipcRenderer.invoke(channel, args[0]);

export function exposeBridge(): void {
  contextBridge.exposeInMainWorld('avb', {
    ...projectBridge(),
    ...dataBridge(),
    ...pageBridge(),
    ...terminalBridge(),
    ...eventBridge(),
  } satisfies PreloadBridge);
}

// The project, its assets and files, and the canvas selection.
function projectBridge() {
  return {
    platform: process.platform,
    createDefaultsCanvas: invoke('project:createDefaultsCanvas'),
    removeDefaultsCanvas: invoke('project:removeDefaultsCanvas'),

    publishStart: invoke('publish:start'),
    publishState: invoke('publish:state'),
    publishAvailability: invoke('publish:availability'),
    publishedSiteURL: invoke('publish:siteURL'),
    publishingRepositories: invoke('publish:repository'),
    discoverPublishing: invoke('publish:discover'),
    publishingAccount: invoke('publish:account'),
    cmsConnections: invoke('cmsConnections:list'),
    saveCmsConnection: invoke('cmsConnections:save'),
    removeCmsConnection: invoke('cmsConnections:remove'),
    sanityLogin: invoke('cmsConnections:sanityLogin'),
    remoteCollections: invoke('cmsRemote:collections'),
    remoteDocuments: invoke('cmsRemote:documents'),
    remoteDocument: invoke('cmsRemote:document'),
    writeRemoteDocument: invoke('cmsRemote:write'),
    remoteReferenceOptions: invoke('cmsRemote:references'),
    actOnRemoteDocument: invoke('cmsRemote:act'),
    remoteHistory: invoke('cmsRemote:history'),
    restoreRemoteRevision: invoke('cmsRemote:restore'),
    uploadRemoteAsset: invoke('cmsRemote:upload'),
    createRemoteDocument: invoke('cmsRemote:create'),
    deleteRemoteDocuments: invoke('cmsRemote:delete'),
    moveRemoteDocument: invoke('cmsRemote:move'),
    projectMetadata: invoke('project:metadata'),
    writeProjectMetadata: invoke('project:writeMetadata'),
    studioStatus: invoke('studio:status'),
    installStudio: invoke('studio:install'),

    // Project:
    openProjectDialog: invoke('project:openDialog'),
    createAstroProject: invoke('project:createAstro'),
    parentDialog: invoke('project:parentDialog'),
    createStarter: invoke('project:createStarter'),
    scanProject: invoke('project:scan'),
    listProjectClasses: invoke('project:classes'),
    watchProject: invoke('watch:start'),

    // Assets (public/)
    listAssets: invoke('assets:list'),
    pickUploadAssets: invoke('assets:pickUpload'),
    uploadAssets: invoke('assets:upload'),
    moveAsset: invoke('assets:move'),
    convertAsset: invoke('assets:convert'),
    renameAsset: invoke('assets:rename'),
    deleteAsset: invoke('assets:delete'),
    mkdirAssets: invoke('assets:mkdir'),
    readAssetText: invoke('assets:readText'),
    writeAssetText: invoke('assets:writeText'),
    // The source file an imported symbol is defined in — data files, consts,
    // anything the page pulls values from.
    readSymbolSource: invoke('src:readSymbol'),
    resolveSourcePath: invoke('src:resolvePath'),
    assetDimensions: invoke('assets:dimensions'),
    readSourceText: invoke('src:readText'),
    writeSourceText: invoke('src:writeText'),
    // OS drag-and-drop: resolve a DOM File to its filesystem path.
    getFilePath: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        // Ourselves before Electron 29: the file carried its path as a
        // non-standard property that the shipped typings never declare.
        return 'path' in file && typeof file['path'] === 'string' ? file['path'] : undefined;
      }
    },
    onAssetsChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('assets:changed', listener);
      return () => ipcRenderer.removeListener('assets:changed', listener);
    },

    // ⇧⌘C — the canvas selection as file:line pointers, for an AI chat.
    copySelection: invoke('selection:copy'),
  } satisfies Partial<PreloadBridge>;
}

// The CMS, the CSS variables and the recent projects.
function dataBridge() {
  return {
    // CMS (JSON data under src/)
    listCms: invoke('cms:list'),
    readCms: invoke('cms:read'),
    writeCms: invoke('cms:write'),
    createCms: invoke('cms:create'),
    deleteCms: invoke('cms:delete'),
    cmsUsage: invoke('cms:usage'),
    cmsAssetRef: invoke('cms:assetRef'),
    resolveImport: invoke('project:resolveImport'),
    cmsMeta: invoke('cms:meta'),
    contentConfig: invoke('content:config'),
    // Variables (CSS custom properties)
    cssVariables: invoke('css:variables'),
    setCssVariable: invoke('css:setVariable'),
    moveCssVariables: invoke('css:moveVariables'),
    addCssVariables: invoke('css:addVariables'),
    renameCssVariables: invoke('css:renameVariables'),
    setCssSectionTitle: invoke('css:setSectionTitle'),
    removeCssSection: invoke('css:removeSection'),
    addCssSection: invoke('css:addSection'),
    moveCssHeading: invoke('css:moveHeading'),
    onCssChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('css:changed', listener);
      return () => ipcRenderer.removeListener('css:changed', listener);
    },

    contentCollections: invoke('content:collections'),
    contentEntries: invoke('content:entries'),
    writeContentEntry: invoke('content:writeEntry'),
    validateContentEntry: invoke('content:validate'),
    contentTargets: invoke('content:targets'),
    contentRenamePlan: invoke('content:renamePlan'),
    renameContentEntry: invoke('content:rename'),
    setCmsMeta: invoke('cms:setMeta'),
    onCmsChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('cms:changed', listener);
      return () => ipcRenderer.removeListener('cms:changed', listener);
    },

    // Recent projects:
    listRecents: invoke('recents:list'),
    addRecent: invoke('recents:add'),
    removeRecent: invoke('recents:remove'),
    refreshThumb: invoke('recents:refreshThumb'),
  } satisfies Partial<PreloadBridge>;
}

// Pages, the dev server, the style panel's targets and git.
function pageBridge() {
  return {
    // Pages:
    readPage: invoke('page:read'),
    parsePageSource: invoke('page:parse'),
    editPage: invoke('page:edit'),
    previewPageEdit: invoke('page:previewEdit'),
    createPage: invoke('page:create'),
    deletePage: invoke('page:delete'),
    movePage: invoke('page:move'),
    createPageFolder: invoke('pagefolder:create'),
    renamePageFolder: invoke('pagefolder:rename'),
    deletePageFolder: invoke('pagefolder:delete'),
    importPathFor: invoke('page:importPathFor'),
    rebaseImport: invoke('page:rebaseImport'),
    createComponent: invoke('component:create'),
    componentProperties: invoke('component:properties'),
    editComponentProperties: invoke('component:editProperties'),
    revertComponentProperties: invoke('component:revertProperties'),
    componentUsage: invoke('component:usage'),
    dynamicPaths: invoke('page:dynamicPaths'),
    injectedRoutes: invoke('project:injectedRoutes'),
    sampleEntry: invoke('content:sampleEntry'),
    sampleValue: invoke('content:sampleValue'),

    // Dev server:
    startDevServer: invoke('dev:start'),
    stopDevServer: invoke('dev:stop'),
    diagnoseDev: invoke('dev:diagnose'),
    probeDevPage: invoke('dev:probe'),

    // Style panel targets:
    listStyleFiles: invoke('style:listFiles'),
    listAstroStyleFiles: invoke('style:listAstroStyles'),
    readStyleFile: invoke('style:readFile'),
    writeStyleFile: invoke('style:writeFile'),

    // Git:
    gitInfo: invoke('git:info'),
    ghStatus: invoke('git:ghStatus'),
    gitInit: invoke('git:init'),
    gitCheckout: invoke('git:checkout'),
    previewAtCommit: invoke('preview:atCommit'),
    previewStop: invoke('preview:stop'),
    checkPreview: invoke('preview:check'),
    gitLog: invoke('git:log'),
    gitCommitDiff: invoke('git:commitDiff'),
    gitAllFiles: invoke('git:allFiles'),
    gitStatus: invoke('git:status'),
    gitWorktrees: invoke('git:worktrees'),
    gitPark: invoke('git:park'),
    gitUnpark: invoke('git:unpark'),
    gitMerge: invoke('git:merge'),
    gitResolveMerge: invoke('git:resolveMerge'),
    gitDeleteBranch: invoke('git:deleteBranch'),
    gitCommit: invoke('git:commit'),
    gitRestoreFile: invoke('git:restoreFile'),
    gitRestoreProject: invoke('git:restoreProject'),
    gitPush: invoke('git:push'),
    gitPull: invoke('git:pull'),
    gitIncoming: invoke('git:incoming'),
    gitRepositories: invoke('git:repositories'),
    gitClone: invoke('git:clone'),
    gitConnect: invoke('git:connect'),
    gitPublish: invoke('git:publish'),

    openExternal: invoke('shell:openExternal'),

    // Dev only: the project to reopen after a "Reload All Code" relaunch.
    pendingProject: invoke('project:pending'),
    closeProject: invoke('project:close'),
  } satisfies Partial<PreloadBridge>;
}

// The terminal.
function terminalBridge() {
  return {
    // Terminal (node-pty). Keystrokes and render acks are `send`, not `invoke`:
    // they're high-frequency and one-way, so they shouldn't pay for a round trip.
    startTerminal: invoke('terminal:start'),
    resizeTerminal: invoke('terminal:resize'),
    closeTerminal: invoke('terminal:close'),
    terminalInput: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }),
    terminalAck: (id: string, count: number) => ipcRenderer.send('terminal:ack', { id, count }),
    terminalClipboardImage: (bytes: Uint8Array, mime: string) =>
      ipcRenderer.invoke('terminal:clipboardImage', { bytes, mime }),
    onTerminalData: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onTerminalExit: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
    onTerminalProcess: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('terminal:process', listener);
      return () => ipcRenderer.removeListener('terminal:process', listener);
    },
  } satisfies Partial<PreloadBridge>;
}

// What main pushes to the app, and its preferences and menu.
function eventBridge() {
  return {
    onStudioProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('studio:progress', listener);
      return () => ipcRenderer.removeListener('studio:progress', listener);
    },
    // Events:
    onPageMaybeChanged: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('page:maybe-changed', listener);
      return () => ipcRenderer.removeListener('page:maybe-changed', listener);
    },
    onDevLog: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('dev:log', listener);
      return () => ipcRenderer.removeListener('dev:log', listener);
    },
    onPreviewFailed: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('dev:preview-failed', listener);
      return () => ipcRenderer.removeListener('dev:preview-failed', listener);
    },
    onDevExit: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('dev:exit', listener);
      return () => ipcRenderer.removeListener('dev:exit', listener);
    },
    onProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('progress', listener);
      return () => ipcRenderer.removeListener('progress', listener);
    },
    // Live output from `npm create astro@latest`, shown in the new-project wizard.
    onCreateLog: (callback: (chunk: unknown) => void) => {
      const listener = (_event: unknown, chunk: unknown) => callback(chunk);
      ipcRenderer.on('create:log', listener);
      return () => ipcRenderer.removeListener('create:log', listener);
    },
    onFsChanged: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('fs:changed', listener);
      return () => ipcRenderer.removeListener('fs:changed', listener);
    },

    // App preferences — read once on load; the menu pushes changes as they happen.
    settings: invoke('settings:get'),
    setPreference: invoke('settings:set'),

    // Application menu events (macOS menu accelerators never reach the DOM)
    onMenu: (channel: string, callback: (data?: unknown) => void) => {
      // The payload is forwarded: a checkbox item sends its new state, and the
      // items that send nothing simply call back with undefined as before.
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on(`menu:${channel}`, listener);
      return () => ipcRenderer.removeListener(`menu:${channel}`, listener);
    },
    nativeCopy: invoke('native:copy'),
    nativePaste: invoke('native:paste'),
    nativeUndo: invoke('native:undo'),
    nativeRedo: invoke('native:redo'),
  } satisfies Partial<PreloadBridge>;
}
