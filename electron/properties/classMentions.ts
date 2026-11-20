// Where else a project mentions a class: the files, other than one page, whose text can name it.
//
// Create component reads this to tell a class used only by the markup it extracts, whose CSS can
// move into the new component, from a class used elsewhere too (a utility, a shared class), whose
// CSS stays where it is. The texts are read as the unused-selector analysis reads them
// (selectorUsageFiles.ts): an .astro file by its text with its style blocks blanked, so a selector
// in another component's <style> is not a use; every other text as it is; and stylesheets not at
// all, since a rule for a class is not a use of it.

import { assert } from '../../shared/core/assert';
import { emptyHits, mentionInterest, scanMentions } from './selectorMentions';
import type { AstroSheet } from './selectorSheets';
import type { ProjectText } from './selectorUsage';
import { readSelectorUsageInput } from './selectorUsageFiles';
import { EMPTY_KEEP_LIST } from '../../shared/properties/styleKeepList';
import { CLASS_USAGE_LIMITS } from '../../shared/properties/classUsage';

// Only the site's own source counts. A README or a framework's notes (LUMOS.md) use class names as plain
// words in sentences, and public/ holds files served as they are, which almost never carry the class.
const SEARCHED_FOLDER = 'src/';

/** The texts that can mention a class, as `readSelectorUsageInput` reads a project. */
export interface MentionTexts {
  readonly astro: readonly Pick<AstroSheet, 'rel' | 'ownText'>[];
  readonly others: readonly ProjectText[];
}

/** For each class, the files under src/ other than `excludedRel` that mention it, in path order; a class no file mentions maps to []. */
export function classMentionFiles(texts: MentionTexts, classes: readonly string[], excludedRel: string): ReadonlyMap<string, readonly string[]> {
  assert(classes.length <= CLASS_USAGE_LIMITS.classesMax, 'classMentionFiles: classes within limit');
  assert(
    classes.every((name) => name.length > 0),
    'classMentionFiles: class names are non-empty',
  );
  const found = new Map<string, string[]>(classes.map((name) => [name, []]));
  if (classes.length === 0) {
    return found;
  }
  const interest = mentionInterest(classes);
  const files = [...texts.astro.map((sheet) => ({ rel: sheet.rel, text: sheet.ownText })), ...texts.others]
    .filter((file) => file.rel.startsWith(SEARCHED_FOLDER))
    .filter((file) => file.rel !== excludedRel)
    .sort((left, right) => (left.rel < right.rel ? -1 : 1));
  for (const file of files) {
    // One scan per file, so each hit is known by the file it came from.
    const hits = emptyHits();
    scanMentions(file.text, interest, hits);
    for (const name of hits.words) {
      const list = found.get(name);
      if (list !== undefined && list.length < CLASS_USAGE_LIMITS.filesPerClassMax) {
        list.push(file.rel);
      }
    }
  }
  assert(found.size === new Set(classes).size, 'classMentionFiles: one entry per class asked about');
  return found;
}

/** Reads the project at `root` and answers `classMentionFiles` for it, leaving the page `pageRel` out. */
export async function findClassMentions(
  root: string,
  classes: readonly string[],
  pageRel: string,
  styleFolders: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  assert(!pageRel.startsWith('/'), 'findClassMentions: the page is named relative to the project');
  // The keep list only matters to the unused-selector verdicts; reading the texts ignores it.
  const input = await readSelectorUsageInput(root, EMPTY_KEEP_LIST, styleFolders);
  return classMentionFiles({ astro: input.astro, others: input.others }, classes, pageRel);
}
