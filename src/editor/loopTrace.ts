// Where a loop's list really comes from, when the page reads it through code:
// `campusPastors` is `await getCampusPastors()`, which lives in another file,
// which fetches `CAMPUS_PASTORS_QUERY`, which reads Sanity's Campus documents.
// Each hop is one step of a trace the panel shows, so a list named for what
// the page does with it still says which collection it is.
//
// The trace reads code, never runs it. A function's data comes from the first
// call in it that reads a collection (`getCollection('x')`, a fetch of a GROQ
// query held in the file), or else from the first call to an import, which is
// the next hop. Hops are read one file at a time by the caller (the files are
// on disk, reached through the app's bridge), and the number of hops is capped.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { readGroq, type GroqReading } from './groqSyntax';
import type { LoopSource } from './loopQuery';
import { decodeString, namePath, parseModule, type Js, type ParsedModule } from './loopSyntax';

/** Files followed before the trace stops: a list is never more layers deep than this in practice. */
export const TRACE_HOPS_MAX = 6;
const LOCAL_CALLS_MAX = 8;

export type TraceStep =
  | { readonly kind: 'value'; readonly name: string }
  | { readonly kind: 'function'; readonly name: string; readonly file: string }
  | { readonly kind: 'query'; readonly name: string | undefined; readonly file: string }
  | {
      readonly kind: 'collection';
      readonly source: LoopSource;
      readonly groq: GroqReading | undefined;
      readonly file: string;
      /** Where the GROQ string literal is in that file, when the query is one: what an edit rewrites. */
      readonly literal: GroqLiteral | undefined;
    };

/** A GROQ query's string literal in its file: its span, and the query it held when read. */
export interface GroqLiteral {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/** What one function in one file says about where its data comes from. */
export interface FunctionTrace {
  readonly steps: readonly TraceStep[];
  /** The import it hands on to, when its data comes from another module. */
  readonly next: { readonly name: string; readonly spec: string } | undefined;
  /** JS methods that change the list after it is read (`map`, `filter`). */
  readonly reshaped: readonly string[];
}

const RESHAPING = new Set([
  'map',
  'filter',
  'flatMap',
  'sort',
  'toSorted',
  'slice',
  'reduce',
  'reverse',
]);
// Modules whose imports read data rather than lead to more of the project's code.
const FRAMEWORK = new Set(['astro:content', 'sanity:client', 'groq', 'astro']);

/** How `functionName` in a module of `file` gets its data. */
export function traceFunction(text: string, file: string, functionName: string): FunctionTrace {
  const module = parseModule(text);
  const steps: TraceStep[] = [{ kind: 'function', name: functionName, file }];
  const reshaped = new Set<string>();
  // A local helper (`fetchOnce`) is followed in the same file; each name once.
  const pending = [functionName];
  const seen = new Set<string>();
  for (let count = 0; pending.length > 0 && count < LOCAL_CALLS_MAX; count++) {
    const name = pending.shift();
    const found = name === undefined || seen.has(name) ? undefined : module.functions.get(name);
    if (name === undefined || found === undefined) {
      continue;
    }
    seen.add(name);
    for (const call of found.calls) {
      const method =
        call.kind === 'call' && call.callee.kind === 'member' ? call.callee.property : undefined;
      if (method !== undefined && RESHAPING.has(method)) {
        reshaped.add(method);
      }
    }
    const read = readIn(found.calls, module, file);
    if (read !== undefined) {
      return { steps: [...steps, ...read], next: undefined, reshaped: [...reshaped] };
    }
    const handOff = importCalled(found.calls, module);
    if (handOff !== undefined) {
      return { steps, next: handOff, reshaped: [...reshaped] };
    }
    pending.push(...localCalls(found.calls, module));
  }
  assert(steps.length >= 1, 'A trace names the function it read');
  return { steps, next: undefined, reshaped: [...reshaped] };
}

// The first call that reads a collection: getCollection, or a GROQ query.
function readIn(
  calls: readonly Js[],
  module: ParsedModule,
  file: string,
): readonly TraceStep[] | undefined {
  for (const call of calls) {
    if (call.kind !== 'call') {
      continue;
    }
    const callee = call.callee.kind === 'name' ? call.callee.name : undefined;
    const imported =
      callee === undefined ? undefined : module.imports.find((entry) => entry.name === callee);
    const first = call.args[0];
    if (
      imported?.path === 'astro:content' &&
      imported.imported === 'getCollection' &&
      first?.kind === 'string'
    ) {
      return [
        {
          kind: 'collection',
          source: { kind: 'astro', collection: first.value },
          groq: undefined,
          file,
          literal: undefined,
        },
      ];
    }
    for (const argument of call.args) {
      const query = groqOf(argument, module, 0);
      if (query !== undefined) {
        return [
          ...(query.name === undefined ? [] : [{ kind: 'query' as const, name: query.name, file }]),
          collectionStep(query, file),
        ];
      }
    }
  }
  return undefined;
}

function collectionStep(
  query: { readonly text: string; readonly from: number; readonly to: number },
  file: string,
): TraceStep {
  const groq = query.text;
  const reading = readGroq(groq);
  // A query the reader cannot model still names its type, which is what the
  // trace is for: the collection the list comes from.
  const type = reading?.type ?? /_type\s*==\s*["']([\w.-]+)["']/.exec(groq)?.[1] ?? 'documents';
  return {
    kind: 'collection',
    source: { kind: 'sanity', collection: type },
    groq: reading,
    file,
    literal: { from: query.from, to: query.to, text: groq },
  };
}

// A GROQ string, `defineQuery(…)` of one, or a constant holding either.
interface FoundGroq {
  readonly text: string;
  readonly name: string | undefined;
  /** The string literal's span in the module. */
  readonly from: number;
  readonly to: number;
}

function groqOf(node: Js, module: ParsedModule, depth: number): FoundGroq | undefined {
  if (depth > LOCAL_CALLS_MAX || depth > LIMITS.treeDepthMax) {
    return undefined;
  }
  if (node.kind === 'string') {
    return node.value.trim().startsWith('*')
      ? { text: node.value, name: undefined, from: node.from, to: node.to }
      : undefined;
  }
  if (node.kind === 'call' && node.args.length === 1 && node.args[0]) {
    return groqOf(node.args[0], module, depth + 1);
  }
  if (node.kind === 'name') {
    const init = module.declarations.get(node.name)?.init;
    const held = init === undefined ? undefined : groqOf(init, module, depth + 1);
    return held === undefined ? undefined : { ...held, name: held.name ?? node.name };
  }
  return undefined;
}

// The first call to a function this module imports from the project.
function importCalled(
  calls: readonly Js[],
  module: ParsedModule,
): { readonly name: string; readonly spec: string } | undefined {
  for (const call of calls) {
    const path = call.kind === 'call' ? namePath(call.callee) : undefined;
    const root = path?.[0];
    const imported =
      root === undefined ? undefined : module.imports.find((entry) => entry.name === root);
    if (imported !== undefined && !FRAMEWORK.has(imported.path) && path?.length === 1) {
      return {
        name: imported.imported === 'default' ? imported.name : imported.imported,
        spec: imported.path,
      };
    }
  }
  return undefined;
}

function localCalls(calls: readonly Js[], module: ParsedModule): readonly string[] {
  return calls.flatMap((call) =>
    call.kind === 'call' && call.callee.kind === 'name' && module.functions.has(call.callee.name)
      ? [call.callee.name]
      : [],
  );
}

/**
 * The file with one GROQ literal holding `groq` instead, in the literal's own
 * quotes, or undefined when the file no longer holds the query the trace read
 * there (it was edited since): an edit is never written over code it did not see.
 */
export function rewrittenGroqLiteral(
  fileText: string,
  literal: GroqLiteral,
  groq: string,
): string | undefined {
  if (literal.to > fileText.length || literal.from >= literal.to) {
    return undefined;
  }
  const current = fileText.slice(literal.from, literal.to);
  if (decodeString(current) !== literal.text) {
    return undefined;
  }
  const quote = current.charAt(0);
  const written = `${quote}${escapedFor(groq, quote)}${quote}`;
  assert(decodeString(written) === groq, 'A rewritten literal holds exactly the new query');
  return `${fileText.slice(0, literal.from)}${written}${fileText.slice(literal.to)}`;
}

// The query escaped for the quote it is written in. A template keeps its line
// breaks; `${` would start an interpolation, so its `$` is escaped.
function escapedFor(text: string, quote: string): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    if (character === '\\' || character === quote) {
      out += `\\${character}`;
    } else if (quote === '`' && character === '$' && text.charAt(index + 1) === '{') {
      out += '\\$';
    } else if (quote !== '`' && character === '\n') {
      out += '\\n';
    } else if (quote !== '`' && character === '\r') {
      out += '\\r';
    } else {
      out += character;
    }
  }
  return out;
}
