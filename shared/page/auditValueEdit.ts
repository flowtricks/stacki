// Typing a new value for a raw CSS value the review window lists. The window's
// row holds a token (`0.5em` in `gap: 0.5em`); the person types another value, or
// binds a variable, and this module turns that text into the one edit that
// replaces the token's bytes. It never touches the selector, the property, the
// rest of the declaration, or an `!important` flag: only the token's text moves,
// so a rule's formatting survives exactly as written. The edit is the same
// `raw-text` / `file-text` swap the "Use variable" fixes make, so the window sends
// it through the same fix pipeline (undo step, canvas refresh, stale-bytes refusal).
import { err, ok, type Result } from '../core/result';
import { labelText, type AuditCssContext, type AuditEdit, type AuditFinding, type AuditFix } from './auditFindings';

/** Bounds of one typed value. */
export const VALUE_EDIT_LIMITS = { charsMax: 256, parenDepthMax: 16 } as const satisfies Record<string, number>;

/** Why a typed value was not accepted; the window words each one. */
export type ValueRefusal = 'empty' | 'long' | 'illegal' | 'important' | 'unbalanced' | 'unsupported';

/** What the property accepts: asked with the declaration's whole value as it would read. Absent where nothing can answer. */
export type ValueSupport = (property: string, value: string) => boolean;

/** `after` as the text that replaces the token, or why it cannot. The typed text is trimmed; nothing else is rewritten. */
export function parseRawValue(
  css: Pick<AuditCssContext, 'property' | 'value' | 'token'>,
  typed: string,
  supports: ValueSupport | undefined,
): Result<string, ValueRefusal> {
  const text = typed.trim();
  if (text.length === 0) {
    return err('empty');
  }
  if (text.length > VALUE_EDIT_LIMITS.charsMax) {
    return err('long');
  }
  // These end or open a declaration or a rule, or smuggle a comment: one value never holds them.
  if (/[;{}\n\r\\<>]|\/\*|\*\//.test(text)) {
    return err('illegal');
  }
  if (text.includes('!')) {
    return err('important');
  }
  if (!balanced(text)) {
    return err('unbalanced');
  }
  if (supports !== undefined && !supports(css.property, withToken(css, text))) {
    return err('unsupported');
  }
  return ok(text);
}

/** The edit that replaces the token with `after`, or undefined where its bytes are not known (an inline style). */
export function valueEdit(css: AuditCssContext, after: string): AuditEdit | undefined {
  const place = css.place;
  if (place === undefined) {
    return undefined;
  }
  if (place.tag === 'style-block') {
    return { tag: 'raw-text', path: place.path, expect: 'style', offset: place.offset, before: css.token, after };
  }
  return { tag: 'file-text', offset: place.offset, before: css.token, after };
}

/** `findings` rewritten so each carries the fix that sets its token to `after`, or undefined when any one has no known place. */
export function valueFixes(findings: readonly AuditFinding[], after: string): readonly AuditFinding[] | undefined {
  const rewritten: AuditFinding[] = [];
  for (const finding of findings) {
    const css = finding.css;
    const edit = css === undefined ? undefined : valueEdit(css, after);
    if (css === undefined || edit === undefined) {
      return undefined;
    }
    const fix: AuditFix = {
      ...labelText('audits.fix.setValue', { property: css.property, value: after }),
      before: `${css.property}: ${css.value};`,
      after: `${css.property}: ${withToken(css, after)};`,
      file: finding.file,
      edits: [edit],
    };
    rewritten.push({ ...finding, fix });
  }
  return rewritten;
}

/** The declaration's value with its first token replaced by `after`: what the property would read. */
export function withToken(css: Pick<AuditCssContext, 'value' | 'token'>, after: string): string {
  const at = css.value.indexOf(css.token);
  return at < 0 ? after : `${css.value.slice(0, at)}${after}${css.value.slice(at + css.token.length)}`;
}

// Parentheses and quotes pair up, within the depth bound.
function balanced(text: string): boolean {
  let depth = 0;
  let quote = '';
  for (const char of text) {
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
      if (depth > VALUE_EDIT_LIMITS.parenDepthMax) {
        return false;
      }
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0 && quote === '';
}
