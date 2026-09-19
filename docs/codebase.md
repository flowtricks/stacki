# Stacki — Codebase Architecture

**Status: living document.** Migration status updated after the Astro parser
conversion on `main`, following PR #26 and `v0.1.26`. Sections marked
"migration" describe in-flight work; see `docs/migration-tracker.md` for verification.

## What Stacki is

Stacki is a **visual builder for Astro projects** — a desktop app (Electron,
macOS and Windows, MIT licensed) that opens a real Astro project from disk and
lets you edit its pages visually:

- Browse, create, and delete pages under `src/pages` (including nested routes).
- Pick which layout from `src/layouts` wraps a page; edit layout props.
- Drag components from `src/components` into the page tree; reorder and remove.
- A props panel reads each component's `interface Props` / `Astro.props`
  destructure and generates typed fields (text, number, checkbox, lists,
  objects), with defaults shown as placeholders.
- A style panel edits CSS visually (layout, spacing, typography, backgrounds,
  effects, transforms, clip-path, embeds).
- Live preview: the app runs `astro dev` for the open project and embeds it;
  edits auto-save (300 ms debounce) and Astro's hot reload updates the canvas.
- Git/GitHub integration: branch chip, branch switching/creation, commit,
  push, publish via the `gh` CLI.
- **⇧⌘C** copies the current selection as a trail of `file:line-range`
  pointers (page → each drilled-into component → node), pasteable into an AI
  assistant so it knows exactly which markup is meant. Making the project
  legible to AI tools is a first-class goal of the design.
- Pages too complex for the visual model fall back to a code editor with live
  preview; "New Project…" scaffolds a minimal Astro starter.

The product constraint that shapes everything below: Stacki edits files that
are _also_ edited by hand and by AI assistants in real editors. The source of
truth is always the `.astro` file on disk — never the app's internal model.

## The core problem: round-trip editing with preserved source

Parsing `.astro` into a tree and rendering it is easy. The hard part, and the
thing the architecture is organized around, is the **round trip**: text →
structured model → user edits → text, _preserving everything the user did not
touch_ — comments, formatting, attribute order, hand-written expressions,
frontmatter code, and markup constructs the visual model does not understand.

Stacki solves this the way editors with faithful round trips always do: a
structured tree for the parts the UI edits, plus **raw-text anchors for
everything else**. Concretely:

- `electron/astroParser.ts` (emits `astroParser.js`) parses an `.astro` file into a
  `PageNode` tree. Nodes carry their **source ranges** (`.at` offsets), and
  anything not modeled (attributes in unusual order, raw `<script>`, unknown
  constructs) is kept verbatim and re-emitted on write.
- Frontmatter (`electron/frontmatter.ts`) is _not_ treated as a code blob:
  imports become editable records whose **slots** retain the exact source,
  whitespace, and position between them. Edits to the declarations field are
  mapped back to import positions by a line-based diff (`moveOffsets`) that
  can never place an import inside a string or expression
  (`safeImportOffsets`).
- The writer re-emitting a file reuses untouched source ranges byte-for-byte
  and regenerates only the edited subtrees.

This rules out the two tempting shortcuts: a standard AST library (it
normalizes away exactly the text the slots preserve) and codegen-from-model
(it would rewrite files the user didn't touch, destroying AI/hand edits).

## Process architecture

Four cooperating processes, each with one job:

```
┌─────────────────────────────────────────────────────────┐
│ Electron main (electron/main.js)                        │
│  File I/O, project scan, git, terminal, window state,   │
│  spawns + supervises the Astro dev server               │
└──────────────▲───────────────────────────┬──────────────┘
               │ contextBridge (typed)     │ spawns
┌──────────────┴─────────────┐   ┌─────────▼─────────────┐
│ Renderer (React + Vite)    │   │ astro dev (the user's │
│  src/App.tsx + panels      │   │ project, its deps)    │
│  Edits the PageNode model  │   │ Serves the live page  │
└──────────────┬─────────────┘   └─────────▲─────────────┘
               │ iframe embed + injected   │ HMR on save
               │ selection/hover script    │
               ▼                           │
        Canvas (preview iframe) ───────────┘
```

- **Main** (`electron/`, Node.js, CommonJS): owns everything that touches the
  OS. `main.ts` (emits `main.js`, 113 invoke channels) is a registry of
  capabilities; leaf modules do the work (`astroParser`, `frontmatter`,
  `htmlText`, `assetRefs`, `cssVars`, `gitBranches`, `gitHistory`,
  `projectWatcher`, `terminal` via node-pty, `previewWorktree`,
  `serialQueue`, `selfWrites`, `windowBounds`, content-collection tooling in
  `electron/content/`, data-format parsers in `electron/formats/`).
- **Preload** (`electron/preload.js`): a sandboxed bridge exposing an
  allowlisted `window.avb` API via `contextBridge`. Must stay CommonJS
  (Electron ≥ 33 sandbox requirement).
- **Renderer** (`src/`, React 19 + Vite, ESM): `App.tsx` (~4.9k lines) is the
  application shell and owns the page model; `src/panels/` are the side views
  (Structure, Props, Style, Pages, Assets, CMS, Git history, terminal…);
  `src/style-panel/` is the CSS editing surface (mostly TypeScript);
  `src/ui/` holds shared widgets.
- **Astro dev server**: the _user's project's own_ dev server. Stacki renders
  the canvas by embedding it, so the preview is always exactly what Astro
  produces — no re-implementation of Astro semantics. A small injected client
  script (`electron/morphClient.js` and friends) maps DOM ↔ source nodes for
  hover/selection and morphs the DOM on edits.

## The rendering pipeline

The path from source to canvas, per REFACTOR.md:

1. **Parse** — the page's own `.astro`, every component it imports, its layout
   chain, and its style sources become one serializable tree. No shared
   parser state: anything outside the current page loads on demand, so a page
   is never polluted by an unused file.
2. **Prop defaults** — a prop's default is the value its component template
   is already written against; rendered in the child frame, so defaults the
   renderer shows are exactly the ones `Astro.props` will hand it.
3. **Slots** — `<slot />` and named slots are paired with the markup that
   fills them; a component exposing a slot never needs to know its content.
4. **Client directives** — `client:*` scripts are read from the component
   itself. The editor ships no framework knowledge; a directive it has never
   seen renders the same way.
5. **Dispatch** — the render receives a `path` only (no ad-hoc overrides).
6. **The preview frame is a real browser** — styles resolve with the
   project's real cascade. A style the editor can't parse can't make the
   canvas lie, and the app never serves the user's markup from its own
   handlers.

## The write path

Editing is a serialized pipeline with explicit convergence:

```
edit → mutate tree → debounce 300ms → save queue → write .astro
                                   ↘ morph preview DOM (no reload)
```

- `src/pagePersistence.ts` (`createPageSaver` / `createFileSaver`) debounces,
  serializes writes per file, and **drains edits made while a write is
  pending**. A successful write acknowledges its exact state — currently by
  `WeakSet` object identity (see "live model vs boundary", below); drain
  loops are capped at `LIMITS.saveDrainMax` (each pass past the cap means
  edits arrive faster than writes can drain — a bug, not a load).
- `electron/serialQueue.ts` orders file writes in the main process.
- `electron/selfWrites.ts` keeps the file watcher from treating the app's own
  saves as external edits (with a shared `fs.watch` mitigation for a known
  Chokidar/macOS issue).
- `electron/projectWatcher.ts` detects genuine outside edits (AI assistants,
  editors, git operations) and triggers a rescan; the renderer re-pulls the
  file, bounded by `LIMITS.rescanChainMax`.

## Data model

The contract layer (`shared/`, introduced by the migration — see below) is
now the authoritative description:

- `shared/page-node.ts` — the `PageNode` discriminated union (10 kinds:
  component, element, raw, text, expr, raw-line, comment, map, cond, branch,
  chunk-group), `PropValue` (`string | number | boolean | expr | raw`), the
  `PageModel` envelope (nodes, imports, layout chain, frontmatter slots), and
  hand-rolled parsers. Invariants the types can't express are asserted:
  unique ids, paired nodes own `children`, `children: null` means
  self-closing. **Idioms the writers depend on:** `props` is always present
  on paired nodes (possibly `{}`) because writers mutate it in place; branch
  and map nodes always carry their children arrays (possibly empty).
- `shared/prop-schema.ts` — the prop-field model the props panel generates
  from, including `readonly` as a value shape (a `const`-initialized string
  is an exact value, not a default).
- `shared/scan.ts`, `shared/ipc.ts` — the project scan shape and the typed
  IPC contract (`IpcContract`, per-channel request/response pairs, the
  `AvbBridge` surface).
- `shared/limits.ts` — every runtime bound (parser depth/size, component
  nesting, save drain, rescan chain) in one importable module, enforced at
  boundaries.
- `shared/assert.ts`, `shared/result.ts`, `shared/brand.ts`,
  `shared/record.ts` — the invariant/Result/branding/unknown-narrowing
  primitives.

The renderer consumes contracts through `src/bridge.ts`, a typed, validating
wrapper over `window.avb` — the renderer never calls raw `ipcRenderer`.

## Tests

124 suites under `test/`, run by `scripts/run-tests.ts` (`npm test`):

- **Round-trip tests** (the majority) parse → mutate → write → re-parse and
  assert stability, under the runtime's own parsers.
- **Canvas tests** stub the iframe and run the real modules with esbuild.
- **Node test-runner suites** (`*.test.js`, `test/contracts/`) exercise pure
  and contract code directly.
- `test/unpacked-parser.js` verifies the packaged app: the parser's whole
  `require` closure must be unpacked from the asar so the Astro dev server
  can load it.

A failing renderer suite fails the run while the others finish (a hung
window cannot hold the gate hostage). The gate is:
`build:contracts → build:electron → tsc --noEmit → eslint → ratchet → all
test suites`, exiting non-zero if any non-quarantined suite fails.

## The TypeScript migration (completed 2026-09-16)

Continues on `main` after PR #26; plan in `docs/ts-migration-plan.md`.
Motivation: the app is built heavily with AI assistance, and plain JS gave
the model no contract to fulfill — bugs landed at runtime. The migration
prioritizes **safety, performance, DX** in that order, and is executed
leaf-first, convert-then-split, one module per commit, with the full gate
green at every commit.

- **Phase 0 (done)** — strict `tsconfig` (all of AGENTS.md's flags), an
  ESLint flat config enforcing the ruleset (no `any`, no unchecked
  assertions, exhaustive switches, ≤70-line functions), a **`@ts-nocheck`
  ratchet** (`scripts/ratchet-check.ts`, baseline zero after removing 44 legacy
  headers), and ~4,800 mechanical `curly` fixes. No suites remain
  quarantined: `varsrowheight` healed in `v0.1.26`, after five earlier repairs.
  The latest complete gate passed all 150 test commands.
- **Phase 1 (done)** — the `shared/` contract layer above, with contract
  tests (round-trip, negative space, invariant violations). Found and fixed a
  real bug: a lone top-level component was not treated as a layout.
- **Phase 2 (done)** — `shared/` compiles to `dist/shared` (CJS + `.d.ts`;
  the Electron runtime artifact; Vite reads the TS sources); the renderer's `src/bridge.ts` validates at the
  boundary; packaging unpacks `shared/dist` for the dev server. A first live
  end-to-end open (a real project, on a user's Windows machine) then exposed a
  wrong wire shape — the scan payload's component schema was contracted as a
  `Map` while the wire has always carried an array of fields; fixed in
  b94457c together with `renderTag`'s object shape and the dropped `hasRest`.
- **Phase 3 (done)** — all application, panel, Electron, shared, and authored
  script sources are strict TypeScript. Generated JavaScript lives under
  `dist/`, including CommonJS automation in `dist/scripts`. The style-panel
  ratchet reached zero, and the full gate passes 150/150 commands.
- **Phase 4 (done)** — `docs/contracts.md` records invariants types cannot
  express; AGENTS.md names the contract surface; CI runs the full gate.

## Architectural findings (structural review at 4fa3a5d)

A maintenance-structural review (hotspots, co-change, clones, dead code)
found the architecture fundamentally right — the round-trip design, the
batching, the zero dead code — with four gaps that account for most measured
pain, in priority order:

1. **The IPC protocol lives in three places, hand-maintained.** 113 channels
   in `main.js`, mirrored in `preload.js`'s dispatch, mirrored at every
   renderer call site; co-change data shows renderer files driving preload
   and main edits at 0.8–1.0 confidence with no static link. **Main conversion
   addressed the inventory:** all 117 invoke channels now have shared payload
   parsers and result types; main, terminal, and preload use those channel types.
   Remaining renderer conversions can adopt those payload/result types directly.
2. **One mutable tree wears two hats.** The live editor model is mutated in
   place (`loopBindings` even rewrites node `kind`s), while the boundary
   contract is `readonly`; saves ack by `WeakSet` identity as a workaround
   for "which version of the file is this?". **Superseded by
   `docs/stacki-editor-core-plan.md`** (tracked in
   `docs/editor-core-tracker.md`): the long-term fix is the editor core —
   edit intents over expected-bytes witnesses (the file is the only state;
   identity is a span mapped through a diff at apply time), which removes the
   ack machinery entirely rather than polishing it. Until that lands,
   mutating modules convert with minimal-fidelity local mirrors.
3. **The style-panel sections are one abstraction written six times.**
   Layout/Size/Typography/Grid/Gap/Background/Embed co-change at ~1.0 with no
   static link — parallel hand-rolled field rows over `css.ts` (the clone
   data agrees: 94 clone groups, ~3.7k duplicate LOC). Fix: after converting
   two or three sections, extract the shared field-row pattern; new sections
   become data, not components.
4. **File size is the DX constraint.** `ClipPath.tsx` (ccx 3,173, 8.8k lines,
   churn 3) barely changes — splitting it by tool is low-risk. The four
   hotspots (`App` ccx 1,026, `parsePropSchema` 334, `PropField` 288,
   `ClipPath` 776) split **after** conversion, never in the same commit.

Explicit non-changes: no state library (the WeakSet issue is
identity-vs-version, not missing stores), no `.astro` AST dependency (loses
the text fidelity the slots exist to keep), no churning of the
batching/queueing write path (already the right shape).

## Directory map

| Path                | What lives there                                                                  |
| ------------------- | --------------------------------------------------------------------------------- |
| `electron/`         | Main process: IPC registry, parsers, git, watcher, terminal, packaging helpers    |
| `electron/content/` | Astro content-collection introspection + stubs injected into the dev server       |
| `electron/formats/` | Leaf parsers for data files (JSON/YAML/TOML/CSV/NDJSON/frontmatter)               |
| `src/`              | Renderer: `App.tsx` shell, tree/persistence/binding logic, `bridge.ts`            |
| `src/panels/`       | Side panels (Structure, Props, Style, Pages, Assets, CMS, History, Git, terminal) |
| `src/style-panel/`  | CSS editing surface (TypeScript); `clip-path/`, `lib/`, shared controls           |
| `src/ui/`           | Shared renderer widgets                                                           |
| `shared/`           | Contract layer: types, parsers, limits, IPC contract → compiled to `shared/dist`  |
| `scripts/`          | Dev/CI tooling (test runner, ratchet, packaging hooks)                            |
| `test/`             | 124 suites: round-trip, canvas-stub, contract, packaging                          |
| `docs/`             | This file, the migration plan                                                     |

## Standing rules

- AGENTS.md is the normative engineering standard (strict TS, parse-don't-
  validate, discriminated unions, branded primitives, bounded everything,
  ≤70-line functions). The ratchet and lint gate enforce it mechanically.
- Behavior preservation is proven per conversion by parity checks against the
  pre-conversion artifact plus the full suite — conversion review has already
  caught four real hazards (codepoint corruption, a prototype-pollution
  regression, a kind-narrowing behavior change, a dropped promise await).
- Dependencies stay at zero additions unless a change carries a written
  justification; the platform and the contract layer come first.
