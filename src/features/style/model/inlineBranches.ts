// A `style={…}` attribute written as code, edited branch by branch (the "Inline
// styles" chip, useInlineTarget.ts). `maxWidth ? `--_mw: ${maxWidth}ch;` : undefined`
// has two branches: the template when maxWidth is set, and nothing otherwise. Each
// branch's text is a declaration list the panel reads and writes as it does a plain
// style string; `${maxWidth}` stays in it untouched, as part of a value.
//
// The expression's shape is checked by the conditional model (editor/conditionalValue.ts):
// only what it reads, a chain of tests ending in a value, is editable. The branch
// values are then located in the expression's own text, so a write replaces exactly
// one branch's literal and every other byte (tests, spacing, quotes, the other
// branches) stays as written.

import { assert } from '../../../../shared/core/assert';
import { described, messageRef, englishText, type Described, type TypedMessageRef } from '../../../../shared/properties/i18n/messageRef';
import { LIMITS } from '../../../../shared/core/limits';
import { CONDITIONAL_LIMITS, readConditionalExpression, type ConditionalResult } from '../../../editor/conditionalValue';
import { plainTestName, stringEnd, ternaryIndices } from './inlineCode';

/** One branch: when it applies, its literal's place in the expression, and its text. */
export interface StyleBranch {
  /** Stable within one expression: its position in the chain. */
  readonly key: string;
  /** `when maxWidth is set`, `otherwise (render is set)`, `otherwise`, `always`. */
  readonly label: string;
  /** The same label as a message the panel translates; `label` stays the English text. */
  readonly labelRef: TypedMessageRef;
  /** The literal's offsets in the expression (UTF-16), quotes included. */
  readonly start: number;
  readonly end: number;
  /** How the branch is written: a template, a quoted string, or no value (`undefined`). */
  readonly form: { readonly kind: 'template' } | { readonly kind: 'string'; readonly quote: '"' | "'" } | { readonly kind: 'none' };
  /** The declarations as written inside the literal, `${…}` kept; '' for no value. */
  readonly body: string;
}

export type StyleBranches =
  | { readonly tag: 'branches'; readonly expression: string; readonly branches: readonly StyleBranch[] }
  | { readonly tag: 'unsupported'; readonly reason: string; readonly reasonRef: TypedMessageRef };

/** The branches of a style expression, or why it is not one the panel edits. */
// The one branch of a plain string attribute.
export function alwaysBranchLabel(): Pick<StyleBranch, 'label' | 'labelRef'> {
  return branchLabel(messageRef('styleModel.inline.branch.always'));
}

export function readStyleBranches(expression: string): StyleBranches {
  if (expression.length > LIMITS.attrCharsMax) {
    return unsupported('styleModel.inline.reason.tooLongToEdit');
  }
  const whole = literalAt(expression, 0, expression.length);
  if (whole !== undefined) {
    // A template or string on its own: one branch, always applied.
    if (whole.form.kind === 'none') {
      return unsupported('styleModel.inline.reason.rendersNothing');
    }
    return { tag: 'branches', expression, branches: [{ ...whole, key: '0', ...branchLabel(messageRef('styleModel.inline.branch.always')) }] };
  }
  const model = readConditionalExpression(expression);
  if (model === undefined) {
    return unsupported('styleModel.inline.reason.onlyChain');
  }
  if (!editableResult(model.otherwise)) {
    return unsupported('styleModel.inline.reason.fromProp');
  }
  for (const group of model.groups) {
    if (!editableResult(group.value)) {
      return unsupported('styleModel.inline.reason.fromProp');
    }
  }
  const branches = locateBranches(expression);
  if (branches === undefined) {
    return unsupported('styleModel.inline.reason.unplaceable');
  }
  // The text scan and the model must agree on the chain, or neither is trusted.
  if (branches.length !== model.groups.length + 1) {
    return unsupported('styleModel.inline.reason.unplaceable');
  }
  return { tag: 'branches', expression, branches };
}

export type BranchWrite = { readonly tag: 'written'; readonly expression: string } | ({ readonly tag: 'refused' } & Described);

/**
 * The expression with one branch's text replaced, every other byte unchanged. The
 * branch keeps its form where it can (a string stays a string in its own quote); a
 * text with `${…}` or that quote becomes a template, and an empty text no value.
 */
export function writeStyleBranch(expression: string, branch: StyleBranch, body: string): BranchWrite {
  assert(branch.start >= 0, 'writeStyleBranch: a branch starts inside the expression');
  assert(branch.end <= expression.length, 'writeStyleBranch: a branch ends inside the expression');
  const literal = branchLiteral(branch, body.trim() === '' ? '' : body);
  if (literal === undefined) {
    return { tag: 'refused', ...described('styleModel.inline.refusal.backtick') };
  }
  const next = expression.slice(0, branch.start) + literal + expression.slice(branch.end);
  if (next.length > LIMITS.attrCharsMax) {
    return { tag: 'refused', ...described('styleModel.inline.refusal.tooLong') };
  }
  // Written back, the branches read as before with the one text changed.
  const read = readStyleBranches(next);
  if (read.tag !== 'branches') {
    return { tag: 'refused', ...described('styleModel.inline.refusal.breaksCode') };
  }
  return { tag: 'written', expression: next };
}

/** The `${…}` placeholders in a branch's text, in order, as offsets into it. */
export function interpolationRanges(body: string): readonly { readonly from: number; readonly to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let index = body.indexOf('${');
  for (let round = 0; index !== -1 && round < CONDITIONAL_LIMITS.templatePartsMax; round += 1) {
    const close = body.indexOf('}', index + 2);
    if (close === -1) {
      break;
    }
    ranges.push({ from: index, to: close + 1 });
    index = body.indexOf('${', close + 1);
  }
  return ranges;
}

function unsupported(
  key:
    | 'styleModel.inline.reason.tooLongToEdit'
    | 'styleModel.inline.reason.rendersNothing'
    | 'styleModel.inline.reason.onlyChain'
    | 'styleModel.inline.reason.fromProp'
    | 'styleModel.inline.reason.unplaceable',
): StyleBranches {
  const reasonRef = messageRef(key);
  return { tag: 'unsupported', reason: englishText(reasonRef), reasonRef };
}

// A branch's label: the English text next to the reference the panel translates.
function branchLabel(labelRef: TypedMessageRef): Pick<StyleBranch, 'label' | 'labelRef'> {
  return { label: englishText(labelRef), labelRef };
}

function editableResult(result: ConditionalResult): boolean {
  return result.kind === 'text' || result.kind === 'template' || result.kind === 'none';
}

// `test ? value : rest`, down the else side, with each value's offsets.
function locateBranches(expression: string): StyleBranch[] | undefined {
  const branches: StyleBranch[] = [];
  let from = 0;
  let previousTest: string | undefined;
  for (let round = 0; round <= CONDITIONAL_LIMITS.groupsMax; round += 1) {
    const rest = expression.slice(from);
    const at = ternaryIndices(rest);
    if (at === undefined) {
      const last = literalAt(expression, from, expression.length);
      if (last === undefined) {
        return undefined;
      }
      branches.push({
        ...last,
        key: String(branches.length),
        ...branchLabel(messageRef(previousTest === undefined ? 'styleModel.inline.branch.always' : 'styleModel.inline.branch.otherwise')),
      });
      return branches;
    }
    const test = rest.slice(0, at.question).trim();
    const value = literalAt(expression, from + at.question + 1, from + at.colon);
    if (value === undefined) {
      return undefined;
    }
    const condition = test.replace(/^\(([\s\S]*)\)$/, '$1').trim();
    const name = plainTestName(condition);
    const first = branches.length === 0;
    const labelRef =
      name === undefined
        ? messageRef(first ? 'styleModel.inline.branch.when' : 'styleModel.inline.branch.otherwiseWhen', { condition })
        : messageRef(first ? 'styleModel.inline.branch.whenSet' : 'styleModel.inline.branch.otherwiseWhenSet', { name });
    branches.push({ ...value, key: String(branches.length), ...branchLabel(labelRef) });
    previousTest = test;
    from += at.colon + 1;
  }
  return undefined;
}

// The one literal between `start` and `end` (spaces and redundant parentheses
// around it allowed), or undefined when something else is there.
function literalAt(expression: string, start: number, end: number): Omit<StyleBranch, 'key' | 'label' | 'labelRef'> | undefined {
  let from = start;
  let to = end;
  for (let round = 0; round <= CONDITIONAL_LIMITS.parenthesesDepthMax; round += 1) {
    while (from < to && /\s/.test(expression.charAt(from))) {
      from += 1;
    }
    while (to > from && /\s/.test(expression.charAt(to - 1))) {
      to -= 1;
    }
    if (expression.charAt(from) === '(' && expression.charAt(to - 1) === ')') {
      from += 1;
      to -= 1;
    } else {
      break;
    }
  }
  const text = expression.slice(from, to);
  if (text === 'undefined' || text === 'null') {
    return { start: from, end: to, form: { kind: 'none' }, body: '' };
  }
  const quote = text.charAt(0);
  if (quote !== '`' && quote !== '"' && quote !== "'") {
    return undefined;
  }
  // The literal must be the whole text: its closing quote is the last character.
  if (stringEnd(expression, from) !== to - 1) {
    return undefined;
  }
  const body = text.slice(1, -1);
  if (body.includes('\\')) {
    // Escapes would need unescaping to edit and re-escaping to write: not here.
    return undefined;
  }
  if (quote === '`') {
    return { start: from, end: to, form: { kind: 'template' }, body };
  }
  return { start: from, end: to, form: { kind: 'string', quote }, body };
}

function branchLiteral(branch: StyleBranch, body: string): string | undefined {
  if (body === '') {
    return 'undefined';
  }
  const interpolated = body.includes('${');
  const form = branch.form;
  if (form.kind === 'string' && !interpolated && !body.includes(form.quote)) {
    return `${form.quote}${body}${form.quote}`;
  }
  if (body.includes('`')) {
    return undefined;
  }
  if (form.kind === 'none' && !interpolated && !body.includes('"')) {
    return `"${body}"`;
  }
  return `\`${body}\``;
}

/** What the CSS code editor locks around a branch's declarations. */
export const STYLE_BLOCK_PREFIX = 'element.style {\n';
export const STYLE_BLOCK_SUFFIX = '\n}';

/** One declaration of a branch's text: trimmed, and as written with its separator. */
interface DeclarationPiece {
  /** The declaration without its `;`, trimmed. */
  readonly text: string;
  /** From the declaration's first character to the next one's: its `;` and spacing. */
  readonly raw: string;
}

/**
 * A branch's text as the editor shows it, inside the locked edges: each declaration
 * on its own line, indented and ended with `;`, as normal CSS reads.
 */
export function displayStyleDeclarations(body: string): string {
  return splitDeclarations(body)
    .pieces.map((piece) => `  ${piece.text};`)
    .join('\n');
}

/**
 * The branch's text from the editor's lines, in the attribute's own formatting:
 * unchanged text when no declaration changed (so an unedited file stays byte for byte),
 * each untouched declaration with the separator it had, and `; ` for a new one.
 */
export function declarationsFromDisplay(display: string, original: string): string {
  const next = splitDeclarations(display).pieces.map((piece) => piece.text);
  const before = splitDeclarations(original);
  const same = next.length === before.pieces.length && next.every((text, index) => text === before.pieces[index]?.text);
  if (same) {
    return original;
  }
  if (next.length === 0) {
    return '';
  }
  let text = before.lead;
  for (const [index, declaration] of next.entries()) {
    const old = before.pieces[index];
    const followed = index < next.length - 1;
    if (old !== undefined && old.text === declaration) {
      // The old last declaration's `;` ended the list; followed now, it is `; `.
      text += followed && index === before.pieces.length - 1 ? `${old.text}; ` : old.raw;
    } else {
      // Its old separator, unless it was the last declaration (whose `;` ends the list):
      // between declarations a single-line attribute reads `; `.
      const lastBefore = index >= before.pieces.length - 1;
      const separator = old === undefined || lastBefore ? '; ' : old.raw.slice(old.text.length);
      text += declaration + (separator === '' ? '; ' : separator);
    }
    // The original's last declaration may have had no `;`; one now followed needs it.
    if (followed && !text.trimEnd().endsWith(';')) {
      text = `${text.trimEnd()}; `;
    }
  }
  // The end as the attribute had it: closed by `;` or not, then its trailing spacing.
  let body = text.trimEnd();
  const closed = original.trimEnd().endsWith(';') || before.pieces.length === 0;
  if (body.endsWith(';') && !closed) {
    body = body.slice(0, -1);
  }
  if (!body.endsWith(';') && closed && before.pieces.length > 0) {
    body += ';';
  }
  return body + original.slice(original.trimEnd().length);
}

// Top-level `;` ends a declaration; brackets (`${…}` among them) and quotes hide it.
function splitDeclarations(body: string): { readonly lead: string; readonly pieces: readonly DeclarationPiece[] } {
  assert(body.length <= LIMITS.attrCharsMax, 'splitDeclarations: an attribute is inside its bound');
  const starts: { start: number; end: number }[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === '"' || char === "'") {
      const close = stringEnd(body, index);
      index = close ?? body.length;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ';' && depth === 0) {
      starts.push({ start: from, end: index });
      from = index + 1;
    }
  }
  starts.push({ start: from, end: body.length });
  const found = starts
    .map((range) => ({ ...range, text: body.slice(range.start, range.end).trim() }))
    .filter((range) => range.text !== '')
    .map((range) => ({ ...range, start: range.start + (body.slice(range.start, range.end).length - body.slice(range.start, range.end).trimStart().length) }));
  const pieces = found.map((range, index) => {
    const nextStart = found[index + 1]?.start ?? body.length;
    return { text: range.text, raw: body.slice(range.start, nextStart) };
  });
  const lead = found[0] === undefined ? '' : body.slice(0, found[0].start);
  assert(pieces.length <= starts.length, 'splitDeclarations: no more pieces than separators');
  return { lead, pieces };
}
