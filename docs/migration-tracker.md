# Migration Tracker — TypeScript conversion of Stacki

Living status document for the migration, now on `main` after PR #26.
Each task here replaces a bullet in `docs/ts-migration-plan.md` once its
definition of done is met. Run the gate (`npm test`) after every conversion,
then update the counts below.

## Handoff state (read this first)

The TypeScript source migration is complete. `src/`, `electron/`, `shared/`,
and `scripts/` contain no authored `.js` or `.jsx` files; the four remaining
Electron `.mjs` files are runtime worker assets. `allowJs` and `checkJs` are
gone from the root compiler configuration, all 44 legacy style-panel
`@ts-nocheck` headers are removed, and the ratchet baseline is zero.
The invoke inventory remains complete: **113 main channels + 4 terminal
channels**, with parsed inputs and compile-checked handler results.

`src/App.tsx` is now checked under the strict root configuration. Its IPC calls
route through `appBridge.ts`, the mutable editor clone is confined to
`shared/editor-model.ts`, and both Astro and Markdown page models retain their
source-preservation metadata through the shared boundary. The final gate passes
150/150 commands in 108.6 seconds. Follow-up hotspot splitting remains listed
separately because it changes architecture rather than source language.

Build-output checkpoint: all generated code now lives under the root `dist/`:
`dist/electron` for main/preload/preview modules, `dist/shared` for contracts,
and `dist/renderer` for Vite. Runtime workers and icons are staged there too.
Builds start clean; package entries, unpacked-parser paths, tests, and development
scripts use the new layout. Removed per-file ignore rules and the last tracked
compiler artifact (`electron/git.js`). New layout regressions pass; contracts
now total 159 tests. The full gate passes 138/138 commands (102.8s), the real
Electron/Astro lifecycle passes, and an unsigned macOS arm64 package contains the
complete runtime with a working unpacked parser.

Main verification: 26 old/new handler and output comparisons matched, including
byte-identical generated Astro config, preview page, and both API endpoints.
The contract suite passes 152 tests. The full gate passes all 125 test commands;
repository lint retains 177 existing warnings and no errors. New main helpers,
IPC contracts, and tests have no lint warnings and meet the 70-line function limit.
The live lifecycle integration also passes against Electron 33.4.11 and Astro
5.13.10: content schemas, concurrent starts, stop/restart, startup cancellation,
process cleanup, and the built renderer/preload boot.

Main conversion details:

- One shared payload inventory drives main and terminal registration. Preload
  channel/payload types erase at build time, keeping sandboxed preload free of
  additional runtime imports. Renderer result parsers remain at their boundary.
- Disk settings, recents, package/config fields, Astro locks, content manifests,
  and dev-server responses are parsed. Markdown save metadata is checked without
  dropping source-preservation fields or trailing blank lines.
- Directory depth/count, file reads, port searches, name collisions, pending style
  writes, previews, logs, clipboard bytes, and IPC collections have explicit bounds.
- CMS scanning, menu construction, Git identity, preview startup, and image header
  reading use responsibility-sized helpers. Generated preview output is unchanged.
- Native source-text test checks tolerate emitted import quotes and whitespace.
  No runtime dependencies were added. Root `allowImportingTsExtensions` lets native
  Node TypeScript tests share a checked VM harness under the existing no-emit build.

Run the gate as `env -u ELECTRON_RUN_AS_NODE npm test` if the surrounding shell
sets that variable: browser probes need Electron's app API, not Node mode.

Field lessons a real project surfaced (a user's Windows machine, 2026-09-15):
the renderer contract had never run against a real scan payload (every suite
stubs `window.avb`), and the first live run exposed a wrong wire shape —
fixed in b94457c, see Phase 2. The repo runs end-to-end against a real Astro
site after that fix. The packaged `Stacki.exe` on that machine is a stale
snapshot (old contract baked into its `dist/`); test from the repo with
`npm run dev` / `npm start`, which rebuild `dist/shared` first.

Legend: ✅ done · ⏳ in progress · ⬜ pending — no item is "done" until its
parity check and `npm test` pass on the commit that lands it.

---

## Phase 0 — Tooling gate ✅

Strict tsconfig, `@ts-nocheck` ratchet (`BASELINE=0`, reduced from 44), ESLint flat config,
~4,800 `curly` fixes. `QUARANTINED` is empty: varsrowheight was removed by
`v0.1.26`, after the earlier binding, chipedit, codeeditorlifecycle, codeprop,
and jsguard repairs.

Gate: builds + `tsc --noEmit` + ESLint + ratchet + 125/125 test commands, exit 0.

## Phase 1 — Contract layer (`shared/`) ✅

`brand`, `limits`, `assert`, `result`, `page-node`, `prop-schema`, `scan`,
`ipc`, `record` (+ `toArray`). 152 contract tests, including a roundtrip
property test and parser/import-slot boundary tests. Also fixed a lone-top-level-component layout bug found by the
contracts.

## Phase 2 — Boundary wiring ✅

`dist/shared` CJS + d.ts emit; `src/bridge.ts` (typed, validating renderer
bridge); rescan/save drain caps; `assertTreeInvariants`; packaging asarUnpack;
`electron/astroParser.d.ts` and `electron/contentEntries.d.ts` seed contracts;
`electron/git.ts` extraction (with gitBranches).

**Field fix (b94457c):** the first end-to-end open of a real project threw
`ScanResult…: expected Map` — `parseScanResult` routed each component's
schema into the prop-schema Map builder, but the wire (main.js `safeSchema`
→ App.tsx `schemaFor`) has always carried an **array of fields**; Maps are
collapsed to plain objects by IPC serialization, so the Map shape could never
survive `ipcRenderer.invoke`. Also corrected while there: `renderTag` is
`rootTag`'s `{tag, prop} | null` object, not `string | null`, and the
payload's `hasRest` (which `schemaFor` reads) is parsed instead of dropped.
Lesson: the bridge is stubbed in every suite, so renderer-contract ↔ real-
payload agreement is exercised only by live runs — keep one in the loop when
touching `shared/` wire shapes.

## Phase 3 — Mechanical conversion (leaf → hotspot) ✅

### electron/ — 38 source modules converted ✅

| Module                                                                                                                      | State                |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `htmlText`, `serialQueue`, `selfWrites`, `windowBounds`                                                                     | ✅                   |
| `assetRefs` (+ `shared/record.ts`)                                                                                          | ✅                   |
| `frontmatter`                                                                                                               | ✅                   |
| `jsCollections`                                                                                                             | ✅                   |
| `devProbe`, `injectedRoutes`, `projectWatcher`                                                                              | ✅                   |
| `componentFile`, `gitSnapshot`, `starter`, `cmsRefs`                                                                        | ✅                   |
| `componentUsage`, `previewWorktree`, `scaffold` (byte-identical output)                                                     | ✅                   |
| `contentRefs` (fixed real bug: mentions() walks array schemas)                                                              | ✅                   |
| `formats/{transplant,ndjson,csv,yaml}`                                                                                      | ✅                   |
| `formats/frontmatter`                                                                                                       | ✅                   |
| `formats/json`, `formats/toml`                                                                                              | ✅ formats/ complete |
| `thumbs`                                                                                                                    | ✅                   |
| `gitBranches` (+ `git.ts`), `gitHistory`                                                                                    | ✅                   |
| `contentEntries` (retired its seed d.ts)                                                                                    | ✅                   |
| `conflicts` (CommonRun/DiffRun union; retired seed d.ts)                                                                    | ✅                   |
| `contentConfig` (Service interface, child-process typing)                                                                   | ✅                   |
| `terminal` (first ipcMain registrar; node-pty seed contract)                                                                | ✅                   |
| `morphClient` (browser ESM, own tsconfig + DOM lib; fixed console.warn reload bug)                                          | ✅                   |
| `markdownParser` (byte-exact round trips incl. CRLF; seed gains parseTemplate)                                              | ✅                   |
| `cssVars` (postcss 8 types; array-collect rule lookups)                                                                     | ✅                   |
| `preload` (own tsconfig, DOM lib; predicate-narrowed CSSOM; parsed message payloads; Canvas logic + full window.avb bridge) | ✅                   |

`astroParser` is also converted: checked tree/schema types, serializer validation,
shared import slots, and bounded parsing; its seed declaration is retired.

`main` is converted with `main.types`, `main.validation`, `main.bounds`, and the
shared typed IPC registrar. The count is 38 converted source modules (including
formats); seven supporting TypeScript modules bring the checked total to 45.
No scheduled Electron `.js` conversion remains. The authored content-worker
`.mjs` files stay outside this conversion queue.

Cleanup complete: removed the six tracked `electron/scratch2-7.js` outputs
from cssVars conversion experiments (198 lines) in a standalone commit.
Repository reference search confirmed no module or test imports them.

### src/ — 38 modules converted ✅

`editorTree`, `pagePersistence` (WeakSet acks + drain caps),
`cleanError`, `branchName`, `loopBindings` (minimal-fidelity LiveNode),
`bindings` (parts protocol kept exact), `arrayValue`, `dataSuggest`
(1,117 lines; dataTree split; dead `resolvePath` deleted; fixed dropped
closing quote in samplePreview).

First renderer continuation batch: `assetPath`, `assetPick`, `attrOrder`,
`branches`, `canvasClick`, `componentName`, `dragState`, `jsCheck`, `pageOrder`,
`slotAttr`. All 132 old/new comparisons passed; the full gate passed 125/125
commands (94.8s), with no lint warnings in these modules. Request cancellation
and existing null results stay compatible; attribute renames preserve value identity.

Second renderer batch: `classNames`, `classAttr`, `astroAssets`,
`elementSchemas`, `outlineBoxes`, `spacingBands`, `terminalPaste`, `insertRank`.
All 164 old/new comparisons passed. The expanded gate passes 126/126 commands
(97.3s); the new renderer-leaves suite pins cancellation, listener replacement,
metadata identity, and boundary limits. Converted files have no lint warnings.

Third renderer batch: `treeSelection`, `liveClasses`, `extractProps`,
`instanceProps`, `insertTarget`, `fluid`, plus the shared `treeView` projection
and traversal budget. All 70 old/new comparisons passed. The gate passes
126/126 commands (94.6s), with no warnings in converted files. Regression tests
cover cyclic/deep/wide trees and arithmetic nesting limits; Node-only fluid tests
now bundle renderer TypeScript using the same compiler as the app.

Fourth renderer batch: `frontmatterMove`, `canvasQuery`, `previewRecovery`,
plus the bounded `canvasReply` parser. Eleven old/new frontmatter comparisons,
43 frontmatter checks, 30 preview recovery checks, and new iframe-message boundary
and lifecycle tests pass. The full gate passes 127/127 commands (94.7s), with no
lint warnings in converted modules. Pending iframe queries are capped at 1,024;
frame replacement cancels them, and malformed replies retain the timeout fallback.

Fifth renderer batch: `contentSchema` and `cmsSchema`, plus typed field
contracts and a bounded content-schema parser. All 317 old/new comparisons pass;
the full gate passes 128/128 commands (92.6s). New tests pin invalid schema shapes,
size/depth bounds, nullable/default/union distinctions, and CMS wrapper and
expression preservation. The external-project content-fields test still skips
when its optional fixture is absent; the new fixture-independent suite always runs.

Final root leaf: `gitActions`, with a parsed Git bridge and the `ConfirmDialog`
UI dependency. The gate passes 129/129 commands (93.7s). Scripted action tests pin
confirmation order, cancellation, trunk protection, parking/restoration and
conflict handoff. All scheduled root `.js` leaves are now converted.
`sound` and `useListReorder` remain under `src/ui`, not the root directory.

### src/ui — 38 original modules converted ✅

`Icons` 969, `RichContent` 606, `WelcomeBackground` 433, `ClassInput` 344,
`ExprInput` 336, `DataPicker` 308, `Dropdown` 303, `FileBrowser` 277,
`AssetField` 248, `CustomValueEditor` 243, `BindInput` 226, `StyleEditor`
200, plus smaller controls and hooks. `ConfirmDialog` is converted; the actual
inventory also includes `sound`, `soundScope`, and the four interaction hooks.

UI leaf batch: `Icons`, `StackiLogo`, `VariableTypeIcon`, `FileStatus`,
`SegSwitch`, `AutoTextarea`, `BranchActions`, `soundScope`, `usePopupOpen`,
`useDismiss`, `chipKeys`. All 196 old/new markup comparisons pass, with vector
paths byte-identical. The full gate passes 129/129 commands (94.0s). The binding
suite caught a DOM-realm assumption; chip guards now use the node's own document,
and all 110 binding checks pass. Popup blur timers are bounded and cancelled on cleanup.

UI interaction batch: `Dropdown`, `DynamicPicker`, `LeftRail`, `PropTip`,
`sound`, `useListReorder`, and `usePointerDrag`. All 130 gate commands pass
(96.7s), including dropdown, binding, sound, and drag behavior checks. A focused
regression test pins drag-listener installation with a stable move callback;
pointer sessions flush final coordinates and clean up on cancellation/unmount.
Audio voices are capped at 32, with capacity released when each voice ends.
Converted modules have no lint warnings and meet the function/column limits.

UI editor/menu batch: `Code`, `CodeEditor`, `CodeWindow`, `MoreMenu`,
`FluidBadge`, and `PageSwitcher`. All 25 old/new markup/language comparisons
pass; the full gate passes 130/130 commands (93.6s). The code-search suite now
reads the renamed source. Editor instances preserve history across callback
updates; floating-window pointer sessions release listeners on unmount.

UI value/file batch: `StyleEditor`, `CustomValueEditor`, and `FileBrowser`.
All 96 old/new value, ranking, and tree comparisons pass; the full gate passes
130/130 commands (96.7s). File trees use bounded iterative construction and
traversal; tests reject oversized paths, collections, depth, and invalid search
limits. Custom editors retain blur-before-save and portaled-picker focus behavior.

UI asset/link batch: `AssetThumb`, `AssetField`, and `LinkField`. All 38
old/new markup and path comparisons pass; the full gate passes 131/131 commands
(95.0s). Asset entries have tested boundary parsers; disk failures return values
while malformed responses remain loud contract errors. Refresh bursts coalesce,
font previews and fallback attempts are capped, and stale project reads are ignored.
A type-only shared preload surface now checks every exposed method against the
invoke payload inventory; renderer responses remain unknown until parsed.

UI picker batch: `DataPicker` and `InsertSearch`. Nine old/new rendered
comparisons pass; the full gate passes 132/132 commands (95.4s). Picker trees,
binding paths, and component lists have tested bounds, including cycles and deep
nesting. Existing binding, item-field, and ranking tests remain green; their
source-reading checks now follow the renamed modules.

UI input batch: `BindInput`, `ExprInput`, and `ClassInput`. Nine old/new
markup comparisons, 110 binding checks, 30 loop-source checks, and 15 chip-edit
checks pass. The full gate passes 132/132 commands (95.3s). Caret insertion,
per-chip replacement, external synchronization, completion scope, and family
preview/revert behavior retain their existing contracts. No new unchecked types
or lint warnings were introduced; only `RichContent` and `WelcomeBackground`
remain in the UI queue.

Final UI batch: `RichContent` and `WelcomeBackground`, plus the inline-content
model helper. All 22 serialization/shader comparisons pass; 40 simulated pointer
frames produce byte-identical float fields through injection, decay, and blur.
Rich-content tests cover invalid shapes, expression expansion, cycles, and depth
bounds. The full gate passes 133/133 commands (97.1s). The bridge inventory now
parses exported components with the existing TypeScript dependency, avoiding
false matches against private hooks; all 415 bridge checks pass. The entire
original UI queue is converted, with no new unchecked modules.

### src/panels — 20/20 original files converted ✅

PropsPanel dependencies: `ListField` and `ObjectField` are now typed. List editor
and drag state use discriminated unions; field updates construct readonly values.
Input and serialized output share the attribute-size bound. All 71 interaction
checks pass, alongside 11 old/new markup comparisons and two size assertions.
The gate passes 133/133 commands (96.6s); both new modules have zero lint warnings.
The live Electron 33.4.11 / Astro 5.13.10 lifecycle and built welcome-screen check
also passed after the final UI batch. Continue with PropsPanel's schema boundary
and panel conversion; the remaining 18 original panel files are still pending.

PropsPanel schema/rule checkpoint: shared schemas now parse union branches,
member shapes, expression defaults, hints, and exclusive numeric bounds instead
of dropping or trusting that metadata. A real Astro-parser-to-scan round trip
pins the wire shape; the contract suite now has 156 passing tests. `propRules.ts`
contains typed, immutable visibility/default/option/cascade decisions, with
bounded restoration state in the panel. All 6,144 old/new comparisons match.
The full gate passes 134/134 commands (98.0s). PropsPanel itself is still JSX;
continue its binding/editor extraction and fix its conditional hook order as
part of that conversion.

PropsPanel binding checkpoint: `propBindings.tsx` owns typed chip/value/source
editors and picker lifetimes, with helpers inside the 70-line limit and zero lint
warnings. The existing `BindField` export is preserved. `valueFromParts` now
advertises its actual string/expression output type. Element hooks mount in a
separate component; the panel owns restoration state across all node kinds.
A real-render regression covers 24 selection transitions and Settings retention.
All 17 old/new markup comparisons match; binding/chip/source/loop interaction
checks pass, and the full gate passes 135/135 commands (99.9s). Continue with the
attribute editors and the remaining PropsPanel body; it is not yet fully typed.

PropsPanel attribute checkpoint: `propAttributes.tsx` types element/object
attribute rows, their floating editor, and literal/paste parsers. Helpers meet
the size limit and lint without warnings. Object rows now provide both paste
callbacks (previously a single or bulk paste threw); real paste tests pin rename,
merge, append, and oversized-input behavior. Twelve old/new literal comparisons
and 17 rendered comparisons match. The gate passes 136/136 commands (102.5s).
Continue with `PropField`, asset resolution, and the remaining panel dispatcher.

PropsPanel control checkpoint: `PropField.tsx` owns the typed field dispatcher,
number bounds, reset menus, and imported-asset picker. Asset import resolution
parses bridge responses, including path bounds; transport failures remain values.
All 600 old/new control, helper, and rendered comparisons match. The gate passes
136/136 commands (101.5s), with zero lint warnings in the converted modules.
Continue with the remaining PropsPanel editors and root dispatcher.

PropsPanel node-editor checkpoint: `propNodeEditors.tsx` types loop source,
item/index renames, insertion pickers, and tag selection. The unused recursive
loop-mode calculation is removed; the single expression field needs no mode.
The loop suite now exercises the actual helpers, with parser and size-bound tests.
All 32 old/new editor comparisons match. The gate passes 136/136 commands
(102.2s); the new module has no lint warnings. Finish the root panel conversion.

PropsPanel is fully converted to `PropsPanel.tsx`. The root dispatches the shared
node union exhaustively; element state, content, and settings helpers meet the
70-line limit. Both remaining asset reads now use parsed responses, with tested
dimension and path limits. All 50 old/new root comparisons match across node
kinds and Settings states. Selection transitions, focus, and attribute controls
pass. Navigation harnesses now recognize `.tsx` panels, and the bridge inventory
reads local props interfaces (494 checks). The full gate passes 136/136 commands
(99.2s), with zero warnings in the new panel modules. Seventeen original panels
remain; continue with the variables boundary/panel before VariablesView.

Variables rail checkpoint: `VariablesPanel.tsx` uses the parsed `variablesBridge`
snapshot. Nested files, groups, blocks, columns, rows, and cells share a collection
budget, with string/source-range checks and retained color/reference metadata.
A real CSS-parser round trip and malformed-shape tests pass. Refreshes allow one
request plus one pending read; project changes and unmounts discard stale results.
Eighteen old/new display comparisons, all 14 rail interaction checks, and the
watcher/project-switch regression pass. The full gate passes 137/137 commands
(99.6s). Added PropsPanel assertion tests pin schema, layout, attribute, and child
limits. Sixteen original panels remain; continue with VariablesView.

VariablesView row/scroll checkpoint: `variableRows.ts` types row/heading drops,
renames, and sheet slot construction with explicit collection/index bounds.
All 416 old/new row comparisons and 33 existing drop checks pass. Scroll peers
are bounded and disposal cancels the echo frame; regression tests cover stale
cleanup callbacks and reuse. The full gate passes 138/138 commands (99.8s).
VariablesView remains JSX; continue with cell/editor hooks and mutation boundaries.

VariablesView cell checkpoint: `VariableCell.tsx` separates empty matrix cells
from populated editors, fixing conditional hooks when a mode gains or loses a
value. A real-render regression reuses the same positions through six sparse
matrix updates and checks draft cleanup. All 12 old/new cell displays match;
value/name limits are asserted, and the full gate passes 138/138 commands
(100.0s). Continue with the table controls and stylesheet mutation boundary.

VariablesView table checkpoint: `VariableTable.tsx` types sheet/table layout,
inline renaming, new-variable rows, drag offsets, and scroll registration. Matrix
blocks now require columns in both the model and parser, with a regression for
missing columns and reversed title ranges. All 24 old/new table comparisons and
171 sheet interactions pass; helpers lint without warnings and meet the size
limits. The full gate passes 138/138 commands (100.5s). Finish the remaining
VariablesView data/mutation coordinator and rename its root to TypeScript.

VariablesView is fully converted to `VariablesView.tsx`. All ten edit methods
parse outgoing payloads and incoming replies; operating failures remain values.
Snapshot undo covers every touched stylesheet and stops an edit when the initial
snapshot cannot be read. Restore failures are reported. The refresh coordinator
coalesces watcher bursts and ignores replies after disposal; the saved indicator
owns one timer and clears it on unmount. New tests cover these boundaries and
lifetimes. All 32 old/new root displays match, 171 sheet interactions pass, and
the full gate passes 138/138 commands (101.3s). Converted modules have zero lint
warnings. Fifteen original panels remain; continue with CmsView.

CmsView field checkpoint: `CmsField.tsx` types scalar controls, nested groups,
repeaters, and dialogs with exhaustive field dispatch and bounded text, lists,
and nesting. Nested repeaters now retain the image-import callback; reordering
keeps an open dialog attached to its entry. Tests cover those paths, focused
input preservation, Escape handling, and bounds. All 40 old/new field displays
match. The full gate passes 138/138 commands (101.2s); the new module has zero
lint warnings. Continue with CmsView settings, metadata, and its save coordinator.

CmsView settings checkpoint: `CmsSettings.tsx` types nested schema editing and
new-field dialogs; keyed rows own expansion state, bounding retained state to
visible fields. `cmsTypes.ts` parses saved field declarations against the shared
field-type inventory. `cmsBridge.ts` validates CMS read/write, metadata, usage,
delete, and imported-asset contracts. Invalid replies remain programmer errors;
I/O failures are explicit results. All 475 old/new settings/type comparisons
match, and new boundary/interaction tests cover malformed data, size limits,
paths, dialog state, and failed deletion. The full gate passes 138/138 commands
(101.3s), with zero warnings in converted modules. Finish CmsView's root and
its debounced save lifetime.

CmsView is fully converted to `CmsView.tsx`. Each file owns its editor lifetime,
reader, and writer. Switching files flushes the old file through its original path;
late reads cannot replace the new selection. Saves and undo restores share one
write slot, with one pending snapshot, bounded drains, retryable I/O failures,
and exact wrapper-preserving undo. Unreadable collections cannot be edited.
Schema operations construct new items and declaration maps. All 48 old/new root
displays match; new real-render and coordinator tests cover file switches, read
races, queued edits during undo, failures, bounds, and nested schema changes.
The full gate passes 138/138 commands (101.9s); new modules typecheck and lint
without warnings. Fourteen original panels remain; continue with GitChip.

GitChip dialog checkpoint: `SwitchBranchModal.tsx` types the dirty-tree decision
and bounds its file list and commit input. `gitPublish.ts` parses GitHub CLI
status, owns preflight lifetime, and types remote-link formatting. The publish
dialog now supplies the project path required by `git:ghStatus`; the missing
argument previously made a usable CLI appear unavailable. Tests cover each
status, malformed/bounded data, project changes, transport failure, and unmount.
All 50 old/new dialog/remote comparisons match. The full gate passes 138/138
commands (101.8s); new modules lint without warnings. Continue GitChip's merge
conflict model, publish state, and remaining actions/root.

GitChip conflict checkpoint: `MergeConflictModal.tsx` and `gitConflictModel.ts`
type per-hunk and whole-file choices. The shared IPC contract now describes
same/clash parts, and the renderer parses every part with a cumulative file/part
budget. Electron producers retain their actual part types through the handler
contract. Context lines are built in one pass rather than rescanning all parts
for each hunk. Whole-file choices now honor the busy lock. All 54 old/new displays
match after accounting for that fix. Real-parser, malformed-input, bounds, and
mounted-choice tests pass, alongside 64 conflict and 107 Git branch checks.
The full gate passes 138/138 commands (101.9s); new renderer modules lint without
warnings. GitChip's publish state, action boundaries, and root remain to convert.

GitChip publish checkpoint: `PublishModal.tsx` models form, publishing, and done
as a discriminated union, so an error and a completed URL cannot coexist with
an in-flight step. Project changes and unmounts discard late progress. The
publish workflow validates info, commit, and repository replies outside the
operating-error channel; transport failures stop the next Git operation and
remain retryable values. Seven focused parser/workflow/lifetime tests and seven
reachable old/new dialog displays pass. The full gate passes 138/138 commands
(106.7s), with zero warnings in the new modules. Continue with GitChip's
remaining action boundaries and root conversion.

GitChip bridge checkpoint: `gitChipBridge.ts` now parses info, changed-file,
checkout, commit, initialize, push, publish, and merge-resolution responses.
Checkout creation and parking use a discriminated mode instead of boolean
arguments. Payloads are validated before IPC, transport failures are values,
and malformed replies remain loud. Ten focused bridge/publish checks cover the
response variants, limits, ordering, and all action payloads. The full gate
passes 138/138 commands (108.0s), with zero warnings in the new bridge. Wire
these boundaries into the remaining GitChip actions, then convert and split
its root.

GitChip action-wiring checkpoint: every direct info, status, checkout, commit,
initialize, push, and merge-resolution call now goes through `gitChipBridge`.
Selected-file commits and the create/switch/park checkout modes retain their
original payloads; bridge failures continue through the chip's existing visible
error path. A source-level regression prevents raw Git IPC from returning to
the component. The full gate passes 138/138 commands (104.6s). Convert and split
the remaining JSX root next.

GitChip is fully converted to `GitChip.tsx`. Loading, initialization, and active
repository states now render through separate typed components, while the dropdown
is split into `GitChipView.tsx`. Checkout replies are narrowed by their `ok`
discriminant, optional trunk and upstream data stay explicit, and stale project
info cannot replace the current project. Operating failures reopen the dropdown's
visible error state. Branch, bridge, publish, action, and conflict checks pass;
the full gate passes 138/138 commands (104.8s), and both new modules lint without
warnings. Thirteen original panels remain; continue with `ContentView.jsx`.

ContentView is fully converted to `ContentView.tsx`. Recursive schema controls
live in `ContentFields.tsx`; their values use the bounded shared `Data` type and
exhaustive control dispatch. `contentViewBridge.ts` parses entries, targets,
validation, writes, and rename plans before UI state sees them. Target caching is
bounded, stale loads and validations are discarded, and all save/validation/saved
timers are owned and cleared. A fixture-independent mounted test confirms a title
edit writes only that field while preserving adjacent data; parser tests cover
malformed nested replies, limits, payloads, and failure channels. The full gate
passes 140/140 commands (101.5s), and the new modules lint without warnings.
Twelve original panels remain; continue with `StructurePanel.jsx`.

StylePanel is converted to `StylePanel.tsx`. Its project and Astro stylesheet
inventories now cross `stylePanelBridge.ts`, which validates paths, sizes, and
collection bounds while preserving transport failures as values. File loading
and panel-bound publication have owned hooks, and the host bridge receives a
typed `Partial<HostState>`. Sound and popup-lock behavior still pass; new tests
cover both stylesheet endpoints and malformed replies. The full gate passes
141/141 commands (104.7s), with no warnings in the new modules. Eleven original
panels remain.

CanvasView is converted to `CanvasView.tsx`. Breakpoints, world layout, iframe
ownership, zoom state, and pointer sessions are typed; page-height messages are
parsed from `unknown`, reject non-finite heights, and clamp to the existing
limits. Frame refs are removed on unmount, and fit/wheel/pointer behavior is
split into bounded hooks. The preview lifecycle test still covers malformed
messages, stale frames, refresh resets, pointer cancellation, and cleanup. The
full gate passes 141/141 commands (106.5s), with no warnings in the converted
module. Ten original panels remain.

CmsPanel is converted to `CmsPanel.tsx`. JSON files and Astro content collections
now cross `cmsPanelBridge.ts` independently, with bounded paths, data, counts,
loader fields, and covered-path inventories. A failure in either source leaves
the other visible, while malformed replies remain loud contract errors. Project
changes and unmounts discard stale reads. New fixture-independent tests cover
valid, invalid, bounded, and transport-failure paths; the optional real-project
panel test still exercises grouping when its fixture is present. Nine original
panels remain. The full gate passes 142/142 commands (104.4s), with no warnings
in the converted modules. Continue with `StructurePanel.jsx`.

StructurePanel is converted to `StructurePanel.tsx`, with recursive row rendering
and context-menu behavior in `StructureTree.tsx` and bounded visible/raw tree
queries in `structureModel.ts`. Drop locations are a discriminated union, node
descriptions are exhaustive over the parsed page-node union, and branch helpers
preserve their caller's recursive node type. New tests reject oversized, deep,
and cyclic live trees. Navigator, fragment, condition, insertion, state-marker,
bridge, panel-sound, and production-build checks pass without warnings in the
new modules. The full gate passes 142/142 commands (98.8s). Eight original
panels remain; continue with `PreviewPane.jsx`.

PreviewPane is converted to `PreviewPane.tsx`. Iframe messages now cross a
bounded parser before reaching React state, and the runtime, toolbar, overlays,
and offline diagnosis are split into typed modules with stable effect inputs.
Malformed project messages are ignored at the frame boundary; finite geometry,
spacing, classes, node states, clicks, and query replies remain discriminated.
Preview lifecycle, outline, moving-page, spacing, bridge, and production-build
checks pass without warnings in the new modules. The full gate passes 143/143
commands (97.3s). Seven original panels remain; continue with `AssetsPanel.jsx`.

AssetsPanel is converted to `AssetsPanel.tsx`. Asset inventories and every
mutation now cross `assetPanelBridge.ts`, which validates roots, parent/name
relationships, duplicate and bounded paths, missing-root state, payloads, and
operation replies. Project switches discard stale listings and watcher bursts
retain at most one pending refresh. Failed moves no longer record unusable undo
commands. Boundary, mounted-lifetime, delete, undo, bridge, app-render, and
production-build checks pass without warnings in the new modules. Six original
panels remain; the full gate passes 144/144 commands (97.3s). Continue with
`PalettePanel.jsx`.

PalettePanel is converted to `PalettePanel.tsx`, with typed creation and usage
dialogs in `PaletteDialogs.tsx`. Creation availability and usage loading,
failure, and ready states are discriminated. `paletteModel.ts` validates usage
files, kinds, counts, totals, duplicates, and bounds. Closing or reopening a
popup invalidates its older scan even when both scans target the same component.
Scan contracts now reject negative instance counts. Component creation, folder
search, popup lifetime, bridge, app-render, contract, and production-build
checks pass without warnings in the new modules. Five original panels remain;
the full gate passes 145/145 commands (98.1s). Continue with `PagesPanel.jsx`.

PagesPanel is converted to `PagesPanel.tsx`, with typed dialogs and recursive
rows split into focused modules. `pageTree.ts` bounds source depth and iterative
tree walks, while the drag boundary parses unknown JSON and reconciles it with
the current trusted scan before App can move a file. Folder UI state is pruned
after rescans. Page ordering, sound scope, bridge, render, boundary, and
production-build checks pass without warnings in the new modules. Four original
panels remain; the full gate passes 146/146 commands (98.0s). Continue with
`HistoryPanel.jsx`.

HistoryPanel is converted to `HistoryPanel.tsx`, with the timeline, branch/file/
worktree sections, model, and renderer bridge split into typed modules. The
`git:log` contract now preserves and forwards `withFiles`; main describes each
changed file before returning it, so timeline summaries receive the data they
were designed to show. Log, inventory, and worktree replies are parsed and
bounded, stale replies are discarded, and pagination stops at 10,000 commits.
History wording, bridge, payload-contract, app-render, and production-build
checks pass without warnings in the new modules. Three original panels remain;
the full gate passes 147/147 commands (98.1s). Continue with
`WelcomeScreen.jsx`.

WelcomeScreen is converted to `WelcomeScreen.tsx`, with both creation wizards
split into `WelcomeWizards.tsx` and all IPC calls routed through
`welcomeBridge.ts`. Recent projects, thumbnails, dialogs, creation results, and
streamed log chunks are parsed before use. Thumbnail refreshes stay serial and
stop when the screen unmounts; removed cards reject late updates, and both
creation logs retain at most 20,000 characters. Welcome behavior, sound scope,
bridge, app-render, boundary, and production-build checks pass without warnings
in the new modules. Two original panels remain; the full gate passes 148/148
commands (98.4s). Continue with `TerminalPane.jsx` and `TerminalDock.jsx`.

TerminalPane and TerminalDock are converted to TypeScript. `terminalBridge.ts`
parses start, resize, close, clipboard, data, exit, and foreground-process
boundaries, while `terminalRuntime.ts` owns the mutable xterm lifecycle and its
bounded 10,000-line scrollback. Paste/drop handling is isolated, clipboard
images stop at 20 MB, tab count stops at 32, and terminal listeners, observers,
and drag state have explicit owners. Lifecycle tests retain lazy loading,
scrollback, resize deduplication, and late-reply disposal behavior. The full
gate passes 149/149 commands (98.9s), with no warnings in the new modules. The
original panel queue was complete before the final `src/App.tsx` conversion.

| File                 | Lines                                                        |
| -------------------- | ------------------------------------------------------------ |
| `PropsPanel.tsx`     | ✅ converted with typed controls/editors                     |
| `VariablesView.tsx`  | ✅ converted with typed edits, history, and refreshes        |
| `CmsView.tsx`        | ✅ converted with per-file saves and parsed contracts        |
| `GitChip.tsx`        | ✅ converted with typed repository states and split dropdown |
| `ContentView.tsx`    | ✅ converted with typed fields, saves, and rename boundaries |
| `CmsPanel.tsx`       | ✅ converted with independent parsed content inventories     |
| `StructurePanel.tsx` | ✅ converted with typed rows, drops, and bounded traversal   |
| `PreviewPane.tsx`    | ✅ converted with parsed frame messages and typed runtime    |
| `AssetsPanel.tsx`    | ✅ converted with bounded listings and typed mutations       |
| `PalettePanel.tsx`   | ✅ converted with typed creation and usage popup states      |
| `PagesPanel.tsx`     | ✅ converted with bounded trees and parsed drag payloads     |
| `HistoryPanel.tsx`   | ✅ converted with parsed history and stale-reply guards      |
| `WelcomeScreen.tsx`  | ✅ converted with parsed recents and bounded creation logs   |
| `TerminalPane.tsx`   | ✅ converted with typed runtime and bounded paste handling   |
| `TerminalDock.tsx`   | ✅ converted with bounded tabs and parsed process events     |
| `StylePanel.tsx`     | ✅ converted with parsed stylesheet inventories              |
| `CanvasView.tsx`     | ✅ converted with typed frame and gesture lifetimes          |

### src/App.tsx — 4,872 lines ✅ converted hotspot

The root renderer is converted with explicit editor, history, project, preview,
and panel state. `appBridge.ts` parses lifecycle, write, Git, route, content, and
event replies before App uses them. The conversion also fixed a real preload
event bug: page-change payloads are forwarded instead of discarded. Markdown
models now pass the same shared page boundary without losing fence, list,
indentation, or trailing-blank metadata. `src/main.tsx` validates the root node
and supplies the Suspense boundary used by lazy panels. Focused App bridge,
render, navigation, component-preview, and Markdown negative-space tests pass.

### style-panel — strict TypeScript complete ✅

All 44 legacy `@ts-nocheck` headers are removed. The style panel passes the
strict root compiler and repository lint with no errors. Boundary assertions
are confined to the validated PostCSS, DOM-storage, and host adapters. Dead
pre-property-addressed write paths were removed while making the checked types
honest. These architecture hotspots still need splitting, one per commit:

| File                     | Lines                            |
| ------------------------ | -------------------------------- |
| `clip-path/ClipPath.tsx` | 8,893 — split only, already .tsx |
| `EmbedEditor.tsx`        | 4,573                            |
| `TypographySection.tsx`  | 1,551                            |
| `lib/webflow.ts`         | 1,108                            |

### scripts/ — strict TypeScript complete ✅

All eight authored JavaScript entry points are TypeScript. A dedicated strict
CommonJS project emits them to `dist/scripts`; package commands, the test gate,
development supervisor, reports, install repairs, and Electron Builder's
`afterPack` hook execute those compiled artifacts. The clean-build bootstrap is
the sole source-run script because it removes `dist` before compilation.

### Cross-cutting rules for every conversion

- Parity-check against `git show HEAD:<file>.js` before commit; watch symbol
  identity (DELETE symbols differ per module instance) and
  `JSON.parse`-as-unknown lint errors (use an annotated binding + `toRecord`).
- Preserve behavior through parity checks. Large files last. The current
  AGENTS.md hard function-size limit takes precedence when conversion requires
  private helper extraction; keep broader architecture changes separate.
- Electron and script compilers emit only under `dist/`; authored source trees
  contain no generated JavaScript sidecars.
- Parity harness preserves the relative layout under
  `node_modules/.stacki-test/orig/` for require closures.
- Known tolerated lint warnings (max-lines-per-function): jsCollections
  `parseValue` 79, projectWatcher `watchProject` 84, conflicts `threeWay` 84 /
  `parseConflict` 76, contentConfig 1 warning. Warnings are not errors; do not
  refactor to silence them unless the commit is a hotspot split.

## Phase 4 — AI contract docs ✅

- `docs/contracts.md` records page-tree, IPC, parser, bounds, and gate rules.
- `AGENTS.md` names `shared/` as the cross-process contract surface.
- `.github/workflows/check.yml` runs the full gate for main and pull requests.

## Post-Phase-3 target — Editor core ⬜

`docs/stacki-editor-core-plan.md` is the adopted, consolidated plan; it
supersedes `docs/diff-mapping-editor-core.md` (removed with the merge). Tracked
item by item in `docs/editor-core-tracker.md`. Identity = a span mapped through
one pure function `(lastKnownBytes, currentBytes, edit)`; the file is the
only state; splices carry expected-bytes witnesses; the write protocol is
atomic with checksum verification. Corpus gate (multi-span, kind-changing,
multi-file CSS, frontmatter slots). During Phase 3, mutating modules convert
with **minimal fidelity** — the intent processor deletes that layer later
(tracker step 9).

## Pending tasks (not file conversions)

| Task                                                                 | State                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| Complete `IpcContract` invoke inventory (117 channels)               | ✅ with `main.ts`                                      |
| Fix conditional-hook bugs in PropsPanel / VariablesView              | ✅ PropsPanel and VariablesView cell transitions fixed |
| Delete stray `electron/scratch2-7.js` (tracked tsc-emit leftovers)   | ✅ standalone cleanup commit                           |
| `release.sh` → TypeScript (`scripts/*.ts`, per AGENTS §17)           | ✅ `scripts/release.ts`; parsed semver and checked steps |
| Tooling deps declared devDependencies (node_modules-incident repair) | ✅                                                     |
| Node_modules incident recorded under Risks in plan                   | ✅                                                     |

## Test-suite state

- Gate green at last run: 150/150 (108.6s), exit 0. No quarantined tests remain.
  The optional external-project corpus sweep still skips without `STACKI_CORPUS`.
- Contract suite: 160/160. Full-repository lint retains existing warnings and no
  errors; the new bridge, entry point, editor model, and release script have no warnings.
- Healed out of quarantine during Phase 3 (verified two consecutive direct
  runs each, then removed per the gate's own heal report): binding, chipedit,
  codeeditorlifecycle, codeprop, jsguard.
- FLAKY: `hovercost`, `popoverdropdown` (load-sensitive).
- Regressed tests fixed during Phase 3: section-dot (quiescence polling, proven
  by bisect), outside-edit, self-writes, preview-recovery (regex loosened for
  converted formatting), backend-lifecycle (both vm module wrappers now pass
  `exports` — the content harness got the same fix its sibling had, 9c06938).
- Preload-conversion test anchors made whitespace-tolerant (tsc emits 4-space
  and expands inline `{stmt}` blocks, so text-slicing regexes broke):
  bridge, canvas-click, comment-markers, gap-bands, opened-class.
- `test:bridge` enforces the preload method-name contract
  (`readSourceText`, `writeSourceText`, `readSymbolSource`,
  `resolveSourcePath`).

## How to work this tracker

The source conversion queue is closed. Keep this document as the audit trail;
track hotspot splitting and the diff-mapping editor core as architecture work,
with the same full gate required for every follow-up commit.
