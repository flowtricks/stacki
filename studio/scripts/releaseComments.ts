import ts from 'typescript';

// Why this exists: every Studio release is one JSON file, and every Desktop and Studio already
// installed refuses one larger than 32,000,000 bytes (RELEASE_BYTES_MAX in
// shared/ipc/studioRelease.ts). 1.4.18 measured 32,255,496 bytes and could not be installed. The
// vendored Desktop sources (vendor/stacki) are about four fifths of the file, and their comments
// are about 3.9 MB of it once JSON escapes them. An install only type checks and bundles that
// tree; it is generated and never edited there (PROVENANCE.md), so the release carries it without
// comments. The repository's vendor/stacki and the canonical sources keep every comment.
//
// Safety: comments are found by the TypeScript parser (never a regular expression, which a
// regular expression literal or a template string would fool), comments that tools read are
// kept, and each stripped file must transpile to exactly the same JavaScript as the original.

// Comments a compiler, bundler or linter reads, so they are code rather than prose.
const DIRECTIVE_COMMENT =
  /@ts-|eslint-|prettier-ignore|@vite-ignore|webpack[A-Z]|[#@]__PURE__|[#@]__NO_SIDE_EFFECTS__|@jsx|@license|@preserve|@refresh|^\/\*!|^\/\/\/\s*</;

// The most syntax nodes the walk visits in one file. The largest vendored file (about 440 KB)
// has well under 500,000; the bound stops a pathological file instead of growing without limit.
const SYNTAX_NODES_MAX = 2_000_000;

export const RELEASE_COMMENT_FILE = /^vendor\/stacki\/.+(?<!\.d)\.(ts|tsx|mts)$/;

/** The release text of one vendored source file: the same code without prose comments. */
export function stripReleaseComments(file: string, text: string): string {
  assertRelease(RELEASE_COMMENT_FILE.test(file), `Only vendored TypeScript sources lose comments: ${file}`);
  const ranges = commentRanges(file, text);
  let output = '';
  let at = 0;
  for (const range of ranges) {
    if (range.pos < at) {
      continue;
    }
    if (DIRECTIVE_COMMENT.test(text.slice(range.pos, range.end))) {
      continue;
    }
    const lineStart = text.lastIndexOf('\n', range.pos - 1) + 1;
    const lineEndFound = text.indexOf('\n', range.end);
    const lineEnd = lineEndFound === -1 ? text.length : lineEndFound;
    const aloneOnLine = lineStart >= at && text.slice(lineStart, range.pos).trim() === '' && text.slice(range.end, lineEnd).trim() === '';
    if (aloneOnLine) {
      // A comment on its own lines leaves no blank line behind.
      output += text.slice(at, lineStart);
      at = Math.min(lineEnd + 1, text.length);
    } else {
      output += text.slice(at, trimmedStart(text, at, range.pos));
      at = range.end;
    }
  }
  output += text.slice(at);
  assertRelease(output.length <= text.length, `Stripping comments never grows a file: ${file}`);
  assertRelease(transpiled(file, output) === transpiled(file, text), `Stripping comments changed the code of ${file}`);
  return output;
}

// Every comment in the file, in source order, as the parser attaches them to tokens.
function commentRanges(file: string, text: string): readonly ts.CommentRange[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found = new Map<number, ts.CommentRange>();
  // JSX text has no trivia: `<p>// shown</p>` is text, yet a trivia scan started at its first
  // character would read it as a comment, so ranges that start inside JSX text are dropped.
  const jsxText: { readonly pos: number; readonly end: number }[] = [];
  const stack: ts.Node[] = [source];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    assertRelease(visited <= SYNTAX_NODES_MAX, `Syntax tree too large: ${file}`);
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxText.push({ pos: node.pos, end: node.end });
    }
    for (const range of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) {
      found.set(range.pos, range);
    }
    stack.push(...node.getChildren(source));
  }
  const comments = [...found.values()].filter((range) => !jsxText.some((span) => span.pos <= range.pos && range.pos < span.end));
  return comments.sort((left, right) => left.pos - right.pos);
}

// The start of the spaces before an end-of-line comment, so no trailing whitespace stays.
function trimmedStart(text: string, at: number, position: number): number {
  let start = position;
  while (start > at && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
    start -= 1;
  }
  return start;
}

// The JavaScript one file compiles to with comments removed: equal output proves equal code.
function transpiled(file: string, text: string): string {
  return ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: false,
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: false,
    },
  }).outputText;
}

function assertRelease(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
