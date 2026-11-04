// A component's prop schema: the fields of its Props type with their types,
// defaults, docs and unions, as the props panel shows them.
//
// The schema is a projection of the component's prop model, the one reader of
// what a prop is (electron/parse/propModel/readPropModel.ts, on the
// TypeScript syntax tree). This module only keeps the long-standing name and
// signature; the regex reader it used to hold was retired in Phase 1 of
// docs/plans/prop-controls.md, once the parity corpus agreed.

import type { SchemaField } from './astroParserTypes';
import { readPropModel } from './propModel/readPropModel';
import { schemaFieldsOf } from '../../shared/properties/propModelSchema';

// `prelude` carries type declarations this file imports from elsewhere. A
// component is free to write `type Props = SeoProps` with SeoProps in
// types.ts, and without the declaration text there is nothing to read — the
// panel would show a component with no props at all. The caller (which has
// file access; this doesn't) resolves and reads them.
export function parsePropSchema(source: string, prelude = ''): SchemaField[] {
  return schemaFieldsOf(readPropModel(source, prelude));
}
