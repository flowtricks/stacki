// The Assets panel's search as values: which files a query finds across the whole project, by name
// and by path, without caring about case or accents.
//
// Pure: the panel builds the index once per listing (every file's path folded to lowercase and
// without accents, one string each) and each keystroke is then one linear pass over those strings
// with `String.includes`. That is the whole per-keystroke cost, so no debounce is needed: 5,000
// files are 5,000 substring checks. The result is the matching files in listing order; the panel
// sorts them with the view's sort and draws only the window on screen (AssetItems.tsx), so the
// number of matches never grows the DOM.
//
// A query is words: a file matches when every word is somewhere in its path (`hero png`,
// `images hero`). The path holds the name, so one haystack covers both.
import { assert } from '../../../shared/core/assert';
import { foldSearchText, holdsEveryWord, queryWords } from '../../lib/searchText';
import type { AssetFile } from './assetPaths';
import type { AssetPanelEntry } from './assetPanelBridge';

/** Every file of one listing with the text a query is held against, kept side by side. */
export interface AssetIndex {
  readonly files: readonly AssetFile[];
  /** `haystacks[index]` is `foldSearchText(files[index].rel)`. */
  readonly haystacks: readonly string[];
}

export { foldSearchText, isSearching, queryWords } from '../../lib/searchText';

export const EMPTY_ASSET_INDEX: AssetIndex = { files: [], haystacks: [] };

/** The index of the files in a listing, built once per listing: one pass, folding each path once. */
export function buildAssetIndex(entries: readonly AssetPanelEntry[], accepts: (file: AssetFile) => boolean): AssetIndex {
  const files: AssetFile[] = [];
  const haystacks: string[] = [];
  for (const entry of entries) {
    if (!isAssetFile(entry)) {
      continue;
    }
    if (accepts(entry)) {
      files.push(entry);
      haystacks.push(foldSearchText(entry.rel));
    }
  }
  assert(files.length === haystacks.length, 'Every indexed file has its text');
  assert(files.length <= entries.length, 'The index holds no more than the listing');
  return { files, haystacks };
}

/**
 * The files whose path holds every word of the query, in the order the index lists them. A query
 * with no word finds nothing: the panel shows the folder instead of searching.
 */
export function searchAssets(index: AssetIndex, query: string): readonly AssetFile[] {
  const words = queryWords(query);
  assert(index.files.length === index.haystacks.length, 'The index is whole');
  if (words.length === 0) {
    return [];
  }
  const found: AssetFile[] = [];
  for (let position = 0; position < index.files.length; position += 1) {
    const haystack = index.haystacks[position];
    const file = index.files[position];
    if (haystack === undefined || file === undefined) {
      continue;
    }
    if (holdsEveryWord(haystack, words)) {
      found.push(file);
    }
  }
  assert(found.length <= index.files.length, 'A search never finds more files than there are');
  return found;
}

function isAssetFile(entry: AssetPanelEntry): entry is AssetFile {
  return !entry.isDir;
}
