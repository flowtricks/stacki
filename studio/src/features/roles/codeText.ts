// The strings and comments of JavaScript, found in one pass. A pattern that looks for a closing mark afresh at every
// opening one takes time that grows with the square of the text, which a hostile file turns into minutes. Here a mark
// that was not found is not looked for again.

export interface Skipper {
  /** Where the string or comment opening at `at` ends, or undefined when none opens there and closes. */
  readonly endOf: (at: number) => number | undefined;
}

export function skipper(source: string): Skipper {
  // How far each kind of quote is known to have no end.
  const open = new Map<string, number>();
  let comments = true;
  const quoted = (at: number, quote: string): number | undefined => {
    if (at < (open.get(quote) ?? 0)) {
      return undefined;
    }
    let index = at + 1;
    for (; index < source.length; index++) {
      const character = source[index];
      if (character === quote) {
        return index + 1;
      }
      if (quote !== '`' && character === '\n') {
        break;
      }
      if (character === '\\' && (quote === '`' || source[index + 1] !== '\n')) {
        index++;
      }
    }
    open.set(quote, index);
    return undefined;
  };
  return {
    endOf(at) {
      const character = source[at] ?? '';
      if (character === '"' || character === "'" || character === '`') {
        return quoted(at, character);
      }
      if (character !== '/') {
        return undefined;
      }
      if (source[at + 1] === '/') {
        const line = source.indexOf('\n', at);
        return line < 0 ? source.length : line;
      }
      if (source[at + 1] !== '*' || !comments) {
        return undefined;
      }
      const close = source.indexOf('*/', at + 2);
      comments = close >= 0;
      return close < 0 ? undefined : close + 2;
    },
  };
}

/** Whether `code` is nothing but space and comments. */
export function onlyComments(code: string): boolean {
  const strings = skipper(code);
  for (let at = 0; at < code.length;) {
    if (/\s/.test(code[at] ?? '')) {
      at++;
    } else {
      const end = code[at] === '/' ? strings.endOf(at) : undefined;
      if (end === undefined) {
        return false;
      }
      at = end;
    }
  }
  return true;
}
