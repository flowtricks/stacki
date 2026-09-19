# Editor-Core Tracker — the consolidated editor-core plan, tracked item by item

Living status document for `docs/stacki-editor-core-plan.md`, the adopted,
consolidated plan. It supersedes `docs/diff-mapping-editor-core.md`, which is
removed from the tree; nothing in the old file that contradicts the new one
survives. Run the full gate (`npm test`) after every step, then update the
counts below. No item is "done" until its gate passes on the commit that
lands it.

## Handoff state (read this first)

- TypeScript migration complete (Phases 0–4). First tracker stamp: `v0.1.28`,
  HEAD `21efec2`. Current: `v0.1.30`, HEAD `d515fcc` (2026-09-18).
- **No editor-core step has started.** The repo still runs the legacy write
  path: renderer `mutateModel` → `page:write` payload → `serializePage` →
  direct `fs.writeFileSync`; watcher echo via `selfWrites`; renderer rescan
  chain; saver acks by `WeakSet` object identity.
- **A partial precedent landed in the window (v0.1.29).**
  `electron/componentProperties.ts` validates a whole-file expected-source
  (`source.value !== request.source` → typed `conflict` rejection), then
  commits a multi-file batch through temp-file writes with mode preservation
  and rollback. This is a legacy-layer prototype of the plan's §3.4 witness
  and §5 atomic write — absorb it at step 9, and include the
  `component:editProperties` gesture in step-5 parity runs. Two write paths
  now exist (`page:*` and `component:editProperties`), and two new IPC
  channels arrived (`component:properties`, `component:editProperties`).
- Nothing of the new core exists as named modules: no `intent.ts`, `ref.ts`,
  `snapshot.ts`, `projection.ts`, `diff.ts`, `mapSpan.ts`, capability model,
  actor rejection enum, or bounded intent queue (verified by `rg`, 2026-09-18).
- What the plan builds on: the `shared/` contract parsers and bounds; the
  parser's internal source offsets (`electron/astroParser.ts` `start`/`end`);
  `serialQueue`, `selfWrites`, `projectWatcher`; `shared/limits.ts` plus
  `electron/main.bounds.ts` and `shared/component-properties.ts` (`PROPERTY_LIMITS`).
- The plan document itself is untracked (`?? docs/stacki-editor-core-plan.md`);
  commit it before starting step 1.

## Steps

Gates are per the plan's implementation sequence (§11). Ratchet counters
(adapter surface) go down only; nothing grows a cap or retries forever.

### Step 1 — Contracts and simulator skeleton ⬜

**Deliverables.** `shared/intent.ts`, `shared/ref.ts`, `shared/snapshot.ts`,
the capability model, the rejection enum, the extended limits, and the
hostile fixture corpus. The deterministic simulator skeleton lands with the
determinism constraint (§10): the actor is driven as pure steps by a
deterministic scheduler — no real timers, no OS async, disk I/O behind an
interface the simulator fakes. The `shared/projection.ts` /
`shared/page-node.ts` rename lands in this step's commit. A lint rule bans
whole-file regeneration calls (mechanically enforces the no-`toSource()`
invariant; today that means confining `serializePage` / `serializeNodes`
call sites to the writer boundary).

**Corpus gate.** The hard intent classes are in from day one, in the
simulator even where shipping is deferred: multi-span (loop rename),
kind-changing (`stripLostBindings`), multi-file (CSS write to a stylesheet),
frontmatter slot edits. Hostile fixtures target wrong-site mapping, not
anchor survival; oracle scenarios carry hand-derived expected splices.

**Gate proof.** Contract tests green; deterministic scheduler in place;
corpus diversity is a failed gate if it is thin, not a passed one.

### Step 2 — Diff and mapping ⬜

**Deliverables.** `diff.ts`, `mapSpan.ts`, `set-attribute` only.

**Gate proof.** Ambiguity resolves to a typed rejection, never a fallback to
"the third matching node"; a missing node is a rejection, never a guess.

### Step 3 — Spike ⬜

**Deliverables.** Intent → map → witness-check → splice → reparse →
reproject against the simulator's seeded scenarios. Record mapping
correctness, reproject-plus-diff latency, and the **adapter surface** — the
direct node-mutation sites in `src/`. The plan's measured estimate is ~123
mutation sites plus ~15 prop-index writes (~138 total, §13); re-measure and
record the count here, then track it downward.

**Gate proof.** Results published against the pre-registered numbers (§11.4,
see Thresholds below). The numbers may not change between the spike and the
step-4 decision without a written reason.

### Step 4 — Threshold decision ⬜

**Deliverables.** A recorded decision, not code.

**Gate proof.** Zero wrong-site applications across the corpus; adapter
count recorded; latency within budget. Fail → report and fall back to the
anchor plan, which the author keeps intact (not on file in this repo).

### Step 5 — Actor and write protocol ⬜

**Deliverables.** Bounded intent queue, per-intent typed outcomes
(`accepted` / `backpressured`; terminal `applied` / `rejected` /
`uncertain`), expected-bytes witnesses, atomic write (temp file in the same
directory, flush, atomic replace), re-read-and-verify, new snapshot commit.
Platform integration suite against real filesystems — the simulator cannot
test the real write protocol. Single-gesture parallel run with parity checks
against the legacy path.

**Gate proof.** Nine simulator invariants hold (§10); the platform suite
covers temp-file permissions/ownership, flush semantics, directory
durability, Windows replacement semantics, symlinks, writer interference,
and the crash-between-replace-and-verify reconciliation that produces
`uncertain`. The OS-facing contract is pinned: what "flush" means, how mode
and metadata are preserved, symlink policy, canonical paths on
case-insensitive filesystems.

### Step 6 — Gesture expansion ⬜

**Deliverables.** Single-file operations ship in order: attribute → prop →
insert/remove → move → inline CSS → frontmatter slots. Stylesheet intents
(multi-file) follow the §3.3 outcome-gated composition rule once a real
gesture needs them. New features enter through intents only.

**Gate proof.** Adapter surface shrinks monotonically. Undo semantics must
be decided before this step (see Open questions).

### Step 7 — Capabilities and preview bridge ⬜

**Deliverables.** Read-only fallbacks visible, never silent; dev-only source
markers injected in memory; the preview token (digest over the sorted
dependency manifest of the rendering chain); stale-token rejection;
morph-without-reload from a projection diff, capped by a limit, honest
reload past the cap.

**Gate proof.** A preview event is accepted only if the source file and
dependency state that produced it are still current; no marker that could
change observable project behavior is ever written into the project.

### Step 8 — Code editor on the actor ⬜

**Deliverables.** Diff-based patches through the same actor; `parse-error`
projections persist invalid intermediates; overlapping external changes
surface a visible `merge-conflict`, never an overwrite; visual intents
reject with `source-invalid` while the file stays broken, and visual editing
resumes automatically once it parses again.

### Step 9 — Deletion ⬜

**Deliverables.** Compat adapter, legacy mutable tree
(`shared/editor-model.ts`), `WeakSet` acks (`src/pagePersistence.ts`),
version counters, `n\d+` parser ids — plus three special cases the actor
dissolves:

- `electron/selfWrites.ts` — the actor's own write is a watcher tick whose
  read matches the committed checksum; the suppression machinery evaporates.
- `LIMITS.saveDrainMax` — the bounded queue replaces drain semantics.
- `LIMITS.rescanChainMax` — one read plus one parse per tick removes the
  chain.

**End state.** Snapshots, projections, intents, splices. The file on disk is
the only persisted state.

## Thresholds (pre-registered, §11.4)

- Intent → applied p95 ≤ 50 ms on a representative large file.
- Keystroke → disk p95 ≤ 150 ms on a representative large file.
- Zero wrong-site applications across the corpus.

Published before the spike; may not move between the spike and the step-4
decision; revising them later requires a written reason.

## Limits work (§8)

Every bound lives in `shared/limits.ts`. Existing and usable:
`treeNodesMax`, `treeDepthMax`, `tagNameCharsMax`, `attrCharsMax`,
`attrsPerNodeMax`, `nodeValueCharsMax`, `scanEntriesMax`, `propSchema*`,
`importsMax`, `ipcFieldCharsMax`; `electron/main.bounds.ts` adds
`sourceBytesMax` and friends at the electron layer.

To add at step 1: max file bytes (merge up from `MAIN_LIMITS.sourceBytesMax`),
max projection nodes, max nesting depth, max pending intents, max intent
payload bytes, max diff work, max parse tasks in flight, max retained
snapshots, max watcher work per tick, max preview markers. Exceeding a limit
returns `resource-limit` or `queue-full` — the system never grows a drain
cap, retries forever, or reduces fidelity to cope.

## Adapter surface (ratchet, counted at step 3)

| Point | Count | State |
|---|---|---|
| Direct node-mutation sites in `src/` | ~123 (plan estimate) | to re-measure at step 3 |
| Prop-index writes | ~15 (plan estimate) | to re-measure at step 3 |

Record the real numbers at step 3. From step 6 the count goes down only.

## Open questions

Carried from the removed diff-mapping plan; resolved or still open per the
consolidated plan:

- **Threshold timing** — resolved: pre-registered at §11.4, decided at step 4.
- **`lastKnownBytes` chaining** — addressed by design: the actor commits a
  new snapshot per applied intent (§5.10); pending intents carry compact
  authored preconditions (§3.1). Confirm the interleaving behavior in the
  step-5 simulator runs.
- **Undo semantics** — open. Under file-as-state, undo is an inverse intent
  or a byte-level restore; the renderer's current snapshot/command
  `AppHistory` is the legacy model to replace. Decide before step 6.
- **Morph move-blindness** — partially addressed: morph-without-reload from
  a projection diff capped by a limit, honest reload past the cap (§9).
  Confirm the moved-node case at steps 6–7.

## Telemetry (§9a)

One counter and one structured log line in production: rejection counts by
reason, emitted with the intent id and a hashed or redacted file path. No
source bytes ever enter logs. No metrics pipeline, no dashboard, no new
dependency. The rejection distribution is the production signal for
everything the corpus cannot cover.

## Verification record

Factual record of checks run while building this tracker (first entry —
update on every step):

- 2026-09-17, HEAD `21efec2` + untracked plan:
  - `npm run build:electron` — pass (tsc, morph, preload, stage-runtime).
  - `node test/renderer-core.test.js` — 9/9 pass.
  - `node test/outside-edit.js` — 13/13 pass.
  - `node test/self-writes.js` — 12/12 pass.
  - `npm run test:contracts` — 159/160. The one failure is the build-layout
    gate flagging `shared/dist/` as generated output inside an authored
    tree: a stale artifact from an earlier compiler config (`shared/tsconfig.json`
    now emits to `dist/shared`; `shared/dist` is gitignored). Delete
    `shared/dist` before the step-1 commit.
  - `npm test` — blocked before the gate: `scripts/afterPack.ts` fails tsc
    with TS2307 on `app-builder-lib` (module present in this node_modules but
    extraneous — not declared in `package.json`). Environment/tooling issue,
    unrelated to the plan; record when fixed. Persists at `d515fcc` (v0.1.30),
    where `afterPack.ts` also grew an `builder-util` import.
- 2026-09-18, HEAD `d515fcc` (v0.1.30), after the 24h window advanced
  `21efec2 → d515fcc` (dropdown loop fix, windows hardening, component
  property management, v0.1.29/v0.1.30 releases):
  - Re-verified the contract suite after rebuilding `dist/electron` for the
    new channels: **161/162 pass**, sole failure the known build-layout
    `shared/dist` stale-artifact flag (unchanged).
  - The window added `component:properties` and `component:editProperties`;
    main-channel count is now **113** (+2), total invoke channels **117**
    (contract test asserts `harness.handlers.size === 113`).
  - New write path and limits home verified and folded into Handoff state
    above (`electron/componentProperties.ts`, `shared/component-properties.ts`).
  - `npm run build:scripts` still fails on `app-builder-lib`/`builder-util`
    TS2307. Blocker unchanged by the window.

## How to work this tracker

The executor's workflow lives in `docs/editor-core-prompts.md` — one prompt
per step, PROMPT-0 first, PROMPT-ALIGN last. This tracker is the audit trail
the prompts update.

Update the step rows as work lands, always with the gate evidence and the
test counts at the commit that did it. Keep the plan document as the
normative design; this tracker answers "where are we", the migration-tracker
answers "how the TypeScript conversion closed", and `docs/codebase.md` stays
the architecture overview. Standing rules unchanged: AGENTS.md normative,
gate green per step, behavior preservation proven by parity, verify before
claiming, zero new dependencies without a written justification, improve
only touched code.