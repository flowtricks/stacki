// Reads and writes the `newStyleTag` section of `.stacki/styles.json` (shared/properties/newStyleTag.ts)
// for the Style panel's writers and the Settings page. It lives in the IPC layer because both the
// Style feature and the Settings page need it and neither may import the other's feature.
//
// A write reads the whole file first and replaces only this section, witnessed by the bytes it read,
// so the keep list and locked stylesheets the Selectors panel owns are carried over untouched and an
// edit made since is refused rather than lost.

import { DEFAULT_NEW_STYLE_TAG, type NewStyleTagSettings } from '../../shared/properties/newStyleTag';
import { EMPTY_KEEP_LIST, parseStyleKeepList, serializeStyleKeepList, type StyleKeepList } from '../../shared/properties/styleKeepList';
import { readMetadata, writeMetadata } from './projectMetadataBridge';

interface Stored {
  readonly keepList: StyleKeepList;
  readonly source: string | undefined;
}

async function readStored(projectPath: string): Promise<Stored> {
  const stored = await readMetadata(projectPath, 'styles');
  if (stored.source === undefined) {
    return { keepList: EMPTY_KEEP_LIST, source: undefined };
  }
  const input: unknown = JSON.parse(stored.source);
  return { keepList: parseStyleKeepList(input), source: stored.source };
}

/** The project's setting; Stacki's default (`<style is:global>`) when the file or the section is absent. */
export async function readNewStyleTag(projectPath: string): Promise<NewStyleTagSettings> {
  const stored = await readStored(projectPath);
  return stored.keepList.newStyleTag ?? DEFAULT_NEW_STYLE_TAG;
}

/** Saves the setting, keeping everything else in the file; resolves to what the file now holds. */
export async function writeNewStyleTag(projectPath: string, settings: NewStyleTagSettings): Promise<NewStyleTagSettings> {
  const stored = await readStored(projectPath);
  const source = serializeStyleKeepList({ ...stored.keepList, newStyleTag: settings });
  await writeMetadata(projectPath, stored.source === undefined ? { kind: 'styles', source } : { kind: 'styles', source, base: stored.source });
  return settings;
}
