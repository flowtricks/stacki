// Read-only progress meter for the interface translation (docs/i18n-playbook.md): counts the
// user-visible strings that are still raw text instead of a `translate()` call, per folder, so an
// agent can drive its own folders to zero. It parses with the TypeScript AST rather than grepping, and it
// errs toward counting; a hit that is really code is silenced with `// i18n-ignore: <reason>` on the same
// or the previous line, and the reason is the point (AGENTS.md "Always say why").
//
// Usage:
//   node scripts/i18n/scanRawStrings.mts <folder-or-file>...           per-folder counts for those paths
//   node scripts/i18n/scanRawStrings.mts --list <folder-or-file>...    also print every hit: file:line kind text
//   node scripts/i18n/scanRawStrings.mts --json <folder-or-file>...    machine-readable
// Exit code is always 0: this is a meter, not a gate.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

type HitKind = 'jsx-text' | 'text-prop' | 'jsx-expression' | 'option-label' | 'error-message' | 'status' | 'returned-text' | 'plural' | 'property-text';

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly kind: HitKind;
  readonly text: string;
}

// Limits on everything (AGENTS.md §10): a scan that walks the wrong directory stops instead of running away.
const FILES_MAX = 5000;

// JSX attributes whose string value a person reads or a screen reader speaks.
const TEXT_PROPS = new Set([
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'ariaLabel',
  'searchPlaceholder',
  'resetLabel',
  'unbindLabel',
  'emptyMessage',
  'placeholder',
  'alt',
  'label',
  'description',
  'tooltip',
  'hint',
  'emptyLabel',
  'emptyText',
  'confirmLabel',
  'cancelLabel',
  'heading',
  'caption',
  'summary',
  'text',
  'message',
  'helper',
  'helpText',
  'subtitle',
]);
// Object properties that carry display text (option arrays, menu items, toasts).
const LABEL_PROPERTIES = new Set(['label', 'title', 'description', 'hint', 'tooltip', 'placeholder', 'text', 'caption', 'subtitle', 'heading', 'summary']);
const ERROR_PROPERTIES = new Set(['message', 'error', 'reason', 'detail']);
const STATUS_CALLEES = new Set(['toast', 'notify', 'showToast', 'setStatus', 'setError', 'setMessage', 'reportError', 'showError']);
// `KeyboardEvent.key` values: key names a handler compares with, never text.
const KEY_NAMES = new Set([
  'Escape',
  'Tab',
  'Enter',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
]);
// Attributes that are code, not text, even though they hold words.
const CODE_PROPS = new Set([
  'className',
  'class',
  'id',
  'key',
  'ref',
  'type',
  'role',
  'href',
  'src',
  'htmlFor',
  'name',
  'value',
  'data-testid',
  'style',
  'variant',
  'tone',
  'size',
  'kind',
  'icon',
]);

function main(): void {
  const argumentsList = process.argv.slice(2);
  const list = argumentsList.includes('--list');
  const json = argumentsList.includes('--json');
  const targets = argumentsList.filter((argument) => !argument.startsWith('--'));
  if (targets.length === 0) {
    console.error('usage: node scripts/i18n/scanRawStrings.mts [--list|--json] <folder-or-file>...');
    return;
  }
  const root = process.cwd();
  const files: string[] = [];
  for (const target of targets) {
    collect(resolve(root, target), files);
  }
  const hits: Hit[] = [];
  let translateCalls = 0;
  for (const file of files) {
    const scanned = scanFile(file, root);
    hits.push(...scanned.hits);
    translateCalls += scanned.translateCalls;
  }
  report({ hits, files, root, list, json, translateCalls });
}

function collect(start: string, files: string[]): void {
  // Iterative with a node budget: a scan pointed at the wrong directory stops instead of running away.
  const pending: string[] = [start];
  let visited = 0;
  while (pending.length > 0 && visited < FILES_MAX * 4 && files.length < FILES_MAX) {
    visited += 1;
    const path = pending.pop();
    if (path === undefined) {
      break;
    }
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort().reverse()) {
        if (entry !== 'node_modules' && entry !== 'vendor' && entry !== 'dist' && !entry.startsWith('.')) {
          pending.push(join(path, entry));
        }
      }
    } else if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts')) {
      files.push(path);
    }
  }
}

function scanFile(file: string, root: string): { readonly hits: readonly Hit[]; readonly translateCalls: number } {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = source.split('\n');
  // `// i18n-ignore-file: <reason>` near the top excuses a whole file (brand names, a table of codes).
  if (lines.slice(0, 30).some((line) => line.includes('i18n-ignore-file'))) {
    return { hits: [], translateCalls: 0 };
  }
  const hits: Hit[] = [];
  let translateCalls = 0;
  const display = relative(root, file);

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const ignored = (line: number): boolean => (lines[line - 1] ?? '').includes('i18n-ignore') || (lines[line - 2] ?? '').includes('i18n-ignore');
  const add = (node: ts.Node, kind: HitKind, text: string): void => {
    const line = lineOf(node);
    if (!ignored(line) && looksLikeText(text)) {
      hits.push({ file: display, line, kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 80) });
    }
  };

  // Walk with an explicit stack: bounded by the node count, no recursion (AGENTS.md §10).
  const stack: ts.Node[] = [sourceFile];
  let visited = 0;
  while (stack.length > 0 && visited < 2_000_000) {
    visited += 1;
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (ts.isCallExpression(node) && isTranslateCall(node)) {
      translateCalls += 1;
      continue; // Whatever is inside a translate call is already routed.
    }
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      continue;
    }
    visit(node, add);
    node.forEachChild((child) => {
      stack.push(child);
    });
  }
  return { hits, translateCalls };
}

function isTranslateCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === 'translate' || callee.text === 't' || callee.text === 'translateRich' || callee.text === 'translateRef';
  }
  return ts.isPropertyAccessExpression(callee) && (callee.name.text === 'translate' || callee.name.text === 'translateMain');
}

function visit(node: ts.Node, add: (node: ts.Node, kind: HitKind, text: string) => void): void {
  if (ts.isJsxText(node)) {
    add(node, 'jsx-text', node.text);
    return;
  }
  if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
    const name = node.name.getText();
    if ((TEXT_PROPS.has(name) && !CODE_PROPS.has(name)) || (name === 'name' && false)) {
      for (const text of stringsOf(node.initializer)) {
        add(node, 'text-prop', text);
      }
    }
    return;
  }
  if (ts.isJsxExpression(node) && node.expression !== undefined && !(node.parent !== undefined && ts.isJsxAttribute(node.parent))) {
    for (const text of stringsOf(node.expression)) {
      add(node, 'jsx-expression', text);
    }
    return;
  }
  if (ts.isReturnStatement(node) && node.expression !== undefined) {
    // A sentence returned to a caller that shows it: validation problems, status lines, labels computed by a function.
    for (const text of stringsOf(node.expression)) {
      add(node, 'returned-text', text);
    }
    return;
  }
  if (
    ts.isConditionalExpression(node) &&
    isPluralCondition(node.condition) &&
    [...stringsOf(node.whenTrue), ...stringsOf(node.whenFalse)].filter((text) => text !== '' && /^[A-Za-z ’']+$/.test(text)).length > 0
  ) {
    // Plural by ternary (`count === 1 ? 'item' : 'items'`): a word that needs a plural message, even when it is one lowercase word.
    add(node, 'plural', `${stringsOf(node.whenTrue)[0] ?? ''} / ${stringsOf(node.whenFalse)[0] ?? ''} (plural by ternary)`);
    return;
  }
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
    const name = node.name.text;
    if (LABEL_PROPERTIES.has(name)) {
      for (const text of stringsOf(node.initializer)) {
        add(node, 'option-label', text);
      }
    } else if (ERROR_PROPERTIES.has(name)) {
      for (const text of stringsOf(node.initializer)) {
        add(node, 'error-message', text);
      }
    } else {
      // Any other property holding a capitalised phrase: the label maps (`kind: 'Long text'`) that name things in a form.
      for (const text of stringsOf(node.initializer)) {
        if (/^[A-Z][a-z]/.test(text) && !KEY_NAMES.has(text)) {
          add(node, 'property-text', text);
        }
      }
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
    if (STATUS_CALLEES.has(callee)) {
      for (const argument of node.arguments) {
        for (const text of stringsOf(argument)) {
          add(argument, 'status', text);
        }
      }
    }
    return;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text)) {
    // `new Error('...')` is a programmer error unless it reaches a person; counted so the author decides.
    return;
  }
}

/** `count === 1`, `items.length !== 1`, `1 === n`: the condition of a plural-by-ternary. */
function isPluralCondition(condition: ts.Expression): boolean {
  return /(?:[=!]==?\s*1\b|\b1\s*[=!]==?)/.test(condition.getText());
}

/** The string literals and template literal heads a value can evaluate to: through ternaries, `&&`, `??`, `||`, parentheses and templates. */
function stringsOf(node: ts.Node): readonly string[] {
  const found: string[] = [];
  const stack: ts.Node[] = [node];
  let steps = 0;
  while (stack.length > 0 && steps < 64) {
    steps += 1;
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      found.push(current.text);
    } else if (ts.isTemplateExpression(current)) {
      found.push(current.head.text + current.templateSpans.map((span) => `\u0000${span.literal.text}`).join(''));
    } else if (ts.isJsxExpression(current) && current.expression !== undefined) {
      stack.push(current.expression);
    } else if (ts.isParenthesizedExpression(current)) {
      stack.push(current.expression);
    } else if (ts.isConditionalExpression(current)) {
      stack.push(current.whenTrue, current.whenFalse);
    } else if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
        stack.push(current.right);
      }
    } else if (ts.isAsExpression(current)) {
      stack.push(current.expression);
    }
  }
  return found;
}

/** Prose, not code: at least two letters in a row, and either a space or an initial capital. Identifiers, CSS values, paths and numbers do not count. */
function looksLikeText(text: string): boolean {
  if (text.endsWith(' (plural by ternary)')) {
    return true;
  }
  const trimmed = text
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (trimmed.length < 2 || !/[A-Za-z]{2}/.test(trimmed)) {
    return false;
  }
  if (/^[a-z][A-Za-z0-9_-]*$/.test(trimmed) || /^[a-z0-9._/:#-]+$/.test(trimmed) || /^https?:/.test(trimmed) || /^[A-Z0-9_]+$/.test(trimmed)) {
    return false; // An identifier, a token, a path, a constant.
  }
  // Code generated for a person's project (a GROQ query, a sort comparator) or a key chord is not interface text. Prose wins
  // when it has three plain words in a row.
  const prose = /\b[a-z’']{2,} [a-z’']{2,} [a-z’']{2,}\b/.test(trimmed);
  if (!prose && (/[(){}[\]=<>]|\?\?|=>|\.\w+\(/.test(trimmed) || /^(Ctrl|Alt|Shift|Cmd|Meta)\+/.test(trimmed) || trimmed.includes('://'))) {
    return false;
  }
  if (/^[\s\W\d]*$/.test(trimmed)) {
    return false;
  }
  return trimmed.includes(' ') || /^[A-Z][a-z]/.test(trimmed);
}

function report(options: {
  readonly hits: readonly Hit[];
  readonly files: readonly string[];
  readonly root: string;
  readonly list: boolean;
  readonly json: boolean;
  readonly translateCalls: number;
}): void {
  const byFolder = new Map<string, number>();
  for (const hit of options.hits) {
    const folder = hit.file.includes('/') ? hit.file.slice(0, hit.file.lastIndexOf('/')) : '.';
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          total: options.hits.length,
          files: options.files.length,
          translateCalls: options.translateCalls,
          byFolder: Object.fromEntries(byFolder),
          hits: options.hits,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.list) {
    for (const hit of options.hits) {
      console.log(`${hit.file}:${hit.line}  ${hit.kind.padEnd(14)} ${hit.text}`);
    }
    console.log('');
  }
  for (const [folder, count] of [...byFolder.entries()].sort((first, second) => second[1] - first[1])) {
    console.log(`${String(count).padStart(5)}  ${folder}`);
  }
  console.log(
    `${String(options.hits.length).padStart(5)}  TOTAL raw strings in ${options.files.length} files (${options.translateCalls} translate calls already)`,
  );
}

main();
