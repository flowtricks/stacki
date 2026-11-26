// The text a code intelligence tooltip shows, as elements: signatures and values coloured as code (the app's one
// palette), documentation as the plain prose it is.
import { codeTokenLines } from '../../ui/codeHighlight';

export type TooltipCodeLanguage = 'css' | 'typescript';

export function codeElement(code: string, language: TooltipCodeLanguage, tag: 'pre' | 'span'): HTMLElement {
  const element = document.createElement(tag);
  element.className = tag === 'pre' ? 'code-block code-intel-signature' : 'code-inline code-intel-detail';
  element.dir = 'ltr';
  codeTokenLines(code, language).forEach((line, index) => {
    if (index > 0) {
      element.append('\n');
    }
    for (const token of line) {
      const span = document.createElement('span');
      span.textContent = token.text;
      Object.assign(span.style, token.style ?? {});
      element.append(span);
    }
  });
  return element;
}

export function codeLanguageOf(signature: string): TooltipCodeLanguage {
  return signature.startsWith('--') ? 'css' : 'typescript';
}

function prose(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'code-intel-prose';
  element.dir = 'auto';
  element.textContent = text;
  return element;
}

/** A signature over its documentation; undefined when there is neither. */
export function describedElement(signature: string | undefined, documentation: string | undefined): HTMLElement | undefined {
  if (signature === undefined && documentation === undefined) {
    return undefined;
  }
  const element = document.createElement('div');
  element.className = 'code-intel-described';
  if (signature !== undefined) {
    element.append(codeElement(signature, codeLanguageOf(signature), 'pre'));
  }
  if (documentation !== undefined) {
    element.append(prose(documentation));
  }
  return element;
}
