export { historyTransport } from '../../../../src/features/history/historyTransport';
import { readVariables as readHostedVariables } from '../../../../src/features/variables/variableTransport';
export { editVariables } from '../../../../src/features/variables/variableTransport';
export const readVariables = (_project: string) => readHostedVariables();
// Same editor, browser capabilities. Native file paths never cross this boundary.
export { cmsTransport } from '../../../../src/features/cms/cmsTransport';
export { styleTransport } from '../../../../src/features/settings/styleTransport';
export { onVariablesChanged } from '../../../../src/features/variables/variableTransport';
export { onPropertyFilesChanged } from '../../../../src/features/componentProperties/propertyTransport';
export const assetDropLimit = 20;
export const assetDeletionMessage = 'The file will be removed from the draft.';
export const collectionDeletionMessage = 'Removes the collection from the shared draft.';
/** What deleting content collection entries does to their files. */
export const entryDeletionMessage = 'Their files are removed from the shared draft.';
export function assetSources(path: string, _native: readonly [string, string]): readonly [string, string] {
  const url = '/studio/api/asset?file=' + encodeURIComponent(path.replace(/^studio\//, ''));
  return [url, url];
}

export const hasVariableCommand = (_name: string): boolean => true;

export const canConvertAssets = false;
