// AGENTS.md §13: comments are sentences — a space after `//`, a capital letter
// (or a code token such as an identifier), and a full stop or colon at the end
// of the block. End-of-line comments may be phrases, so only comments that
// stand on their own line are checked, and a run of adjacent `//` lines is one
// block: its first line opens the sentence and its last line closes it.

import type { TSESTree } from '@typescript-eslint/utils';
import { assert } from '../policy/assert.mts';
import type { RuleModule } from './ast.mts';

type SentenceMessageIds = 'space' | 'capital' | 'terminal';

// Tool directives are not prose.
const DIRECTIVE = new RegExp(
  '^\\s*(?:' +
    ['eslint-(?:disable|enable)', 'eslint\\s+[\\w/-]+:', '@ts-', 'prettier-ignore', '#(?:end)?region', '/', 'global\\s', 'c8\\s', 'istanbul\\s'].join('|') +
    ')',
);
// A first character that opens code or a list rather than a word.
const CODE_OPENER = /^[A-Z0-9`'"@$([{<.\-*#>|~=!?:/\\+%&^_]/;
// A first word that is an identifier or expression: camelCase, dotted, called.
const CODE_WORD = /[A-Z0-9_.$()[\]<>:/'"`-]/;
// Characters that may close a sentence or a quoted code block, or a rule line
// (`// --- Section ---`) that closes a heading rather than a sentence.
const TERMINAL = /(?:[.:!?)`'"\]}>]|-{3,}|={3,}|─{3,})$/;
// A list item: `- one`, `* two`, `1. three`, `2) four`.
const LIST_ITEM = /^(?:[-*•]|\d+[.)])\s/;
const COMMENTS_PER_FILE_MAX = 100_000;

export const commentSentence: RuleModule<SentenceMessageIds> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Own-line comments are sentences (AGENTS.md §13).' },
    messages: {
      space: 'Put a space after `//` (AGENTS.md §13).',
      capital: 'Start the comment with a capital letter, or quote the identifier it opens with in ' + 'backticks (AGENTS.md §13).',
      terminal: 'End the comment with a full stop, or a colon before what follows (AGENTS.md §13).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        assert(comments.length <= COMMENTS_PER_FILE_MAX, 'comment-sentence: comment limit');
        const blocks = ownLineBlocks(comments, sourceCode.lines);
        for (const block of blocks) {
          const first = block[0];
          const last = block.at(-1);
          assert(first !== undefined, 'comment-sentence: a block has a first line');
          assert(last !== undefined, 'comment-sentence: a block has a last line');
          const opening = openingProblem(first.value);
          if (opening !== undefined) {
            context.report({ loc: first.loc, messageId: opening });
            continue;
          }
          // A block that ends in a list closes with its last item.
          if (LIST_ITEM.test(last.value.trimStart())) {
            continue;
          }
          if (!TERMINAL.test(last.value.trimEnd())) {
            context.report({ loc: last.loc, messageId: 'terminal' });
          }
        }
      },
    };
  },
};

// Groups own-line `//` comments into blocks of consecutive lines.
function ownLineBlocks(comments: readonly TSESTree.Comment[], lines: readonly string[]): readonly (readonly TSESTree.Comment[])[] {
  const blocks: TSESTree.Comment[][] = [];
  let previousLine = -1;
  for (const comment of comments) {
    if (comment.type !== 'Line') {
      previousLine = -1;
      continue;
    }
    const line = comment.loc.start.line;
    const text = lines[line - 1];
    assert(text !== undefined, 'comment-sentence: a comment sits on a source line');
    const leading = text.slice(0, comment.loc.start.column).trim();
    // An end-of-line phrase or a tool directive is not part of any sentence,
    // and it ends the block above it.
    if (leading.length > 0 || DIRECTIVE.test(comment.value)) {
      previousLine = -1;
      continue;
    }
    const current = blocks.at(-1);
    if (current !== undefined && line === previousLine + 1) {
      current.push(comment);
    } else {
      blocks.push([comment]);
    }
    previousLine = line;
  }
  return blocks;
}

function openingProblem(value: string): SentenceMessageIds | undefined {
  // An empty `//` line opens nothing; the block's text starts later.
  if (value.trim().length === 0) {
    return undefined;
  }
  if (!value.startsWith(' ')) {
    return 'space';
  }
  const text = value.trimStart();
  if (CODE_OPENER.test(text)) {
    return undefined;
  }
  const first = text.charAt(0);
  // Only a lower-case ASCII letter can open a word that should be capitalized;
  // symbols such as → or … open notation.
  if (first < 'a' || first > 'z') {
    return undefined;
  }
  const word = text.split(/\s/, 1)[0] ?? '';
  return CODE_WORD.test(word) ? undefined : 'capital';
}

// Every suppression says why, so the reader can evaluate it (AGENTS.md: always
// say why). `// eslint-disable-next-line rule -- reason`.
export const requireDisableReason: RuleModule<'missingReason'> = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Every lint suppression states its reason.' },
    messages: {
      missingReason: 'State why the rule does not apply: `eslint-disable… <rule> -- <reason>` ' + '(AGENTS.md: always say why).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value.trim();
          if (!/^eslint-disable(?:-next-line|-line)?\b/.test(text)) {
            continue;
          }
          const separator = text.indexOf(' -- ');
          const reason = separator < 0 ? '' : text.slice(separator + 4).trim();
          if (reason.length === 0) {
            context.report({ loc: comment.loc, messageId: 'missingReason' });
          }
        }
      },
    };
  },
};
