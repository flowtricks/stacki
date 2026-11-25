// Surgical edits of a project's `studio/cloudflare/wrangler.jsonc` for the sign-in variables.
// The file is the owner's: it holds comments, trailing commas and their own routes, so nothing here
// parses and re-prints it. A small scanner finds the `vars` object and the spans of its members; an
// edit replaces, inserts or deletes exactly one member's text and leaves every other byte alone.
// Pure text in, text out: the caller reads and writes the file.
import { err, ok, type Result } from '../core/result';
import { STUDIO_AUTH_VARIABLES, studioAuthVariables, isStudioAuthKind, type StudioAuthConfig, type StudioSignIn } from './studioAuth';

export const STUDIO_CONFIG_BYTES_MAX = 1_000_000;
const MEMBERS_MAX = 2_000;
const EXPLANATION = '// How people sign in to Studio. Client secrets are never stored here; add them with `wrangler secret put`.';

export type StudioAuthEditProblem =
  | { readonly kind: 'tooLarge' }
  | { readonly kind: 'syntax' }
  | { readonly kind: 'noVars' }
  /** AUTH_PROVIDER is already set and the caller did not say it may be replaced. */
  | { readonly kind: 'alreadySet'; readonly provider: string };

/** `refuse` keeps an existing AUTH_PROVIDER and says so; `replace` is the owner's explicit change. */
export type StudioAuthExisting = 'refuse' | 'replace';

interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** The comma that ends this member, or undefined for a last member without one. */
  readonly commaAt: number | undefined;
}

interface Vars {
  readonly openAt: number;
  readonly closeAt: number;
  readonly members: readonly Member[];
}

/** The sign-in a file says today: no AUTH_PROVIDER means GitHub; a value Stacki did not write is `custom`. */
export function readStudioSignIn(text: string): Result<StudioSignIn, StudioAuthEditProblem> {
  const vars = findVars(text);
  if (!vars.ok) {
    // A file without `vars` sets no AUTH_PROVIDER either, so Studio's default applies.
    return vars.error.kind === 'noVars' ? ok('github') : vars;
  }
  const member = vars.value.members.find((candidate) => candidate.key === 'AUTH_PROVIDER');
  if (member === undefined) {
    return ok('github');
  }
  const value = stringValue(text, member);
  return ok(value !== undefined && isStudioAuthKind(value) ? value : 'custom');
}

/** Write the choice into the file's `vars`, removing the sign-in variables the choice does not use. */
export function applyStudioAuth(text: string, config: StudioAuthConfig, existing: StudioAuthExisting): Result<string, StudioAuthEditProblem> {
  const found = findVars(text);
  if (!found.ok) {
    return found;
  }
  const current = found.value.members.find((member) => member.key === 'AUTH_PROVIDER');
  const currentValue = current === undefined ? undefined : (stringValue(text, current) ?? '');
  if (currentValue !== undefined && existing === 'refuse') {
    return err({ kind: 'alreadySet', provider: currentValue });
  }
  const wanted = studioAuthVariables(config);
  const keep = new Set<string>(wanted.map(([key]) => key));
  let next = text;
  for (const key of STUDIO_AUTH_VARIABLES) {
    if (!keep.has(key)) {
      const removed = removeMember(next, key);
      if (!removed.ok) {
        return removed;
      }
      next = removed.value;
    }
  }
  for (const [key, value] of wanted) {
    const set = setMember(next, key, value);
    if (!set.ok) {
      return set;
    }
    next = set.value;
  }
  return ok(next);
}

// Edits ---------------------------------------------------------------------

function setMember(text: string, key: string, value: string): Result<string, StudioAuthEditProblem> {
  const found = findVars(text);
  if (!found.ok) {
    return found;
  }
  const vars = found.value;
  const literal = JSON.stringify(value);
  const member = vars.members.find((candidate) => candidate.key === key);
  if (member !== undefined) {
    return ok(text.slice(0, member.valueStart) + literal + text.slice(member.valueEnd));
  }
  const comment = key === 'AUTH_PROVIDER' ? EXPLANATION : undefined;
  return ok(insertMember(text, vars, key, literal, comment));
}

function insertMember(text: string, vars: Vars, key: string, literal: string, comment: string | undefined): string {
  const last = vars.members[vars.members.length - 1];
  if (last === undefined) {
    const indent = `${lineIndent(text, vars.openAt)}  `;
    const body = (comment === undefined ? '' : `\n${indent}${comment}`) + `\n${indent}"${key}": ${literal},`;
    return text.slice(0, vars.openAt + 1) + body + `\n${lineIndent(text, vars.openAt)}` + text.slice(vars.closeAt);
  }
  const trailing = last.commaAt !== undefined;
  const lastEnd = last.commaAt === undefined ? last.valueEnd : last.commaAt + 1;
  const lineEnd = text.indexOf('\n', lastEnd);
  const sameLineAsClose = lineEnd === -1 || lineEnd > vars.closeAt;
  const comma = trailing ? ',' : '';
  if (sameLineAsClose) {
    // A one-line object: `"vars": { "A": "b" }`.
    const separator = last.commaAt === undefined ? ',' : '';
    return text.slice(0, lastEnd) + `${separator} "${key}": ${literal}${comma}` + text.slice(lastEnd);
  }
  const indent = lineIndent(text, last.keyStart);
  const fixed = last.commaAt === undefined ? text.slice(0, last.valueEnd) + ',' + text.slice(last.valueEnd, lineEnd) : text.slice(0, lineEnd);
  const rest = text.slice(lineEnd);
  const body = (comment === undefined ? '' : `\n${indent}${comment}`) + `\n${indent}"${key}": ${literal}${comma}`;
  return fixed + body + rest;
}

function removeMember(text: string, key: string): Result<string, StudioAuthEditProblem> {
  const found = findVars(text);
  if (!found.ok) {
    return found;
  }
  const vars = found.value;
  const index = vars.members.findIndex((candidate) => candidate.key === key);
  const member = vars.members[index];
  if (member === undefined) {
    return ok(text);
  }
  const lineStart = text.lastIndexOf('\n', member.keyStart) + 1;
  const ownsLine = text.slice(lineStart, member.keyStart).trim().length === 0;
  const memberEnd = member.commaAt === undefined ? member.valueEnd : member.commaAt + 1;
  if (!ownsLine) {
    // Several members share a line: remove only this one and its comma.
    return ok(text.slice(0, member.keyStart) + text.slice(memberEnd).replace(/^\s+/, ''));
  }
  let from = lineStart;
  const lineEnd = text.indexOf('\n', memberEnd);
  const to = lineEnd === -1 ? text.length : lineEnd + 1;
  // Take the sentence the setup wrote above AUTH_PROVIDER with it, and only that sentence.
  if (key === 'AUTH_PROVIDER') {
    const before = text.slice(0, lineStart);
    const commentLineStart = before.lastIndexOf('\n', before.length - 2) + 1;
    if (before.slice(commentLineStart).trim() === EXPLANATION) {
      from = commentLineStart;
    }
  }
  let result = text.slice(0, from) + text.slice(to);
  if (member.commaAt === undefined && index > 0) {
    // The last member had no comma: the one before it must not keep a dangling one.
    result = dropCommaBefore(result, from);
  }
  return ok(result);
}

function dropCommaBefore(text: string, at: number): string {
  let cursor = at - 1;
  for (let steps = 0; steps < 4_096 && cursor >= 0; steps += 1) {
    const character = text.charAt(cursor);
    if (character === ',') {
      return text.slice(0, cursor) + text.slice(cursor + 1);
    }
    if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
      return text;
    }
    cursor -= 1;
  }
  return text;
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, at));
  return match === null ? '' : match[0];
}

function stringValue(text: string, member: Member): string | undefined {
  const raw = text.slice(member.valueStart, member.valueEnd);
  if (raw.length < 2 || !raw.startsWith('"')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Scanning ------------------------------------------------------------------

interface Token {
  readonly kind: 'open' | 'close' | 'comma' | 'colon' | 'string' | 'word';
  readonly start: number;
  readonly end: number;
  readonly char: string;
}

function tokenize(text: string): Result<readonly Token[], StudioAuthEditProblem> {
  if (text.length > STUDIO_CONFIG_BYTES_MAX) {
    return err({ kind: 'tooLarge' });
  }
  const tokens: Token[] = [];
  let index = 0;
  // Every pass moves `index` forward, so the loop ends within the text's length.
  for (let steps = 0; index < text.length && steps <= text.length; steps += 1) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) {
        return err({ kind: 'syntax' });
      }
      index = end + 2;
    } else if (char === '"') {
      const end = stringEnd(text, index);
      if (end === undefined) {
        return err({ kind: 'syntax' });
      }
      tokens.push({ kind: 'string', start: index, end, char });
      index = end;
    } else if (char === '{' || char === '[') {
      tokens.push({ kind: 'open', start: index, end: index + 1, char });
      index += 1;
    } else if (char === '}' || char === ']') {
      tokens.push({ kind: 'close', start: index, end: index + 1, char });
      index += 1;
    } else if (char === ',') {
      tokens.push({ kind: 'comma', start: index, end: index + 1, char });
      index += 1;
    } else if (char === ':') {
      tokens.push({ kind: 'colon', start: index, end: index + 1, char });
      index += 1;
    } else {
      const start = index;
      while (index < text.length && !/[\s,:{}[\]"/]/.test(text.charAt(index))) {
        index += 1;
      }
      if (index === start) {
        return err({ kind: 'syntax' });
      }
      tokens.push({ kind: 'word', start, end: index, char });
    }
  }
  return ok(tokens);
}

function stringEnd(text: string, start: number): number | undefined {
  let index = start + 1;
  for (let steps = 0; index < text.length && steps <= text.length; steps += 1) {
    const char = text.charAt(index);
    if (char === '\\') {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else if (char === '\n') {
      return undefined;
    } else {
      index += 1;
    }
  }
  return undefined;
}

// The index just past the value that starts at `from`, and the index of the token after it.
function skipValue(tokens: readonly Token[], from: number): number | undefined {
  const first = tokens[from];
  if (first === undefined) {
    return undefined;
  }
  if (first.kind === 'string' || first.kind === 'word') {
    return from + 1;
  }
  if (first.kind !== 'open') {
    return undefined;
  }
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === 'open') {
      depth += 1;
    } else if (token?.kind === 'close') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

// Members of the object whose `{` is token `openIndex`.
function objectMembers(
  text: string,
  tokens: readonly Token[],
  openIndex: number,
): { readonly members: readonly Member[]; readonly closeAt: number } | undefined {
  const members: Member[] = [];
  let index = openIndex + 1;
  for (let steps = 0; steps <= MEMBERS_MAX; steps += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return undefined;
    }
    if (token.kind === 'close') {
      return { members, closeAt: token.start };
    }
    const colon = tokens[index + 1];
    if (token.kind !== 'string' || colon?.kind !== 'colon') {
      return undefined;
    }
    const valueIndex = index + 2;
    const after = skipValue(tokens, valueIndex);
    const valueStart = tokens[valueIndex];
    const valueLast = after === undefined ? undefined : tokens[after - 1];
    if (after === undefined || valueStart === undefined || valueLast === undefined) {
      return undefined;
    }
    const separator = tokens[after];
    const hasComma = separator?.kind === 'comma';
    members.push({
      key: keyText(text, token),
      keyStart: token.start,
      valueStart: valueStart.start,
      valueEnd: valueLast.end,
      commaAt: hasComma ? separator.start : undefined,
    });
    index = hasComma ? after + 1 : after;
  }
  return undefined;
}

function keyText(text: string, token: Token): string {
  try {
    const parsed: unknown = JSON.parse(text.slice(token.start, token.end));
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

function findVars(text: string): Result<Vars, StudioAuthEditProblem> {
  const tokens = tokenize(text);
  if (!tokens.ok) {
    return tokens;
  }
  const first = tokens.value[0];
  if (first?.kind !== 'open' || first.char !== '{') {
    return err({ kind: 'syntax' });
  }
  const root = objectMembers(text, tokens.value, 0);
  if (root === undefined) {
    return err({ kind: 'syntax' });
  }
  const member = root.members.find((candidate) => candidate.key === 'vars');
  if (member === undefined) {
    return err({ kind: 'noVars' });
  }
  const openIndex = tokens.value.findIndex((token) => token.start === member.valueStart);
  const open = tokens.value[openIndex];
  if (open?.kind !== 'open' || open.char !== '{') {
    return err({ kind: 'noVars' });
  }
  const inner = objectMembers(text, tokens.value, openIndex);
  if (inner === undefined) {
    return err({ kind: 'syntax' });
  }
  return ok({ openAt: open.start, closeAt: inner.closeAt, members: inner.members });
}
