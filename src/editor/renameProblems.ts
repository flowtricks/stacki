// A refused rename or loop head, worded in the person's language. The shared engine (shared/engine/variableRename.ts) has no catalog, so it
// returns a stable code with parameters next to its English sentence; this table is the one place that turns each code into a catalog key.
import { assert } from '../../shared/core/assert';
import type { RenameProblem } from '../../shared/engine/variableRename';
import type { Translator } from '../lib/i18n/localeContext';

export function renameProblemText(problem: RenameProblem, translate: Translator): string {
  switch (problem.code) {
    case 'invalid-name':
      return translate('editor.rename.invalidName', { name: problem.name });
    case 'reserved-word':
      return translate('editor.rename.reservedWord', { name: problem.name });
    case 'not-declared':
      return translate('editor.rename.notDeclared', { name: problem.name });
    case 'exists':
      return translate(problem.choose === 'source-menu' ? 'editor.rename.existsSourceMenu' : 'editor.rename.exists', { name: problem.name });
    case 'frontmatter-invalid':
      return translate('editor.rename.frontmatterInvalid');
    case 'partial':
      return translate('editor.rename.partial');
    case 'exported':
      return translate('editor.rename.exported', { name: problem.name });
    case 'used-as-tag':
      assert(problem.name.length > 0, 'A tag that blocks a rename has a name');
      return translate('editor.rename.usedAsTag', { name: problem.name });
    case 'unreadable-code':
      return translate('editor.rename.unreadableCode', { excerpt: problem.excerpt });
    case 'captured':
      return translate('editor.rename.captured', { from: problem.from, to: problem.to });
    case 'undeclared-in-head':
      return translate('editor.rename.undeclaredInHead', { name: problem.name });
    case 'head-unparsed':
      return translate('editor.rename.headUnparsed');
    case 'too-large':
      return translate('editor.rename.tooLarge');
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}
