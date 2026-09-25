import { PROPERTY_LIMITS } from './component-properties';

// Only literal unions expose option controls. Complex unions remain in the type editor.
export function literalOptions(type: string): readonly string[] | undefined {
  const tokens = type.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false/g);
  if (!tokens || tokens.length < 1 || tokens.length > PROPERTY_LIMITS.fieldsMax) {
    return undefined;
  }
  const remaining = type.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false/g,
    ''
  );
  if (!/^\s*(?:\|\s*)*$/.test(remaining)) {
    return undefined;
  }
  if ((remaining.match(/\|/g)?.length ?? 0) !== tokens.length - 1) {
    return undefined;
  }
  return tokens;
}
