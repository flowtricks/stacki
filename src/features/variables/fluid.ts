import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

// Fluid type, and whether a reader can enlarge it.
//
// This lives with the panel rather than with the file reader because it has to
// run on what is being typed. Editing `--site-margin-min` changes what
// `--site-margin`'s clamp() amounts to, and the badge that says so has to move
// with the keystroke — waiting for the save would mean the warning arrives
// after the decision it was meant to inform.

// A chain of variables that refer to variables is short in any real stylesheet;
// past this many hops the value is returned as far as it got, which also stops
// a self-referencing variable from looping.
const FLUID_LIMITS = { referenceDepthMax: 8 } as const;

// A value with its variables substituted, following references until nothing
// is left to follow. `overrides` is what is being typed right now, which is not
// yet what the file says.
export function resolveValue(value: string, values?: Readonly<Record<string, string>>, overrides?: Readonly<Record<string, string>>, depth = 0): string {
  if (depth > FLUID_LIMITS.referenceDepthMax) {
    return value;
  }
  const next = String(value).replace(
    /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (whole: string, name: string, fallback: string | undefined): string => {
      const found = overrides?.[name] ?? values?.[name];
      if (found !== undefined) {
        return found;
      }
      return fallback !== undefined ? fallback.trim() : whole;
    },
  );
  return next === String(value) ? next : resolveValue(next, values, overrides, depth + 1);
}

//
// A fluid value is a clamp() of three parts: a floor, a linear term that grows
// with the viewport, and a ceiling. Written the usual way — a min and a max
// size, scaled between a min and a max viewport — it carries two accessibility
// hazards, and both are visible in the numbers:
//
//   error    At 500% zoom the viewport is a fifth as wide, which puts nearly
//            any screen below the minimum, so the value locks to its floor and
//            is then magnified 5×. WCAG 1.4.4 wants text to reach 200% of what
//            it started at, so 5·min >= 2·max — a max more than 2.5× the min
//            never doubles for a zoomed-in reader.
//
//   warning  vw units ignore the reader's font-size preference; only the rem
//            part of the linear term answers to it. If that part is zero or
//            negative the value cannot be enlarged at all, and a negative one
//            actively shrinks as the root size grows.
//
// The numbers are read out of the expression itself rather than from fields, so
// this works on any clamp() written any way round — including one built out of
// variables, which is resolved first.

// Splits `a, b, c` at the top level, ignoring commas inside nested parentheses.
export function splitArgs(text: string): readonly string[] {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

// Arithmetic, in rem, with `vw` left as a symbol so the linear term can be read
// off. Anything it does not understand — a nested function, a unit that depends
// on context — makes the whole reading fail rather than a wrong number.
export function evaluate(text: unknown, viewportWidth: number): number | undefined {
  const source = String(text);
  if (source.length > LIMITS.nodeValueCharsMax) {
    return undefined;
  }
  return new ArithmeticReader(source, viewportWidth).read();
}

// Only this reader mutates the cursor. Every operator consumes a character;
// nested parentheses and unary minus share the same explicit depth budget.
class ArithmeticReader {
  private position = 0;
  constructor(
    private readonly source: string,
    private readonly viewportWidth: number,
  ) {}

  read(): number | undefined {
    const value = this.expression(0);
    this.skip();
    return this.position === this.source.length ? value : undefined;
  }

  private skip(): void {
    while (this.position < this.source.length && /\s/.test(this.source.charAt(this.position))) {
      this.position++;
    }
  }

  private expression(depth: number): number | undefined {
    let value = this.term(depth);
    for (let count = 0; count <= this.source.length; count++) {
      this.skip();
      const operator = this.source[this.position];
      if (operator !== '+' && operator !== '-') {
        return value;
      }
      this.position++;
      const right = this.term(depth);
      if (right === undefined || value === undefined) {
        return undefined;
      }
      value = operator === '+' ? value + right : value - right;
    }
    assert(false, 'Arithmetic expression must consume input');
  }

  private term(depth: number): number | undefined {
    let value = this.factor(depth);
    for (let count = 0; count <= this.source.length; count++) {
      this.skip();
      const operator = this.source[this.position];
      if (operator !== '*' && operator !== '/') {
        return value;
      }
      this.position++;
      const right = this.factor(depth);
      if (right === undefined || value === undefined) {
        return undefined;
      }
      value = operator === '*' ? value * right : value / right;
    }
    assert(false, 'Arithmetic term must consume input');
  }

  private factor(depth: number): number | undefined {
    if (depth > LIMITS.treeDepthMax) {
      return undefined;
    }
    this.skip();
    if (this.source[this.position] === '(') {
      this.position++;
      const value = this.expression(depth + 1);
      this.skip();
      if (this.source[this.position] !== ')') {
        return undefined;
      }
      this.position++;
      return value;
    }
    if (this.source[this.position] === '-') {
      this.position++;
      const value = this.factor(depth + 1);
      return value === undefined ? undefined : -value;
    }
    const match = /^([0-9]*\.?[0-9]+)(px|rem|em|vw|vh|%)?/.exec(this.source.slice(this.position));
    if (!match?.[1]) {
      return undefined;
    }
    this.position += match[0].length;
    const number = parseFloat(match[1]);
    switch (match[2]) {
      case undefined:
      case 'rem':
        return number;
      case 'px':
        return number / 16;
      case 'vw':
        return number * this.viewportWidth;
      default:
        return undefined;
    }
  }
}

export const FLUID_LINK = 'https://www.smashingmagazine.com/2023/11/' + 'addressing-accessibility-concerns-fluid-type/#conclusion';

/**
 * What a fluid clamp() is worth, accessibility-wise: { status, min, max, rem,
 * vw }, or undefined when the value is not one. `resolved` is the value with its
 * variables already substituted — the check is on numbers, never on names.
 */
export function fluidCheck(resolved: unknown) {
  const text = String(resolved || '').trim();
  const match = /^clamp\(([\s\S]*)\)$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const args = splitArgs(match[1] ?? '');
  if (args.length !== 3) {
    return undefined;
  }

  const min = evaluate(args[0], 0);
  const max = evaluate(args[2], 0);
  // The middle term read as `rem + coefficient · vw`: its value with no
  // viewport at all is the rem part, and the step to one vw is the coefficient.
  const base = evaluate(args[1], 0);
  const atOne = evaluate(args[1], 1);
  if ([min, max, base, atOne].some((reading) => reading === undefined || !Number.isFinite(reading))) {
    return undefined;
  }
  if (min === undefined || max === undefined || base === undefined || atOne === undefined) {
    return undefined;
  }
  const vw = atOne - base;
  // No viewport term is a clamp, but not a fluid one — nothing here applies.
  if (vw === 0) {
    return undefined;
  }

  // Inverted values (a max below the min) are read the way they render, or the
  // ratio test passes on a value that fails it in the other direction.
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const accessible = high <= 2.5 * low;
  const zooms = base > 0;
  return {
    status: !accessible ? 'error' : !zooms ? 'warning' : 'ok',
    min: low,
    max: high,
    rem: base,
    vw,
    link: FLUID_LINK,
  };
}
