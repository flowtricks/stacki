import type { PreloadBridge } from '../../shared/ipc/preloadApi';
// Native capabilities stay behind this boundary; Studio supplies its HTTP adapter.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
export const historyTransport = {
  log: (payload: Parameters<PreloadBridge['gitLog']>[0]) => window.avb.gitLog(payload),
  diff: (payload: Parameters<PreloadBridge['gitCommitDiff']>[0]) =>
    window.avb.gitCommitDiff(payload),
};
export { onFilesChanged as onPropertyFilesChanged } from '../ipc/appBridge';
export const cmsTransport = {
  writeContentEntry: (
    payload: Parameters<PreloadBridge['writeContentEntry']>[0],
    expected?: unknown,
  ) =>
    window.avb.writeContentEntry(parseIpcPayload('content:writeEntry', { ...payload, expected })),
  writeCms: (payload: Parameters<PreloadBridge['writeCms']>[0], _expected?: unknown) =>
    window.avb.writeCms(payload),
  renameContentEntry: (payload: Parameters<PreloadBridge['renameContentEntry']>[0]) =>
    window.avb.renameContentEntry(payload),
  contentRenamePlan: (payload: Parameters<PreloadBridge['contentRenamePlan']>[0]) =>
    window.avb.contentRenamePlan(payload),
  validateContentEntry: (payload: Parameters<PreloadBridge['validateContentEntry']>[0]) =>
    window.avb.validateContentEntry(payload),
  contentTargets: (payload: Parameters<PreloadBridge['contentTargets']>[0]) =>
    window.avb.contentTargets(payload),
  contentEntries: (payload: Parameters<PreloadBridge['contentEntries']>[0]) =>
    window.avb.contentEntries(payload),
  contentCollections: (payload: Parameters<PreloadBridge['contentCollections']>[0]) =>
    window.avb.contentCollections(payload),
  contentRemoteRead: (payload: Parameters<PreloadBridge['contentRemoteRead']>[0]) =>
    window.avb.contentRemoteRead(payload),
  contentRemoteEdit: (payload: Parameters<PreloadBridge['contentRemoteEdit']>[0]) =>
    window.avb.contentRemoteEdit(payload),
  cmsAssetRef: (payload: Parameters<PreloadBridge['cmsAssetRef']>[0]) =>
    window.avb.cmsAssetRef(payload),
  deleteCms: (payload: Parameters<PreloadBridge['deleteCms']>[0]) => window.avb.deleteCms(payload),
  cmsUsage: (payload: Parameters<PreloadBridge['cmsUsage']>[0]) => window.avb.cmsUsage(payload),
  setCmsMeta: (payload: Parameters<PreloadBridge['setCmsMeta']>[0]) =>
    window.avb.setCmsMeta(payload),
  createCms: (payload: Parameters<PreloadBridge['createCms']>[0]) => window.avb.createCms(payload),
  cmsMeta: (payload: Parameters<PreloadBridge['cmsMeta']>[0]) => window.avb.cmsMeta(payload),
  readCms: (payload: Parameters<PreloadBridge['readCms']>[0]) => window.avb.readCms(payload),
  listCms: (payload: Parameters<PreloadBridge['listCms']>[0]) => window.avb.listCms(payload),
  onCmsChanged: (callback: () => void) => window.avb.onCmsChanged(callback),
};
export const onVariablesChanged = (callback: () => void) => window.avb.onCssChanged(callback);
export const styleTransport = {
  readStyleFile: (payload: Parameters<PreloadBridge['readStyleFile']>[0]) =>
    window.avb.readStyleFile(payload),
  listAstroStyleFiles: (payload: Parameters<PreloadBridge['listAstroStyleFiles']>[0]) =>
    window.avb.listAstroStyleFiles(payload),
  listStyleFiles: (payload: Parameters<PreloadBridge['listStyleFiles']>[0]) =>
    window.avb.listStyleFiles(payload),
  writeStyleFile: (input: {
    readonly filePath: string;
    readonly css: string;
    readonly base?: string;
  }) => window.avb.writeStyleFile(parseIpcPayload('style:writeFile', input)),
};
export const assetDropLimit = 1_000;
export const assetDeletionMessage = 'The file moves to your Bin.';
export const collectionDeletionMessage = 'Moves the collection to the Trash.';
/** What deleting content collection entries does to their files. */
export const entryDeletionMessage = 'Their files move to the Trash.';
export function assetSources(
  _path: string,
  native: readonly [string, string],
): readonly [string, string] {
  return native;
}

export const readVariables = (project: string) =>
  window.avb.cssVariables(parseIpcPayload('css:variables', project));
const variableCommands = {
  setCssVariable: (payload: Parameters<PreloadBridge['setCssVariable']>[0]) =>
    window.avb.setCssVariable(payload),
  moveCssVariables: (payload: Parameters<PreloadBridge['moveCssVariables']>[0]) =>
    window.avb.moveCssVariables(payload),
  addCssVariables: (payload: Parameters<PreloadBridge['addCssVariables']>[0]) =>
    window.avb.addCssVariables(payload),
  renameCssVariables: (payload: Parameters<PreloadBridge['renameCssVariables']>[0]) =>
    window.avb.renameCssVariables(payload),
  setCssSectionTitle: (payload: Parameters<PreloadBridge['setCssSectionTitle']>[0]) =>
    window.avb.setCssSectionTitle(payload),
  addCssSection: (payload: Parameters<PreloadBridge['addCssSection']>[0]) =>
    window.avb.addCssSection(payload),
  removeCssSection: (payload: Parameters<PreloadBridge['removeCssSection']>[0]) =>
    window.avb.removeCssSection(payload),
  moveCssHeading: (payload: Parameters<PreloadBridge['moveCssHeading']>[0]) =>
    window.avb.moveCssHeading(payload),
};
export function editVariables<Name extends keyof typeof variableCommands>(
  name: Name,
  payload: Parameters<(typeof variableCommands)[Name]>[0],
): Promise<unknown> {
  // Each command is already validated by variableEditBridge's discriminated command table.
  switch (name) {
    case 'setCssVariable':
      return variableCommands.setCssVariable(parseIpcPayload('css:setVariable', payload));
    case 'moveCssVariables':
      return variableCommands.moveCssVariables(parseIpcPayload('css:moveVariables', payload));
    case 'addCssVariables':
      return variableCommands.addCssVariables(parseIpcPayload('css:addVariables', payload));
    case 'renameCssVariables':
      return variableCommands.renameCssVariables(parseIpcPayload('css:renameVariables', payload));
    case 'setCssSectionTitle':
      return variableCommands.setCssSectionTitle(parseIpcPayload('css:setSectionTitle', payload));
    case 'addCssSection':
      return variableCommands.addCssSection(parseIpcPayload('css:addSection', payload));
    case 'removeCssSection':
      return variableCommands.removeCssSection(parseIpcPayload('css:removeSection', payload));
    case 'moveCssHeading':
      return variableCommands.moveCssHeading(parseIpcPayload('css:moveHeading', payload));
    default:
      throw new Error('Unknown variable operation');
  }
}

export const hasVariableCommand = (name: keyof PreloadBridge): boolean =>
  typeof window.avb[name] === 'function';

export const canConvertAssets = true;
