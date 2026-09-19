# Editor-Core Prompt Pack — run this program with an AI coding agent

Copy-paste prompts, one per session, in order. Each prompt assumes the
previous step's commits landed and the full gate passed. The agent reads the
plan, the tracker, and AGENTS.md itself — these prompts point, they do not
duplicate. After every step the agent updates
`docs/editor-core-tracker.md` (step row to ✅, verification record appended)
and, where relevant, `docs/migration-tracker.md`.

All prompts share the same standing rules:

- AGENTS.md is normative. Nothing in a prompt overrides it.
- Gate green at every step: `env -u ELECTRON_RUN_AS_NODE npm test` plus the
  step's targeted suites and `tsc --noEmit` / lint for the touched projects.
- Zero new dependencies unless the change carries a written justification
  (platform and `shared/` first).
- Expected failures are `Result` or typed outcomes; programmer errors assert
  and crash; the two channels are never mixed.
- Every boundary input is parsed, with bounds from `shared/limits.ts`.
- Ratchet counters go down only (the adapter surface). Improve only touched
  code.
- Verify before claiming. Record what you actually ran in the tracker.

Known environment blockers (state them when they bite; do not hack around
them): `scripts/afterPack.ts` currently fails `tsc` with TS2307 on
`app-builder-lib` (present but extraneous in `node_modules`), and a stale
generated `shared/dist/` fails one build-layout contract test. Both are
tracked in `docs/editor-core-tracker.md`; removal of `shared/dist` is a
pre-flight item below.

---

## PROMPT-0 — Pre-flight and workspace

TASK
Prepare the workspace for the editor-core program. Do not start any plan
step.

READ FIRST
- `docs/stacki-editor-core-plan.md` (§1, §11, §15)
- `docs/editor-core-tracker.md`
- `docs/migration-tracker.md` (handoff state)
- `docs/codebase.md`, `docs/contracts.md`
- `AGENTS.md`

ACTIONS
1. Re-verify the handoff facts in the tracker: no `shared/intent.ts`,
   `ref.ts`, `snapshot.ts`, `projection.ts`, `diff.ts`, `mapSpan.ts` exists;
   the legacy write path (`pagePersistence` / `WeakSet` acks, `serializePage`
   in `electron/main.ts`, `selfWrites`, `rescanChainMax`) is present. If any
   fact is wrong, fix the tracker, not the code.
2. Remove the stale generated tree `shared/dist/` (leftover from an earlier
   compiler config; `shared/tsconfig.json` emits to `dist/shared`) and
   confirm `npm run test:contracts` goes green on the build-layout suite.
3. Investigate the `app-builder-lib` TS2307 failure long enough to either
   fix it in `package.json`/the lockfile (only if the fix is a declared
   devDependency, nothing else) or record the finding in the tracker's
   verification record. Do not delete or edit anything else.
4. Stage and commit the plan and tracker docs if the workflow expects
   commits per step: `docs/stacki-editor-core-plan.md`,
   `docs/editor-core-tracker.md`, and the already-edited cross-links in
   `docs/migration-tracker.md`, `docs/codebase.md`, `docs/ts-migration-plan.md`.
5. Read `docs/editor-core-prompts.md` once and report the step order back.

DEFINITION OF DONE
Working tree clean except your own commits; contract suite green;
verification record updated; you can name the first step and its gate.

---

## PROMPT-1 — Step 1: contracts and simulator skeleton

TASK
Land Step 1 of `docs/stacki-editor-core-plan.md` (§§3, 8, 10, 11.1): the
contract layer and the deterministic simulator skeleton. Nothing else.

READ FIRST
- Plan §3 (data model), §4 (identity), §6 (capabilities), §8 (limits), §10
  (simulator), §11.1 (step gate)
- `docs/editor-core-tracker.md` step 1
- `docs/contracts.md`, `shared/page-node.ts`, `shared/limits.ts`,
  `shared/assert.ts`, `shared/result.ts`, `shared/brand.ts`,
  `electron/astroParser.types.ts` (existing source-offset shape)
- `test/contracts/*` and `test/README.md` for suite conventions

SCOPE
- New: `shared/intent.ts` (Intent union, `RejectionReason`, terminal
  `Outcome`; `SubmissionResult` = `accepted` | `backpressured`, distinct
  from outcomes), `shared/ref.ts` (anchor = span + structural path +
  expected kind), `shared/snapshot.ts` (bytes + checksum + disposable
  projection; no version field), the capability model (`editable` |
  `read-only-opaque` | `repeated-source-node` | `runtime-aggregate` |
  `unsupported`), extend `shared/limits.ts` with every §8 bound that does
  not exist, plus a hostile fixture corpus (multi-span loop rename,
  kind-changing strip-bindings, multi-file CSS intent, frontmatter slot
  edit) and a deterministic simulator skeleton.
- The `shared/projection.ts` / `shared/page-node.ts` name unification lands
  in this commit. The `Projection` sum (`valid` | `parse-error`) is
  first-class from day one (§3.6).
- Add a lint rule banning whole-file regeneration outside the writer
  boundary (today: confine `serializePage` / `serializeNodes` call sites).
- New contract suites under `test/contracts/` in the existing style.

ENGINEERING STANDARDS (AGENTS.md)
- Parse-don't-validate: every wire/disk value crossing a boundary passes a
  parser that enforces bounds from `shared/limits.ts`.
- Branded types where lookalikes collide: `ByteOffset` vs `Utf16Offset`
  (conversion lives in one function, §3.2), `Digest`, `IntentId`.
- Discriminated unions with exhaustive switches (`never` default) for
  `Outcome`, `RejectionReason`, `Projection`, `Capability`.
- Expected failures are values; violating an invariant asserts. Core logic
  averages ≥2 assertions per function.
- No `any`, no assertions on uncontrolled data, no `Partial<T>` parameters.
- Simulator determinism is structural: pure steps, deterministic scheduler,
  no real timers, no OS async, disk I/O behind an interface the simulator
  fakes (§10). A real timer sneaking in is a failed gate.

DEFINITION OF DONE
Contract suites green including negative space and bounds; the simulator
skeleton runs seeded scenarios and reproduces per seed (invariant 9); lint
rules active; tracker step 1 marked ✅ with the verification record.

---

## PROMPT-2 — Step 2: diff and mapping

TASK
Land Step 2: `diff.ts` and `mapSpan.ts`, `set-attribute` only (§11.2).

READ FIRST
- Plan §4 (identity: `(lastKnownBytes, currentBytes, ref) → resolved |
  ambiguous | gone`), §3.2/§3.4 (offsets, spans, witnesses)
- `shared/ref.ts`, `shared/snapshot.ts` from step 1
- `docs/editor-core-tracker.md` step 2

SCOPE
- `shared/diff.ts`: byte-to-byte diff between last-known and current bytes,
  bounded by `maxDiffWork` (a stated `LIMITS` entry; the conservative
  mapping path surfaces as a typed rejection or a `read-only` capability
  downgrade — never silent fidelity loss, plan §14).
- `shared/mapSpan.ts`: maps a span through the diff. Ambiguity and missing
  nodes are typed rejections, never "the third matching node" (§4). The
  mapper never guesses.
- One operation only: `SetAttribute`, resolved against its witness.

ENGINEERING STANDARDS (AGENTS.md)
- Pure functions; every declared input type produces a declared output
  (absence and failure in the return type).
- Example: `mapSpan(a: ByteString, b: ByteString, ref: Ref): SpanMappingOutcome`
  where the outcome union is exhaustive.
- Bounds: diff work, span count, recursion depth all in `LIMITS`, enforced
  at the entry point.
- Tests: negative space exhaustively — identical sibling bytes (hero vs
  footer `title="Old"`), moved blocks, duplicated blocks, inserted and
  deleted text around the span, deep restructures. Wrong-site mapping is
  the target: assert the resolved range, not just the node kind (§3.4).

DEFINITION OF DONE
Mapping outcomes correct on the corpus; every known-bad shape is a pinned
test; tracker step 2 ✅.

---

## PROMPT-3 — Step 3: spike

TASK
Run the spike: intent → map → witness-check → splice → reparse →
reproject against the simulator's seeded scenarios (§11.3).

READ FIRST
- Plan §11.3 (spike), §11.4 (thresholds, published before this prompt),
  §13 (the measured ~123 mutation sites + ~15 prop-index writes)
- `docs/editor-core-tracker.md` step 3 and the §Thresholds section

SCOPE
- Wire the step-1/2 modules end to end in the simulator.
- Measure and record: mapping correctness per scenario, reproject-plus-diff
  latency, and the adapter surface — count the direct node-mutation sites
  in `src/` (search for `mutateModel`, in-place `props` writes, `loopBindings`
  live readers, panels that edit trees) and compare with the plan's ~123 +
  ~15 estimate. Put the real numbers in the tracker's adapter table.
- Publish intent→applied p95 and keystroke→disk p95 against the
  pre-registered thresholds (§11.4). These numbers are pre-registered; if
  the spike misses them, report, do not renegotiate.

ENGINEERING STANDARDS (AGENTS.md)
- The spike is measurement, not productionization: no new public API
  surface beyond the step-1 contracts. No drive-by refactors.
- Every loop in measurement code has a stated bound.

DEFINITION OF DONE
Latency and correctness recorded against the corpus; adapter count recorded;
report written into the tracker. This is a report step — nothing ships to
the app.

---

## PROMPT-4 — Step 4: threshold decision

TASK
Make the recorded go/no-go decision (§11.4). This step changes no source.

READ FIRST
- Plan §11.4 (decision), §12 (fallback and contingent upgrades)
- Tracker step 4

SCOPE
- Zero wrong-site applications across the corpus; latency within the
  pre-registered budget; adapter count recorded. Pass → proceed to step 5.
  Fail → report and retain the anchor plan as the fallback (off-file, kept
  by the author) — do not start step 5.
- If any threshold must move, the reason is written before it moves; a
  number that can move after measurement is a number that can be negotiated
  (§11.4).

DEFINITION OF DONE
A dated decision record appended to the tracker: pass or fail, with the
evidence columns (wrong-site count, p95 numbers, adapter count). If pass:
continue.

---

## PROMPT-5 — Step 5: actor and write protocol

TASK
Land the document actor and the atomic write protocol (§§5, 7, 9a, 11.5):
bounded intent queue, typed outcomes, expected-bytes witnesses, atomic
writes, snapshot commit, crash reconciliation, and the platform
integration suite. Run a single-gesture parallel comparison against the
legacy write path with parity checks.

READ FIRST
- Plan §5 (the ten-step write protocol, the honest-limit product contract,
  the `uncertain` crash semantics), §3.5 (submission vs outcome, no
  retries, reconciliation is comparison), §7 (external writers), §9a
  (telemetry), §11.5 (gate)
- `electron/main.ts` (`writePageText`, `page:write` handlers),
  `electron/componentProperties.ts` (the v0.1.29 proto of the §5 write:
  whole-file expected-source check, temp-file batch commit with rollback —
  reuse its patterns, then delete it at step 9),
  `electron/serialQueue.ts`, `electron/selfWrites.ts`,
  `electron/projectWatcher.ts`, `src/pagePersistence.ts`
- Tracker step 5

SCOPE
- Actor per canonical file: read-and-stat; snapshot rebuild on checksum
  mismatch (never commit an older snapshot over a newer one, §5.1); anchor
  resolution; splice planning with witnesses; in-memory apply in descending
  offset order; re-parse the candidate and confirm kind; advisory lock where
  available with re-read and re-verification; temp-file write + flush +
  atomic replace; re-read and verify; commit.
- Typed outcomes: `applied` | `rejected` (each `RejectionReason`) |
  `uncertain` with `candidateChecksum`; backpressure at a full queue is
  `backpressured` at submission, never a silent drop. The actor never
  retries and never merges.
- Telemetry (§9a): one counter and one structured log line, rejection
  counts by reason, hashed paths, no source bytes in logs. No new
  dependency, no metrics pipeline.
- Platform integration suite against real filesystems (not the simulator):
  temp-file permissions/ownership, flush meaning (`fsync` or equivalent),
  directory durability, Windows replacement semantics, symlinks, antivirus
  and indexer interference, cooperating writers, crashes between
  replacement and verification (§10). The `uncertain` reconciliation is
  exercised here.
- Parity: the same gesture through the legacy path and the actor must
  produce identical files on the corpus.

ENGINEERING STANDARDS (AGENTS.md)
- Expected failures are values (the `Outcome` union), programmer errors
  assert. The `uncertain` state is data, not an exception.
- Bounds in `LIMITS`: `maxPendingIntents`, `maxRetainedSnapshots`,
  `maxParseTasksInFlight`, `maxWatcherWorkPerTick`, `maxDiffWork` — enforced
  at the queue and the actor boundary; a full queue returns `backpressured`.
- The honest-limit product contract is a code comment at the write site:
  a byte check cannot close the check-to-use race; Stacki never knowingly
  applies to stale bytes, never silently remaps an anchor, and reports
  `write-race` where the OS cannot guarantee atomicity (§5).

DEFINITION OF DONE
Simulator invariants 1–9 hold; platform suite green on this OS; parity run
identical; telemetry in place; tracker step 5 ✅.

---

## PROMPT-6 — Step 6: gesture expansion

TASK
Expand operations in the §11.6 order: attribute → prop → insert/remove →
move → inline CSS → frontmatter slots. New features enter through intents
only. Measure the adapter surface at each expansion and keep the ratchet
monotone.

READ FIRST
- Plan §11.6, §3.3 (operations, multi-span from the start), §3.4 (splices;
  moves relocate the original byte slice, never reprint the node), §7
  (coalescing is policy in the persistence layer; the actor never merges)
- `src/App.tsx` mutation sites (`mutateModel`, `setProp` and friends),
  `src/loopBindings.ts`, `src/attrOrder.ts`
- Tracker step 6, adapter table

SCOPE
- Implement each operation against the current corpus. Loop renames are
  multi-span from the start; `stripLostBindings` changes kinds.
- Stylesheet intents (multi-file) follow outcome-gated ordering (§3.3):
  submit the page intent, on `applied` submit the dependent intent with its
  own witness; a failed precondition cancels at the UI layer, never
  submitted, and per-file outcomes are surfaced.
- The persistence layer (successor of `createPageSaver` / `createFileSaver`)
  owns debounce, coalescing, the flush timer for held values, and the
  re-review affordance; a rejected intent never destroys user input (§7,
  rejection UX contract).
- Decide undo semantics before this step ships and record the decision
  (tracker open questions): inverse intent vs byte-level restore.

ENGINEERING STANDARDS (AGENTS.md)
- One name per concept; operations extend the union, not the writer
  (§3.3). No boolean parameters in the new signatures; options objects are
  `readonly`.
- Numerators: adapter surface shrinks at every expansion; a gesture that
  grows it needs a written reason in the commit.

DEFINITION OF DONE
Every shipped operation passes the corpus and parity vs the legacy path for
that gesture; adapter surface recorded at each point; undo decision on
record; tracker step 6 ✅.

---

## PROMPT-7 — Step 7: capabilities and preview bridge

TASK
Land capabilities and the preview bridge (§§6, 9, 11.7): visible read-only
fallbacks, dev-only in-memory source markers, the preview token, and
morph-without-reload from a projection diff with an honest reload past the
cap.

READ FIRST
- Plan §6 (capability model; a loop has one source node and many runtime
  instances — clicking a runtime instance never mints a fake identity), §9
  (preview token = digest over the sorted dependency manifest; a preview
  event is accepted only if the source file and dependency state are still
  current), §11.7
- `electron/morphClient.ts` (existing DOM diff), `electron/astroParser.ts`
  (existing marker injection), `src/previewMessages.ts`
- Tracker step 7

SCOPE
- Surface capabilities on every projected node; non-addressable regions are
  visible, never silently editable.
- Dev-only markers injected in memory via the existing dev integration; no
  marker that could change observable project behavior is ever written into
  the project (§9).
- Preview token: digest over the sorted dependency manifest of the
  rendering chain, or generation + per-file checksum list; stale token
  rejects. A component edit invalidates the token even when the open page's
  bytes are unchanged.
- Morph-without-reload from a projection diff, capped by `maxPreviewMarkers`/
  a stated diff bound; past the cap the preview reloads honestly.

ENGINEERING STANDARDS (AGENTS.md)
- The capability enum is a discriminated union with exhaustive switches;
  "unsupported" is a first-class value, never a `read-only` downgrade of
  something the model can actually do.
- Bounds: preview markers and morph diff capped in `LIMITS`, enforced at
  the bridge boundary.

DEFINITION OF DONE
Stale-token rejection tested both directions (component change, unrelated
page change); no-marker-into-source asserted by a test; morph cap behavior
tested; tracker step 7 ✅.

---

## PROMPT-8 — Step 8: code editor on the actor

TASK
Move the code editor onto the actor: diff-based patches through the same
actor, `merge-conflict` surfacing, invalid intermediates as first-class
state (§3.6, §6, §11.8).

READ FIRST
- Plan §3.6 (parse-error projection; visual intents reject with
  `source-invalid`; editing resumes when it parses again), §7 (external
  writers; the code editor is not a second write path), §11.8
- `src/ui/CodeEditor.tsx`, `src/panels/StructurePanel.tsx` (`CodePage`,
  `onRawChange`), `src/appBridge.ts`, `src/pagePersistence.ts`
- Tracker step 8

SCOPE
- The code editor submits a byte diff against its baseline through the same
  actor; a patch may atomically write temporarily invalid bytes; the
  projection becomes `parse-error`; the UI offers the code editor and
  Astro's own error output. Visual editing resumes automatically once the
  file parses.
- Overlapping external changes produce a visible `merge-conflict`, never an
  overwrite. Rejection UX contract applies: input is never destroyed; the
  re-review affordance names the reason.
- Retire the raw-source path (`page:writeRaw` → `writeProjectPageRaw`) once
  the actor path is the only writer.

ENGINEERING STANDARDS (AGENTS.md)
- `parse-error` is a Projection variant, not an exception; renderers switch
  exhaustively over it.
- Every patch has a stated byte bound (`maxIntentPayloadBytes`); a patch
  that exceeds it fails with `resource-limit`, never truncates.

DEFINITION OF DONE
Code-editor save, external-edit-overlap, and invalid-intermediate scenarios
covered by tests (including the negative space: malformed intermediates in
the corpus, plan §3.6); tracker step 8 ✅.

---

## PROMPT-9 — Step 9: deletion

TASK
Delete the legacy layer the actor replaces (§11.9): compat adapter, legacy
mutable tree, `WeakSet` acks, version counters, `n\d+` ids — plus
`selfWrites.ts`, `saveDrainMax`, and `rescanChainMax`. End state: snapshots,
projections, intents, splices. The file on disk is the only persisted state.

READ FIRST
- Plan §11.9 (the three dissolving special cases: `selfWrites.ts` — the
  actor's own write is a watcher tick whose read matches the committed
  checksum; `saveDrainMax` — the bounded queue replaces drain; `rescanChainMax`
  — one read plus one parse per tick), §13
- `electron/selfWrites.ts`, `src/pagePersistence.ts`, `shared/editor-model.ts`,
  `src/App.tsx` (`mutateModel`, `pageStateRef`, `cloneEditorModel`),
  `shared/limits.ts`
- Tracker step 9

SCOPE
- Remove the compat adapter and every legacy mutation site; renderer
  interaction state (selection, hover, trail) resolves through the same
  mapping as every edit (§4, §12 — the ⇧⌘C trail payoff).
- `n\d+` parser ids: verify nothing keys on parse-order ids across
  snapshots; session restart re-resolves everything from bytes.
- Delete `selfWrites` machinery, the drain caps, and the rescan chain, and
  remove their limits from `shared/limits.ts` only after the actor's
  equivalent behavior is proven by the full suite.
- The no-whole-file-regeneration lint rule now guards the real invariant.

ENGINEERING STANDARDS (AGENTS.md)
- Deleting is reversible only through git: one commit per removal group,
  gate green at each. Behavior preservation is proven by the suite, not
  asserted verbally.
- After deletion, re-run the forbidden-pattern scan: no stray mutation
  sites, no boolean flags encoding state, no version counters.

DEFINITION OF DONE
Full gate green; `rg` confirms zero remaining mutation-of-model call sites
outside the intent pipeline; tracker step 9 ✅ and the whole plan row set
⏺ closed.

---

## PROMPT-ALIGN — Standards alignment sweep

TASK
Audit the whole repository against AGENTS.md and fix what fails, small and
safe: the final alignment pass. Scope creep is a failure — this is a
compliance pass, not a redesign. Do not refactor beyond what a rule
violation requires.

READ FIRST
- `AGENTS.md` in full
- `eslint.config.mjs`, the root/each-project `tsconfig.json` (strict flags
  must all be present)
- `docs/codebase.md` (the measured findings: four style-panel abstractions
  written six times, hotspot file sizes)

CHECKLIST (fix each violation you find; nothing is "known debt" unless a
comment or doc already says why)
1. Forbidden patterns: `any`, `as any`, `@ts-ignore`, unvalidated `as T`,
   non-null `!`, `enum`, `Partial<T>` params, `Record<string, any>`,
   `catch (e) { e.message }` without narrowing, boolean flags encoding
   state, both `null` and `undefined`, `assert(a && b)` (split), compound
   `if` conditions (split into nested `if/else`), bare `/` feeding an index
   or count, reliance on library defaults for correctness-relevant options.
2. Every boundary (IPC, file, env, `JSON.parse`, drag data, browser
   messages) has a parser that enforces bounds from `shared/limits.ts`;
   one parse-test per contract: known-good passes, each known-bad fails.
3. Every loop, queue, retry, and collection has a stated upper bound;
   `while (true)` only in event loops with a progress assertion or cap.
4. Assertions: preconditions, postconditions, invariants — ≥2 per function
   in core logic; producer and consumer both assert storage invariants.
5. Functions ≤70 lines (the lint rule is the arbiter); control flow
   centralized, helpers pure; every `if` has its `else` handled or
   asserted; conditions positive (`index < count`, not `!(index >= count)`).
6. Immutability at API boundaries: `readonly` params and returns; mutation
   only local, centralized, and justified; `cloneEditorModel` stays the
   single constructor of the mutable mirror.
7. Naming: no abbreviations (`source`/`target`, not `src`/`dest`); units
   and qualifiers last (`latencyMsMax`); one name one meaning; acronyms
   keep capitals.
8. Comments are sentences with a reason; test files open with goal and
   methodology.
9. Bounds live in `shared/limits.ts` (or `MAIN_LIMITS` at the electron
   layer when it is also a runtime gate) — no magic numbers in loops.
10. Result vs assert channels: no `catch` converting an assertion failure
    into a `Result`; no `err` for a violated invariant.
11. Hotspots: if the sweep must touch `ClipPath.tsx`, `EmbedEditor.tsx`,
    `App.tsx`, or `TypographySection.tsx`, split only what the violation
    requires (their size is tracked as architecture work, one commit per
    file, never a conversion commit).

GATE
`tsc --noEmit` clean in every project; lint clean with no new warnings;
`env -u ELECTRON_RUN_AS_NODE npm test` green; the contract suite green;
`npm run ratchet-check` (or the repo's ratchet script) unchanged; the
verification record in `docs/editor-core-tracker.md` appended with what you
changed and measured. Report the violation counts by rule and the files
changed — no blanket "clean" claims without the run evidence.

---

## How to run these

1. Feed PROMPT-0 first, in a session with repo access and the workflow's
   commit rights.
2. Then PROMPT-1..9 strictly in order. Do not parallelize: each step's
   contracts are the next step's input.
3. Run PROMPT-ALIGN last, or as a checkpoint before any release while the
   program is mid-flight.
4. After each prompt: read the tracker's updated verification record before
   starting the next session. Trust `--situ`-style working-tree facts over
   any doc that disagrees.