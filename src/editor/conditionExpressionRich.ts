// The rich reading of a template condition: every test an author writes, as
// the groups the visual editor draws, with each part it cannot draw kept as
// locked code (a Computed chip) rather than the whole test turning back into code:
//
//   render && (isWritten ? content : true)
//     → one group: Render is true, Computed `isWritten ? content : true`
//   ["main", "link"].includes(variant) || hidden
//     → one any group: Variant is any of main, link; Hidden is true
//
// The strict reading (readConditionExpression, conditionExpression.ts) is tried
// first, so a test it reads opens exactly as before. Otherwise the test is cut
// at its top-level `||`, each operand at its top-level `&&` (conditionCodeScan.ts),
// and each part is read on its own: a condition the strict reading takes, a list
// test, or locked code holding the part's text as written. The groups keep the
// test's meaning: `||` of `&&` runs is how JavaScript itself reads `a || b && c`.
// A test with something looser than `&&` and `||` at its top (a ternary, `??`)
// is one locked part. Only code that cannot be delimited at all (a regular
// expression, an unclosed bracket) reads as undefined, and is shown as code.
//
// Nothing here writes: untouched, the node keeps its bytes; an edit writes the
// model back with emitConditionExpression, the locked parts as they were read.
// Pure, bounded and total.

import { assert } from '../../shared/core/assert';
import { CONDITIONAL_LIMITS } from './conditionalValue';
import { cutAt, scanTopLevel, withoutOuterParentheses } from './conditionCodeScan';
import {
  CONDITION_EXPRESSION_LIMITS,
  isCodeCondition,
  isConditionSubject,
  isOptionalChainSubject,
  isWritableLiteral,
  readConditionExpression,
  type ConditionExpression,
  type ExpressionCondition,
  type ExpressionGroup,
  type ExpressionLiteral,
} from './conditionExpression';

/** The model `code` says, its undrawable parts as locked code; undefined only when the code cannot be delimited. */
export function readRichConditionExpression(code: string): ConditionExpression | undefined {
  if (code.length > CONDITION_EXPRESSION_LIMITS.richCodeCharsMax) {
    return undefined;
  }
  const leading = leadingComments(code);
  if (leading.length === 0) {
    return readBody(code);
  }
  // Comments before the test are kept as written; what follows them is the test.
  const rest = readBody(code.trimStart().slice(leading.length));
  return rest === undefined || rest.groups.length === 0 ? undefined : { ...rest, leading };
}

// The test with no comment before it.
function readBody(code: string): ConditionExpression | undefined {
  const strict = readConditionExpression(code);
  if (strict !== undefined) {
    return strict;
  }
  const scan = scanTopLevel(code);
  if (scan === undefined) {
    return undefined;
  }
  const whole = code.trim();
  assert(whole.length > 0, 'readRichConditionExpression: blank code reads strictly');
  if (scan.loose) {
    return { groups: [{ match: 'all', conditions: [locked(whole)] }] };
  }
  const operands = cutAt(code, scan.ors, 2);
  if (operands.some((operand) => operand === '')) {
    return undefined; // `a ||` is not a test.
  }
  const runs: (readonly ExpressionCondition[])[] = [];
  for (const operand of operands) {
    const run = readRun(operand);
    if (run === undefined) {
      return undefined;
    }
    runs.push(run);
  }
  return boundedModel(groupsOf(runs));
}

// The comments a test opens with, as written (spacing between them kept), or '' when it opens with code.
function leadingComments(code: string): string {
  const text = code.trimStart();
  let end = 0;
  for (let round = 0; round < CONDITION_EXPRESSION_LIMITS.groupsMax && end < text.length; round += 1) {
    const at = end + (text.slice(end).length - text.slice(end).trimStart().length);
    if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2);
      if (close < 0) {
        return '';
      }
      end = close + 2;
    } else if (text.startsWith('//', at)) {
      const close = text.indexOf('\n', at);
      if (close < 0) {
        return ''; // A line comment with nothing after it is all comment.
      }
      end = close;
    } else {
      break;
    }
  }
  return text.slice(0, end).trimEnd();
}

// `a && b && (c)`: the conditions of one `&&` run, each part read on its own.
function readRun(operand: string): readonly ExpressionCondition[] | undefined {
  const scan = scanTopLevel(operand);
  if (scan === undefined) {
    return undefined;
  }
  const parts = cutAt(operand, scan.ands, 2);
  if (parts.some((part) => part === '')) {
    return undefined;
  }
  const conditions: ExpressionCondition[] = [];
  for (const part of parts) {
    conditions.push(...readPart(part));
    if (conditions.length > CONDITION_EXPRESSION_LIMITS.conditionsPerGroupMax) {
      return undefined;
    }
  }
  assert(conditions.length >= parts.length, 'readRun: every part is at least one condition');
  return conditions;
}

// One part: what the strict reading takes as one `all` group (so `(a && b)` joins the run), a list test, or locked code.
function readPart(part: string): readonly ExpressionCondition[] {
  const strict = readConditionExpression(part);
  const [only] = strict?.groups ?? [];
  if (strict !== undefined && strict.groups.length === 1 && only !== undefined) {
    if (only.match === 'all' || only.conditions.length === 1) {
      return only.conditions;
    }
  }
  const list = readListTest(part);
  if (list !== undefined) {
    return [list];
  }
  const chained = readOptionalChainTest(part);
  if (chained !== undefined) {
    return [chained];
  }
  return [locked(part)];
}

// Locked code holds the part as written, less the parentheses around all of it, which the writer puts back where needed.
function locked(part: string): ExpressionCondition {
  const code = withoutOuterParentheses(part);
  assert(code.length > 0, 'locked: a part is never blank');
  return { kind: 'code', code };
}

// `||` of runs: plain conditions alone are one `any` group; a run of more than one is a group of its own.
function groupsOf(runs: readonly (readonly ExpressionCondition[])[]): readonly ExpressionGroup[] {
  assert(runs.length > 0, 'groupsOf: there is a run');
  const [first] = runs;
  if (runs.length === 1 && first !== undefined) {
    return [{ match: 'all', conditions: first }];
  }
  if (runs.every((run) => run.length === 1)) {
    return [{ match: 'any', conditions: runs.flat() }];
  }
  return runs.map((conditions) => ({ match: 'all', conditions }));
}

function boundedModel(groups: readonly ExpressionGroup[]): ConditionExpression | undefined {
  if (groups.length > CONDITION_EXPRESSION_LIMITS.groupsMax) {
    return undefined;
  }
  if (groups.some((group) => group.conditions.length > CONDITION_EXPRESSION_LIMITS.conditionsPerGroupMax)) {
    return undefined;
  }
  return { groups };
}

// ---------------------------------------------------------------------------
// Optional chaining.
// ---------------------------------------------------------------------------

// A name whose steps may be optional (`a?.b`, `a?.[0]`, `a.b?.["c"]`), then the rest of the test.
const CHAINED_TEST = /^(!?)\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|(?:\?\.)?\[(?:\d+|"[^"\\\]]*"|'[^'\\\]]*')\])*)([\s\S]*)$/;

// A placeholder name the strict reading reads the rest of the test against; the real name is put back after.
const PLACEHOLDER = 'subject';

/**
 * `image?.url`, `!item?.hidden`, `note?.kind === "callout"`: the test the
 * strict reading takes once the name is plain, with the name kept as written.
 */
export function readOptionalChainTest(part: string): ExpressionCondition | undefined {
  const match = CHAINED_TEST.exec(part.trim());
  const negation = match?.[1] ?? '';
  const subject = match?.[2];
  const rest = match?.[3] ?? '';
  if (subject === undefined || !isOptionalChainSubject(subject)) {
    return undefined;
  }
  const model = readConditionExpression(`${negation}${PLACEHOLDER}${rest}`);
  const [group] = model?.groups ?? [];
  const [condition] = group?.conditions ?? [];
  if (model?.groups.length !== 1 || group?.conditions.length !== 1 || condition === undefined || isCodeCondition(condition)) {
    return undefined;
  }
  if (condition.subject !== PLACEHOLDER) {
    return undefined; // `.length` or a call after the name took a step of it: the shapes are not this simple one.
  }
  return { ...condition, subject };
}

// ---------------------------------------------------------------------------
// List tests.
// ---------------------------------------------------------------------------

const LIST_TEST = /^(!?)\s*\[([^\]]*)\]\s*\.\s*includes\s*\(\s*([^()]+?)\s*\)$/;
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** `["a", "b"].includes(x)` as Is any of, `!["a", "b"].includes(x)` as Is none of: words or plain numbers, one name. */
export function readListTest(part: string): ExpressionCondition | undefined {
  const match = LIST_TEST.exec(part.trim());
  const subject = match?.[3];
  const items = match?.[2];
  if (match === null || subject === undefined || items === undefined || !isConditionSubject(subject)) {
    return undefined;
  }
  const values = readListItems(items);
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  return { subject, operator: match[1] === '!' ? 'isNoneOf' : 'isAnyOf', values };
}

function readListItems(items: string): readonly ExpressionLiteral[] | undefined {
  const values: ExpressionLiteral[] = [];
  let index = 0;
  for (let round = 0; round <= CONDITIONAL_LIMITS.valuesPerConditionMax; round += 1) {
    index = skipSpace(items, index);
    if (index >= items.length) {
      return values;
    }
    const item = readListItem(items, index);
    if (item === undefined || values.length >= CONDITIONAL_LIMITS.valuesPerConditionMax) {
      return undefined;
    }
    values.push(item.value);
    index = skipSpace(items, item.end);
    if (index < items.length) {
      if (items.charAt(index) !== ',') {
        return undefined;
      }
      index += 1;
    }
  }
  return undefined;
}

function readListItem(items: string, start: number): { readonly value: ExpressionLiteral; readonly end: number } | undefined {
  const quote = items.charAt(start);
  if (quote === '"' || quote === "'") {
    const close = items.indexOf(quote, start + 1);
    const value: ExpressionLiteral = { kind: 'string', value: items.slice(start + 1, close) };
    // A string the writer cannot spell back (an escape, a line break) stays code with the list.
    return close > start && isWritableLiteral(value) ? { value, end: close + 1 } : undefined;
  }
  const number = /^-?[\d.]+/.exec(items.slice(start));
  if (number !== null && PLAIN_NUMBER.test(number[0])) {
    return { value: { kind: 'number', value: Number(number[0]) }, end: start + number[0].length };
  }
  return undefined;
}

function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** Whether any part of `model` is locked code: what a strict-only reader would have refused. */
export function hasLockedCode(model: ConditionExpression): boolean {
  return model.groups.some((group) => group.conditions.some(isCodeCondition));
}
