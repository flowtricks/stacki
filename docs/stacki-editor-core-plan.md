# Stacki Editor Core — Consolidated Implementation Plan

**Status: recommended, reconciled.** This document merges the diff-mapping plan
with the strongest engineering from an independent architectural proposal
(expected-bytes witnesses, the atomic write protocol, the capability model, and
the event simulator). It is the **post-Phase-3 target**, not a redirect of the
TypeScript migration. It rejects that proposal's shell rewrite and its stored
identity mapper, for reasons stated in §12.

Nothing here is verified against the running app. Every claim is gated by §10.

## 1. Decision

The editor core is a **source-editing engine with a visual client**. The file on
disk is the only persisted state. The engine additionally holds, per open file,
one immutable snapshot: the last-known bytes, their checksum, and a disposable
projection. A UI edit is an intent referencing a span in the last-known bytes.
At apply time, the engine maps that span through a diff from last-known to
current bytes and splices the edit at the mapped position. Ambiguous mapping or
a missing node is a typed rejection, never a guess.

Identity is resolved at use time by one pure function. No stored identity layer.
No version counter. No fingerprints kept between edits.

## 2. Architecture

```
external edit ──┐
                ▼
        ┌───────────────┐    push    ┌──────────────┐
        │ file on disk  │ ─────────► │ projection   │ ──► renderer
        │  (Layer 0)    │            │  (Layer 1)   │      (Layer 3)
        └───────▲───────┘            └──────────────┘
                │ atomic write
        ┌───────┴───────────┐
        │ document actor (2)│  one per canonical file
        └───────▲───────────┘
                │ intents (bounded queue)
            renderer (visual UI / code editor / preview bridge)
```

- **Layer 0 — Source.** The `.astro` file (and, for CSS intents, its stylesheet).
  The only artifact. Owned by the write protocol below.
- **Layer 1 — Projection.** Pure function `bytes → Projection`, repackaging the
  existing `astroParser`. Raw spans cover everything unmodeled. No `toSource()`
  exists anywhere: no API can regenerate a whole file from a model.
- **Layer 2 — Document actor.** One per canonical file. Reads, resolves, plans
  splices with expected-bytes witnesses, applies in memory, re-parses the
  candidate, writes atomically, verifies, commits a new snapshot. Returns one
  typed outcome per intent. The bounded intent queue lives here.
- **Layer 3 — Renderer.** Owns interaction state only: selection, hover, trail —
  each a node reference resolved at use time. A compat adapter translates legacy
  gestures during migration, then dies.

The watcher is a hint, not an authority. The actor trusts a direct disk read
before writing, never watcher ordering.

## 3. Data model

### 3.1 Snapshot — the only source-derived state

```ts
interface Snapshot {
  readonly path: FilePath;
  readonly checksum: Digest;        // identifies exact byte content
  readonly bytes: ByteString;       // retained: writes copy untouched bytes exactly
  readonly projection: Projection;  // disposable view, derived
}
```

No `version` field. The checksum answers "which file is this?" — a counter would
answer it with something extra to keep in sync. Snapshots are immutable; a new
one replaces the old. Only the current snapshot and compact authored
preconditions for pending intents are retained.

### 3.2 Offsets and spans

```ts
type ByteOffset  = number & { readonly __brand: 'ByteOffset' };
type Utf16Offset = number & { readonly __brand: 'Utf16Offset' };
```

Parser emits UTF-16 spans; the writer works in bytes; conversion lives in one
function. Mixing them is a compile error. The encoding contract is pinned in
the same step: files are read and written as UTF-8, with defined BOM handling,
CRLF preservation (line endings round-trip untouched), and a typed error for
invalid UTF-8 rather than a lossy replacement. Unicode and CRLF fixtures are
mandatory corpus members.

### 3.3 Intents — immutable commands with witnesses

Intents are multi-span from the start: a loop rename touches dozens of
scattered spans; `stripLostBindings` changes node kinds. The *shipped* operation
set is single-file: one actor, one terminal result, no cross-file atomicity
question. Multi-file gestures (page + stylesheet) are composed at the UI layer as
ordered, dependent intents. Cross-file dependency is **outcome-gated
ordering**, not a witness: a witness attests expected bytes at a range, and
across files no shared byte range exists. The dependent intent therefore
carries (a) a precondition on the prior intent's terminal outcome — submit
only after the page intent returns `applied` — and (b) its own witness against
its own file's bytes, nothing more. A dependent intent whose precondition
fails is cancelled at the UI layer and never submitted; the outcome contract
covers accepted intents only, so no new rejection reason is needed. A
mid-sequence failure surfaces per-file outcomes to the user rather than a
fabricated pair atomicity. Multi-file scenarios run in the simulator from day
one; the shipped orchestration lands only when a real gesture needs it.

```ts
interface Intent {
  readonly id: IntentId;
  readonly file: FilePath;                // canonical path; the actor is per-file
  readonly authoredChecksum: Digest;      // the bytes this intent was authored against
  readonly anchor: AnchorRef;             // span + structural path + expected kind
  readonly operation: Operation;          // closed union, see below
}
```

Operations (initial): `SetAttribute`, `RemoveAttribute`, `InsertNode`,
`MoveNode`, `RenameBinding` (multi-span), `SetInlineStyle`, `ApplyCodePatch`
(code editor), `EditFrontmatterSlot`. New operations extend the union; they do
not extend any writer.

### 3.4 Splices — the only write primitive

```ts
interface Splice {
  readonly range: ByteSpan;
  readonly expectedBytes: ByteString;     // witness
  readonly replacementBytes: ByteString;
}
```

The writer verifies `expectedBytes` at the resolved range before applying. The
splice for changing `title="Old"` to `title="New"` covers `"Old"` only — the tag
is never regenerated. Attribute insertions use a zero-width point plus a
witness range around it. Moves relocate the original byte slice; they never
print the node again.

Division of labor, stated precisely: **`expectedBytes` is a stale-range
witness, not an identity witness.** Consider `<Hero title="Old" />` beside
`<Footer title="Old" />`: both ranges contain identical bytes, so a
replacement applied at the wrong range passes the witness and still produces a
different file. Identity therefore comes from unique anchor resolution —
structural paths and source ranges, with rejection on ambiguity (§4). The
witness then verifies that the uniquely resolved range still contains the
authored bytes. Neither guard substitutes for the other. The simulator's
oracle cases (§10) assert the exact intended target range or labeled source
node, not merely the expected node kind, precisely so a correct-bytes-
wrong-target planner cannot pass.

### 3.5 Submission and outcomes — typed and total

Submission and terminal results are separate types, and the distinction is
load-bearing: backpressure is not rejection.

```ts
type SubmissionResult =
  | { readonly tag: 'accepted'; intentId: IntentId }
  | { readonly tag: 'backpressured' };  // draft remains in the persistence layer

type Outcome =
  | { readonly tag: 'applied'; intentId: IntentId; changedRanges: ByteSpan[]; checksum: Digest }
  | { readonly tag: 'rejected'; intentId: IntentId; reason: RejectionReason }
  | { readonly tag: 'uncertain'; intentId: IntentId; candidateChecksum?: Digest };

type RejectionReason =
  | 'anchor-moved'
  | 'anchor-ambiguous'
  | 'region-externally-modified'
  | 'source-invalid'
  | 'unsupported-operation'
  | 'resource-limit'
  | 'write-failed'
  | 'write-race'
  | 'merge-conflict';
```

A full queue returns `backpressured` at submission. The persistence layer may
automatically flush and resubmit a backpressured draft — it owns those values.
An *accepted* intent is terminal: `applied`, `rejected`, or `uncertain`. The
actor never retries, and a rejected intent requires deliberate user
resubmission — the rejection UX contract (§7) applies to accepted intents
only. Operations are designed for idempotency where cheap: `SetAttribute`
applied twice yields the same file, so reconciliation is a checksum
comparison; insert and move are the non-idempotent cases and carry the
explicit care described in §5.

**Crash semantics, stated as a narrowed guarantee.** "Every accepted intent
reaches exactly one terminal result" holds only while the actor remains able
to report it. A crash between the atomic replacement and the verification
read leaves the file possibly containing the edit and the client holding no
result — that state is `uncertain`, carrying the deterministic candidate
checksum. On reconnect, comparing the current checksum against the candidate
resolves to "edit applied," "edit not applied," or "source changed again —
review required." No durable intent journal: the file stays the only
persisted state, and reconciliation is a comparison, not a guess. This case
is tested in the step-5 platform suite (§11).

## 3.6 Invalid source — a first-class projection state

The write protocol requires the candidate to parse (§5). That applies to
visual intents. The code editor and external writers must be able to persist
temporarily invalid bytes — no real editor rejects every broken intermediate.
The projection is therefore a sum:

```ts
type Projection =
  | { readonly tag: 'valid'; /* nodes, capabilities, ranges */ }
  | { readonly tag: 'parse-error'; diagnostics: Diagnostic[]; bytes: ByteString };
```

Code-editor patches may atomically write invalid bytes; the projection
becomes `parse-error`; visual intents reject with `source-invalid`; the UI
offers the code editor and Astro's own error output. Visual editing resumes
automatically once the file parses again. Malformed intermediates in the
corpus exercise this path explicitly.

## 4. Identity: resolved at use time

A node reference is a span in last-known coordinates plus a structural path.
Resolution is `(lastKnownBytes, currentBytes, ref) → resolved | ambiguous | gone`,
computed by mapping the span through the diff between the two byte-strings.

- Renderer convenience handles (selection, hover, trail, focus) are resolved
  through the same function at the moment they are used.
- No ids are stored between snapshots. No mapping table, no tombstones, no
  fingerprint matching rules to maintain.
- Session restart re-resolves everything from bytes. Persisting identity into
  `.astro` files is permanently rejected — it violates the source contract.
- The mapper never falls back to "the third matching `<div>`". Ambiguity is a
  rejection.

**Dependency worth stating:** the witness's wrong-instance protection (§3.4)
stands on this rule. Two identical `title="Old"` attributes in hero and footer
have identical bytes and identical kinds; mapping to the footer would pass the
witness and produce a legal splice on the wrong node. The structural path check
catches it, and where paths also match, ambiguity rejection is the last guard.
"Ambiguity is a rejection, never a fallback" is the load-bearing wall; the
witness is the door it protects.

The UI's interaction state (selection, structure-panel expansion, props-panel
focus) references nodes only through this mechanism. The current `n\d+` parse-
order ids — which do not survive reparse — are replaced as part of the
renderer-wide migration counted in §11.

## 5. Write protocol

The actor performs, per intent:

1. Read and stat the file. If the checksum differs from the snapshot, parse and
   build a new snapshot. If a newer disk version arrived while parsing, discard
   the parse; never commit an older snapshot over a newer one.
2. Resolve the anchor against current bytes. Ambiguous or gone → reject.
3. Plan splices with expected-bytes witnesses.
4. Verify every witness against current bytes.
5. Apply splices in memory (descending offset, non-overlapping).
6. Re-parse the candidate; confirm it parses and the target retains its
   expected kind.
7. Acquire an advisory lock where available; re-read the file while holding it;
   verify identity, checksum, and witnesses again.
8. Write a temp file in the same directory, flush, atomically replace.
9. Re-read the target; verify the checksum.
10. Commit the new snapshot; return `applied`.

**Honest limit, stated as a product contract:** a byte check does not close the
kernel check-to-use race against an uncooperative writer. No portable API gives
compare-and-swap on a pathname. Stacki therefore promises: it never knowingly
applies an intent to stale bytes, it never silently remaps an anchor, and it
reports `write-race` where the OS cannot guarantee atomicity. That sentence
belongs in the product requirements, not just this document.

**A pattern this document states once so future claims inherit it:** wherever
the plan says something "is current" — a resolved range, a preview, a
committed snapshot — the claim must name its token and its reconciliation
path. The witness covers a single-file range; the preview token covers the
dependency graph; the candidate checksum covers the crash window. A "current"
claim without a token is a bug waiting for a name.

## 6. Capabilities, not silent fallbacks

The projection exposes a capability per node:

```ts
type Capability =
  | 'editable'
  | 'read-only-opaque'
  | 'repeated-source-node'   // one source node, many runtime instances
  | 'runtime-aggregate'
  | 'unsupported';
```

Initially visual-editable: native elements, component invocations, literal
attributes, simple expression attributes with exact ranges, same-file inline
styles, direct child moves, scalar props. Initially code-only: spread
attributes, dynamic prop objects, `set:html`, generated lists, conditionally
repeated nodes, multi-root components, external CSS rules without their own
actor, edits requiring frontmatter or import rewrites.

A loop has one source node and many runtime DOM elements. Clicking one rendered
list item never mints a fake identity for a runtime instance — the UI targets
the source loop node or shows the region as non-addressable. The fallback is
visible, never silent.

## 7. External writers

Watcher events coalesce to a dirty flag; intermediate file states do not matter
because current bytes are the source of truth. One read and one parse per tick.
External editors are absorbed the same way: their change becomes new bytes, the
snapshot rebuilds, and pending intents resolve against the new snapshot or
reject. The code editor is not a second write path — it submits a byte diff
against its baseline through the same actor, and overlapping external changes
produce a visible `merge-conflict`, never an overwrite.

**Coalescing replaces the debounce.** Coalescing folds a burst within a single
(file × operation) stream into one intent — a slider drag is one stream and
coalesces happily. A gesture spanning operations (a drag while a prop field is
mid-edit) is multiple streams and submits multiple intents; the actor never
merges, and the per-intent witness design prefers many small intents. The
actor never retries and never merges; the engine stays dumb and the policy
stays in one place.

The policy has a named owner: the **persistence layer** — the successors of
`createPageSaver` / `createFileSaver` — which already owns debounce and
coalescing semantics and the re-review affordance. On `queue-full` it holds
the stream's latest values, surfaces a non-blocking notice, and resubmits.
Because a user who finishes a burst and goes idle would otherwise hold values
that never reach disk, the persistence layer runs a short flush timer
(renderer-side only; the actor never sees a timer). The held-values window is
thus bounded by decision, not by accident.

**Rejection UX contract.** Because the renderer owns interaction state, this
falls out for free, and it is specified now while it is cheap: a rejected
intent never destroys the user's input. The panel keeps the submitted values.
The rejection renders as a non-blocking "external change — re-review"
affordance naming the reason. Resubmission is a deliberate user act, never
automatic. Mid-typing, the user never loses work and never gets a modal.

## 8. Limits

Every bound lives in `shared/limits.ts`: max file bytes, max projection nodes,
max nesting depth, max pending intents, max intent payload bytes, max diff work,
max parse tasks in flight, max retained snapshots, max watcher work per tick,
max preview markers. Exceeding a limit returns `resource-limit` or `queue-full`.
The system never grows a drain cap, retries forever, or reduces fidelity to
cope.

## 9. Preview

The project's own Astro dev server remains the rendering authority, embedded in
an iframe. The projection supplies nodes, capabilities, ranges, and interaction
metadata — it is not a renderer. Selection uses a dev-only bridge: source markers injected in memory via a
dev integration. A marker carries its source file identity and checksum —
but one page's checksum is insufficient, because the preview is derived from
the page plus imported components, layouts, stylesheets, and potentially
content and configuration. The bridge therefore uses a **preview token**: a
digest over a sorted dependency manifest of the rendering chain (the same
chain the projection already resolves on parse), or equivalently a generation
plus the per-file checksum list. The invariant: **a preview event is accepted
only if the source file and dependency state that produced it are still
current.** This makes HMR transitions and morphing honest — a component edit
invalidates the token even when the open page's bytes are unchanged. Nodes
with unreliable runtime-to-source mapping are read-only. No marker that could
change observable project behavior is ever written into the project.
Morph-without-reload updates the canvas from a projection diff, capped by a
limit; past the cap the preview reloads honestly.

## 9a. Telemetry — is the wall holding?

Production carries one counter and one structured log line, nothing more:
rejection counts by reason, emitted with the intent id and a hashed or
redacted file path — raw paths leak usernames and project names. No source
bytes ever enter logs. The
simulator proves the mapper correct under its corpus; the rejection
distribution is the production signal for everything the corpus cannot cover.
A spike in `anchor-ambiguous` or `region-externally-modified` means a gesture
is fighting real-world concurrent edits — visible before users complain, and
visible in time to answer the question the fingerprint verifier would
otherwise have been built to answer. Read the three priorities into it
directly: safety first (rejection rates by reason), performance second
(intent→applied latency percentiles against the pre-registered numbers (step 11, item 4)), developer
experience third (adapter-surface count trending down, parity failures by
gesture). No metrics pipeline, no dashboard, no new dependency — a counter, a
log statement, and a weekly glance.

## 10. Simulator — the corpus, generalized

A deterministic simulator calls the real parser, span mapper, intent planner,
and writer. Scenarios are generated from a corpus of real Astro files, hand-
written edge cases (duplicate siblings, whitespace and comment variants,
malformed intermediates, repeated and conditional templates), and seeded
interleavings of: visual intents, external manual edits, AI-style rewrites,
git-style atomic replacements, watcher ticks, parse completions, preview
events, code-editor saves.

After every operation, assert:

1. Every accepted intent reaches one terminal result.
2. Every applied patch matches its expected bytes.
3. Bytes outside splice ranges are unchanged.
4. No anchor resolves to the wrong node type.
5. Ambiguous anchors never apply.
6. A stale preview cannot submit a silently remapped edit.
7. The actor never commits an older snapshot over a newer one.
8. Queue, parser, diff, and snapshot bounds hold.
9. The same seed produces the same results.

The simulator fakes I/O to test logical interleavings; it cannot test the
real write protocol. Temp-file permissions and ownership, flush behavior,
directory durability, Windows replacement semantics, symlinks, antivirus and
indexer interference, cooperating writers, and crashes between replacement
and verification are the province of a **platform integration suite** that
runs at step 5 against real filesystems, including the `uncertain` outcome's
reconciliation. The simulator proves the actor's state machine; only real
filesystems validate the atomic-write implementation. Step 5 also pins the
OS-facing contract: what "flush" means (`fsync` or equivalent), how file mode
and metadata are preserved, whether symlinked files are supported or rejected,
and how canonical paths are computed on case-insensitive filesystems.

Two hard requirements on the simulator itself. First, **determinism is
structural**: the actor is driven as pure steps by a deterministic scheduler —
no real timers, no OS async, disk I/O behind an interface the simulator fakes.
Invariant 9 is a claim about the harness, and it is decorative the moment
anything real sneaks in. This constraint lands with the step-1 skeleton.
Second, **oracle scenarios sit beside the invariants**. The nine invariants are
self-consistency: witnesses match, untouched bytes unchanged, anchors never
resolve to the wrong kind. They cannot catch a planner that derives the wrong
splice from a correct mapping. A small set of hand-built files — a moved node,
a duplicated block, a deep restructure — carries hand-derived expected splices
whose targets are unambiguous to a human. The corpus thus has two layers:
hostile fixtures for mapping failure modes, oracle scenarios for
intent-to-splice correctness.

Small exhaustive interleavings run in CI; large seeded randomized runs run
nightly. The hostile corpus of earlier plans folds into this harness — its
target is wrong-site mapping, and invariants 4 and 5 are the net.

## 11. Implementation sequence

Gate green at every step. Zero new dependencies. Ratchet count only decreases.

1. **Contracts and simulator skeleton.** `intent.ts`, `ref.ts`, `snapshot.ts`,
   capability model, rejection enum, limits, fixture corpus. Contract tests
   first. The corpus includes the hard intent classes from day one: multi-span
   (loop rename), kind-changing (strip bindings), multi-file (CSS write to a
   stylesheet), frontmatter slot edits — in the simulator, even where shipping
   is deferred. The simulator skeleton carries the determinism constraint from
   §10. The `shared/projection.ts` / `shared/page-node.ts` rename lands in
   this step's commit, not later. A lint rule bans whole-file regeneration
   calls, mechanically enforcing the no-`toSource()` invariant instead of
   trusting a sentence to survive refactors.
2. **Diff and mapping.** `diff.ts`, `mapSpan.ts`, `set-attribute` only.
3. **Spike.** Intent → map → witness-check → splice → reparse → reproject
   against the simulator's seeded scenarios. Record mapping correctness,
   reproject-plus-diff latency, and the **adapter surface** — the direct
   node-mutation sites in `src/` (~123 plus ~15 prop-index writes in review)
   are the real migration cost. That count is measured here and tracked
   downward.
4. **Threshold decision.** Zero wrong-site applications; adapter count
   recorded; latency against pre-registered numbers: intent→applied p95 ≤ 50ms
   and keystroke→disk p95 ≤ 150ms on a representative large file. These numbers
   are provisional and published before the spike; they may not change between
   the spike and this decision; revising them later requires a written reason.
   A number that can move after measurement is a number that can be
   negotiated. Fail → report and fall back to the anchor plan, kept intact.
5. **Actor and write protocol.** Bounded queue, atomic write, external-writer
   handling. Single-gesture parallel run with parity checks against the legacy
   path.
6. **Gesture expansion.** Single-file operations ship in order: attribute →
   prop → insert/remove → move → inline CSS → frontmatter slots. Stylesheet
   intents (multi-file) follow the §3.3 composition rule once a real gesture
   needs them. Adapter surface shrinks monotonically; new features enter
   through intents only.
7. **Capabilities and preview bridge.** Read-only fallbacks visible; dev-only
   markers; stale-checksum rejection.
8. **Code editor on the actor.** Diff-based patches, merge-conflict surfacing.
9. **Deletion.** Compat adapter, legacy mutable tree, WeakSet acks, version
   counters, `n\d+` ids — plus three special cases the actor dissolves:
   `selfWrites.ts` (the actor's own write is a watcher tick whose read matches
   the committed checksum; suppression machinery evaporates), `saveDrainMax`
   (the bounded queue replaces drain semantics), and `rescanChainMax` (one read
   plus one parse per tick removes the chain). End state: snapshots,
   projections, intents, splices.

## 12. Contingent upgrades and rejected options

- **Fingerprint verifier** (one lazy hash of the mapped node's slice against a
  recorded fingerprint): triggered only if the simulator ever produces a
  wrong-site application. Not built on caution.
- **Document service** (version-counter protocol, AI as peer client): promote
  only if a one-day sketch shows the parser's query surface fits a service
  boundary naturally. ⇧⌘C covers the legibility goal until then — and the
  trail is now connected to the core by construction: a trail is a node
  reference resolved at use time through the same mapping as every edit, which
  is the productized payoff of the whole architecture.
- **Rejected permanently.** Identity written into `.astro` files (violates the
  source contract). Whole-file regeneration as a write path (violates
  fidelity). Shell rewrite — the engine boundary is language-independent, and
  swapping Electron for Tauri mid-migration buys nothing the boundary does not
  already give, at the cost of the gate, the suites, and the team's momentum.
- **Superseded.** The earlier `LiveModel` + version-counter recommendation:
  convert mutating modules with minimal fidelity — local mutable mirrors, no
  deep identity design — because step 9 deletes that layer.

## 13. Reconciled against the codebase

A structural review corrected three misjudgments of the first draft; all are
folded in above. The current write path re-serializes the whole file from a
mutated tree, so external edits between parse and write are overwritten — the
write-path change is the real work, not the identity swap. "Renderer owns no
editable state" is a renderer-wide refactor against ~138 measured mutation
sites, and simultaneously the strongest argument for the plan, since the
current parse-order ids do not survive reparse. The contract-layer collision
between `shared/projection.ts` and `shared/page-node.ts` is one owner; rename
before both grow.

## 14. Honest risks

- The simulator is the arbiter. Its seed diversity gates everything; low corpus
  diversity is a failed gate, not a passed one.
- The diff algorithm is the safety margin. Its conservatism must be judged by
  the simulator, not assumed.
- Steady-state cost per edit is one file-scale diff plus one in-memory splice
  and reparse. The pre-registered latency numbers (step 11, item 4) decide; cache diff
  results if they fail. `max diff work` is a measured limit; its conservative
  mapping path surfaces as a typed rejection or a `read-only` capability
  downgrade — never a silent fidelity reduction, or §8's "no silent
  degradation" is broken in the one place it matters most.
- Staleness semantics are looser than a fingerprint scheme: some edits apply
  that fingerprints would reject. The simulator informs whether that trade
  holds.
- The write protocol's `write-race` outcome is a designed admission of a real
  OS limit. Product requirements must carry it.

## 15. Standing rules

AGENTS.md remains normative. Gate green per step. Behavior preservation proven
by parity. Verify before claiming — each step's owner runs the gate and the
simulator before declaring the step done. Commit only per workflow. Improve
only touched code. The earlier plans' feature-coverage and verification
sections carry over; anything they say that conflicts with this document is
superseded by it.
