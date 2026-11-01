// What the binding picker asks the loop reader, kept out of the picker's own
// module: the data tree (dataSuggest.ts) is a small contract the app loads
// before anything else, and the loop reader brings a JavaScript parser with it.
// The app hands this to the tree through its data context.

import { readLoop } from './loopQueryRead';
import { parseExpression } from './loopSyntax';
import type { CollectionReader } from './dataScope';

export const collectionReader: CollectionReader = {
  // `items1`, read through the loop reader to the collection it lists and
  // where its items keep their fields: `fields` in a builder export, `data`.
  listOf: (name, frontmatter, imports) => {
    const known = imports.flatMap((entry) => (entry.name !== undefined && entry.path !== undefined ? [{ name: entry.name, path: entry.path }] : []));
    const reading = readLoop({ frontmatter, imports: known, data: name });
    if (reading.kind !== 'query' || reading.query.source.kind !== 'astro') {
      return undefined;
    }
    return { collection: reading.query.source.collection, itemPath: reading.home === undefined ? ['data'] : reading.home.itemPath };
  },
  // The keys of an object written out: `{ "campus": …, "nav-links": … }`.
  keysOf: (value) => {
    const parsed = parseExpression(value);
    const object = parsed?.expression;
    return object?.kind === 'object' ? object.entries.flatMap((entry) => (entry.key === undefined ? [] : [entry.key])) : undefined;
  },
};
