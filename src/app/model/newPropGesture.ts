// A component prop declared from the binding picker, as the frontmatter
// gesture the app holds for the field's own edit (holdForNextEdit in
// appHistory.ts), so the declaration and the binding are one undo step. The
// text edit is propDeclaration.ts's; this adds the imports the prop needs
// (an attributes prop's HTMLAttributes, an image prop's ImageMetadata and its
// default's file), each once, and names every binding in scope so the prop is
// read by its own name only when nothing else has it.

import type { Translator } from '../../lib/i18n/localeContext';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { frontmatterGesture } from '../../editor/editGestures';
import type { EditGesture } from '../../editor/pageEdits';
import { namesInScope } from '../../editor/dataSuggest';
import { declaredProp, type PropDeclaration, type PropImport } from '../../editor/propDeclaration';
import type { EditorModel } from '../../editor/pageView';

/** The gesture declaring the prop, and the name the field binds. */
export interface NewPropGesture {
  readonly gesture: EditGesture;
  readonly local: string;
}

export function newPropGesture(model: EditorModel, declaration: PropDeclaration, translate: Translator = ENGLISH_TRANSLATE): Result<NewPropGesture, string> {
  if (model.format !== undefined) {
    return err(translate('shell.prop.astroOnly'));
  }
  const taken = namesInScope(model.extraFrontmatter, model.imports);
  const declared = declaredProp(model.extraFrontmatter, declaration, taken, model.imports, translate);
  if (!declared.ok) {
    return declared;
  }
  const imports = withImports(model.imports, declared.value.imports);
  const { frontmatter, local } = declared.value;
  const gesture = frontmatterGesture(model, { coalesceKey: undefined, urgency: true }, (shown) => ({ ...shown, extraFrontmatter: frontmatter, imports }));
  assert(gesture.coalesceKey === undefined, 'A declared prop is a step of its own');
  return ok({ gesture, local });
}

// The file's imports with each one the prop needs, unless the file already
// imports that name: `import type { HTMLAttributes } from "astro/types"`.
function withImports(imports: EditorModel['imports'], needed: readonly PropImport[]): EditorModel['imports'] {
  const added = needed
    .filter((wanted) => !imports.some((entry) => entry.name === wanted.name))
    .map((wanted) =>
      wanted.named
        ? { name: wanted.name, imported: wanted.name, path: wanted.path, quote: '"', named: true, typeOnly: wanted.typeOnly }
        : { name: wanted.name, path: wanted.path, quote: '"' },
    );
  const out = [...imports, ...added];
  assert(out.length <= imports.length + needed.length, 'withImports: at most the needed imports are added');
  return out;
}
