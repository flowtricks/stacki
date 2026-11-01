// Small bounded parsers shared by IPC and disk readers. Parsers construct typed
// values; no library or assertion is needed to trust a field after this boundary.
import { toDigest, type Digest } from './brand';
import { LIMITS } from './limits';
import { toArray, toRecord } from './record';

// The wire bounds, named for these parsers. The numbers live in limits.ts so a
// disk reader and the IPC field that carries what it read answer to one bound
// (a 5 MiB copy here once refused files the 10 MB readers accepted).
export const BOUNDARY_LIMITS = {
  textLengthMax: LIMITS.ipcFieldCharsMax,
  pathLengthMax: LIMITS.ipcPathCharsMax,
  itemsMax: LIMITS.ipcItemsMax,
  depthMax: LIMITS.ipcDepthMax,
} as const;

export type Parser<T> = (input: unknown) => T;
export type Parsed<P> = P extends Parser<infer T> ? T : never;
// `null` here is a JSON value a project's data files hold, not absence: a content
// entry's `null` field must round-trip to the file as `null`.
// eslint-disable-next-line stacki/no-null -- JSON null is data in project files, not absence
export type Data = undefined | null | boolean | number | string | Data[] | DataRecord;
export interface DataRecord {
  readonly [key: string]: Data;
}

export function text(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Expected string');
  }
  if (input.length > BOUNDARY_LIMITS.textLengthMax) {
    throw new Error('String exceeds limit');
  }
  return input;
}

export function pathText(input: unknown): string {
  const value = text(input);
  if (value.length > BOUNDARY_LIMITS.pathLengthMax) {
    throw new Error('Path exceeds limit');
  }
  if (value.includes('\0')) {
    throw new Error('Path contains NUL');
  }
  return value;
}

export function digest(input: unknown): Digest {
  if (typeof input !== 'string') {
    throw new Error('Expected digest string');
  }
  return toDigest(input);
}

export function boolean(input: unknown): boolean {
  if (typeof input !== 'boolean') {
    throw new Error('Expected boolean');
  }
  return input;
}

export function count(input: unknown): number {
  if (typeof input !== 'number') {
    throw new Error('Expected number');
  }
  if (!Number.isSafeInteger(input)) {
    throw new Error('Expected safe integer');
  }
  if (input < 0) {
    throw new Error('Expected nonnegative integer');
  }
  return input;
}

export function optional<T>(parse: Parser<T>): Parser<T | undefined> {
  return (input) => (input === undefined ? undefined : parse(input));
}

// For external producers that write `null` themselves (a project iframe's
// messages, legacy payloads). Our own results say absence with `undefined`.
// eslint-disable-next-line stacki/no-null -- parses producers outside our types that send null
export function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (input) => (input === null ? input : parse(input));
}

export function list<T>(parse: Parser<T>): Parser<T[]> {
  return (input) => {
    const values = toArray(input);
    if (!values) {
      throw new Error('Expected array');
    }
    if (values.length > BOUNDARY_LIMITS.itemsMax) {
      throw new Error('Array exceeds limit');
    }
    return values.map(parse);
  };
}

export function record(input: unknown): Record<string, unknown> {
  const value = toRecord(input);
  if (!value) {
    throw new Error('Expected object');
  }
  if (Object.keys(value).length > BOUNDARY_LIMITS.itemsMax) {
    throw new Error('Object exceeds limit');
  }
  return value;
}

type Shape = Readonly<Record<string, Parser<unknown>>>;
type ShapeValue<S extends Shape> = {
  readonly [K in keyof S as undefined extends Parsed<S[K]> ? never : K]: Parsed<S[K]>;
} & {
  readonly [K in keyof S as undefined extends Parsed<S[K]> ? K : never]?: Exclude<Parsed<S[K]>, undefined>;
};

export function object<S extends Shape>(shape: S): Parser<ShapeValue<S>> {
  return (input) => {
    const source = record(input);
    const result: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(shape)) {
      const value = parse(source[key]);
      if (value !== undefined) {
        result[key] = value;
      }
    }
    // Each declared field was parsed above, and the shape controls the keys.
    return result as ShapeValue<S>;
  };
}

export function dictionary<T>(parse: Parser<T>): Parser<Record<string, T>> {
  return (input) => Object.fromEntries(Object.entries(record(input)).map(([key, value]) => [pathText(key), parse(value)]));
}

export function data(input: unknown): Data {
  // A per-message node budget also bounds wide nested objects, not just depth.
  let remaining = BOUNDARY_LIMITS.itemsMax;
  const visit = (value: unknown, depth: number): Data => {
    if (--remaining < 0) {
      throw new Error('Data exceeds item limit');
    }
    if (depth > BOUNDARY_LIMITS.depthMax) {
      throw new Error('Data exceeds depth limit');
    }
    if (value === undefined) {
      return value;
    }
    if (value === null) {
      return value;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return text(value);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error('Expected finite number');
      }
      return value;
    }
    const values = toArray(value);
    if (values) {
      return list((entry) => visit(entry, depth + 1))(values);
    }
    return dictionary((entry) => visit(entry, depth + 1))(value);
  };
  return visit(input, 0);
}

type DefinedFields<T> = {
  readonly [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & { readonly [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

export function definedFields<T extends Readonly<Record<string, unknown>>>(source: T): DefinedFields<T> {
  // Dropping undefined keys makes explicit options safe for exact optional types.
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as DefinedFields<T>;
}
