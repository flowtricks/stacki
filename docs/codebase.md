# Stacki — Codebase Architecture

**Status: living document.** Migration status updated after the Astro parser
conversion on `main`, following PR #26 and `v0.1.26`. Sections marked
"migration" describe in-flight work; see `docs/archive/migration-tracker.md` for verification.

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
  preview; "Start from Lumos" and "Start from Astro" create a new site.

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

- `electron/parse/astroParser.ts` (emits `astroParser.js`) parses an `.astro` file into a
  `PageNode` tree. Nodes carry their **source ranges** (`.at` offsets), and
  anything not modeled (attributes in unusual order, raw `<script>`, unknown
  constructs) is kept verbatim and re-emitted on write. It is the parser's
  facade: the scanner, the template parser, the printers, the prop-schema
  reader and the chunk handling live beside it as `electron/parse/astro*.ts`.
- Frontmatter (`shared/page/frontmatterSource.ts`) is _not_ treated as a code blob:
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
│  src/app/App.tsx + features│   │ project, its deps)    │
│  Edits the PageNode model  │   │ Serves the live page  │
└──────────────┬─────────────┘   └─────────▲─────────────┘
               │ iframe embed + injected   │ HMR on save
               │ selection/hover script    │
               ▼                           │
        Canvas (preview iframe) ───────────┘
```

- **Main** (`electron/`, Node.js, CommonJS): owns everything that touches the
  OS. `main.ts` (emits `main.js`) owns the window, the menu and the app's
  lifecycle, and hands the invoke channels to the handler modules in
  `handlers/`; the area folders do the work — the parsers in `parse/`, the
  write path in `documents/`, content collections in `content/`, component
  properties in `properties/`, project services in `project/`, and git, the
  dev-server preview and the terminal (node-pty) in their own folders. See
  the directory map below.
- **Preload** (`electron/preload/`): in the app's window, a sandboxed bridge
  exposing an allowlisted `window.avb` API via `contextBridge`
  (`preloadBridge.ts`); in preview frames, the canvas script (`frame*.ts`).
  The sandbox's `require` reaches only `electron`, so its modules ship as one
  CommonJS bundle (`scripts/build/bundleClients.ts`; Electron ≥ 33 sandbox
  requirement).
- **Renderer** (`src/`, React 19 + Vite, ESM): layered folders under one
  entry, `src/main.tsx`. `src/app/App.tsx` is the application shell and owns
  the page model; each side view (structure, props, style, pages, assets,
  CMS, history, git, terminal…) is a folder in `src/features/`; the editing
  core every feature builds on is `src/editor/`; `src/ui/` holds the widgets
  more than one feature draws. See the directory map below.
- **Astro dev server**: the _user's project's own_ dev server. Stacki renders
  the canvas by embedding it, so the preview is always exactly what Astro
  produces — no re-implementation of Astro semantics. A small injected client
  script maps DOM ↔ source nodes for hover/selection (the preload's frame
  half), and the morph client (`electron/previewClient/`, bundled into one
  module served as `virtual:avb-morph`) morphs the DOM on edits.

## The rendering pipeline

The path from source to canvas, per the refactor notes (`docs/archive/refactor-notes.md`):

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

Since editor-core step 9 (`docs/editor-core-tracker.md`), an existing file
changes only by splices, and the file on disk is the only persisted state:

```
gesture → edit requests (page:edit) → main: intent → document actor
        → splices witnessed by the bytes they replace → atomic write
        → reply: the page as written + its inverse (Undo)
```

- `src/editor/editGestures.ts` states each gesture as edit requests against the
  page's origin (the bytes of the last reply) and predicts its effect on the
  shown model; the model is readonly (`src/editor/pageView.ts`), so the prediction
  is a new model. `electron/documents/editRequests.ts` turns a request into an intent
  against main's own snapshot of those bytes; the planner
  (`shared/engine/planner.ts`) and the page's actor (`electron/documents/documentActors.ts`)
  do the rest.
- `src/editor/pageEdits.ts` holds the open page's queue — gestures on any page
  (`.astro`, `.md`, `.mdx`), or typed code (a byte diff,
  `shared/engine/codePatch.ts`) — and `src/editor/pagePersistence.ts` sends it one entry
  at a time; a flush
  sends only the entries present when it starts, so there is no drain loop.
  `src/editor/pageSender.ts` installs each reply: node handles are carried from the
  origin through the write's own splices (`src/editor/nodeHandles.ts`), so selection
  survives every edit. A refused save turns the page conflicted; reviewing it
  in code shows the queued gestures planned as splices and never written
  (`page:previewEdit`).
- Undo is the inverse splices a write returned, submitted as a `revert`.
- The file watcher tells the app's own saves from outside edits by bytes:
  a tick is the app's echo only while the file holds exactly what its
  document actor last wrote (`DocumentActors.echoes`, plan §11.9).
- `electron/project/projectWatcher.ts` detects genuine outside edits (AI assistants,
  editors, git operations) and triggers a rescan; each rescan, panel read and
  panel write is one run of `src/lib/coalescedRun.ts` (one in flight, one
  waiting), so a burst costs at most two.
- Printing a whole file is fenced by lint to new files (`componentFile.ts`)
  and the parsers' own round-trip oracles (`eslint.config.mjs`); no write
  replaces a file whole — a program's write is the diff it makes
  (`rewrite-text`, step 10).

## Data model

The contract layer (`shared/`, introduced by the migration — see below) is
now the authoritative description:

- `shared/page/pageNode.ts` — the `PageNode` discriminated union (10 kinds:
  component, element, raw, text, expr, raw-line, comment, map, cond, branch,
  chunk-group), `PropValue` (`string | number | boolean | expr | raw`), the
  `PageModel` envelope (nodes, imports, layout chain, frontmatter slots), and
  hand-rolled parsers. Invariants the types can't express are asserted:
  unique ids, paired nodes own `children`, `children: null` means
  self-closing. Branch and map nodes always carry their children arrays
  (possibly empty). Nothing edits a tree in place (editor-core step 9).
- `shared/properties/propSchema.ts` — the prop-field model the props panel generates
  from, including `readonly` as a value shape (a `const`-initialized string
  is an exact value, not a default).
- `shared/properties/projectScan.ts`, `shared/ipc/ipcContract.ts` — the project scan shape and the typed
  IPC contract (`IpcContract`, per-channel request/response pairs, the
  `AvbBridge` surface).
- `shared/core/limits.ts` — every runtime bound (parser depth/size, component
  nesting, pending intents, retained snapshots) in one importable module,
  enforced at boundaries.
- `shared/page/htmlText.ts` — a text node's value: entity decoding and encoding
  and the whitespace rule (`textValue`). The parser reads text with it, and
  the Content field emits `textValueCanonical` values so the save echo comes
  back identical to what it emitted (a differing echo resets its caret).
- `shared/core/assert.ts`, `shared/core/result.ts`, `shared/core/brand.ts`,
  `shared/core/record.ts` — the invariant/Result/branding/unknown-narrowing
  primitives.

The renderer consumes contracts through `src/ipc/bridge.ts`, a typed, validating
wrapper over `window.avb` — the renderer never calls raw `ipcRenderer`.

## Tests

Suites under `test/`, found by name and run by `scripts/gate/runTests.ts`
(`npm test`; suites run in a bounded parallel pool, `--jobs=<n>` to change
it — see `docs/contracts.md`, Required gate). They mirror the source:
`test/renderer/<layer or feature>/`, `test/electron/<area>/`,
`test/shared/<area>/` and `test/scripts/<area>/` hold the suites for that
folder, with the simulator in `test/simulator/` and the harnesses in
`test/helpers/`.

- **Round-trip tests** parse → mutate → write → re-parse and assert
  stability, under the runtime's own parsers.
- **Canvas tests** stub the iframe and run the real modules with esbuild.
- **Contract suites** (`test/shared/`, much of `test/electron/`) exercise pure
  and contract code directly.
- `test/scripts/release/unpackedParser.test.js` verifies the packaged app: the
  parser's whole `require` closure must be unpacked from the asar so the Astro
  dev server can load it.

A failing renderer suite fails the run while the others finish (a hung
window cannot hold the gate hostage). The gate is: the builds, then side by
side `tsc --noEmit` (app and scripts), ESLint with `--max-warnings 0`,
Prettier, the policy scan, and the adapter-surface ratchet, then every test
suite; it exits non-zero if any non-quarantined suite fails.
`docs/enforcement.md` maps each AGENTS.md rule to the check that holds it.

## The TypeScript migration (completed 2026-09-16)

Continues on `main` after PR #26; plan in `docs/archive/ts-migration-plan.md`.
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
  the Electron runtime artifact; Vite reads the TS sources); the renderer's `src/ipc/bridge.ts` validates at the
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
   contract is `readonly`; saves ack by `WeakMap` identity as a workaround
   for "which version of the file is this?". **Resolved by the editor core**
   (`docs/stacki-editor-core-plan.md`, step 9 in
   `docs/editor-core-tracker.md`): edit intents over expected-bytes witnesses,
   the file the only state, identity a span mapped through a diff. The tree is
   readonly and the ack machinery is deleted.
3. **The style-panel sections are one abstraction written six times.**
   Layout/Size/Typography/Grid/Gap/Background/Embed co-change at ~1.0 with no
   static link — parallel hand-rolled field rows over `css.ts` (the clone
   data agrees: 94 clone groups, ~3.7k duplicate LOC). Fix: after converting
   two or three sections, extract the shared field-row pattern; new sections
   become data, not components.
4. **File size is the DX constraint.** *Resolved 2026-09-30:* every function
   is within 70 lines, enforced as an error. The hotspots were split by
   responsibility during the lint paydown — `App` from a 4,319-line function
   into staged hooks and shell components, `EmbedEditor`'s 2,253-line
   component into hooks, `ClipPath`'s path readers into classes that own their
   state — each proven with the full suite, and `ClipPath` (which has no suite)
   with HEAD-versus-working-copy interaction harnesses and differential
   fuzzing. *Closed 2026-10-02:* the files followed. Every source file in
   `src/`, `electron/`, `shared/` and `scripts/` is within 800 lines,
   enforced by `max-lines`. `ClipPath` became a folder of pure modules
   (pinned first by a recorded characterization suite), `EmbedEditor` and
   `App` became folders of composers and views, `main.ts` hands its IPC to
   `electron/handlers/`, and `astroParser.ts` is a facade over layered
   `electron/parse/astro*.ts` modules. The sandboxed preload and the morph
   client, which the runtime loads as one file each, are modules bundled
   back into that file by esbuild (`scripts/build/bundleClients.ts`).

Explicit non-changes: no state library (the WeakMap ack issue is
identity-vs-version, not missing stores), no `.astro` AST dependency (loses
the text fidelity the slots exist to keep), no churning of the
batching/queueing write path (already the right shape).

## Directory map

| Path | What lives there |
| --- | --- |
| `electron/main.ts` | The main process's entry: the window, the menu, the lifecycle, settings and recents |
| `electron/handlers/` | The IPC handler modules main.ts registers, the dev server and thumbnails they drive |
| `electron/lib/` | Bounds, platform facts, the serial queue, the IPC registrar, runtime paths, Node tools |
| `electron/parse/` | The Astro and Markdown parsers (unpacked: the dev server loads them) |
| `electron/documents/` | The write path: document actors, edit requests, atomic writes |
| `electron/content/` | Content collections and CMS references; `formats/` parsers, `workers/` |
| `electron/properties/` | Component properties: definitions, consumers, renames; which selectors nothing uses |
| `electron/project/` | Scaffolding, the watcher, thumbnails, assets, CSS variables |
| `electron/git/`, `preview/`, `terminal/` | Git; the dev server and preview worktree; the terminal |
| `electron/previewServer/` | Modules the project's own dev server runs (unpacked) |
| `electron/previewClient/`, `preload/` | The canvas's morph client; the preload (bridge and frame script), each bundled to one file |
| `electron/app/` | main.ts's payload validation, window bounds and auto update |
| `src/main.tsx` | The renderer's entry: mounts `src/app/App.tsx` |
| `src/lib/` | Generic utilities that know nothing of pages or features |
| `src/ipc/` | The typed bridges to main that more than one feature uses |
| `src/editor/` | The page-editing core: model and view, edits, persistence, tree, canvas queries |
| `src/ui/` | Widgets more than one feature draws |
| `src/features/<feature>/` | One folder per feature: its panel, components, models, bridge and CSS |
| `src/app/` | The application shell: `App.tsx`, global styles, the rail, shell types |
| `shared/core/` | The primitives: assert, Result, brands, record and boundary parsers, limits, spans |
| `shared/page/` | The page model: page nodes, frontmatter, projection, snapshots, capability |
| `shared/engine/` | The edit engine: intents, the planner, splices, rebase, diffs, patches |
| `shared/properties/` | Component-property and prop-schema contracts, the project scan |
| `shared/ipc/` | The IPC contract: channels, payload parsers, results, the preload API |
| `scripts/build/`, `install/`, `release/` | Build, install-time repairs, packaging and release |
| `scripts/gate/`, `reports/` | The test runner and its pool, the adapter check; reports and fixtures |
| `scripts/policy/`, `agent/`, `eslintPlugin/` | The gates: policy scan and git hooks, agent hooks, lint rules |
| `scripts/lib/`, `move/` | Script helpers; the move tool (`move/moveSources.mts`), which moves files and rewrites every reference to them |
| `test/` | Suites (round-trip, canvas-stub, contract, packaging); harnesses in `test/helpers/` |
| `docs/` | This file, the contracts, the enforcement map, the editor-core plan; `archive/` for finished plans |

The contract layer's folders are areas too (`SHARED_AREAS`): `core` is the
floor, the page model and the property contracts sit on it, the engine on
the page model, and the IPC contract may name any of them; `shared/`
imports nothing outside itself.

The main process's folders are areas, each importing only the areas listed
for it in `eslint.config.mjs` (`ELECTRON_AREAS`): `lib` is the floor, the
parsers sit on it, the write path on the parsers, and content, project,
git and properties on the write path. The handler modules reach what
main.ts reaches, so a channel moves out of main.ts unchanged; they take
electron's values from main.ts (`handlers/mainHost.ts`) rather than importing
them. The preview server imports only the parser, and the preview client and
the preload nothing of main's.

The renderer's folders are layers, lowest first: `lib` → `ipc` → `editor` →
`ui` → `features` → `app`. A module imports only the layers below its own,
and a feature imports another feature only along the edges listed in
`eslint.config.mjs` (`SOURCE_LAYERS`): the variables panel edits values with
the style panel's editors, component properties use the props panel's
fields, and history draws with git's widgets. The lint rule
`stacki/source-layers` holds the order; the policy scan holds the names —
camelCase folders and modules, PascalCase components, every name unique
under each of `src/`, `electron/`, `shared/` and `scripts/`.

## Standing rules

- AGENTS.md is the normative engineering standard (strict TS, parse-don't-
  validate, discriminated unions, branded primitives, bounded everything).
  The checks in docs/enforcement.md hold it mechanically
  — the same code for people and for every coding agent — and CI is the gate
  no one can skip.
- Behavior preservation is proven per conversion by parity checks against the
  pre-conversion artifact plus the full suite — conversion review has already
  caught four real hazards (codepoint corruption, a prototype-pollution
  regression, a kind-narrowing behavior change, a dropped promise await).
- Dependencies stay at zero additions unless a change carries a written
  justification; the platform and the contract layer come first.
