#!/usr/bin/env node
// Large named fixtures for the step-4 thresholds (plan §10, §11 step 4). The
// round-trip corpus tops out at 2.7 KB, far too small to measure an engine
// against a 10 MB / 20 000-node budget, so these are generated — from corpus
// pieces, deterministically, at about 25, 50 and 100 % of each bound:
//
//   nodes-<pct>  piece after piece until the parser counts <pct> % of
//                LIMITS.treeNodesMax nodes (topped up with single `<hr />`s);
//   bytes-<pct>  pieces interleaved with long filler paragraphs (with multibyte
//                and astral characters, so byte and UTF-16 offsets diverge)
//                until the file holds <pct> % of LIMITS.sourceBytesMax bytes,
//                staying well under the node bound so it still parses.
//
// No randomness: pieces go round-robin in name order, and the filler is a
// fixed word cycle. The same corpus and limits give the same bytes, which the
// committed manifest (sha256, bytes, nodes) pins; the contract suite rebuilds
// every fixture in memory and compares. The files themselves are not committed
// (17.5 MB of generated text); `npm run fixtures:large` writes them.
//
// The node counter is injected so this module stays pure: the CLI below and
// the contract suite both pass the real parser.

import fs = require('node:fs');
import path = require('node:path');
import { createHash } from 'node:crypto';
import { repositoryRoot } from '../lib/repoRoot';

export interface FixtureLimits {
  readonly sourceBytesMax: number;
  readonly treeNodesMax: number;
}

export interface LargeFixture {
  readonly name: string;
  readonly axis: 'bytes' | 'nodes';
  readonly percent: number;
  readonly text: string;
}

export interface ManifestEntry {
  readonly name: string;
  readonly axis: 'bytes' | 'nodes';
  readonly percent: number;
  readonly target: number;
  readonly bytes: number;
  readonly utf16Units: number;
  readonly nodes: number;
  readonly sha256: string;
}

/** Counts every node the parser produces for `text`, or undefined when the
 * text does not parse (a piece that does not stand alone is skipped). */
export type NodeCounter = (text: string) => number | undefined;

export const PERCENTS = [25, 50, 100] as const;
/** Filler paragraphs a bytes fixture interleaves; keeps nodes far below the bound. */
const BYTE_UNITS = 400;
const FILLER_WORDS = ['stacki', 'café', 'naïve', 'source', '🎉', 'bytes', 'Zoë', 'splice'] as const;
const PIECES_MAX = 1_000;

const HEADER = '---\nconst title = "Large fixture";\n---\n';

export function generateLargeFixtures(limits: FixtureLimits, corpus: ReadonlyMap<string, string>, countNodes: NodeCounter): readonly LargeFixture[] {
  const pieces = standalonePieces(corpus, countNodes);
  if (pieces.length === 0) {
    throw new Error('Large fixtures: no corpus piece parses on its own');
  }
  const fixtures: LargeFixture[] = [];
  for (const percent of PERCENTS) {
    const nodes = Math.floor((limits.treeNodesMax * percent) / 100);
    fixtures.push({
      name: `nodes-${percent}`,
      axis: 'nodes',
      percent,
      text: nodesFixture(pieces, nodes),
    });
  }
  for (const percent of PERCENTS) {
    const bytes = Math.floor((limits.sourceBytesMax * percent) / 100);
    fixtures.push({
      name: `bytes-${percent}`,
      axis: 'bytes',
      percent,
      text: bytesFixture(pieces, bytes),
    });
  }
  return fixtures;
}

export function manifestEntry(fixture: LargeFixture, limits: FixtureLimits, countNodes: NodeCounter): ManifestEntry {
  const nodes = countNodes(fixture.text);
  if (nodes === undefined) {
    throw new Error(`Large fixture ${fixture.name} does not parse`);
  }
  const bound = fixture.axis === 'bytes' ? limits.sourceBytesMax : limits.treeNodesMax;
  return {
    name: fixture.name,
    axis: fixture.axis,
    percent: fixture.percent,
    target: Math.floor((bound * fixture.percent) / 100),
    bytes: Buffer.byteLength(fixture.text, 'utf8'),
    utf16Units: fixture.text.length,
    nodes,
    sha256: createHash('sha256').update(fixture.text, 'utf8').digest('hex'),
  };
}

interface Piece {
  readonly text: string;
  readonly nodes: number;
}

// The template part of each corpus file, wrapped in a section so pieces sit
// side by side as blocks. Only pieces that parse alone are used; the node count
// is measured on the wrapped piece, which is exactly what it adds to a fixture.
function standalonePieces(corpus: ReadonlyMap<string, string>, countNodes: NodeCounter): readonly Piece[] {
  const names = [...corpus.keys()].sort();
  if (names.length > PIECES_MAX) {
    throw new Error(`Large fixtures: more than ${PIECES_MAX} corpus files`);
  }
  const pieces: Piece[] = [];
  for (const [index, name] of names.entries()) {
    const source = corpus.get(name) ?? '';
    const body = source.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n/g, '\n');
    if (/<html|<!doctype|<(?:style|script)\b/i.test(body)) {
      continue; // Whole documents and raw blocks do not nest inside a section.
    }
    const text = `<section data-piece="${index}">\n${body.trim()}\n</section>\n`;
    const nodes = countNodes(text);
    if (nodes !== undefined) {
      pieces.push({ text, nodes });
    }
  }
  return pieces;
}

function nodesFixture(pieces: readonly Piece[], target: number): string {
  const parts = [HEADER];
  let nodes = 0;
  for (let index = 0; index < target; index++) {
    const piece = pieces[index % pieces.length];
    if (piece === undefined) {
      throw new Error('Large fixtures: piece index out of range');
    }
    if (nodes + piece.nodes > target) {
      break;
    }
    parts.push(piece.text);
    nodes += piece.nodes;
  }
  // One node per `<hr />` closes the gap exactly.
  parts.push('<hr />\n'.repeat(target - nodes));
  return parts.join('');
}

function bytesFixture(pieces: readonly Piece[], target: number): string {
  const unitBytes = Math.floor(target / BYTE_UNITS);
  const parts = [HEADER];
  let bytes = Buffer.byteLength(HEADER, 'utf8');
  for (let unit = 0; unit < BYTE_UNITS; unit++) {
    const piece = pieces[unit % pieces.length];
    if (piece === undefined) {
      throw new Error('Large fixtures: piece index out of range');
    }
    const open = `<p data-filler="${unit}">`;
    const frame = Buffer.byteLength(piece.text + open + '</p>\n', 'utf8');
    const filler = fillerText(Math.max(0, Math.min(unitBytes, target - bytes) - frame));
    const text = `${piece.text}${open}${filler}</p>\n`;
    const size = Buffer.byteLength(text, 'utf8');
    if (bytes + size > target) {
      break;
    }
    parts.push(text);
    bytes += size;
  }
  // ASCII padding lands the file on its target byte for byte.
  const padding = target - bytes - Buffer.byteLength('<p></p>\n', 'utf8');
  if (padding > 0) {
    parts.push(`<p>${'x'.repeat(padding)}</p>\n`);
  }
  return parts.join('');
}

// A fixed cycle of words, cut to at most `bytes` UTF-8 bytes on a word boundary.
function fillerText(bytes: number): string {
  const words: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index++) {
    const word = FILLER_WORDS[index % FILLER_WORDS.length] ?? 'x';
    const next = Buffer.byteLength(word, 'utf8') + 1;
    if (size + next > bytes) {
      break;
    }
    words.push(word);
    size += next;
  }
  return words.join(' ');
}

// --- CLI: node dist/scripts/reports/largeFixtures.js [--write] ---------------------

// A built module, named by its repository path (dist/…).
function loadRecord(modulePath: string): Record<string, unknown> {
  const input: unknown = require(path.join(repositoryRoot(), modulePath));
  if (typeof input !== 'object' || input === null) {
    throw new Error(`${modulePath}: expected module object`);
  }
  return Object.fromEntries(Object.entries(input));
}

function cliLimits(): FixtureLimits {
  const limits = loadRecord('dist/shared/core/limits.js')['LIMITS'];
  if (typeof limits !== 'object' || limits === null) {
    throw new Error('limits: expected LIMITS object');
  }
  const values: Record<string, unknown> = Object.fromEntries(Object.entries(limits));
  const sourceBytesMax = values['sourceBytesMax'];
  const treeNodesMax = values['treeNodesMax'];
  if (typeof sourceBytesMax !== 'number' || typeof treeNodesMax !== 'number') {
    throw new Error('limits: expected numeric sourceBytesMax and treeNodesMax');
  }
  return { sourceBytesMax, treeNodesMax };
}

/** The real parser as a node counter, for the CLI. */
export function parserNodeCounter(parsePage: (text: string) => unknown): NodeCounter {
  return (text) => {
    const result: unknown = parsePage(text);
    if (typeof result !== 'object' || result === null || !('model' in result)) {
      return undefined;
    }
    const model: unknown = result.model;
    if (typeof model !== 'object' || model === null || !('nodes' in model)) {
      return undefined;
    }
    return countTree(model.nodes);
  };
}

function countTree(roots: unknown): number {
  const list: readonly unknown[] = Array.isArray(roots) ? roots : [];
  const pending: unknown[] = [...list];
  let count = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    count += 1;
    if (count > 1_000_000) {
      throw new Error('countTree: exceeds one million nodes');
    }
    if (typeof node === 'object' && node !== null && 'children' in node) {
      const children: readonly unknown[] = Array.isArray(node.children) ? node.children : [];
      pending.push(...children);
    }
  }
  return count;
}

function main(): void {
  const root = repositoryRoot();
  const parsePage = loadRecord('dist/electron/parse/astroParser.js')['parsePage'];
  if (typeof parsePage !== 'function') {
    throw new Error('astroParser: expected parsePage');
  }
  const counter = parserNodeCounter((text) => {
    const result: unknown = Reflect.apply(parsePage, undefined, [text]);
    return result;
  });
  const corpusDirectory = path.join(root, 'test', 'corpus');
  const corpus = new Map(
    fs
      .readdirSync(corpusDirectory)
      .filter((name) => name.endsWith('.astro'))
      .map((name) => [name, fs.readFileSync(path.join(corpusDirectory, name), 'utf8')] as const),
  );
  const limits = cliLimits();
  const fixtures = generateLargeFixtures(limits, corpus, counter);
  const target = path.join(root, 'test', 'fixtures', 'large');
  fs.mkdirSync(target, { recursive: true });
  const manifest = fixtures.map((fixture) => manifestEntry(fixture, limits, counter));
  if (process.argv.includes('--write')) {
    for (const fixture of fixtures) {
      fs.writeFileSync(path.join(target, `${fixture.name}.astro`), fixture.text);
    }
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.table(manifest.map(({ sha256: _sha256, ...entry }) => entry));
}

if (require.main === module) {
  main();
}
