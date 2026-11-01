#!/usr/bin/env node
// The adapter surface: how much renderer code still edits the legacy mutable
// page tree directly (plan §11 steps 3–6). Every site counted here is one the
// compat adapter must translate into intents and step 9 must delete. The counts
// only go down: a new site fails the gate, a removed one asks for the baseline
// to be lowered.
//
// Method (a grep, written down so anyone can re-run it by hand):
//
//   Files   src/**/*.ts and src/**/*.tsx. Node mutations and prop-index writes
//           exclude src/features/style/, which edits CSS rules, not the page tree.
//           Wrapper call sites cover all of src/: applyEdit lives there.
//   Fields  the page-node fields a mutation can change: props, children,
//           attrOrder, attrSource, kind, name, value, id, dynamicTag, slots,
//           body, test, nodes, mdRaw, mdSource.
//
//   1. Node mutations — one per match of
//        a. `<receiver>.<field> =`, `+=` or `-=` (not `==`, not `=>`);
//        b. `<receiver>.<field>.<mutator>(` where mutator is an array mutator
//           (push, pop, splice, shift, unshift, sort, reverse, fill, copyWithin);
//        c. `delete <receiver>.<field>`;
//        d. aliased lists: `const|let <alias> = <expression>.children|nodes`
//           declares an alias, and each `<alias>.<mutator>(` in that file counts;
//           so does the sibling list a tree lookup returns (findParentList
//           gives `{ list, index }`): `<receiver>.list.<mutator>(`, and
//           `<alias>.<mutator>(` after `const { list: <alias> } = …` or
//           `const { list } = …`.
//      Receivers whose last segment names a DOM or CMS object, not a page node,
//      are excluded: event, target, currentTarget, gain, input, field (CMS
//      schema fields), style, dataset.
//   2. Prop-index writes — `props[<key>] =` (any receiver, or a bare `props`
//      alias) and `delete <receiver>.props[<key>]`.
//   3. `mutateModel(` call sites, the definition excluded.
//   4. `applyEdit(` call sites, the definition excluded.
//   5. Whole-file writes: the migration-only `replace-source` operation (plan
//      §3.3) named in code, or a `replaceSource(` call, in electron/, shared/
//      and src/ (*.ts, *.tsx). From step 5 this counted every legacy writer's
//      call; step 9 took them away from `.astro` pages and step 10 retired
//      the operation, so every write is splices — a program's write of a file
//      is its diff (`rewrite-text`). Zero, and held there.
//
// Comment lines (starting with //, * or /*) are skipped. Hand count on
// 2026-09-28 was 67 / 10 / 28 / 4; this method is the authority from step 1 on,
// and the tracker records both.

import fs = require('node:fs');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

interface Counts {
  readonly mutations: number;
  readonly propIndexWrites: number;
  readonly mutateModelCalls: number;
  readonly applyEditCalls: number;
  readonly wholeFileWrites: number;
}

/** Measured 2026-09-28 by this script at step 1, lowered at each step-6
 * expansion and at step 9 (the tracker's adapter table). Lower these; never
 * raise them. Step 9 ends with the page tree readonly (src/editor/pageView.ts):
 * no node is edited in place, anywhere in src/. The four applyEdit( sites left
 * are the style panel's CSS-rule edits (src/features/style/EmbedEditor.tsx), which
 * never touch the page tree. */
const BASELINE: Counts = {
  mutations: 0,
  propIndexWrites: 0,
  mutateModelCalls: 0,
  applyEditCalls: 4,
  /** Measured at step 5 as 22 legacy writer calls, lowered to 21 with the
   * Markdown whole-model save and to 0 when step 10 retired the operation. */
  wholeFileWrites: 0,
};

const FILES_MAX = 20_000;
const FIELDS = ['props|children|attrOrder|attrSource|kind|name|value|id', 'dynamicTag|slots|body|test|nodes|mdRaw|mdSource'].join('|');
const MUTATORS = 'push|pop|splice|shift|unshift|sort|reverse|fill|copyWithin';
const EXCLUDED_RECEIVERS = new Set(['event', 'target', 'currentTarget', 'gain', 'input', 'field', 'style', 'dataset']);
const DOM_ELEMENT_NAME = /[eE]lement$/;
const RECEIVER = '([A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])*)';

const ASSIGN_RE = new RegExp(`${RECEIVER}\\.(?:${FIELDS})\\s*(?:=(?![=>])|\\+=|-=)`, 'g');
const MUTATE_RE = new RegExp(`${RECEIVER}\\.(?:${FIELDS})\\.(?:${MUTATORS})\\(`, 'g');
const DELETE_RE = new RegExp(`delete\\s+${RECEIVER}\\.(?:${FIELDS})\\b(?!\\[)`, 'g');
const ALIAS_RE = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*` + String.raw`[^;\n]*\.(?:children|nodes)\b\s*(?:[;\n|?]|$)`, 'g');
const LIST_MUTATE_RE = new RegExp(`${RECEIVER}\\.list\\.(?:${MUTATORS})\\(`, 'g');
const LIST_ALIAS_RE = /(?:const|let)\s+\{[^}]*\blist\b(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=/g;
const PROP_INDEX_RE = /(?:\bprops\[[^\]]+\]\s*=(?![=>]))|(?:delete\s+[\w$.?]+\.props\[)/g;
const MUTATE_MODEL_RE = /\bmutateModel\(/g;
const APPLY_EDIT_RE = /\bapplyEdit\(/g;
const DEFINITION_RE = new RegExp(String.raw`(?:function\s+(?:mutateModel|applyEdit)\b|` + String.raw`(?:const|let)\s+(?:mutateModel|applyEdit)\s*=)`);
const WHOLE_FILE_RE = /\breplaceSource\(|['"]replace-source['"]/g;

export function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  const pending = [directory];
  for (let visited = 0; pending.length > 0; visited++) {
    if (visited > FILES_MAX) {
      throw new Error(`adapter-surface: more than ${FILES_MAX} paths under ${directory}`);
    }
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

function codeLines(text: string): readonly string[] {
  return text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
}

function receiverCounts(line: string, pattern: RegExp): number {
  let count = 0;
  for (const match of line.matchAll(pattern)) {
    const receiver = match[1] ?? '';
    const last = receiver.split(/\??\./).pop()?.replace(/\[.*$/, '') ?? '';
    // A receiver named for a DOM element (`inputElement.value = …`) is the
    // platform's node, not the page tree's: the same naming rule the lint
    // exemption for in-place DOM writes uses (eslint.config.mjs).
    if (DOM_ELEMENT_NAME.test(last)) {
      continue;
    }
    if (!EXCLUDED_RECEIVERS.has(last)) {
      count += 1;
    }
  }
  return count;
}

/** Node mutations and prop-index writes in one file's text. */
export function countTreeEdits(text: string): {
  readonly mutations: number;
  readonly propIndexWrites: number;
} {
  const lines = codeLines(text);
  const aliases = new Set([
    ...[...text.matchAll(ALIAS_RE)].map((match) => match[1] ?? ''),
    ...[...text.matchAll(LIST_ALIAS_RE)].map((match) => match[1] ?? 'list'),
  ]);
  aliases.delete('');
  const aliasSource = `\\b(?:${[...aliases].join('|')})\\.(?:${MUTATORS})\\(`;
  const aliasRe = aliases.size === 0 ? undefined : new RegExp(aliasSource, 'g');
  let mutations = 0;
  let propIndexWrites = 0;
  for (const line of lines) {
    mutations += receiverCounts(line, ASSIGN_RE) + receiverCounts(line, MUTATE_RE);
    mutations += receiverCounts(line, DELETE_RE);
    mutations += receiverCounts(line, LIST_MUTATE_RE);
    mutations += aliasRe === undefined ? 0 : [...line.matchAll(aliasRe)].length;
    propIndexWrites += [...line.matchAll(PROP_INDEX_RE)].length;
  }
  return { mutations, propIndexWrites };
}

/** Wrapper call sites in one file's text, definitions excluded. */
export function countWrapperCalls(text: string): {
  readonly mutateModelCalls: number;
  readonly applyEditCalls: number;
} {
  let mutateModelCalls = 0;
  let applyEditCalls = 0;
  for (const line of codeLines(text)) {
    if (DEFINITION_RE.test(line)) {
      continue;
    }
    mutateModelCalls += [...line.matchAll(MUTATE_MODEL_RE)].length;
    applyEditCalls += [...line.matchAll(APPLY_EDIT_RE)].length;
  }
  return { mutateModelCalls, applyEditCalls };
}

/** Whole-file write sites in one file's text: the `replace-source` operation
 * named, or a `replaceSource(` call. */
export function countWholeFileWrites(text: string): number {
  let sites = 0;
  for (const line of codeLines(text)) {
    sites += [...line.matchAll(WHOLE_FILE_RE)].length;
  }
  return sites;
}

function measureWholeFileWrites(root: string): number {
  let sites = 0;
  for (const directory of ['electron', 'shared', 'src']) {
    for (const file of sourceFiles(path.join(root, directory))) {
      sites += countWholeFileWrites(fs.readFileSync(file, 'utf8'));
    }
  }
  return sites;
}

function measure(root: string): {
  readonly counts: Counts;
  readonly byFile: ReadonlyMap<string, number>;
} {
  const source = path.join(root, 'src');
  const stylePanel = path.join(source, 'features', 'style') + path.sep;
  let mutations = 0;
  let propIndexWrites = 0;
  let mutateModelCalls = 0;
  let applyEditCalls = 0;
  const byFile = new Map<string, number>();
  for (const file of sourceFiles(source)) {
    const text = fs.readFileSync(file, 'utf8');
    const calls = countWrapperCalls(text);
    mutateModelCalls += calls.mutateModelCalls;
    applyEditCalls += calls.applyEditCalls;
    if (file.startsWith(stylePanel)) {
      continue;
    }
    const edits = countTreeEdits(text);
    mutations += edits.mutations;
    propIndexWrites += edits.propIndexWrites;
    if (edits.mutations + edits.propIndexWrites > 0) {
      byFile.set(path.relative(root, file), edits.mutations + edits.propIndexWrites);
    }
  }
  const wholeFileWrites = measureWholeFileWrites(root);
  const counts = { mutations, propIndexWrites, mutateModelCalls, applyEditCalls, wholeFileWrites };
  return { counts, byFile };
}

function main(): void {
  const root = repositoryRoot();
  const { counts, byFile } = measure(root);
  const labels: Readonly<Record<keyof Counts, string>> = {
    mutations: 'direct node-mutation sites',
    propIndexWrites: 'prop-index writes',
    mutateModelCalls: 'mutateModel( call sites',
    applyEditCalls: 'applyEdit( call sites',
    wholeFileWrites: 'whole-file write sites (replace-source)',
  };
  let slipped = false;
  const keys = ['mutations', 'propIndexWrites', 'mutateModelCalls', 'applyEditCalls', 'wholeFileWrites'] as const;
  for (const key of keys) {
    const now = counts[key];
    const baseline = BASELINE[key];
    console.log(`${String(now).padStart(4)} ${labels[key]} (baseline ${baseline})`);
    if (now > baseline) {
      slipped = true;
      const grown = now - baseline;
      const rule = 'new code must enter through intents (plan §11 step 6)';
      console.error(`     grew by ${grown}: ${rule}.`);
    } else if (now < baseline) {
      const below = baseline - now;
      const where = `BASELINE.${key} in scripts/gate/adapterSurface.ts`;
      console.log(`     ${below} below baseline — lower ${where}.`);
    }
  }
  if (process.argv.includes('--files')) {
    for (const [file, count] of byFile) {
      console.log(`  ${String(count).padStart(3)} ${file}`);
    }
  }
  if (slipped) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
