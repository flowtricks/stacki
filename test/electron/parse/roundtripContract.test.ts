// Goal: prove the contract and the real parser agree — every tree the
// serializer writes must re-parse editable, validate against shared/page/pageNode,
// and preserve structure. A fuzzer proves the presence of bugs, never their
// absence (AGENTS.md testing), so this hunts the roundtrip boundary with
// generated trees, not hand-picked ones.
//
// Methodology: a seeded PRNG builds trees from the kinds that roundtrip
// cleanly (element, component, text, comment, raw) with attrs of every type;
// each is serialized by the REAL serializeNodes, re-parsed by the REAL
// parsePage, validated by the contract parsers, and compared loosely — ids
// are regenerated per parse, and whitespace-only filler text is the parser's
// own normalization, so neither takes part in the comparison.
//
// Excluded kinds (map, cond, expr) need source-level context the generator
// cannot synthesize faithfully; their roundtrip is covered by the existing
// marker/loop/cond test suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parsePageResult, assertTreeInvariants } from '#dist/shared/page/pageNode.js';

const require = createRequire(import.meta.url);
// CJS module boundary; every value it returns is validated by the contract parsers.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Untyped CJS exports.
const astroParser: {
  parsePage: (source: string) => unknown;
  serializeNodes: (nodes: readonly unknown[]) => string;
} = require('#dist/electron/parse/astroParser.js');
const { parsePage, serializeNodes } = astroParser;

// mulberry32 — deterministic, so a failure replays exactly.
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['div', 'section', 'span', 'p', 'Card', 'Hero'];
const WORDS = ['alpha', 'beta', 'gamma', 'delta'];

/** The producer-shaped node the generator emits: id is a plain string here —
 * branding happens when the contract parser validates the re-parse. PageNode
 * (parsed output) is structurally assignable to this shape. */
interface GeneratedNode {
  readonly kind: string;
  readonly id: string;
  readonly name?: string;
  readonly value?: string;
  readonly inner?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly attrOrder?: readonly string[];
  readonly children?: readonly GeneratedNode[] | undefined;
}

// The seeded sources a generated tree draws from: its randomness and its node ids.
interface Sources {
  readonly rand: () => number;
  readonly nextId: () => string;
}

function pick(options: readonly string[], rand: () => number): string {
  return options[Math.floor(rand() * options.length)] ?? options[0] ?? 'div';
}

// Adjacent sibling text nodes merge on re-parse (the serializer writes them
// with no separator) — a generator constraint, not a contract bug. A comment
// keeps them apart on both sides of the roundtrip.
function pushChild(sources: Sources, depth: number, children: GeneratedNode[]): void {
  const { rand, nextId } = sources;
  let child = generateNode(sources, depth);
  const previous = children[children.length - 1];
  if (child.kind === 'text' && previous?.kind === 'text') {
    child = { kind: 'comment', id: nextId(), value: ` sep ${Math.floor(rand() * 100)} ` };
  }
  children.push(child);
}

function generateNode(sources: Sources, depth: number): GeneratedNode {
  const { rand, nextId } = sources;
  const shape = rand();
  if (depth >= 3 || shape < 0.3) {
    return {
      kind: 'text',
      id: nextId(),
      value: `${pick(WORDS, rand)} ${Math.floor(rand() * 100)}`,
    };
  }
  if (shape < 0.4) {
    return { kind: 'comment', id: nextId(), value: ` note ${Math.floor(rand() * 100)} ` };
  }
  if (shape < 0.45) {
    return {
      kind: 'raw',
      id: nextId(),
      name: 'style',
      inner: `.x${Math.floor(rand() * 10)} { color: red; }`,
    };
  }
  const name = pick(NAMES, rand);
  const props: Record<string, unknown> = {};
  const attrCount = Math.floor(rand() * 3);
  const attrOrder: string[] = [];
  for (let i = 0; i < attrCount; i++) {
    const attrName = `data-x${i}`;
    attrOrder.push(attrName);
    const attrShape = rand();
    if (attrShape < 0.4) {
      props[attrName] = { type: 'string', value: `v${Math.floor(rand() * 100)}` };
    } else if (attrShape < 0.7) {
      props[attrName] = { type: 'expr', value: `count + ${Math.floor(rand() * 10)}` };
    } else {
      props[attrName] = { type: 'bare' };
    }
  }
  const children: GeneratedNode[] = [];
  const wantsChildren = rand() < 0.7;
  if (wantsChildren) {
    const childCount = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < childCount; i++) {
      pushChild(sources, depth + 1, children);
    }
  }
  const node: GeneratedNode = {
    kind: /^[A-Z]/.test(name) ? 'component' : 'element',
    id: nextId(),
    name,
    children: rand() < 0.15 ? undefined : children,
    ...(attrOrder.length ? { props, attrOrder } : {}),
  };
  return node;
}

function loose(node: GeneratedNode): unknown {
  switch (node.kind) {
    case 'text':
      return { kind: node.kind, value: (node.value ?? '').trim() };
    case 'comment':
      return { kind: node.kind, value: (node.value ?? '').trim() };
    case 'raw':
      // `inner` is verbatim source, so it keeps the serializer's indentation —
      // the payload itself is what round-trips.
      return { kind: node.kind, name: node.name, inner: (node.inner ?? '').trim() };
    case 'component':
    case 'element': {
      const props = Object.fromEntries(Object.entries(node.props ?? {}));
      const children = (node.children ?? []).filter((child) => !(child.kind === 'text' && (child.value ?? '').trim() === '')).map(loose);
      return {
        kind: node.kind,
        name: node.name,
        props,
        children,
        selfClosing: node.children === undefined,
      };
    }
    default:
      return { kind: node.kind };
  }
}

test('serialize ∘ parse roundtrip: generated trees survive the real parser', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    let id = 0;
    const nextId = () => `n${++id}`;
    const tree: GeneratedNode[] = [];
    const topCount = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < topCount; i++) {
      pushChild({ rand, nextId }, 0, tree);
    }
    const source = serializeNodes(tree);
    const result = parsePageResult(parsePage(source));
    assert.equal(result.editable, true, `seed ${seed} bailed on: ${source.slice(0, 120)}`);
    if (result.editable) {
      assertTreeInvariants(result.model.nodes);
      const actual = result.model.nodes.filter((node) => !(node.kind === 'text' && node.value.trim() === '')).map((node) => loose(node));
      const expected = tree.filter((node) => !(node.kind === 'text' && (node.value ?? '').trim() === '')).map((node) => loose(node));
      assert.deepEqual(
        actual,
        expected,
        `seed ${seed} drifted\nSOURCE: ${source}\nACTUAL: ${JSON.stringify(actual)}\n` + `EXPECTED: ${JSON.stringify(expected)}`,
      );
    }
  }
});
