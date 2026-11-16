// The editor language an attribute's language is drawn in: one place that turns
// the name-to-language table (ui/attributeLanguage.ts) into what an editor
// wants. JavaScript and a style attribute's declarations already have editors'
// grammars (the field's own, and StyleEditor.tsx); every other language is read
// by ui/attributeSyntax.ts.

import { javascript } from '@codemirror/lang-javascript';
import type { Extension } from '@codemirror/state';
import type { AttributeLanguage } from '../../ui/attributeLanguage';
import { attributeSyntax } from '../../ui/attributeSyntax';
import { styleDeclarations } from './StyleEditor';

/** The grammar an editor is given as its `syntax` for text in `language`. */
export function propSyntax(language: AttributeLanguage): Extension {
  switch (language) {
    case 'declarations':
      return styleDeclarations;
    case 'javascript':
      return javascript();
    case 'json':
    case 'keyValues':
    case 'mediaQuery':
    case 'pathData':
    case 'regex':
    case 'sourceSet':
    case 'svgNumbers':
    case 'tokens':
      return attributeSyntax(language);
    default: {
      const exhaustive: never = language;
      return exhaustive;
    }
  }
}
