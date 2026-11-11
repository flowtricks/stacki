// What a pick from the binding picker writes into the page's frontmatter
// before it binds, as a source change: the `getCollection` query of a project
// collection, or the import of a data file's export. The addition itself is
// Desktop's (vendor src/editor/frontmatterAdditions.ts); it is printed with the
// shared frontmatter writer and placed as one frontmatter edit, as a loop's
// query is (loopSourceEdit.ts). Settings.tsx holds it for the field's own
// change, so the two land as one undo step.

import { assert } from '../../../vendor/stacki/shared/core/assert';
import { writeFrontmatter } from '../../../vendor/stacki/shared/page/frontmatterSource';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import type { ImportNeed } from '../../../vendor/stacki/src/editor/dataSample';
import { withCollectionQuery, withDataImport, type FrontmatterAddition, type FrontmatterPart } from '../../../vendor/stacki/src/editor/frontmatterAdditions';
import { applyEdits, parsePage } from '../source/source';
import { frontmatterEdit } from './settingsEdits';

/** A page source after a frontmatter addition, and the name the binding reads. */
export interface AddedSource {
  readonly source: string;
  readonly name: string;
}

/** `source` reading `collection` through a marked `getCollection` query. */
export function collectionQueryEdit(source: string, collection: string): AddedSource {
  return added(source, (model) => withCollectionQuery(model, collection));
}

/** `source` importing a data file's export, joined to the module's existing import when there is one. */
export function dataImportEdit(source: string, need: ImportNeed): AddedSource {
  return added(source, (model) => withDataImport(model, need));
}

function added(source: string, add: <M extends FrontmatterPart>(model: M) => FrontmatterAddition<M>): AddedSource {
  const parsed = parsePage(source);
  if (!parsed.editable) {
    throw new Error('Fix the page syntax before binding to data it does not read yet.');
  }
  const model = parsePageModel(parsed.model);
  const next = add(model);
  if (next.model === model) {
    return { source, name: next.name };
  }
  const text = writeFrontmatter(next.model).replace(/\r?\n$/, '');
  const written = applyEdits(source, [frontmatterEdit(source, text)]);
  assert(parsePage(written).editable, 'A frontmatter addition leaves a page the parser reads');
  return { source: written, name: next.name };
}
