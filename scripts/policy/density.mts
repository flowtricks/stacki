// Assertion density of the contract layer (AGENTS.md §9: core logic averages at
// least two assertions per function). shared/ is the core: the parsers and pure
// engine every process trusts. Counted with the TypeScript parser, so strings
// and comments that mention `assert(` never count.
//
// A function is any function with a block body; an expression-bodied arrow
// (`(node) => node.id`) is a value, not logic, and would only dilute the
// average. An assertion is a call to `assert` or to a function whose name
// starts with `assert` (`assertTreeInvariants`).

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { assert } from './assert.mts';

export interface Density {
  readonly functions: number;
  readonly assertions: number;
  readonly perFunction: number;
}

const NODES_PER_FILE_MAX = 2_000_000;

export function sharedAssertionDensity(root: string, files: readonly string[]): Density {
  let functions = 0;
  let assertions = 0;
  for (const file of files) {
    if (!file.startsWith('shared/')) {
      continue;
    }
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) {
      continue;
    }
    const counts = countFile(file, fs.readFileSync(path.join(root, file), 'utf8'));
    functions += counts.functions;
    assertions += counts.assertions;
  }
  assert(functions >= 0, 'density: function count is non-negative');
  const perFunction = functions === 0 ? 0 : assertions / functions;
  return { functions, assertions, perFunction };
}

export function countFile(file: string, text: string): { readonly functions: number; readonly assertions: number } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let functions = 0;
  let assertions = 0;
  let visited = 0;
  const pending: ts.Node[] = [source];
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= NODES_PER_FILE_MAX, `density: ${file} exceeds the node limit`);
    const node = pending.pop();
    assert(node !== undefined, 'density: stack underflow');
    if (ts.isFunctionLike(node)) {
      if ('body' in node && node.body !== undefined && ts.isBlock(node.body)) {
        functions += 1;
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text.startsWith('assert')) {
        assertions += 1;
      }
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return { functions, assertions };
}
