// ESLint flat config — AGENTS.md rule set.
//
// Hand-rolled rather than via the typescript-eslint meta-package: the parser
// and plugin are declared directly (docs/dependencies.md), and the meta package
// would add a third name for the same code. Same rules, same shape.
//
// docs/enforcement.md maps every AGENTS.md rule to the check that holds it;
// the rules AGENTS.md states that stock ESLint cannot express live in the
// local plugin, scripts/eslintPlugin/, loaded here without a build step.
//
// Every rule is an error, and every run uses --max-warnings 0: a finding either
// blocks the change or carries a stated reason in an eslint-disable comment.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import stacki from './scripts/eslintPlugin/index.mts';

// AGENTS.md §12: no abbreviations. Word → what to write instead. Checked word
// by word on every declared name (scripts/eslintPlugin/naming.mts). Loop
// counters i, j, k are the stated exception; x, y, z are coordinates, not
// abbreviations. `attr` and `env` are left alone: they are the platform's own
// vocabulary (the DOM's Attr, process.env).
const ABBREVIATIONS = {
  a: 'a descriptive name (left, first, …)',
  arr: 'array, or what it lists',
  b: 'a descriptive name (right, second, …)',
  btn: 'button',
  c: 'a descriptive name',
  calc: 'calculate',
  cb: 'callback',
  cfg: 'config',
  ctx: 'context',
  cur: 'current',
  curr: 'current',
  d: 'a descriptive name',
  def: 'definition',
  defs: 'definitions',
  desc: 'description',
  dest: 'target',
  dir: 'directory',
  dirs: 'directories',
  doc: 'document',
  e: 'event or error',
  el: 'element',
  elem: 'element',
  err: 'error',
  ev: 'event',
  evt: 'event',
  f: 'a descriptive name',
  fn: 'callback, handler, or what it computes',
  g: 'a descriptive name',
  h: 'height',
  idx: 'index',
  k: 'key',
  l: 'a descriptive name',
  len: 'length',
  m: 'a descriptive name (match, …)',
  msg: 'message',
  n: 'count, or what it counts',
  num: 'number, or what it counts',
  o: 'a descriptive name',
  obj: 'object, or what it holds',
  opt: 'option',
  opts: 'options',
  p: 'a descriptive name',
  pct: 'percent',
  pos: 'position',
  prev: 'previous',
  q: 'query',
  r: 'a descriptive name',
  req: 'request',
  res: 'result or response',
  s: 'a descriptive name (text, …)',
  sel: 'selection or selector',
  src: 'source',
  str: 'text, or what it spells',
  t: 'a descriptive name',
  temp: 'temporary, or what it holds',
  tmp: 'temporary, or what it holds',
  u: 'a descriptive name',
  util: 'utility',
  utils: 'utilities',
  v: 'value',
  val: 'value',
  w: 'width',
};
// Quantities whose `max`/`min` prefix is a misplaced qualifier (§12:
// latencyMsMax, not maxLatencyMs).
const QUANTITY_WORDS = [
  'bytes',
  'chars',
  'columns',
  'count',
  'depth',
  'entries',
  'height',
  'items',
  'length',
  'lines',
  'ms',
  'nodes',
  'px',
  'retries',
  'rows',
  'seconds',
  'size',
  'width',
];
const NAMING = { words: ABBREVIATIONS, quantityWords: QUANTITY_WORDS };

// Rules that read syntax only, so they hold for JavaScript and TypeScript
// alike. Type-aware and TypeScript-syntax rules join in the TS block.
const STACKI_SYNTAX_RULES = {
  'stacki/bounded-recursion': 'error',
  'stacki/comment-sentence': 'error',
  'stacki/division-intent': 'error',
  'stacki/naming': ['error', NAMING],
  'stacki/no-compound-assert': 'error',
  'stacki/no-null': 'error',
  'stacki/no-unbounded-loop': 'error',
  'stacki/require-disable-reason': 'error',
};
const STACKI_TYPESCRIPT_RULES = {
  ...STACKI_SYNTAX_RULES,
  'stacki/callback-last': 'error',
  'stacki/catch-unknown': 'error',
  'stacki/no-boolean-parameter': 'error',
  'stacki/no-enum': 'error',
  'stacki/no-overloads': 'error',
  'stacki/no-partial-parameter': 'error',
};

// no-restricted-syntax lists replace each other between config blocks rather
// than merging, so each group is defined once and composed per block below.

// `as const` is the canonical way to keep literal unions (§5). Reject all
// other assertion syntax while allowing that one language construct.
const NO_ASSERTIONS = [
  {
    selector: "TSAsExpression:not([typeAnnotation.typeName.name='const'])",
    message: 'Type assertions must be replaced with validation and narrowing.',
  },
  {
    selector: 'TSTypeAssertion',
    message: 'Type assertions must be replaced with validation and narrowing.',
  },
];

// Whole-file regeneration (plan §12: rejected as the steady state; §11.9: gone
// for existing .astro files). An existing file changes only by splices, so the
// printers may be imported or called only where a file is printed that does not
// exist yet, or where an edit prints just what it adds. Importing the name is
// what is banned, so an alias cannot slip past.
const WHOLE_FILE_REGENERATION_MESSAGE =
  'Whole-file regeneration is confined to the printer boundaries (plan §11.9); ' +
  'an existing file changes only through intents and splices.';
const NO_ASTRO_PRINTING = [
  {
    selector: 'ImportSpecifier[imported.name=/^serialize(Page|Nodes)$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.name=/^serialize(Page|Nodes)$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector: 'ImportDeclaration[source.value=/astroParser(\\.js)?$/] > ImportNamespaceSpecifier',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
];
const NO_MARKDOWN_PRINTING = [
  {
    selector: 'ImportSpecifier[imported.name=/^serializeMarkdownPage$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.name=/^serializeMarkdownPage$/]',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
  {
    selector:
      'ImportDeclaration[source.value=/markdownParser(\\.js)?$/] > ImportNamespaceSpecifier',
    message: WHOLE_FILE_REGENERATION_MESSAGE,
  },
];
const NO_WHOLE_FILE_REGENERATION = [...NO_ASTRO_PRINTING, ...NO_MARKDOWN_PRINTING];
// Where the .astro printers may run: their definitions; new files (a component
// made from a piece of a page, a new page); the nodes and the frontmatter block
// an edit adds, printed alone (editRequests.ts); and Markdown's HTML blocks.
const ASTRO_PRINTER_BOUNDARY = [
  'electron/parse/astroParser.ts',
  'electron/documents/componentFile.ts',
  'electron/documents/editRequests.ts',
];
// Markdown's parser module holds the page printer — the round-trip oracle the
// tests hold it to, never a write path (step 10: a Markdown page reaches disk
// only as splices) — and prints its HTML blocks with the .astro printer.
const PRINTER_BOUNDARY = ['electron/parse/markdownParser.ts'];

// Determinism is structural (plan §10): the simulator and the engine contracts
// run on no clock, no timer, no promise and no OS. A real timer sneaking in is
// a failed gate, not a flaky test.
const NO_ASYNC = [
  { selector: 'AwaitExpression', message: 'Deterministic code has no async steps (plan §10).' },
  {
    selector: ':function[async=true]',
    message: 'Deterministic code has no async steps (plan §10).',
  },
  {
    selector: "Identifier[name='Promise']",
    message: 'Deterministic code has no promises (plan §10).',
  },
];
const DETERMINISM_RULES = {
  'no-restricted-globals': [
    'error',
    ...[
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'Date',
      'performance',
      'process',
      'fetch',
    ].map((name) => ({
      name,
      message: `${name} is nondeterministic; the scheduler owns time (plan §10).`,
    })),
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Use the seeded Prng (plan §10).' },
    { object: 'crypto', property: 'randomUUID', message: 'Use the seeded Prng (plan §10).' },
    { object: 'crypto', property: 'getRandomValues', message: 'Use the seeded Prng (plan §10).' },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        'fs',
        'node:fs',
        'node:fs/promises',
        'timers',
        'node:timers',
        'node:timers/promises',
        'node:child_process',
        'node:worker_threads',
        'node:perf_hooks',
        'node:os',
        'node:net',
        'node:http',
        'node:https',
      ].map((name) => ({
        name,
        message: 'Deterministic code does no I/O; fake it behind an interface (plan §10).',
      })),
    },
  ],
};
// Pure engine contracts, fenced like the simulator: they will run inside it.
const ENGINE_CONTRACTS = [
  'shared/page/capability.ts',
  'shared/engine/codePatch.ts',
  'shared/engine/diff.ts',
  'shared/engine/documentActor.ts',
  'shared/engine/intent.ts',
  'shared/engine/mapSpan.ts',
  'shared/engine/inlineStyle.ts',
  'shared/engine/loopScope.ts',
  'shared/engine/markdownLayout.ts',
  'shared/engine/planMarkdown.ts',
  'shared/engine/planner.ts',
  'shared/engine/planSupport.ts',
  'shared/engine/planText.ts',
  'shared/engine/planTree.ts',
  'shared/engine/rebase.ts',
  'shared/page/ref.ts',
  'shared/page/snapshot.ts',
  'shared/page/sourceProjection.ts',
  'shared/core/span.ts',
  'shared/engine/splice.ts',
];

// The renderer's layers (docs/codebase.md, "Directory map"), lowest first: a
// module imports only the layers below its own. A feature imports another
// feature only along an edge listed here, by file, never through a barrel —
// a barrel would pull eager stylesheets and lazy panels into its importers.
const SOURCE_LAYERS = {
  repository: import.meta.dirname,
  root: 'src',
  layers: ['lib', 'ipc', 'editor', 'ui', 'features', 'app'],
  featureLayer: 'features',
  featureEdges: {
    // Property defaults and options are edited with the props panel's fields.
    componentProperties: [
      'features/props/ListField',
      'features/props/arrayValue',
      'features/props/propBindings',
    ],
    // CMS fields are the component props panel's fields, so both read and work alike.
    cms: [
      'features/props/PropField',
      'features/props/PropTip',
      'features/props/propValuePolicy',
      // A colour value is chosen with the style panel's swatch and picker.
      'features/style/components/ColorSwatch',
    ],
    // The history panel draws commits with git's file and branch widgets.
    history: ['features/git/BranchActions', 'features/git/FileBrowser', 'features/git/FileStatus'],
    // The column guide's menu is built from the style panel's controls.
    preview: [
      'features/style/LayerPopover',
      'features/style/SizeKit',
      'features/style/VariableConnect',
      'features/style/components/ColorSwatch',
      'features/style/components/DragSlider',
      'features/style/components/FieldLabel',
      'features/style/components/Select',
      'features/style/components/useScrub',
    ],
    // A variable's value is edited with the style panel's value editors.
    variables: [
      'features/style/CustomValueEditor',
      'features/style/EasingEditor',
      'features/style/VariableConnect',
      'features/style/components/ColorSwatch',
      'features/style/model/host',
      'features/style/model/transition',
      'features/style/utilities',
    ],
  },
  outside: ['shared'],
};

// The main process's areas (docs/codebase.md, "Directory map"): each folder
// imports only the areas listed for it, so the write path cannot come to
// depend on what is built on it. lib is the floor. The three folders that do
// not run in the main process import nothing of main's but what they run:
// the preview server only the parser (it is unpacked from the asar, and its
// closure stays small), the preview client and the preload nothing at all.
const ELECTRON_AREAS = {
  repository: import.meta.dirname,
  root: 'electron',
  outside: ['shared'],
  areas: {
    main: ['*'],
    lib: [],
    parse: ['lib'],
    documents: ['lib', 'parse'],
    content: ['lib', 'documents'],
    project: ['lib', 'documents'],
    git: ['lib', 'documents'],
    terminal: ['lib'],
    properties: ['lib', 'parse', 'documents', 'content'],
    preview: ['lib', 'git'],
    app: ['lib', 'content'],
    // The IPC handler modules main.ts registers, and the helpers only they use:
    // they reach what main.ts itself reaches, so a handler moves out unchanged.
    handlers: [
      'lib',
      'parse',
      'documents',
      'content',
      'project',
      'git',
      'properties',
      'preview',
      'app',
      'previewServer',
    ],
    previewServer: ['parse'],
    previewClient: [],
    preload: [],
  },
};

// The contract layer's areas (docs/codebase.md, "Directory map"): core is the
// floor; the page model and the property contracts sit on it, the edit engine
// on the page model, and the IPC contract may name any of them. shared/
// reaches nothing outside itself: main and the renderer both depend on it.
const SHARED_AREAS = {
  repository: import.meta.dirname,
  root: 'shared',
  outside: [],
  areas: {
    core: [],
    page: ['core'],
    properties: ['core'],
    engine: ['core', 'page'],
    ipc: ['core', 'page', 'engine', 'properties'],
  },
};

export default [
  {
    ignores: [
      'studio/**',
      'node_modules/**',
      'dist/**',
      'release/**',
      'coverage/**',
      '**/generated/**',
    ],
  },
  {
    // The JavaScript left in the tree: ESM configs and content-tool modules,
    // and the CommonJS test harnesses (top-level return is legal in the CJS
    // module wrapper). No types, so only the syntax rules apply.
    files: ['*.mjs', 'electron/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { stacki },
    rules: { curly: ['error', 'all'], ...STACKI_SYNTAX_RULES },
  },
  {
    files: ['electron/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    plugins: { stacki },
    rules: { curly: ['error', 'all'], ...STACKI_SYNTAX_RULES },
  },
  {
    files: ['**/*.{ts,tsx,mts}'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks, stacki },
    rules: {
      ...tsPlugin.configs['eslint-recommended'].rules,
      ...tsPlugin.configs.recommended.rules,
      ...STACKI_TYPESCRIPT_RULES,
      // AGENTS.md non-negotiables.
      // The migration ratchet is zero, so unchecked files cannot re-enter the
      // tree; a type test's expected error must say what it proves.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Reached zero in the alignment pass; AGENTS.md forbids `x!` outright.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_WHOLE_FILE_REGENERATION],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      curly: ['error', 'all'],
      // Effect dependencies are correctness: a stale closure is a real bug.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // Type-aware safety. Error — the compiler-adjacent bug class.
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      // §3: all errors are handled. A promise nobody awaits drops its
      // rejection; `void` is the explicit, reviewable way to say "detached".
      // node:test's registration calls are the exception: the runner owns
      // and awaits the promise each returns.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'suite', 'test'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      eqeqeq: ['error', 'always'],
      // §7: construct and return, never mutate a parameter. DOM elements,
      // React refs, canvas 2D contexts, and style declarations are mutable by
      // platform design; a function that takes one exists to change it. The
      // names are narrow on purpose: any other in-place write states its reason
      // in a disable, so a rename cannot opt out of the rule.
      'no-param-reassign': [
        'error',
        {
          props: true,
          ignorePropertyModificationsForRegex: [
            '[eE]lement$',
            '[rR]ef$',
            '^(?:canvas|drawing)?[cC]ontext$',
            '^style$',
          ],
        },
      ],
      // §11: a function fits on a screen.
      'max-lines-per-function': ['error', { max: 70, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // A source file fits in one reading: past 800 lines a module is several
    // modules, and splitting it by responsibility is cheaper now than later.
    // Tests are left out — a suite reads best as one file of cases.
    files: [
      'src/**/*.{ts,tsx}',
      'electron/**/*.{ts,mts}',
      'shared/**/*.ts',
      'scripts/**/*.{ts,mts}',
    ],
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // The Result constructor pair is the canonical `ok`/`err` of AGENTS.md §3;
    // `err` means exactly that and nothing else anywhere in the tree.
    files: ['shared/core/result.ts'],
    rules: { 'stacki/naming': ['error', { ...NAMING, allowedNames: ['err'] }] },
  },
  {
    // shared/ is the validated-constructor layer (AGENTS.md §2): assertions
    // are permitted here immediately after validation. Everywhere else the
    // rule stands at error.
    files: ['shared/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'stacki/source-layers': ['error', SOURCE_LAYERS] },
  },
  {
    files: ['electron/**/*.ts'],
    rules: { 'stacki/source-layers': ['error', ELECTRON_AREAS] },
  },
  {
    files: ['shared/**/*.ts'],
    rules: { 'stacki/source-layers': ['error', SHARED_AREAS] },
  },
  {
    // These adapters validate values from PostCSS, DOM storage, and the host
    // bridge before constructing trusted application values. AGENTS.md §2
    // permits assertions inside validated constructors and type guards.
    files: [
      'src/features/style/model/css.ts',
      'src/features/style/model/cssRegions.ts',
      'src/features/style/model/host.ts',
      'src/features/style/model/webflow.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION],
    },
  },
  {
    // These entrypoints compile to CommonJS because Electron Builder loads its
    // afterPack hook with require. Import assignments also keep direct Node
    // execution in CommonJS so __dirname and require.main have one meaning.
    files: ['scripts/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ASTRO_PRINTER_BOUNDARY,
    rules: {
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_MARKDOWN_PRINTING],
    },
  },
  {
    // Both printers, and the tests that pin their round trips.
    files: [...PRINTER_BOUNDARY, 'test/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_ASSERTIONS],
    },
  },
  {
    files: ENGINE_CONTRACTS,
    rules: {
      ...DETERMINISM_RULES,
      'no-restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION, ...NO_ASYNC],
    },
  },
  {
    // The simulator core. Its entry points — the *.test.ts suites and the
    // *.bench.ts spike measurement — and the *.entry.ts modules only they import
    // load fixtures from disk, read the environment and (the bench) the clock,
    // then hand plain values in.
    files: ['test/simulator/**/*.ts'],
    ignores: [
      'test/simulator/**/*.test.ts',
      'test/simulator/**/*.bench.ts',
      'test/simulator/**/*.entry.ts',
    ],
    rules: {
      ...DETERMINISM_RULES,
      'no-restricted-syntax': [
        'error',
        ...NO_ASSERTIONS,
        ...NO_WHOLE_FILE_REGENERATION,
        ...NO_ASYNC,
      ],
    },
  },
];
