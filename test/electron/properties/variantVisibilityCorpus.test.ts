// Goal: what the panels say about a prop's visibility per variant equals what
// TypeScript says about it. Both readers are held: the variant rule reader
// that the Property settings Visibility popover draws
// (electron/properties/variantRuleModel.ts) and the union tables the instance
// panel hides props by (electron/parse/propModel/propDeclarations.ts). The bug
// this pins: a prop declared in a type intersected beside the union
// (`Props = Base & (A | B | C)`, Lumos's Card and its `theme`) was read as
// forbidden in every member that does not name it again, so the instance panel
// never showed it and the popover said "Hide" for every option.
//
// Method: a reference built on the TypeScript checker, not on the readers'
// syntax walks. Each component's frontmatter is compiled in one program with
// a small stub for `astro/types`; `Props` is expanded into the object types
// TypeScript distributes it into, and for each option of a controller the
// constituents whose controller admits that option are found. In each, a prop
// is forbidden when it is absent or its type, `undefined` removed, is `never`;
// otherwise it is required or optional by its declaration. A reader's
// "forbidden" must hold in every such constituent, and its "allowed" in at
// least one (another union may still forbid it, which is that union's rule).
// First Card's real shape, as a table; then the corpus: every `.astro` file in
// the fixtures (the Lumos starter, the variant rules Button, the prop zoo), and
// every directory listed in STACKI_CORPUS_DIRS (colon separated), which the
// author points at the projects named in docs/props-complex-shapes.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { editVariantRules } from '#dist/electron/properties/variantRuleEdits.js';
import { readVariantGroups } from '#dist/electron/properties/variantRuleModel.js';
import { readPropModel } from '#dist/electron/parse/propModel/readPropModel.js';
import type { VariantRule, VariantRuleEdit } from '#dist/shared/properties/variantRules.js';

type State = 'optional' | 'required' | 'forbidden';

interface Mismatch {
  readonly file: string;
  readonly reader: 'popover' | 'instance';
  readonly controller: string;
  readonly option: string;
  readonly prop: string;
  readonly computed: string;
  readonly reference: readonly State[];
}

// The gate runs every suite from the repository root.
const CARD_PATH = 'test/fixtures/lumos/components/item/Card.astro';
const FIXTURE_DIRECTORIES = ['test/fixtures/lumos/components', 'test/fixtures/variantRules', 'test/fixtures/propZoo/src'];
const FILES_MAX = 2048;
const DEPTH_MAX = 16;

// Only what the corpus's frontmatter names from Astro: attribute types add
// HTML attributes, none of which a corpus union rules, so they hold no props here.
const GLOBAL_STUB = [
  "declare module 'astro/types' {",
  '  export type HTMLAttributes<Tag extends string> = { class?: string | null | undefined; id?: string | undefined; readonly __tag?: Tag };',
  '  export type HTMLTag = string;',
  '  export type Polymorphic<T> = T;',
  '}',
  'interface ImageMetadata { src: string; width: number; height: number; format: string }',
  'declare const Astro: { readonly props: unknown; readonly slots: unknown; readonly url: URL };',
].join('\n');

function frontmatterOf(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  return match?.[1] ?? '';
}

function astroFiles(directory: string): readonly string[] {
  const found: string[] = [];
  const work: { readonly folder: string; readonly depth: number }[] = [{ folder: directory, depth: 0 }];
  for (let steps = 0; steps < FILES_MAX && work.length > 0; steps++) {
    const item = work.pop();
    assert.ok(item !== undefined);
    for (const entry of fs.readdirSync(item.folder, { withFileTypes: true })) {
      const full = path.join(item.folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.') && item.depth < DEPTH_MAX) {
          work.push({ folder: full, depth: item.depth + 1 });
        }
      } else if (entry.name.endsWith('.astro')) {
        found.push(full);
      }
    }
  }
  assert.equal(work.length, 0, 'the corpus walk finishes within its budget');
  return found.sort();
}

// The checker's reading of every component's `Props`, compiled together.
function referencePrograms(files: readonly string[]): ReadonlyMap<string, readonly ts.Type[]> {
  const sources = new Map<string, string>();
  files.forEach((file, index) => sources.set(`/corpus/component${index}.ts`, `${frontmatterOf(fs.readFileSync(file, 'utf8'))}\nexport {};\n`));
  sources.set('/corpus/globals.d.ts', GLOBAL_STUB);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = (name: string): string | undefined => sources.get(name) ?? (name.startsWith('/corpus/') ? undefined : ts.sys.readFile(name));
  host.readFile = read;
  host.fileExists = (name) => read(name) !== undefined;
  host.getSourceFile = (name, version) => {
    const text = read(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, version);
  };
  host.getCurrentDirectory = () => '/corpus';
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const result = new Map<string, readonly ts.Type[]>();
  files.forEach((file, index) => {
    const source = program.getSourceFile(`/corpus/component${index}.ts`);
    assert.ok(source !== undefined);
    const declaration = source.statements.find(
      (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === 'Props',
    );
    if (declaration !== undefined) {
      const symbol = checker.getSymbolAtLocation(declaration.name);
      assert.ok(symbol !== undefined, `${file}: Props has a symbol`);
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      // A type imported from a file outside the corpus reads as any, which would agree with every reading: such a file has no reference.
      if ((type.flags & ts.TypeFlags.Any) === 0) {
        result.set(file, type.isUnion() ? type.types : [type]);
      }
    }
  });
  referenceChecker = checker;
  return result;
}
let referenceChecker: ts.TypeChecker | undefined;

function checker(): ts.TypeChecker {
  assert.ok(referenceChecker !== undefined, 'the reference program was built');
  return referenceChecker;
}

// The options a constituent's controller admits: string literals, or `true` / `false`.
function controllerOptions(constituent: ts.Type, controller: string): readonly string[] {
  const symbol = constituent.getProperty(controller);
  if (symbol === undefined) {
    return [];
  }
  const type = checker().getNonNullableType(checker().getTypeOfSymbol(symbol));
  const parts = type.isUnion() ? type.types : [type];
  return parts.flatMap((part) => (part.isStringLiteral() ? [part.value] : part.flags & ts.TypeFlags.BooleanLiteral ? [checker().typeToString(part)] : []));
}

function referenceState(constituent: ts.Type, prop: string): State {
  const symbol = constituent.getProperty(prop);
  if (symbol === undefined) {
    return 'forbidden';
  }
  const type = checker().getNonNullableType(checker().getTypeOfSymbol(symbol));
  if (type.flags & ts.TypeFlags.Never) {
    return 'forbidden';
  }
  return symbol.flags & ts.SymbolFlags.Optional ? 'optional' : 'required';
}

function referenceStates(constituents: readonly ts.Type[], controller: string, options: readonly string[], prop: string): readonly State[] {
  return constituents
    .filter((constituent) => controllerOptions(constituent, controller).some((option) => options.includes(option)))
    .map((constituent) => referenceState(constituent, prop));
}

// A reader's forbidden holds in every matching constituent; its allowed, in one at least.
function agrees(computed: 'forbidden' | 'allowed' | State, reference: readonly State[]): boolean {
  if (reference.length === 0) {
    return true;
  }
  if (computed === 'forbidden') {
    return reference.every((state) => state === 'forbidden');
  }
  if (computed === 'allowed') {
    return reference.some((state) => state !== 'forbidden');
  }
  return reference.some((state) => state === computed);
}

function popoverMismatches(file: string, constituents: readonly ts.Type[]): readonly Mismatch[] {
  const mismatches: Mismatch[] = [];
  const groups = readVariantGroups(fs.readFileSync(file, 'utf8')).filter((group) => group.editing.kind !== 'candidate');
  for (const group of groups) {
    for (const option of group.options) {
      for (const rule of option.rules) {
        const reference = referenceStates(constituents, group.controller, [option.value], rule.prop);
        if (!agrees(rule.state, reference)) {
          mismatches.push({ file, reader: 'popover', controller: group.controller, option: option.value, prop: rule.prop, computed: rule.state, reference });
        }
      }
    }
  }
  return mismatches;
}

function instanceMismatches(file: string, constituents: readonly ts.Type[]): readonly Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const union of readPropModel(fs.readFileSync(file, 'utf8')).unions) {
    // The field that tells the branches apart: pinned in each, to values no two share.
    const controller = union.names.find((name) => {
      const pinned = union.branches.map((branch) => branch.pins[name]);
      const values = pinned.flatMap((entry) => entry ?? []);
      return pinned.every((entry) => entry !== undefined) && new Set(values).size === values.length;
    });
    if (controller !== undefined) {
      for (const branch of union.branches) {
        const options = branch.pins[controller] ?? [];
        for (const prop of union.names.filter((name) => name !== controller)) {
          const computed = branch.forbids.includes(prop) ? 'forbidden' : 'allowed';
          const reference = referenceStates(constituents, controller, options, prop);
          if (!agrees(computed, reference)) {
            mismatches.push({ file, reader: 'instance', controller, option: options.join('|'), prop, computed, reference });
          }
        }
      }
    }
  }
  return mismatches;
}

function corpusFiles(): readonly string[] {
  const extra = (process.env['STACKI_CORPUS_DIRS'] ?? '').split(':').filter((entry) => entry !== '');
  return [...FIXTURE_DIRECTORIES, ...extra].flatMap((directory) => astroFiles(directory));
}

test("Card's real shape: theme is shown for default and cover, hidden for stacked, in both readers", () => {
  const source = fs.readFileSync(CARD_PATH, 'utf8');
  const group = readVariantGroups(source).find((candidate) => candidate.controller === 'variant');
  assert.ok(group !== undefined, 'Card has a variant group');
  assert.equal(group.editing.kind, 'editable');
  const table: readonly (readonly [option: string, prop: string, state: State, listed: boolean])[] = [
    ['default', 'theme', 'optional', false],
    ['cover', 'theme', 'optional', false],
    ['stacked', 'theme', 'forbidden', true],
    ['default', 'image', 'forbidden', true],
    ['cover', 'image', 'optional', true],
    ['stacked', 'image', 'optional', true],
    ['default', 'imageAlt', 'forbidden', true],
    ['cover', 'imageAlt', 'optional', true],
    ['stacked', 'imageAlt', 'optional', true],
  ];
  for (const [option, prop, state, listed] of table) {
    const rule: VariantRule | undefined = group.options.find((candidate) => candidate.value === option)?.rules.find((candidate) => candidate.prop === prop);
    assert.equal(rule?.state, state, `${prop} under ${option}`);
    assert.equal(rule?.listed, listed, `${prop} under ${option} is listed`);
  }
  // The inherited rule carries the shared declaration's type and tooltip.
  const inherited = group.options[0]?.rules.find((rule) => rule.prop === 'theme');
  assert.equal(inherited?.type, '"inherit" | "light" | "dark" | "brand" | "invert"');
  assert.equal(inherited?.description, 'Color theme of element and its children.');
  const union = readPropModel(source).unions.find((candidate) => candidate.names.includes('theme'));
  assert.ok(union !== undefined, 'the instance panel has the union');
  const forbids = Object.fromEntries(union.branches.map((branch) => [(branch.pins['variant'] ?? []).join('|'), branch.forbids.includes('theme')]));
  assert.deepEqual(forbids, { default: false, cover: false, stacked: true });
});

test('a prop left out of a member is forbidden only when no type beside the union declares it', () => {
  const read = (frontmatter: string) => readVariantGroups(`---\n${frontmatter}\n---\n<div />\n`).find((group) => group.controller === 'kind');
  const shared = read('type Base = { tone?: string };\ntype Props = Base & ({ kind?: "a" } | { kind: "b"; tone?: never });');
  assert.deepEqual(
    shared?.options.map((option) => option.rules.map((rule) => rule.state)),
    [['optional'], ['forbidden']],
  );
  const nowhere = read('type Props = { kind?: "a" } | { kind: "b"; tone?: string };');
  assert.deepEqual(
    nowhere?.options.map((option) => option.rules.map((rule) => rule.state)),
    [['forbidden'], ['optional']],
  );
  const undefinedOnly = read('type Base = { tone?: string };\ntype Props = Base & ({ kind?: "a" } | { kind: "b"; tone?: undefined });');
  assert.deepEqual(
    undefinedOnly?.options.map((option) => option.rules.map((rule) => rule.state)),
    [['optional'], ['forbidden']],
  );
  const requiredShared = read('interface Base { tone: string }\ntype Props = Base & ({ kind?: "a" } | { kind: "b"; tone?: string });');
  assert.deepEqual(
    requiredShared?.options.map((option) => option.rules.map((rule) => rule.state)),
    [['required'], ['required']],
  );
  const neverShared = read('type Base = { tone?: never };\ntype Props = Base & ({ kind?: "a" } | { kind: "b"; tone?: string });');
  assert.deepEqual(
    neverShared?.options.map((option) => option.rules.map((rule) => rule.state)),
    [['forbidden'], ['forbidden']],
  );
});

function edited(source: string, edit: VariantRuleEdit): string {
  const result = editVariantRules(source, edit);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
}

function themeStates(source: string): readonly string[] {
  const group = readVariantGroups(source).find((candidate) => candidate.controller === 'variant');
  return (group?.options ?? []).map((option) => option.rules.find((rule) => rule.prop === 'theme')?.state ?? 'not ruled');
}

test("Card's theme is written as the smallest edit, and an edit that changes nothing keeps every byte", () => {
  const card = fs.readFileSync(CARD_PATH, 'utf8');
  // Already as asked: the same source, byte for byte.
  assert.equal(edited(card, { kind: 'setRule', controller: 'variant', option: 'default', prop: 'theme', state: 'optional' }), card);
  assert.equal(
    edited(card, {
      kind: 'setVisibility',
      prop: 'theme',
      rules: [
        {
          controller: 'variant',
          states: [
            { option: 'default', state: 'optional' },
            { option: 'cover', state: 'optional' },
            { option: 'stacked', state: 'forbidden' },
          ],
        },
      ],
    }),
    card,
  );
  // Hide for default: the member gains its own `never`; the shared declaration stays.
  const hidden = edited(card, { kind: 'setRule', controller: 'variant', option: 'default', prop: 'theme', state: 'forbidden' });
  assert.deepEqual(themeStates(hidden), ['forbidden', 'optional', 'forbidden']);
  assert.equal(hidden.split('theme?: "inherit"').length, 2, 'the shared declaration is not repeated');
  // Show everywhere: stacked's `never` goes, and nothing is added beside Base's own declaration.
  const everywhere = edited(card, { kind: 'setVisibility', prop: 'theme', rules: [] });
  assert.deepEqual(themeStates(everywhere), ['not ruled', 'not ruled', 'not ruled']);
  assert.equal(everywhere.includes('theme?: never'), false);
  assert.equal(everywhere.split('theme?: "inherit"').length, 2, 'Base declares theme once');
  // A tooltip for the options that inherit it is written once, on the shared declaration.
  const described = edited(card, {
    kind: 'setRuleDescription',
    controller: 'variant',
    prop: 'theme',
    options: ['default', 'cover'],
    description: 'Surface colors.',
  });
  assert.equal(described.split('Surface colors.').length, 2, 'one shared comment');
  assert.equal(described.includes('/** Color theme of element and its children. */\n  theme?: "inherit"'), false);
});

test('the corpus: every prop of every union reads per option as TypeScript holds it', (context) => {
  const files = corpusFiles();
  assert.ok(files.length > 30, 'the fixtures hold the Lumos starter at least');
  const references = referencePrograms(files);
  const mismatches: Mismatch[] = [];
  let checked = 0;
  for (const file of files) {
    const constituents = references.get(file);
    if (constituents !== undefined) {
      checked += 1;
      mismatches.push(...popoverMismatches(file, constituents), ...instanceMismatches(file, constituents));
    }
  }
  context.diagnostic(`files ${files.length}, with a resolved Props ${checked}, mismatches ${mismatches.length}`);
  assert.ok(references.has(CARD_PATH), "Card's Props resolves in the reference program");
  for (const mismatch of mismatches) {
    context.diagnostic(
      `${mismatch.reader} ${mismatch.file} ${mismatch.controller}=${mismatch.option} ${mismatch.prop}: ${mismatch.computed} vs ${mismatch.reference.join(',')}`,
    );
  }
  assert.deepEqual(mismatches, []);
});
