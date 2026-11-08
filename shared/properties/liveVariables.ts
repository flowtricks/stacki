// Live custom-property overrides: what the app tells a canvas frame while a
// variable's value is being nudged, typed or scrubbed, before the file holds it.
//
// Writing the stylesheet on every arrow press made the page trail the field by a
// file write and a style reload per step. The app instead sets the value in the
// frame at once, as an `!important` declaration on the variable's own selector,
// so every `clamp()` and `calc()` that reads it recomputes in the same frame. The
// write follows once the edit settles; the override is dropped when the page's
// own stylesheet agrees with it, so the swap never shows the old value.

export const LIVE_VARIABLE_MESSAGE = 'avb:live-variable';

export const LIVE_VARIABLE_LIMITS = {
  /** Overrides held at once: one per field being edited, with headroom for modes. */
  entriesMax: 64,
  selectorCharsMax: 1_000,
  /** At-rules and parent selectors around the declaration. */
  contextMax: 8,
  nameCharsMax: 200,
  valueCharsMax: 2_000,
  /** How long an override waits for the page to agree before it is dropped anyway. */
  settleFramesMax: 180,
} as const satisfies Record<string, number>;

/** Where the value lives and what it is now. */
export interface LiveVariable {
  /** `:root`, or the mode's own selector. */
  readonly selector: string;
  /** At-rules (`@media …`) and parent selectors around the rule, outermost first. */
  readonly context: readonly string[];
  /** `--name`. */
  readonly name: string;
  readonly value: string;
}

export type LiveVariableMessage =
  | { readonly type: typeof LIVE_VARIABLE_MESSAGE; readonly op: 'set'; readonly variable: LiveVariable }
  /** `until`: keep the override until the page itself computes this value (the
   *  write landed). Absent: the edit was abandoned, drop it now. */
  | { readonly type: typeof LIVE_VARIABLE_MESSAGE; readonly op: 'drop'; readonly variable: LiveVariable; readonly until?: string | undefined }
  | { readonly type: typeof LIVE_VARIABLE_MESSAGE; readonly op: 'clear' };

/** The key two messages about one declaration share. */
export function liveVariableKey(variable: Pick<LiveVariable, 'selector' | 'context' | 'name'>): string {
  return [...variable.context, variable.selector, variable.name].join('\n');
}

// Text that is spliced into a stylesheet must not be able to close the block it
// sits in, end the declaration early, or add its own `!important`.
const CSS_BREAKOUT = /[{};!<\\]/;
const VARIABLE_NAME = /^--[\w-]+$/;

function cssFragment(input: unknown, charsMax: number): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > charsMax) {
    return undefined;
  }
  if (CSS_BREAKOUT.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

// Context entries are `@media …`/`@supports …` preludes or parent selectors; the
// same breakout rule holds, and `@` may appear only to open an at-rule.
function contextOf(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const values: readonly unknown[] = input;
  if (values.length > LIVE_VARIABLE_LIMITS.contextMax) {
    return undefined;
  }
  const context: string[] = [];
  for (const value of values) {
    const part = cssFragment(value, LIVE_VARIABLE_LIMITS.selectorCharsMax);
    if (part === undefined) {
      return undefined;
    }
    context.push(part);
  }
  return context;
}

export function parseLiveVariable(input: unknown): LiveVariable | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const selector = 'selector' in input ? cssFragment(input.selector, LIVE_VARIABLE_LIMITS.selectorCharsMax) : undefined;
  const context = 'context' in input ? contextOf(input.context) : undefined;
  const name = 'name' in input ? cssFragment(input.name, LIVE_VARIABLE_LIMITS.nameCharsMax) : undefined;
  const value = 'value' in input ? cssFragment(input.value, LIVE_VARIABLE_LIMITS.valueCharsMax) : undefined;
  if (selector === undefined || context === undefined || name === undefined || value === undefined) {
    return undefined;
  }
  if (!VARIABLE_NAME.test(name)) {
    return undefined;
  }
  return { selector, context, name, value };
}

/** A message for the frame, or undefined when `input` is not one (or is malformed). */
export function parseLiveVariableMessage(input: unknown): LiveVariableMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== LIVE_VARIABLE_MESSAGE || !('op' in input)) {
    return undefined;
  }
  if (input.op === 'clear') {
    return { type: LIVE_VARIABLE_MESSAGE, op: 'clear' };
  }
  const variable = 'variable' in input ? parseLiveVariable(input.variable) : undefined;
  if (variable === undefined) {
    return undefined;
  }
  if (input.op === 'set') {
    return { type: LIVE_VARIABLE_MESSAGE, op: 'set', variable };
  }
  if (input.op !== 'drop') {
    return undefined;
  }
  if (!('until' in input) || input.until === undefined) {
    return { type: LIVE_VARIABLE_MESSAGE, op: 'drop', variable };
  }
  const until = cssFragment(input.until, LIVE_VARIABLE_LIMITS.valueCharsMax);
  return until === undefined ? undefined : { type: LIVE_VARIABLE_MESSAGE, op: 'drop', variable, until };
}

/** The stylesheet text that applies `variables`, each inside its own context. */
export function liveVariablesCss(variables: Iterable<LiveVariable>): string {
  const blocks: string[] = [];
  for (const variable of variables) {
    let block = `${variable.selector} { ${variable.name}: ${variable.value} !important; }`;
    for (let index = variable.context.length - 1; index >= 0; index -= 1) {
      block = `${variable.context[index] ?? ''} { ${block} }`;
    }
    blocks.push(block);
  }
  return blocks.join('\n');
}
