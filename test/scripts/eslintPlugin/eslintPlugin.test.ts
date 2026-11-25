// Goal: pin the behavior of every rule in the local ESLint plugin
// (scripts/eslintPlugin/), which turns AGENTS.md rules into lint errors.
// Method: typescript-eslint's RuleTester, run under node:test, feeds each rule source
// snippets parsed as TypeScript. Every rule gets the positive space it must
// accept — including each documented exemption — and the negative space it
// must reject, with the message id pinned so a changed diagnosis is a failure.
// A rule's fixer, where it has one, is pinned by its output.
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { rules } from '../../../scripts/eslintPlugin/index.mts';

// RuleTester registers through void-returning functions. node:test's return a promise the
// runner itself awaits and reports on, so the adapters leave it to the runner.
const voided =
  (register: (text: string, callback: () => void) => Promise<void>) =>
  (text: string, callback: () => void): void => {
    void register(text, callback);
  };
RuleTester.afterAll = after;
RuleTester.describe = voided(describe);
RuleTester.describeSkip = voided(describe.skip);
RuleTester.it = voided(it);
RuleTester.itOnly = voided(it.only);
RuleTester.itSkip = voided(it.skip);

// Directives in the test snippets suppress nothing, and the linter's own
// unused-directive report would count as a second error for the case.
const tester = new RuleTester({
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

const NAMING_OPTIONS: [
  {
    readonly words: Readonly<Record<string, string>>;
    readonly quantityWords: readonly string[];
  },
] = [
  {
    words: { el: 'element', src: 'source', e: 'event or error', err: 'error' },
    quantityWords: ['depth', 'ms'],
  },
];

tester.run('naming', rules.naming, {
  valid: [
    { code: 'const element = document.body;', options: NAMING_OPTIONS },
    { code: 'for (let i = 0; i < 3; i += 1) {}', options: NAMING_OPTIONS },
    // Property keys mirror external shapes and are not ours to name.
    { code: 'const image = { src: "a.png" }; image.src;', options: NAMING_OPTIONS },
    { code: 'const depthMax = 3;', options: NAMING_OPTIONS },
    // A lone qualifier names nothing to reorder.
    { code: 'const max = 3;', options: NAMING_OPTIONS },
    { code: 'const maxWidth = 3;', options: NAMING_OPTIONS },
    { code: 'export const err = 1;', options: [{ ...NAMING_OPTIONS[0], allowedNames: ['err'] }] },
    { code: 'import { err } from "./result";', options: NAMING_OPTIONS },
  ],
  invalid: [
    { code: 'const el = 1;', options: NAMING_OPTIONS, errors: [{ messageId: 'abbreviation' }] },
    {
      code: 'const srcPath = 1;',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'const SRC_PATH = 1;',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'try {} catch (err) {}',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'list.forEach((e) => e);',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'function load({ src }: { src: string }) {}',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'const [first, el] = pair;',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'interface ElProps {}',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'abbreviation' }],
    },
    {
      code: 'const maxDepth = 3;',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'qualifierFirst' }],
    },
    {
      code: 'const MAX_LATENCY_MS = 3;',
      options: NAMING_OPTIONS,
      errors: [{ messageId: 'qualifierFirst' }],
    },
  ],
});

tester.run('no-boolean-parameter', rules['no-boolean-parameter'], {
  valid: [
    'function load(options: { readonly force?: boolean }) {}',
    'function setOpen(open: boolean) {}',
    'list.filter((keep: boolean) => keep);',
    'const view = <input onChange={(checked: boolean) => checked} />;',
    'function load(count: number) {}',
  ],
  invalid: [
    {
      code: 'function load(force: boolean) {}',
      errors: [{ messageId: 'booleanParameter', data: { name: 'force' } }],
    },
    {
      code: 'const load = (path: string, force?: boolean | undefined) => path;',
      errors: [{ messageId: 'booleanParameter' }],
    },
    { code: 'function load(force: true | false) {}', errors: [{ messageId: 'booleanParameter' }] },
    // A setter with a second parameter is no longer self-describing.
    {
      code: 'function setOpen(open: boolean, animate: boolean) {}',
      errors: [{ messageId: 'booleanParameter' }, { messageId: 'booleanParameter' }],
    },
    {
      code: 'function load(force = false, enabled: boolean) {}',
      errors: [{ messageId: 'booleanParameter', data: { name: 'enabled' } }],
    },
  ],
});

tester.run('bounded-recursion', rules['bounded-recursion'], {
  valid: [
    'function walk(node, depth) {\n' + '  assert(depth <= LIMITS.treeDepthMax, "deep");\n' + '  walk(node, depth + 1);\n' + '}',
    'function walk(node, depth) {\n' + '  if (depth + 1 > LIMITS.treeDepthMax) { return; }\n' + '  walk(node, depth + 1);\n' + '}',
    'function visit(node, state) {\n' + '  if (state.depth > LIMITS.treeDepthMax) { return; }\n' + '  visit(node, state);\n' + '}',
    'function once() { return other(); }',
    // A property's key is not in scope: these call the global or outer binding.
    'const timers = { setTimeout: (callback, ms) => setTimeout(callback, ms) };',
    'useScrub({ onCommit: () => { onCommit(); } });',
    'class Branches { park() { return park(this.name); } }',
    'function walk(node, depth) {\n' + '  assert(depth < PARSE_LIMITS.depthMax, "deep");\n' + '  walk(node, depth + 1);\n' + '}',
  ],
  invalid: [
    { code: 'function walk(node) { walk(node.child); }', errors: [{ messageId: 'unbounded' }] },
    {
      code: 'const visit = (node) => { node.children.forEach((child) => visit(child)); };',
      errors: [{ messageId: 'unbounded' }],
    },
    {
      code: 'class Tree { walk(node) { this.walk(node.child); } }',
      errors: [{ messageId: 'unbounded' }],
    },
    // A bound on something other than depth bounds nothing.
    {
      code: 'function walk(node, count) {\n' + '  assert(count <= LIMITS.treeNodesMax, "n");\n' + '  walk(node, count);\n' + '}',
      errors: [{ messageId: 'unbounded' }],
    },
  ],
});

tester.run('no-null', rules['no-null'], {
  valid: [
    'const value = undefined;',
    'if (element === null) {}',
    'if (match !== null) {}',
    'const ref = useRef<HTMLDivElement>(null);',
    'JSON.stringify(value, null, 2);',
    'const map = Object.create(null);',
    'history.replaceState(null, "", url);',
  ],
  invalid: [
    { code: 'const value = null;', errors: [{ messageId: 'nullLiteral' }] },
    { code: 'function find() { return null; }', errors: [{ messageId: 'nullLiteral' }] },
    { code: 'if (value == null) {}', errors: [{ messageId: 'nullLiteral' }] },
    {
      code: 'let value: string | null;',
      errors: [{ messageId: 'nullType' }],
    },
    { code: 'JSON.stringify(null);', errors: [{ messageId: 'nullLiteral' }] },
    { code: 'useRef<HTMLDivElement | null>(null);', errors: [{ messageId: 'nullType' }] },
  ],
});

tester.run('catch-unknown', rules['catch-unknown'], {
  valid: ['try {} catch (error: unknown) {}', 'try {} catch {}'],
  invalid: [
    {
      code: 'try {} catch (error) {}',
      output: 'try {} catch (error: unknown) {}',
      errors: [{ messageId: 'untyped' }],
    },
  ],
});

tester.run('no-compound-assert', rules['no-compound-assert'], {
  valid: ['assert(a); assert(b);', 'assert(a || b, "either");', 'check(a && b);'],
  invalid: [{ code: 'assert(a && b, "both");', errors: [{ messageId: 'compound' }] }],
});

tester.run('no-unbounded-loop', rules['no-unbounded-loop'], {
  valid: ['while (index < count) {}', 'for (let i = 0; i < 3; i += 1) {}', 'do {} while (more);'],
  invalid: [
    { code: 'while (true) {}', errors: [{ messageId: 'unbounded' }] },
    { code: 'for (;;) {}', errors: [{ messageId: 'unbounded' }] },
    { code: 'do {} while (1);', errors: [{ messageId: 'unbounded' }] },
  ],
});

tester.run('division-intent', rules['division-intent'], {
  valid: ['const middle = list[Math.floor(list.length / 2)];', 'const ratio = width / height;', 'text.slice(0, Math.ceil(text.length / 2));'],
  invalid: [
    { code: 'const middle = list[list.length / 2];', errors: [{ messageId: 'bareDivision' }] },
    { code: 'text.slice(0, text.length / 2);', errors: [{ messageId: 'bareDivision' }] },
    { code: 'new Array(size / 2);', errors: [{ messageId: 'bareDivision' }] },
  ],
});

tester.run('comment-sentence', rules['comment-sentence'], {
  valid: [
    '// A sentence.\nconst a = 1;',
    '// A sentence that\n// continues here.\nconst a = 1;',
    '// `loadURL` opens the page.\nconst a = 1;',
    '// loadURL opens the page.\nconst a = 1;',
    '// Lists follow:\n// - one\n// - two\nconst a = 1;',
    'const a = 1; // an end-of-line phrase',
    '// --- Section ---\nconst a = 1;',
    '// eslint-disable-next-line no-console -- demo\nconst a = 1;',
    '// Ends with code: `a.b()`\nconst a = 1;',
  ],
  invalid: [
    { code: '//No space.\nconst a = 1;', errors: [{ messageId: 'space' }] },
    { code: '// lower case.\nconst a = 1;', errors: [{ messageId: 'capital' }] },
    { code: '// No stop\nconst a = 1;', errors: [{ messageId: 'terminal' }] },
    { code: '// Two lines\n// and no stop\nconst a = 1;', errors: [{ messageId: 'terminal' }] },
  ],
});

// A blanket `eslint-disable` suppresses this rule too, so the policy scan
// holds that case (test/scripts/policy/policyScan.test.ts).
tester.run('require-disable-reason', rules['require-disable-reason'], {
  valid: ['// eslint-disable-next-line no-console -- the CLI prints\nconsole.log(1);', '/* eslint-disable no-console -- the CLI prints */'],
  invalid: [
    {
      code: '// eslint-disable-next-line no-console\nconsole.log(1);',
      errors: [{ messageId: 'missingReason' }],
    },
    { code: '/* eslint-disable no-console */', errors: [{ messageId: 'missingReason' }] },
  ],
});

tester.run('no-enum', rules['no-enum'], {
  valid: ['const STATUSES = ["draft", "done"] as const;'],
  invalid: [{ code: 'enum Status { Draft }', errors: [{ messageId: 'enum' }] }],
});

// The custom dropdown is a component, so its name and its props are untouched;
// only the intrinsic element and a created select element are native ones.
tester.run('no-native-select', rules['no-native-select'], {
  valid: [
    'const view = <Dropdown value="a" options={[]} onChange={(value: string) => value} />;',
    'const view = <option value="a">A</option>;',
    'const view = <Select />;',
    'const view = <ui.select />;',
    'document.createElement("div");',
    'document.createElement(tag);',
    'document.createElement(`${tag}`);',
    'document.querySelector("select");',
    'createElement();',
  ],
  invalid: [
    { code: 'const view = <select value="a" onChange={() => undefined} />;', errors: [{ messageId: 'nativeSelect' }] },
    { code: 'const view = <select><option>A</option></select>;', errors: [{ messageId: 'nativeSelect' }] },
    { code: 'document.createElement("select");', errors: [{ messageId: 'nativeSelect' }] },
    { code: "document.createElement('SELECT');", errors: [{ messageId: 'nativeSelect' }] },
    { code: 'document.createElement(`select`);', errors: [{ messageId: 'nativeSelect' }] },
    { code: 'React.createElement("select", { value: "a" });', errors: [{ messageId: 'nativeSelect' }] },
    { code: 'createElement("select");', errors: [{ messageId: 'nativeSelect' }] },
  ],
});

tester.run('no-partial-parameter', rules['no-partial-parameter'], {
  valid: ['function update(fields: Pick<Project, "title">) {}', 'type Draft = Partial<Project>;'],
  invalid: [
    { code: 'function update(fields: Partial<Project>) {}', errors: [{ messageId: 'partial' }] },
    {
      code: 'const update = (fields: Partial<Project>) => fields;',
      errors: [{ messageId: 'partial' }],
    },
  ],
});

tester.run('no-overloads', rules['no-overloads'], {
  valid: ['function parse(input: string | number) {}', 'declare function external(): void;'],
  invalid: [
    {
      code: 'function parse(input: string): string;\n' + 'function parse(input: unknown) { return input; }',
      errors: [{ messageId: 'overload' }],
    },
    {
      code: 'class Parser {\n' + '  parse(input: string): string;\n' + '  parse(input: unknown) { return input; }\n' + '}',
      errors: [{ messageId: 'overload' }],
    },
  ],
});

tester.run('callback-last', rules['callback-last'], {
  valid: ['function watch(path: string, onChange: () => void) {}', 'function both(onStart: () => void, onEnd: () => void) {}'],
  invalid: [
    {
      code: 'function watch(onChange: () => void, path: string) {}',
      errors: [{ messageId: 'callbackNotLast' }],
    },
  ],
});

// The layer order and edges are given here as options, as eslint.config.mjs
// gives them; each case names the file it lints, since the verdict depends on
// where the importing module sits. Sample paths name no real file.
const LAYER_OPTIONS: [
  {
    readonly repository: string;
    readonly root: string;
    readonly layers: readonly string[];
    readonly featureLayer: string;
    readonly featureEdges: Readonly<Record<string, readonly string[]>>;
    readonly outside: readonly string[];
    readonly outsideEdges: Readonly<Record<string, readonly string[]>>;
  },
] = [
  {
    repository: process.cwd(),
    root: 'src',
    layers: ['lib', 'editor', 'features', 'app'],
    featureLayer: 'features',
    featureEdges: { left: ['features/right/Shared'] },
    outside: ['shared'],
    outsideEdges: { 'app/Shell': ['electron/reader'] },
  },
];
const layerCase = (file: string, code: string) => ({
  code,
  filename: path.join(process.cwd(), file),
  options: LAYER_OPTIONS,
});

tester.run('source-layers', rules['source-layers'], {
  valid: [
    layerCase('src/features/left/Panel.tsx', "import { a } from '../../lib/sample';"),
    layerCase('src/features/left/Panel.tsx', "import { a } from './model';"),
    layerCase('src/features/left/Panel.tsx', "import './panel.css';"),
    layerCase('src/features/left/Panel.tsx', "import { a } from '../right/Shared';"),
    layerCase('src/features/left/Panel.tsx', "import { a } from '../../../shared/sample';"),
    layerCase('src/features/left/Panel.tsx', "import React from 'react';"),
    layerCase('src/app/Shell.tsx', "import { a } from '../../electron/reader';"),
    layerCase('src/main.tsx', "import Shell from './app/Shell';"),
    // Files outside the root are not the renderer's.
    layerCase('electron/sample.ts', "import { a } from '../src/app/Shell';"),
  ],
  invalid: [
    {
      ...layerCase('src/lib/sample.ts', "import { a } from '../editor/model';"),
      errors: [{ messageId: 'layerOrder' }],
    },
    {
      ...layerCase('src/editor/model.ts', "export { a } from '../app/Shell';"),
      errors: [{ messageId: 'layerOrder' }],
    },
    {
      ...layerCase('src/editor/model.ts', "const panel = import('../features/left/Panel');"),
      errors: [{ messageId: 'layerOrder' }],
    },
    {
      ...layerCase('src/features/left/Panel.tsx', "import { a } from '../right/Private';"),
      errors: [{ messageId: 'crossFeature' }],
    },
    {
      ...layerCase('src/features/right/Panel.tsx', "import { a } from '../left/Panel';"),
      errors: [{ messageId: 'crossFeature' }],
    },
    {
      ...layerCase('src/features/left/Panel.tsx', "import { a } from '../../../electron/reader';"),
      errors: [{ messageId: 'outsideRoot' }],
    },
    {
      ...layerCase('src/editor/model.ts', "import { a } from '../main';"),
      errors: [{ messageId: 'layerOrder' }],
    },
    {
      ...layerCase('src/features/left/Panel.tsx', "import { a } from './model.ts';"),
      errors: [{ messageId: 'extension' }],
    },
    {
      ...layerCase('src/features/left/Panel.tsx', "import type { A } from './model.js';"),
      errors: [{ messageId: 'extension' }],
    },
  ],
});

// The area shape (the main process): each area imports only those listed.
const AREA_OPTIONS: [
  {
    readonly repository: string;
    readonly root: string;
    readonly outside: readonly string[];
    readonly areas: Readonly<Record<string, readonly string[]>>;
  },
] = [
  {
    repository: process.cwd(),
    root: 'electron',
    outside: ['shared'],
    areas: { main: ['*'], lib: [], parse: ['lib'], documents: ['lib', 'parse'] },
  },
];
const areaCase = (file: string, code: string) => ({
  code,
  filename: path.join(process.cwd(), file),
  options: AREA_OPTIONS,
});

tester.run('source-layers (areas)', rules['source-layers'], {
  valid: [
    areaCase('electron/documents/sample.ts', "import { a } from '../parse/sample';"),
    areaCase('electron/documents/sample.ts', "import { a } from './other';"),
    areaCase('electron/main.ts', "import { a } from './documents/sample';"),
    areaCase('electron/lib/sample.ts', "import { a } from '../../shared/sample';"),
  ],
  invalid: [
    {
      ...areaCase('electron/parse/sample.ts', "import { a } from '../documents/sample';"),
      errors: [{ messageId: 'areaEdge' }],
    },
    {
      ...areaCase('electron/lib/sample.ts', "import { a } from '../parse/sample';"),
      errors: [{ messageId: 'areaEdge' }],
    },
    {
      // An area the config does not list imports nothing outside itself.
      ...areaCase('electron/unlisted/sample.ts', "import { a } from '../lib/sample';"),
      errors: [{ messageId: 'areaEdge' }],
    },
    {
      ...areaCase('electron/lib/sample.ts', "import { a } from '../../src/sample';"),
      errors: [{ messageId: 'outsideRoot' }],
    },
  ],
});
