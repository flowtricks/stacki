# TypeScript migration and contract plan

Status: completed 2026-09-16. Follow-up hotspot splitting remains architectural work.

## Why

The bug classes that hurt us live at boundaries: file contents parsed into page
trees, IPC payloads crossing to the renderer, prop schemas inferred from user
source. None of these are validated today — they are cast and trusted. AGENTS.md
§2, §5, and §9 already name the fix: parse at the boundary, model state as
discriminated unions, assert invariants, and let the compiler enforce what it
can. TypeScript is how the compiler gets enlisted.

The same contracts serve a second client: AI assistants. An AI editing this
repo (or reading a `⇧⌘C` selection dump) must make `tsc --noEmit` and ESLint
pass. Every type we add is a constraint the AI cannot violate silently, and
every parser is a runtime check its generated data must survive. The contract
is the API surface; the gate is the build.

## Design forces (priority order)

1. **Correctness/honesty** — invalid states unrepresentable; invariants asserted.
2. **Performance** — no runtime validation in hot render paths; validation at
   the boundary where data enters, types only after that.
3. **Developer experience** — migration must keep the app runnable at every
   commit; one tool per job; no framework assumptions.

## The contract layer: `shared/`

A new top-level `shared/` directory holds the domain model. It is the single
source of truth for both processes. Renderer imports it as TS via Vite.
Electron (CJS) consumes the compiled output; `tsc` emits it as part of the
build (no new dependency — the TypeScript compiler is the toolchain, Vite
already carries it).

Modules, each exporting types + a hand-rolled parser (AGENTS.md §2) + bounds:

| Module           | Contents                                                                           |
| ---------------- | ---------------------------------------------------------------------------------- |
| `brand.ts`       | `Brand`, `FilePath`, `ProjectPath`, `NodeId` — lookalike primitives made distinct  |
| `limits.ts`      | `LIMITS`: max file bytes, max tree nodes, max attrs, max IPC payload, schema depth |
| `result.ts`      | `Result<T, E>`, `ok`, `err`, `AppError` — the expected-failure channel             |
| `page-node.ts`   | `PageNode` discriminated union + `parsePageNode` + tree invariants                 |
| `prop-schema.ts` | `PropSchema`, `PropField`, `PropShape` + `parsePropSchema`                         |
| `scan.ts`        | `ScanResult`, `ScanEntry`, page/layout/component kinds                             |
| `page-state.ts`  | `PageState`, dirty/saved state machine                                             |
| `content.ts`     | CMS collection/entry/field models (from `electron/content*`)                       |
| `ipc.ts`         | the channel map: method name → payload type → result type; `AvbBridge`             |

### PageNode — the flagship model

Derived from `electron/astroParser.js` (kinds: component, element, text,
comment, raw, branch) and consumed by `src/editorTree.js`:

```ts
type Attr = {
  readonly type: "string" | "expr" | "bare" | "spread";
  readonly value: string;
};

type PairedBase = {
  readonly id: NodeId;
  readonly name: string;
  readonly attrs: readonly Attr[];
};

// Children exist ONLY on kinds that can have them; null = self-closing.
type PageNode =
  | (PairedBase & {
      readonly kind: "component" | "element";
      readonly children: readonly PageNode[] | null;
    })
  | (PairedBase & {
      readonly kind: "branch";
      readonly children: readonly PageNode[];
    })
  | { readonly kind: "text"; readonly id: NodeId; readonly value: string }
  | { readonly kind: "comment"; readonly id: NodeId; readonly value: string }
  | { readonly kind: "raw"; readonly id: NodeId; readonly value: string };
```

Invariants the type encodes (previously conventions enforced nowhere):

1. `text`/`comment`/`raw` are leaves — no `children` key at all.
2. `children: null` only on `component`/`element` (self-closing).
3. `branch` always has children.
4. Ids are unique per tree and match `n\d+` — asserted by `assertTreeInvariants`,
   called by the parser postcondition and by tests.

`parsePageNode(input: unknown): PageNode` throws on violation, enforces
`LIMITS.treeNodesMax`, and is the only producer of trusted trees. The disk and
the IPC boundary are hostile; everything inward receives `PageNode` and needs
no further checks.

### The IPC contract

`preload.js` exposes ~80 methods on `window.avb`; `electron/main.js` registers
~130 `ipcMain.handle` channels. Today nothing connects the two sides. `ipc.ts`
connects them:

```ts
export interface IpcContract {
  readonly "project:scan": {
    payload: { projectPath: ProjectPath };
    result: ScanResult;
  };
  readonly "src:readText": {
    payload: { path: FilePath };
    result: Result<string, AppError>;
  };
  // …one entry per channel, both processes
}

export type AvbBridge = {
  readonly [K in keyof IpcContract]: (
    payload: IpcContract[K]["payload"],
  ) => Promise<IpcContract[K]["result"]>;
};
```

The preload bridge is typed `AvbBridge`; `ipcMain.handle` wrappers take the
channel as a typed key. An AI that adds a handler or a caller now has to route
through the map — a new channel without a contract entry is a compile error,
and a payload that doesn't parse is a boundary failure, not a renderer crash.

## Phases

Each phase ends with the app runnable, tests green, and `tsc --noEmit` +
ESLint clean on everything converted so far. Never convert and split in the
same commit.

### Phase 0 — Tooling gate (days)

- Root `tsconfig.json` with the AGENTS.md strict flag set;
  `allowJs: true`, `checkJs: false` so the tree compiles untouched.
- ESLint flat config with the AGENTS.md rule set; Prettier at 100 columns.
- Wire both into `scripts/run-tests.ts` so the existing `npm test` gate fails
  on type or lint errors.
- `shared/tsconfig.json` emitting compiled JS where Electron can require it;
  Vite `resolve.alias` for the renderer.

Exit: gate exists, everything passes, zero source files changed.

### Phase 1 — Contracts (1–2 weeks)

- Build `shared/` per the table above. Write the parsers and bound checks
  first; the types fall out of them.
- One parse-test per contract (AGENTS.md testing rules): known-good passes,
  each known-bad shape fails, bound checks fail at `LIMITS`.
- Property test: `parse ∘ serialize` roundtrip over generated trees
  (node:test + small local generators; add fast-check only if handwritten
  generation becomes the bigger risk — §17).

Exit: contracts compile, parse, and are tested — with no consumer yet.

### Phase 2 — Boundary wiring (1–2 weeks)

- Type `window.avb` as `AvbBridge`; `invoke` payloads validated by the
  contract parsers on the renderer side (validation lives at the boundary,
  per the performance force).
- `astroParser.js` returns validated `PageNode` trees; `editorTree.js`
  imports the type and drops its defensive re-checks.
- `parsePropSchema` output validated as `PropSchema`.
- Add the unbounded-loop caps found during orientation (`App.tsx` rescan,
  `pagePersistence.js` flush) as `LIMITS` entries with assertions.

Exit: every payload crossing process or disk is parsed. This is the moment
bug incidence from bad data drops — everything after is mechanical.

### Phase 3 — Mechanical migration (weeks, parallelizable)

Order by boundary distance, hottest last:

1. Electron libs: `astroParser`, `frontmatter`, `htmlText`, `jsCollections`,
   `content*`, `cssVars`, `assetRefs`.
2. `src` leaf libs: `editorTree`, `pagePersistence`, `loopBindings`,
   `dataSuggest`, `bindings`, `arrayValue`.
3. Electron main handlers + preload (already contract-typed by Phase 2).
4. React panels and style panel, simplest first.
5. The four hotspots last and alone, one per commit: `App.tsx` (4.9k lines),
   `PropsPanel.tsx` (3.8k), `astroParser`'s `parsePropSchema` (334 cx),
   `ClipPath.tsx` (8.8k lines). Convert types first; split control flow per
   AGENTS.md §11 in follow-up commits.

Per file: rename, fix type errors, run its test gate, commit. No drive-by
refactors (AGENTS.md change rule).

Mutating modules (`loopBindings`, `dataSuggest`, the panels' in-place tree
edits) convert with **minimal fidelity** — local mutable mirrors, no deep
identity design. The mutable-tree write path is scheduled for replacement by
the editor core (`docs/stacki-editor-core-plan.md`, tracked in
`docs/editor-core-tracker.md`), which lands after this plan behind its own
corpus gate; do not build a `LiveModel` type family or version counters the
intent processor will delete. One rename is owed first: the core plan's
projection concept is `shared/page-node.ts` — unify the names before its
`shared/projection.ts` appears.

### Phase 4 — AI-assistant contract surface (ongoing)

- `AGENTS.md` gets a contracts section naming `shared/` as the API surface
  and stating the gate: generated code must pass `tsc`, ESLint, and tests.
- `docs/contracts.md` documents the invariants types cannot express (id
  scheme, self-closing null, roundtrip preservation) so an AI reading a
  `⇧⌘C` dump has the same rules the compiler enforces in-repo.
- CI (or a pre-push hook if no CI) runs the Phase 0 gate.

## Risks and mitigations

- **Undeclared tooling is fragile** (learned the hard way): typescript,
  eslint, and the @types packages spent weeks as transitive-only installs,
  until a package-manager run outside the repo's control pruned them
  mid-session. They are declared in `devDependencies` now; treat any future
  "works but isn't declared" tool the same day it enters the gate.
- **The 4 giant files** — converting + splitting at once doubles the diff.
  Phase 3 order forbids it; each hotspot is its own commit sequence.
- **Electron CJS vs renderer ESM** — `shared/` compiles to CJS for the main
  process; Vite consumes the TS directly. No dual-package hazard because
  `shared/` has no runtime deps.
- **Map over IPC** — `ipcMain.handle` results are serialized across the
  process boundary, and serialization collapses a `Map` to a plain object:
  the assumption that structured clone preserves it was written down here and
  then **disproved in the field** (the renderer contract rejected every real
  scan payload until b94457c). The scan wire shape is an array of `PropField`;
  the prop-schema `Map` builder is for in-process consumers only. When a wire
  shape and its contract disagree, a live end-to-end run is the only test that
  catches it — every suite stubs the bridge.
- **Test harness churn** — do not migrate the ~120 test scripts in this
  project; the gate only adds typecheck. Standardizing on `node:test` is a
  separate, later decision.
- **Performance** — parsing adds work at boundaries only; render paths
  already receive parsed data. The perf tests (`hover-cost`,
  `dist/scripts/performance-report.js`) run in the gate to catch regressions.

## Definition of done

- [x] Zero `.js`/`.jsx` in `src/`, `electron/`, `shared/`.
- [x] Every boundary input parsed; `LIMITS` enforced and tested.
- [x] `tsc --noEmit` + ESLint + tests in `npm test`, with no unchecked source.
- [x] `docs/contracts.md` exists and matches `shared/`.
- [x] Keep already-TypeScript hotspot splitting under its separate architecture
      follow-up; conversion and current tests are complete.
