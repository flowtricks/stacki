// The project's folder settings (`.stacki/folders.json`) for a panel that only
// reads them, as the CMS panel does for its hidden collections. Read through the
// metadata bridge, so Desktop and Studio answer the same way. A host from before
// folder settings refuses the kind; that, like a missing or invalid file, reads
// as no settings: every panel then shows what it always showed.
import { readMetadata } from './projectMetadataBridge';
import { configOf, readProjectFoldersSource, type ProjectFolders } from '../../shared/properties/projectFolders';

// The refusal a main process or Studio server from before folder settings gives
// for the `folders` kind (shared/properties/projectMetadata.ts, metadataKind).
// Electron wraps an invoke's error in its own words, so it is found, not matched whole.
const UNKNOWN_KIND = 'Unknown project metadata file';

/** Whether a failure is an older host not knowing the `folders` kind; any other failure is a real one. */
export function isUnknownKind(failure: unknown): boolean {
  return failure instanceof Error && failure.message.includes(UNKNOWN_KIND);
}

export async function readProjectFolderSettings(projectPath: string): Promise<ProjectFolders | undefined> {
  try {
    const file = await readMetadata(projectPath, 'folders');
    return configOf(readProjectFoldersSource(file.source));
  } catch (failure: unknown) {
    if (isUnknownKind(failure)) {
      return undefined;
    }
    throw failure;
  }
}
