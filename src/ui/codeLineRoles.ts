// Which lines of a piece of code start inside a string or a comment, read from
// the language's real parser. Adding or removing indentation inside a template
// literal changes the string, so codeIndentView.ts has to know these lines, and
// a hand-rolled scan would be fooled by a regular expression holding a backtick.
//
// The parsers recover from errors, which matters here: the text is whatever the
// user has typed so far, and an unclosed backtick runs to the end of the text
// exactly as it does in the language.

import { cssLanguage } from '@codemirror/lang-css';
import { htmlLanguage } from '@codemirror/lang-html';
import { typescriptLanguage } from '@codemirror/lang-javascript';
import type { Language } from '@codemirror/language';
import { assert } from '../../shared/core/assert';
import type { CodeLineClassifier, CodeLineRoles } from './codeIndentView';

type Parser = Language['parser'];

const VERBATIM_NODES: ReadonlySet<string> = new Set(['String', 'StringLiteral', 'TemplateString']);
const COMMENT_NODES: ReadonlySet<string> = new Set(['BlockComment', 'Comment']);

/** The classifier for an editor language; a language with no parser here has no such lines. */
export function codeLineClassifier(language: string | undefined): CodeLineClassifier {
  const parser = parserFor(language);
  return parser === undefined ? noRoles : (text) => rolesFrom(parser, text);
}

function parserFor(language: string | undefined): Parser | undefined {
  switch (language) {
    case 'css':
      return cssLanguage.parser;
    case 'astro':
    case 'html':
      return htmlLanguage.parser;
    case 'javascript':
    case 'typescript':
    case undefined:
      return typescriptLanguage.parser;
    default:
      return undefined;
  }
}

function noRoles(): CodeLineRoles {
  return { verbatim: new Set(), comment: new Set() };
}

function rolesFrom(parser: Parser, text: string): CodeLineRoles {
  const starts = lineStarts(text);
  const verbatim = new Set<number>();
  const comment = new Set<number>();
  parser.parse(text).iterate({
    enter: (node) => {
      if (VERBATIM_NODES.has(node.name)) {
        addInnerLines(verbatim, starts, node);
        // Everything inside, `${}` included, is left as it is.
        return false;
      }
      if (COMMENT_NODES.has(node.name)) {
        addInnerLines(comment, starts, node);
      }
      return undefined;
    },
  });
  assert(verbatim.size < starts.length, 'rolesFrom: the first line never starts inside anything');
  assert(comment.size < starts.length, 'rolesFrom: the first line never starts inside a comment');
  return { verbatim, comment };
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  let at = text.indexOf('\n');
  while (at >= 0) {
    starts.push(at + 1);
    at = text.indexOf('\n', at + 1);
  }
  return starts;
}

// Every line that begins after the node's first character and before its end.
function addInnerLines(lines: Set<number>, starts: readonly number[], node: { readonly from: number; readonly to: number }): void {
  for (let index = lineIndexAt(starts, node.from) + 1; index < starts.length; index += 1) {
    const start = starts[index];
    assert(start !== undefined, 'addInnerLines: a line index is in range');
    if (start >= node.to) {
      return;
    }
    lines.add(index);
  }
}

function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
