// A component prop declared from the binding picker, as the frontmatter
// gesture the app holds for the field's own edit (holdForNextEdit in
// appHistory.ts), so the declaration and the binding are one undo step. The
// text edit is propDeclaration.ts's; this adds the type import an attributes
// prop needs, once, and names every binding in scope so the prop is read by
// its own name only when nothing else has it.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { frontmatterGesture } from '../../editor/editGestures';
import type { EditGesture } from '../../editor/pageEdits';
import { namesInScope } from '../../editor/dataSuggest';
import { ATTRIBUTES_TYPE, declaredProp, type PropDeclaration } from '../../editor/propDeclaration';
import type { EditorModel } from '../../editor/pageView';

/** The gesture declaring the prop, and the name the field binds. */
export interface NewPropGesture {
  readonly gesture: EditGesture;
  readonly local: string;
}

export function newPropGesture(model: EditorModel, declaration: PropDeclaration): Result<NewPropGesture, string> {
  if (model.format !== undefined) {
    return err('Only an Astro component takes properties.');
  }
  const taken = namesInScope(model.extraFrontmatter, model.imports);
  const declared = declaredProp(model.extraFrontmatter, declaration, taken);
  if (!declared.ok) {
    return declared;
  }
  const imports = declaration.kind === 'attributes' ? withAttributesType(model.imports) : model.imports;
  const { frontmatter, local } = declared.value;
  const gesture = frontmatterGesture(model, { coalesceKey: undefined, urgency: true }, (shown) => ({ ...shown, extraFrontmatter: frontmatter, imports }));
  assert(gesture.coalesceKey === undefined, 'A declared prop is a step of its own');
  return ok({ gesture, local });
}

// `import type { HTMLAttributes } from "astro/types"`, unless the file already imports it.
function withAttributesType(imports: EditorModel['imports']): EditorModel['imports'] {
  const has = imports.some((entry) => entry.name === ATTRIBUTES_TYPE.name);
  if (has) {
    return imports;
  }
  const entry = { name: ATTRIBUTES_TYPE.name, imported: ATTRIBUTES_TYPE.name, path: ATTRIBUTES_TYPE.path, quote: '"', named: true, typeOnly: true };
  const out = [...imports, entry];
  assert(out.length === imports.length + 1, 'withAttributesType: one import is added');
  return out;
}
