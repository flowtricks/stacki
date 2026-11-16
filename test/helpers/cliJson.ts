// Reading JSON in the CLI suites without type assertions: parse to unknown, then walk it by keys and positions.
export function parseJson(text: string | undefined): unknown {
  return text === undefined ? undefined : JSON.parse(text);
}

/** The value at `path` inside `value`, or undefined where the walk leaves the data. */
export function dig(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const step of path) {
    if (typeof current !== 'object' || current === undefined || current === false) {
      return undefined;
    }
    current = Reflect.get(Object(current), step);
  }
  return current;
}
