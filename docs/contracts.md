# Stacki contract surface

The modules in `shared/` define the data that Electron and the renderer may
exchange. Code inside either process may rely on these types only after a value
has passed through the matching parser. Raw IPC replies, file contents,
`JSON.parse` results, browser messages, and drag payloads remain `unknown` until
that boundary check succeeds.

## Page trees

`shared/page/pageNode.ts` is the canonical page model for Astro, Markdown, and MDX.
`parsePageNode`, `parsePageTree`, `parsePageModel`, and `parsePageReadResult`
enforce these invariants:

- Node ids are unique within a tree, and nothing keys on them across
  snapshots (plan §4). Both parsers' ids are structural paths — `n0`,
  `n0.2.1` — assigned once a tree is complete, so a parse is a pure function
  of its text (the Markdown parser's since step 10). `layout` names the layout
  wrapper. The renderer carries its own handles from one parse to the next by
  span mapping (`src/editor/nodeHandles.ts`): `s<16 hex>.<path>` for a node first
  seen in that snapshot, `g<32 hex>` for a node a gesture created.
- `text`, `expr`, `raw-line`, `comment`, and `raw` nodes are leaves.
  Components and elements carry `children: undefined` only when self-closing.
  Branches, loops, conditions, and chunk groups always carry child arrays.
  JSON cannot say `undefined`, so the wire parser also reads a missing
  `children` key, and the `null` written before the absence convention
  (AGENTS.md §6), as self-closing; it always emits `undefined`. The same holds
  for a page result's `bail` and a Markdown model's `layoutPath`.
- Attribute variants are `string`, `expr`, `bare`, or `spread`. The value field
  exists only on variants that need it.
- General `.map()` and `.flatMap()` callbacks carry `bodyParts`: bounded JavaScript slices
  interleaved with their markup children, with exactly one more slice than child. Arrow, async,
  function, typed, destructured, and referenced callbacks are recognized by the
  TypeScript syntax parser. Early returns, nested scopes, and the optional `thisArg`
  stay in those slices; preview markers wrap each markup root as one expression.
  Callback roots are separate expression sites, so the projection marks the container
  with `callback: true`; inserting into it cannot silently choose a return branch.
  Its element attributes and nested markup remain editable through ordinary intents.
  Flat-map callbacks always retain their JavaScript slices, including nested map scopes,
  so the navigator exposes their markup without rewriting the flattening operation.
  Referenced callbacks remain loops without invented children: their markup belongs
  to the referenced implementation, not to the call site.

  TypeScript was already a runtime dependency. Its package is also unpacked beside the
  preview parser because the project's plain Node process cannot load it from ASAR.
- Import slots, attribute order, original tag text, line endings, blank lines, Markdown
  fences, list markers, indentation, and trailing blanks are source-preserving
  data. A parse/write round trip must retain them even when the editor does not
  display them.
- Every tree, depth, attribute collection, import list, string, and Markdown
  metadata collection is bounded by `shared/core/limits.ts`.

The renderer reads the parsed model itself, readonly, through
`src/editor/pageView.ts` (a renderer-only view in which any node's optional fields can be
read without narrowing its kind). Nothing edits a tree in place: a gesture's
effect builds a new model, and the file changes only through intents (step 9;
`scripts/gate/adapterSurface.ts` holds the in-place edit count at zero).

## Page display names

Project scan pages may carry a bounded `title` read from the literal `title` attribute
of the parsed layout wrapper, including imported wrapper chains up to 32 levels.
Relative imports and project aliases use the same resolver in Desktop and Studio.
Cycles, missing wrappers and runtime expressions fall back safely without executing site code.
The optional bounded `inheritedTitle` preserves the wrapper fallback when live overrides are removed;
blank or expression-based overrides suppress inheritance. Studio carries the same parsed scan-page
metadata in `pageMetadata`. The Pages panel, switcher and breadcrumbs show that label, falling
back to the filename for missing, blank, expression-based, or unreadable titles.
The root `index.astro`, `index.md`, or `index.mdx` page always displays as `Home`;
nested index pages use the normal title/filename rule.
Dynamic template basenames such as `[slug].astro` display the parent folder in title case,
with dashes replaced by spaces and `Template` appended. A root-level template displays as
`Page Template`. Their filename and URL patterns remain unchanged.
Folder rows use the same title-case display formatting. Page and folder rows show the original
URL path beneath the label, with centered icons; search highlights literal path matches.
Ordering, dragging and renaming continue to use source paths, including `.stacki/pages.json` keys.
The `name`, `path`, and `route` fields retain their file identities for sorting, folders,
renames, and drag operations. Open-page edits update the label from the live model;
external changes update it through the normal project rescan. Scanning never executes
project expressions to obtain a label.

## IPC

Layout fields may request the rendered page's social image and type through `avb:query`
with `pageMetadata: true`. Both preview clients read Open Graph metadata (or Twitter
metadata when absent), so CMS fallbacks and delegated head components are reflected
without evaluating project expressions in the editor. Replies pass `parsePageImage`
before reaching the field: only bounded project paths and HTTP(S) URLs without
credentials are accepted. Types pass the bounded `parsePageType` parser. Images on
the canonical site's origin are mapped to project
paths for local thumbnails; external CDN URLs remain external. This is display-only;
the page's image and type props stay omitted. Page readiness refreshes the values, and selection,
page and project changes discard stale replies.

Unset layout titles and descriptions use `pageText: true` on the same query channel.
Both preview clients return rendered title and description metadata, parsed as bounded
optional strings by `shared/properties/pageText.ts`. These values only supply placeholders;
they never author props. Explicit overrides and defaults recipes do not inherit the rendered
text. Page readiness refreshes it, and page, project, and layout changes discard stale replies.

`shared/ipc/ipcPayloads.ts` is the channel-to-payload inventory and
`shared/ipc/ipcResults.ts` is the channel-to-result inventory. `shared/ipc/preloadApi.ts`
maps the public preload method names to those channels. A new or changed channel
must update all three files and add known-good and malformed cases under
`test/shared/ipc/` or the renderer boundary's focused test.

Electron handlers call `parseIpcPayload` before using input. Renderer modules do
the same before invoking preload and parse every reply before returning it to a
component. Shared parsers cover common records; feature boundary modules such as
`src/ipc/appBridge.ts`, `src/features/history/historyBridge.ts`, and `src/features/terminal/terminalBridge.ts` preserve
only the fields their consumers use while still validating nested values and
bounds.

`terminal:start` carries the measured `cols` and `rows` used to spawn the native
terminal. Startup and resize share positive, bounded dimensions because Windows
uses signed 16-bit native coordinates. The renderer waits for layout before starting
and for the startup reply before sending resize requests; it rechecks layout after
that reply so resizing during a slow launch is not lost. The preload method and
start result retain their existing names and shape.

Absence is `undefined`, never `null` (AGENTS.md §6): an invoke result states a
value that is not there as `undefined` (a missing thumbnail, an unknown remote,
a deleted side of a merge clash, an empty grid cell). Structured clone keeps
`undefined`, including as an array element, so the renderer's parsers accept
`undefined` and refuse `null` for these fields. A value that was ever written
as JSON — a file on disk, a child process's or dev server's reply — is read
with `null` accepted as absent, at the reader that parses it, because JSON
cannot say `undefined`. JSON's own `null` inside project data (`Data` in
`shared/core/boundary.ts`) is a value and round-trips as `null`.

The `dev:preview-failed` event carries a local HTTP URL through
`onPreviewFailed`. `shared/ipc/previewFailure.ts` validates its length, loopback
host, and absence of credentials, and removes the editor-mode hash. Main only
reports failed subframe navigations on the active preview origin; aborted page
switches are ignored. The renderer only recovers its current page, so a late
failure from a previous navigation cannot reload the new page.

Expected operating failures use `Result` or an explicit result union. A shape
that violates the declared wire contract is a programmer error and throws at
the boundary. Do not catch that assertion and turn it into an operating result.

`git:checkout` automatically parks tracked and untracked edits before switching to an existing
branch, even when Git could carry them across. The dirty check reads disk after editor saves
flush; a clean tree needs neither a stash nor a commit. Returning restores that branch's own
drafts, including staged changes. Creating a branch carries current edits onto the new branch.
A failed switch restores the source drafts. Existing `parkFirst` requests remain compatible;
parking is now automatic. Restoration refuses to overwrite newly introduced local edits.
Before checkout, existing ignored paths are preserved in Git's local exclusions so differing
branch ignore rules cannot stash generated caches as drafts. Shared `.stacki` metadata is
excluded from this inheritance; only Stacki's known generated directories stay ignored.
The Desktop branch action flushes edits, awaits `dev:stop`, then performs checkout and
restarts the preview on success or failure. `dev:stop` waits for the owned process or daemon
to exit; external servers remain untouched. Starting/offline previews hide any stale iframe
URL and expose loading or retry controls instead of a blank connection-error document.

`git:resolveMerge` accepts the existing whole-file and per-change choices, plus a validated
text resolution containing the final edited source, the expected target branch and a canonical
snapshot of every original conflict part. Text results prepare the merge without committing,
then recheck the branch, conflicted file set and each snapshot before writing. A changed merge
is aborted for fresh review; a clean rerun cannot silently discard manual overrides. The result
editor splits independently combined inline edits into individual choices for display only;
the existing three-way merge engine remains the source of automatic combinations.

`git:pull` takes a project path and the currently displayed branch. It fetches that branch
from `origin` with the project's publishing account, then merges through the existing
`WireMergeOutcome` contract. A missing remote branch or changed local branch stops the pull;
uncommitted files are never discarded. Conflicts are unwound for review through
`git:resolveMerge`. The Git panel flushes saves first and refreshes Git and the editor afterward.
`git:incoming` takes the same payload and returns a validated nonnegative commit count.
It reads the advertised branch and fetches missing objects without touching working files,
the index, remote-tracking refs, or `FETCH_HEAD`. A missing remote branch returns zero;
network failures remain unavailable rather than pretending the branch is current.
The project checks every 30 seconds and on window return, with one read in flight and one
coalesced retry. Project, branch, remote, and HEAD changes discard stale results. Pull stays
disabled until the latest branch has a confirmed positive incoming count.


Publishing account sign-in uses `publish:account` with bounded `start`, `status`, and `cancel`
requests parsed by `shared/ipc/publishAccount.ts`. A session belongs to its project and random
identifier and provider; one pending session owns CLI authentication at a time.
Requests may select Cloudflare; omitted providers retain GitHub compatibility. Replies expose only
progress, a device verification code, a bounded Cloudflare OAuth authorization URL, or a
sanitized failure. The URL must use the HTTPS Cloudflare dashboard authorization endpoint. CLI output and credentials never
cross the renderer boundary. Closing the dialog cancels the child; server time and output limits
also terminate abandoned sessions. Local Studio shares this service through its authenticated
API routes; managed Studio refuses changes to server CLI accounts.

Desktop's `publish:siteURL` independently discovers the selected hosting project's public
domain without blocking local deployment-status checks. Its optional string reply passes
`parsePublishedSiteURL`: a bounded HTTPS origin without credentials, ports, paths, queries,
or fragments. Provider credentials stay in the main process. Missing access or an unavailable
provider omits the link unless a configured or saved URL is available; discovery never changes
the deployment receipt or publishes the project. Literal Wrangler custom domains are read without
Cloudflare credentials when the configured account and Worker match the selected destination.
Wildcard routes, paths and environment-specific overrides are not treated as public origins.

When publish settings are absent, URL discovery resolves the same single existing provider link
as the menu; explicit saved destinations, including None, take precedence. The shared menu retains
successful discoveries in an existing `.stacki/publish.json` as `publishedSite`, with its provider,
account/project, canonical HTTPS origin and `manual` or `discovered` source. Inspecting an unsaved
project never creates settings. Writes reread the current configuration and use its witnessed base,
so a late discovery cannot overwrite a new destination or manual URL. A saved link appears before
network discovery and survives unavailable provider access. Manual URLs from Publish settings
override discovery. Links from a different account, project or provider are never displayed.

## Page saves

`shared/ipc/pageSave.ts` is the save contract (plan §11 step 0; since step 10
every page save is an edit). `page:read` results carry `checksum`: the SHA-256
of the exact bytes read, as 64 lowercase hex characters (`Digest` in
`shared/core/brand.ts`, built only by `toDigest`). A page changes only through
`page:edit` (Visual edits and Code editor below), whose request names the
checksum it was authored against; the whole-model `page:write` (retired at
step 10 with `page:serialize`) and the code editor's `page:writeRaw` (retired
at step 8) are gone. An edit that cannot be placed on the bytes the file holds
now is `rejected` with the actor's reason and the checksum on disk. The other
`PageWriteFailure` codes are not refusals: a deleted file is `missing`, never
recreated; `filesystem` and `write-race` cover the rest, `uncertain` is a
write that may have landed and could not be verified (plan §3.5), and
`backpressured` a full actor queue (the edit was never accepted). The renderer
keeps its queued edits on every failure, and the next send names the same
origin. The renderer's `SaveState` union (`src/editor/saveState.ts`) turns a
refusal against other bytes into `conflicted`: autosave stops, the edits stay,
and only "Reload from disk" or a reviewed "Save this version" leaves that
state. A confirmed filesystem failure remains `failed` with its message and a persistent
"Retry save" notification until another attempt or edit. The renderer retries an individual
`page:edit` at most three times after 100/250/500 ms only when a `filesystem` reply names
EPERM, EACCES or EBUSY. Each attempt retains its original checksum and goes through the
actor's normal lock, witness and read-back checks. Conflicts, uncertain writes, missing
files and transport exceptions are never automatically replayed.

Every edit offered by the visual editor is expected to save through that editor.
An `unsupported-operation` remaining after the node and page rewrite fallbacks is
an editor defect, not a product limitation or a reason to send the user to code.
Report the failed operation as an error, preserve undo for earlier successful writes,
and cover each discovered defect with a regression test. Conflict review must include
every queued edit or fail without replacing the draft; it must never omit failed edits.

Since step 5 every write of project text — page, chunk, style re-write,
stylesheet, code window, CMS and asset edits, component-property batches — is
an intent to the file's document actor (see Document actors below), which
writes through `electron/documents/atomicWrite.ts`: a temporary file in a stable
project `.stacki/io` directory on the target filesystem (`wx`, the target's mode and
owner, fsync), one rename, an fsync of both changed directories, then
the actor's own read-back, which reports another writer as `write-race`.
The staging directory stays outside source trees: Astro stats directory
entries before ignoring dotfiles, so deleting save files directly beside a page
can crash route discovery. Both `.stacki` and `io` reject links and mount points on other devices.
Staging uses the nearest ancestor with `.stacki` or `package.json`; standalone files
use their parent. Locks hash the target directory identity and filename so equal filenames in separate
folders do not contend. Generated `.stacki/io/` files are locally excluded from Git.
Write failures cross `page:edit` as `filesystem` and stay queued for the next save;
write races use `write-race` and reconcile against disk before another attempt.
Neither is an unsupported visual gesture that should be withdrawn.
Encoding: files are UTF-8; page reads decode strictly (invalid
UTF-8 is an error, never a lossy replacement); line endings round-trip
untouched; a leading byte-order mark is read past by the parsers and, since
nothing rewrites a file whole, never touched by a write.
Reviewing a conflicted page's unsaved edits in code (plan §7): the page's
queued gestures go through `page:previewEdit` — an `EditRequest` plus
`source`, the bytes at its `authoredChecksum` — which main plans exactly as
`page:edit` would and never writes (`electron/documents/editPreview.ts`); the reply has
`page:edit`'s shape, so the next request is stated against it. A request that
names other bytes than it sends is a broken caller and throws. The reviewed
text is the origin's bytes spliced, never a reprint. `test/fixtures/round-trip/`
holds the byte-exact Astro, Markdown and MDX fixtures (CRLF, BOM) the parsers
and printers must reproduce.

## Editor core (plan steps 1–10)

The contract layer of `docs/stacki-editor-core-plan.md`, since step 2 the
diff, the span mapper and the pure planner, and since step 5 the document
actor. Every operation of the union is planned and submitted (steps 6–10);
no operation replaces a whole file.

- `span.ts` — `ByteSpan` and `Utf16Span` over the branded `ByteOffset` and
  `Utf16Offset` (`brand.ts`); mixing them is a compile error. The only
  conversion is `utf16ToByteOffsets` (one linear pass; an offset inside a
  surrogate pair asserts). `ByteString` is a private copy of a file's bytes,
  always a plain `Uint8Array` — never a Node `Buffer`, whose `slice` is a view
  (a `Buffer` from `fs.readFileSync` is copied, not aliased);
  `decodeUtf8` is strict and returns `invalid-utf8` instead of replacing.
- `ref.ts` — `AnchorRef`: a byte span, a structural path of `ChildIndex`es, and
  the expected kind (a page-tree kind, `frontmatter`, or `document`). Node
  anchors have a path; the other two do not; a document anchor starts at 0.
- `intent.ts` — `Intent` (id, file, `authoredChecksum`, anchor, operation), the
  closed `Operation` union (step 10 replaced the whole-file `replace-source`
  with `rewrite-text`: a program's change as hunks of the bytes it read),
  `SubmissionResult` (`accepted` | `backpressured`), the terminal `Outcome`
  (`applied` | `rejected` | `uncertain`) and the nine `REJECTION_REASONS`, each
  with notice text. `parseIntent` checks every anchor/operation pairing,
  multi-span sites (inside the anchor, ascending, disjoint, at most
  `splicesPerIntentMax`) and the summed UTF-8 payload.
- `capability.ts` — `editable` | `read-only-opaque` | `repeated-source-node` |
  `runtime-aggregate` | `unsupported`; `editable` and (since step 7)
  `repeated-source-node` accept visual intents: a node a loop repeats is one
  source node, and an edit of it changes every copy. Sibling placement inside
  an element or component preserves that markup list and its loop bindings;
  placement beside a direct loop or branch return root remains refused because
  that list is JavaScript. A stale intent whose node changed capability
  since it was authored — wrapped in a loop outside Stacki — is refused
  `region-externally-modified`. The renderer shows every other capability
  beside the selection (`src/editor/nodeCapability.ts`, `CapabilityNotice`).
- `sourceProjection.ts` — the `Projection` sum (`valid` with byte-addressed
  nodes, paths, attribute spans and capabilities, and the text's UTF-16 length,
  which the parser bounds; or `parse-error` with bounded diagnostics). Named so
  nothing in it can be confused with the `pageNode.ts` wire model. `.astro`,
  and since step 10 `.md` and `.mdx`: each node says how it is written
  (`syntax`: `markup` or `markdown`) and which list it sits in (`list`:
  `markup`, `blocks`, `items` or `inline`), which the planner's Markdown rules
  need (`planMarkdown.ts`, Markdown below). Stylesheets project as opaque
  documents.
- `snapshot.ts` — `createSnapshot` computes the checksum from the bytes through
  an injected hash (the renderer has no `node:crypto`) and asserts the
  projection measured the same bytes. There is no version field.
- `diff.ts` (step 2) — `diffBytes(source, target, budget)`: Myers' O(ND) byte
  diff run in both directions, so `distanceBefore` / `distanceAfter` give the
  prefix and suffix edit distance of any grid point; `diffHunks` prints one
  minimum script. Budget: `LIMITS.diffWorkMax` (byte comparisons plus frontier
  cells) and `LIMITS.diffDistanceMax` (frontier memory); exhaustion is the
  typed `too-costly`, never a partial diff.
- `mapSpan.ts` (step 2) — `mapSpan(lastKnown, current, span, budget)` →
  `resolved` (every minimum edit script keeps the span whole at one place) |
  `gone` (none keeps it whole) | `ambiguous` (they disagree) | `too-costly`.
  Decided from two columns of the span; `test/simulator/referenceDiff.ts`
  checks every column and the suites assert they agree.
- `planner.ts` (step 2) — `Splice`, `Plan`, and the pure
  `planIntent({ authored, current }, intent)` → `Result<Plan, RejectionReason>`.
  Plans `set-attribute` only: it maps the element's name-through-last-attribute
  region through the diff and splices the mapped value, with the authored value
  as its witness; `ambiguous` → `anchor-ambiguous`, `gone` → `anchor-moved`,
  `too-costly` → `resource-limit`. A resolved region must occur once in the
  current file and once in the authored one: a repeat in either, and the
  minimum script may name a copy or a surviving twin (step 10), so it is
  `anchor-ambiguous`. `rewrite-text` (step 10) is never mapped: one splice
  per hunk, each witnessed by the authored bytes it replaces (stale →
  `region-externally-modified`). Every other operation is planned since steps
  6–10 (Visual edits below). Equal checksums skip the diff;
  `planIntentThroughDiff` is that fast path's reference.
- `splice.ts` (step 5) — `witnessesHold`, `applySplices`, `changedRanges`:
  the one implementation of the write primitive, shared by the actor and the
  simulator.
- `documentActor.ts` (step 5) — the actor as pure steps (idle → planned →
  written → idle, plan §5.2) over an injected `DocumentDisk` (read, advisory
  lock, atomic replace), planner and `Projector`. `submitIntent` answers
  `accepted` or, at `intentsPendingMax`, `backpressured`; every accepted intent
  reaches one `Outcome`; a replace whose directory could not be flushed, or
  whose read-back fails, is `uncertain` with the candidate checksum;
  `reconcileUncertain` resolves one by comparison. The actor never retries and
  never merges. `createLazySnapshot` (`snapshot.ts`) derives a projection on
  first read.

The parser (`parsePage(text, { locs: true })`) reports `start`/`end` on every
node — branches and inline-run gap spaces included — and `attrSpans` on every
tag: the whole attribute, its name and its value, in UTF-16 offsets.
`parsePageNode` validates them against the node's range and its props record.
The span-integrity suite (`test/shared/core/spanIntegrity.test.ts`) slices every
node and attribute of every corpus, round-trip, editor-core and large fixture
and requires the reported text back, in UTF-16 and in bytes. The Markdown
parser (step 10) reports the same for `.md` and `.mdx`: every node's range,
however deep its containers, and a `markdown` attribute span for what Markdown
writes in its own syntax (an image's alt, source and title, a fence's
language, a list's first number); `test/electron/parse/markdownSpans.test.ts`
holds every Markdown fixture and a seeded corpus to it.

Every bound lives in `limits.ts`, including `sourceBytesMax` (merged up from
`electron/lib/mainLimits.ts`) and the engine bounds of plan §8.

Fixtures: `test/fixtures/editor-core/` is the hostile corpus (loop rename,
kind-changing move, page + stylesheet, frontmatter slot, identical siblings,
BOM/CRLF/astral text, conditionals, a malformed page; since step 10 Markdown
lists, fences under BOM and CRLF, MDX JSX blocks and a tight block gap), each with a
hand-written `*.expected.*` output; `test/simulator/oracles.ts` holds the
hand-derived splices. `test/fixtures/large/manifest.json` pins the generated
large fixtures (`npm run fixtures:large` writes the files).

The simulator (`test/simulator/`, `npm test -- simulator/`) drives the real
parser, the planner and a step-wise actor over a fake disk with a seeded PRNG,
and checks the nine invariants after every event. The actor plans every
operation with `shared/engine/planner.ts` (mapped through the diff when stale); each
queued intent carries the snapshot it was authored against. Every stale
decision on a tag's name or attributes, and (step 10) every stale Markdown
block edit, removal, insertion and move, is judged against byte origins the
simulator records for every writer (`provenance.ts`, `remapJudge.ts`): a
wrong-site plan fails the run. Its
`diff`, `map-span` and `planner` suites hold the step-2 modules to their
brute-force references and to hand-derived byte ranges.
`STACKI_SIMULATOR_SEEDS=<n>` raises the seed count for a long run;
`npm run spike:editor-core` prints the step-3 spike report (not in the gate).

Lint fences (`eslint.config.mjs`): an existing file changes only by splices,
so the printers are fenced. `serializePage` and `serializeNodes` may be
imported or called only in `electron/parse/astroParser.ts` (which re-exports
`serializeNodes` from `astroSerialize.ts`, where it is defined), `componentFile.ts` (new
files: a component made from a piece of a page, a new page),
`editRequests.ts` (only the nodes and frontmatter block an edit adds) and
`markdownParser.ts`; `serializeMarkdownPage` only in `markdownParser.ts`,
where it is the round-trip oracle and never a write path (step 10). Tests may
use both. `scripts/gate/adapterSurface.ts` also counts whole-file write sites (the
`replace-source` operation or a `replaceSource(` call) in `electron/`,
`shared/` and `src/`: zero since step 10. The simulator core (all but its `*.test.ts` and
`*.bench.ts` entry points and the `*.entry.ts` modules they import) and the
engine contract modules may not use timers, clocks, promises, `Math.random`,
`process` or I/O modules. `scripts/gate/adapterSurface.ts` runs in the gate as a ratchet on the
legacy tree-mutation surface (method in its header).

## Visual edits (step 6)

`page:edit` carries an `EditRequest` (`shared/engine/editRequest.ts`): a gesture in
the terms of the page the renderer shows — node references are the path, kind
and UTF-16 range of its parse — against that parse's checksum. Main turns it
into an intent (`electron/documents/editRequests.ts`: references checked against its own
projection, ranges converted to bytes, new nodes and the frontmatter block
printed, loop-rename sites found) and the page's actor plans and writes
splices. The reply (`shared/ipc/pageSave.ts`, `parsePageEditResult`) is the page
as written and the inverse hunks Undo sends back as a `revert` request; a
refusal is `rejected` with the actor's reason and the checksum on disk. An edit
authored before the actor's own recent commits is rebased exactly
(`shared/engine/rebase.ts`); one authored before an outside write is mapped through the
diff from a retained snapshot; one whose bytes are gone is refused. Every
unchanged subtree moved by the planner carries its before/after byte spans in
the commit log, so queued edits follow that subtree and its descendants even
among identical siblings. Moves that rewrite loop bindings or Markdown prefixes
do not claim an unchanged byte image. Deleted nodes still reject later edits.
Every operation is planned (`shared/engine/planner.ts`, `planTree.ts`, `planText.ts`,
`planSupport.ts`, `loopScope.ts`, `inlineStyle.ts`); `remove-node` and
`revert-splices` joined the union. `page:read` reads through the page's actor.

Property batches are undoable: `component:editProperties` answers with an undo
token, and `component:revertProperties` applies that batch's inverse — every
file checked against the bytes the batch left — and answers with the redo
token. Main keeps the batches; the renderer holds tokens only.

The renderer's half (`src/editor/pageEdits.ts`, `src/editor/editGestures.ts`) and the gesture
parity suite (`test/renderer/editor/gestureParity.test.js`) are described in the tracker,
Step 6.

When a specialized visual request cannot represent valid source syntax, the
renderer first derives `replace-node` requests for the smallest stable changed
nodes. If no stable node contains the structural change, `replace-page` carries
the predicted model to main. Main prints the authored and predicted models only
as semantic witnesses, diffs those witnesses, and maps each changed hunk onto
the authored bytes; formatting-only regions are never replaced. Ambiguous
placement is rejected. Both fallbacks therefore remain ordinary bounded
`rewrite-node` or `rewrite-text` intents, with the same checksum, conflict,
undo, and parse guarantees as specialized edits.

## Code editor (step 8)

The code editor saves through `page:edit` too: a `code-patch` edit carries the
byte diff from the text it read (named by `authoredChecksum`) to the text it
holds, as ascending, disjoint hunks `{ span, expected, text }` of those bytes
(`shared/engine/codePatch.ts`, `diffCodePatch`; the wire parser in
`shared/engine/editRequest.ts` checks the shape and bounds). Main checks every hunk
against the named bytes — inside them, on code-point boundaries, holding
`expected` — and submits `apply-code-patch`. The patch may leave the page
invalid (plan §3.6): the reply is then `editable: false`, and visual edits are
refused `source-invalid` until a later patch makes it parse. Bytes past
`intentPayloadBytesMax` are refused `resource-limit` (the renderer's diff
refuses them first); a stale patch maps through an outside edit with context
or is refused `merge-conflict`, as is one whose bytes the host no longer holds
or whose witness does not hold; behind the app's own commits it rebases only
where no commit touched a hunk (`shared/engine/rebase.ts`, `shiftUntouched`). Code
patches apply to `.md` and `.mdx` pages too. The renderer's side
(`src/editor/codeEdits.ts`, the `code` queue in `src/editor/pageEdits.ts`) is described in
the tracker, Step 8.

## Markdown and MDX (step 10)

`.md` and `.mdx` pages are on the engine like `.astro` pages: their gestures
are `page:edit` requests, their actor projects them with the Markdown parser,
and nothing prints one whole. Main drafts a Markdown node's intents
(`electron/documents/markdownEdits.ts`): new content — typed text, a heading level, an
image's source or alt, a fence's language, a list's first number — is the node
printed before and after the edit at its place (its containers' line prefix,
`shared/engine/markdownLayout.ts`, and the file's line breaks), the difference placed
on the node's own bytes as `rewrite-node`; new blocks and items are printed
where they go and inserted beside a neighbour; the YAML frontmatter is the
slot that differs or, on a page without one, `insert-frontmatter` at its top.
Markup inside MDX is drafted as on an `.astro` page. `electron/documents/editAnchors.ts`
holds what both front ends share.

The planner's Markdown rules (`shared/engine/planMarkdown.ts`): a Markdown block is
no tag, so tag and attribute operations refuse it; a list and its first item
start on one byte and resolve by depth; inline text is never removed, moved or
stood beside; a new or remaining block is separated as its neighbours are, and
a gap of one line break between blocks is rewritten with a blank line on each
side; the only item of a list takes the list with it; a moved block's
lines take the destination's prefix, and items move only among items with
their marker. The value-splice projection patch refuses Markdown pages:
typing there can change structure, so they always reparse.

## Preview bridge (step 7)

The canvas is the project's own dev server in an iframe. Its source markers
exist only in memory: the generated preview config's Vite plugin hands Astro
`electron/previewServer/previewMarkers.ts`'s marked copy of each `.astro` file under `src`,
and that module reads and returns strings — it writes nothing, and no app
module imports it (`test/electron/previewServer/previewBridge.test.ts` holds both, and runs
the real generated plugin over a project whose bytes it compares before and
after). The generated config itself lives in `node_modules/.avb`.

Style queries (`avb:query`) read computed properties from the rendered element.
A plain text node uses the parent of its live marker run for computed properties
and color resolution only. For inline text without markers, the renderer may
explicitly supply `textParentPath` after identifying a nonempty text node in its
current selection. The frame validates that this names the immediate parent and
uses only that parent's exact, focused DOM mapping for style reads. Ordinary
missing-element queries never opt into this fallback. It does not borrow the
parent's identity, classes,
or selector matches, so reading inherited values cannot retarget visual edits.
Replies also carry optional `authoredProps`, a bounded string map validated by
`parseCanvasReply`. Unset text fields prefer the winning declaration's original
units and expressions; swatches and option highlights keep using computed values.
The frame temporarily mirrors declarations into registered custom properties so
Chromium resolves specificity, layers, conditional rules, and inheritance. Reads
restore the styles synchronously, and those temporary mutations do not invalidate
the canvas. Inaccessible stylesheets or exhausted inspection limits fall back to
computed values. Displaying a hint never authors an override or borrows the parent's
edit target. Replies may also carry `inheritedSources`, parsed with the shared
`properties/styleSource.ts` contract. Each source names the supplying DOM ancestor
and its optional preview path. A noninheriting twin of each probe distinguishes a
local declaration from inheritance, including the same rule applying at both levels.
Plain text counts its rendered host as a parent. Labels use this metadata for orange
provenance and can select a source only if its path resolves in the current tree;
browser defaults and unavailable sources remain unmarked. Source metadata shares
the value cache's selection and history invalidation and never becomes editable CSS.

- `previewToken.ts` — every marked file also carries one stamp for the exact
  bytes it was marked from. It is written as
  `<!--avb-d:<sha256>:<project-relative path>-->` and carried on the file's
  root markup as `data-avb-d`; the attribute survives components that render a
  slot to a string and strip comments. The frame collects both forms into a manifest (sorted
  by path, one entry per file, at most `previewManifestFilesMax`; one file with
  two checksums is no manifest) and its token is the SHA-256 of
  `canonicalManifest`. The frame announces `avb:render` `{ token, stamps }`;
  `avb:hover-node`, `avb:click-node` and `avb:open-node` carry `token` (null
  until the digest is known). `parsePreviewRender` and `parseStampData` reject
  forged shapes: page code can write any comment.
- `preview:check` `{ projectPath, render }` → `PreviewVerdict`: main re-derives
  the token from the manifest, then reads every stamped file from disk
  (`electron/preview/previewCheck.ts`; a path outside the project is `missing`, a file
  past `sourceBytesMax` changed) and answers `current` or `stale` with one of
  `PREVIEW_STALE_REASONS`.
- The renderer (`src/features/preview/previewGate.ts`) accepts a click or double-click only when
  the event's token is the frame's latest, the open file's stamp is the bytes
  the editor shows (the clean checksum, or the origin while unsaved edits keep
  every path), and main answers `current` — judged again after main answers. A
  refusal is a notice; nothing is selected. Hover needs the latest token only.
  During a local render backlog, ordinary clicks may resolve through one of the
  last eight saved origins of the open file (`previewSelection.ts`). The old
  path names a stable node handle, which is resolved again in the current model;
  a move never reuses the old numeric index and a deletion never selects its
  neighbour. The original manifest digest is verified, only the open file's
  known stamp is replaced with its current origin checksum, and main checks
  that manifest against disk. Navigation, another save, an unknown origin or an
  outside change still refuses the click. The runtime rechecks the frame token
  after the asynchronous gate returns. Context actions retain the strict gate.
  Markdown and MDX pages carry no stamp: their markers come from the Markdown
  processor's tree, which never sees the file's bytes (carried at step 10);
  their layouts' stamps are still checked, and every edit is checked by main.
- The canvas patch (`electron/previewClient/`, the caps in `morphBudget.ts`) is bounded by
  `previewMarkersMax` markers per rendering and `previewMorphWorkMax`
  child-list matrix cells per patch; main prepends `AVB_PREVIEW_LIMITS` from
  `shared/core/limits.ts` to the source it serves. Past either the page reloads and
  first posts `avb:preview-reload` `{ reason }` (`markers-over-cap`,
  `diff-over-cap`, `scripts-changed`, `patch-failed`); the app shows the caps.

## Document actors (step 5)

`electron/documents/documentActors.ts` hosts one actor per canonical file in the main
process and steps each submission to its outcome before returning (main's
handlers run one at a time; the queue bound still holds). `documentWrites.ts`
installs the process's host and is the only entry point for writing project
text: `writeProjectText` (witnessed by the bytes on disk now; a missing file is
created) and `createProjectText` (never overwrites). A program's write is
`writeText(file, text, base)`: the hunks from the bytes at `base` to `text`,
submitted as `rewrite-text` (step 10); a text equal to the file's writes its
bytes back unchanged (one empty hunk). No write is repeated to refresh the
canvas: the preview config compiles a file whose `<style>` changed before Vite
announces the new stylesheet (`avbRecompile`, `electron/preview/markerConfig.ts`). Each
chunk file has its own actor; `component:editProperties`
leases its files' actors in sorted canonical order and witnesses each by its
`before` checksum, with the checked rollback as intents too.
`documentDisk.ts` is the real disk: bounded reads, a lock file inside the target's
project’s `.stacki/io` directory (dead or old owners broken), the atomic replace, exclusive creation,
and canonical keys (directory identity plus the name, case-folded where a probe
shows the directory ignores case). Bounds: `documentActorsMax`,
`documentBytesRetainedMax`, `intentsPendingMax`, `parseTasksInFlightMax`,
`watcherFilesPerTickMax`. Telemetry (`documentTelemetry.ts`, plan §9a): one
JSON line per outcome, backpressure, save-guard conflict and leaked lock, with
a running count, the intent id and a 16-hex-character path hash — never a path
or source bytes.

Proofs: `test/electron/documents/singleWriter.test.ts` inventories every file-writing
call in `electron/` against a reasoned allowlist and pins one owner each for
the write primitives, the disk and the host; `test/electron/documents/` runs the write
protocol on real filesystems and processes (modes, ownership, flush order,
symlinks, continuous readers, cooperating writers, crashes between replace and
verify, NTFS replacement semantics and case-insensitive names where a Windows
filesystem is reachable). The step-5 parallel run against the pre-step-5
build (`test/legacy-parity.bench.js`) was retired at step 10 with the
`page:write` channel it drove; its results are in the tracker, Step 5.

## Other shared contracts

- `brand.ts` constructs `NodeId`, `FilePath`, `ProjectPath`, `Digest`,
  `ByteOffset`, `Utf16Offset`, and `IntentId` after validating the primitive value.
- `projectScan.ts` validates project pages, layouts, components, schemas, and scan
  collection limits.
- `propSchema.ts` validates component field schemas and their nested options.
- `frontmatter.ts` validates import members and source slots.
- `boundary.ts` supplies bounded primitive, list, dictionary, and data parsers.
- `result.ts` defines the expected-failure channel.

## Required gate

Run `env -u ELECTRON_RUN_AS_NODE npm test` before merging. The gate cleans and
rebuilds `dist/`, compiles Electron and shared contracts, type-checks and
bundles the preload and the morph client, builds the
renderer, runs strict `tsc --noEmit`, ESLint, Prettier, the policy scan and the
adapter-surface ratchet, and then every test suite: each `*.test.js` and
`*.test.ts` under `test/`, found by name (`scripts/gate/testDiscovery.ts`).
Generated JavaScript belongs only in `dist/`; source folders must contain
TypeScript and source assets.

The builds run in order; the static checks then run side by side, and the
suites run in a bounded pool (`scripts/gate/testPool.ts`, default one fewer
than the CPUs, `npm test -- --jobs=<n>` to change it, `--jobs=1` for a serial
run). A passing suite prints one line; a failing one prints its full output.
The suites that measure timing, depend on read ordering, or drive a real
window run last and alone, as `scripts/gate/testSuites.ts` says, which also
names the two whose failures are tolerated and why.
A new test must write only to its own scratch path under
`node_modules/.stacki-test/` (or a `mkdtemp` directory) and bind no fixed
port, so it can share the pool.

## Desktop Studio setup

`studio:status` inspects the open project's Studio installation; `studio:install`
accepts only that project's path and a source choice (`published` or `file`). Main
chooses the current desktop version from the official release feed in packaged apps.
Development apps use the matching generated bundle in the application checkout's
`studio/release/` directory, never a bundle from the open website. The legacy file
source uses the native file dialog and is not exposed by the setup UI. `shared/ipc/studioSetup.ts`
validates results; `shared/ipc/studioRelease.ts` validates the release itself.
The installer stages dependencies, type checks and a build before activation,
uses the same lock as CLI updates, and refuses an existing Studio directory.
Cloud authorization and deployment remain an explicit agent-assisted handoff.

Each installation carries a bounded `requestId`. The `studio:progress` event echoes
that ID and the requested project path alongside the current stage and a bounded
tail of command output. Preload exposes `onStudioProgress`; the renderer parses
each snapshot before use and ignores other projects or previous attempts. Main
batches output at 150 ms intervals, flushes on stage changes and completion, and
caps command time and output. Progress counts completed stages, not elapsed time.

The managed website preview starts installed Studio and serves an entry page at its
own `/studio` URL. A private loopback server isolates Studio's module graph from the
desktop canvas instrumentation; the entry embeds that editor while preserving the
website's address. Both servers use the original project source, so local Studio saves
edit website files directly. Local editing needs no Cloudflare configuration. Session
state lives in a self-ignored `.studio-state` directory, not a copied draft workspace.
The website preview owns the child process and closes it on shutdown. Missing Studio
is checked again when `/studio` opens so a new installation works without a restart.
Startup and health probes are bounded; failures leave the website preview available.
The terminal stays closed. Setup displays the generated preview configuration command
for later use. Hosted Studio retains its separate draft and publish workflow.

## Desktop preferences

File → Settings opens a modal from both the welcome screen and an open project.
`settings:get` returns sound and anonymous usage-count preferences; `settings:set`
accepts one named boolean preference and returns both current values plus `saved`.
A failed disk write applies only to the current session and is shown in the popup.
Disabling usage counts still aborts in-flight counting. Studio setup is available
in the same popup when a project is open.

## Shared project editor metadata

`.stacki/components.json` (version 1) stores insertion recipes keyed by project-relative
Astro paths. Recipes contain primitive `props` and either literal `text` or ordered
`children`; children name a component path or HTML `element`, or hold `literal` text.
Component children may override their recipe. Captured canvas children use `inherit: false`
to preserve removed props as well as additions. An omitted child
content uses that component's recipe, while `children: []` explicitly inserts empty content.
The shared parser bounds stored nodes, depth, text, fields and file size. The resolver
rejects missing references, unknown slots, cycles and excessive expanded node counts.
Unconfigured projects retain shared starter recipes; the first defaults save makes those
recipes explicit project data. Existing page instances are never rewritten.

`.stacki/guide.json` contains `{ version: 1, settings: ... }`. Guide fields are validated
against shared bounds before storage and consumption. Browser storage is consulted only
when the project file is absent, for migration. Changes use a single pending value and
serialized writes; conflicts stop saving until the user reloads the project settings.
Opening a project without saved guide preferences uses defaults in memory. It does not create
`.stacki/guide.json`; the first guide edit or migration of a readable legacy record creates it.

`.stacki/pages.json` contains `{ version: 1, entries: [...] }`. Entries are relative to
`src/pages`; folder keys end in `/`. Desktop and Studio apply the same order to sibling pages
and folders. Reordering through gaps does not rename files or change routes. Unknown/new entries retain the
default relative order after saved entries. Writes are witnessed and serialized; stale saves
restore the previous order and offer a reload in a toast. Reads and drag payloads use the shared
bounded parser. Desktop retains move-into-folder drops on folder rows. Pages and Navigator
use `src/ui/TreeDragDrop` for gap targets, row feedback, and drag cancellation.

`project:metadata` and `project:writeMetadata` accept only registered metadata kinds.
Desktop confines them to the open project and writes through the document actors against
the supplied base. Studio exposes the same records through `/studio/api/metadata`, its
serialized document rooms and durable draft storage. Neither endpoint permits arbitrary
metadata paths. Settings writes reject stale bases rather than overwriting newer edits.
Each metadata save creates `.stacki/` when needed, independently of the guide file. Saving slot
component defaults, publish settings, page order or component sources never requires opening or
changing the guide first. Reads and invalid writes do not create project settings files.
These files participate in Studio publishing and GitHub sync. The legacy local `.stacki/`
Git exclusion is narrowed to `.stacki/preview/` and `.stacki/canvas/`; user-authored ignore rules are untouched.

Component defaults are opened from the last component context-menu action, “Set component
defaults”, in Desktop and Studio. Client mode disables the action and cannot save defaults.
A bounded temporary page `.stacki/canvas/<uuid>.astro` copies the current source context and
replaces only the selected instance with its resolved default props, text, and children.
Module imports are rebased for the temporary location. Surrounding navigator rows are dimmed
and cannot be selected or receive drops; canvas focus uses the ordinary component focus overlay.
“Close defaults”, Escape, and a click outside the focused canvas subtree save and close the
defaults session. Explicit boolean and enum choices remain stored even when they match an
Astro fallback, so the inspector marks them as set. Defaults mode leaves unset text fields
empty. Boolean and enum controls show the fallback while their blue labels still require
an explicit override. Authored Content is blue in both modes; resetting removes the authored
children so Astro supplies its slot fallback (or empty content). Resetting a prop removes that
override.
Closing captures the edited subtree for future insertions and restores the original
file and navigator selection. Authored Astro files are unchanged. A stale metadata save keeps the editor open with a
recoverable error. Save also checks that content outside the target has not changed.

The scratch page uses normal document edits and the injected `/__avb/preview?defaults=<uuid>`
route. Desktop creates/removes it through `project:createDefaultsCanvas` and
`project:removeDefaultsCanvas`; Studio uses the equivalent `/studio/api/defaults-canvas` endpoint.
Temporary canvases are excluded from publishing and removed on close. Saving rejects
expressions that depend on page scope because those cannot be safely reused as defaults.
Entry and exit keep the preview frame alive. The parent sends `avb:preview-route`; its shared
parser accepts bounded same-origin HTTP(S) transitions only when one side is a defaults route.
The preview fetches that rendering and morphs it in place, replacing its source stamps as well
as content. Studio also updates its render subscription, and obsolete responses cannot repaint
the previous mode.
Relinking a moved component updates owner keys and nested references together and refuses
collisions. Current file rename UI is page-only; external component renames must update the
metadata references too. The installed Studio CLI's
`check-project` command validates component references and guide settings for CI/refactors.


## Historical file diffs

`git:commitDiff` accepts a project path, a full SHA-1/SHA-256 commit hash, a repository-relative
file path, and an optional previous path for renames. The shared parser rejects ambiguous refs,
path traversal, empty paths and oversized strings. The renderer parses replies as a bounded
`Result<string, string>`; operating failures remain visible instead of masquerading as empty diffs.

Git reads the selected commit against its first parent (or the empty tree for a root commit),
using literal pathspecs and disabling external diff/text conversion programs. The working tree
is untouched. Patches exceeding 500,000 characters or 10,000 lines return an explicit error;
smaller patches retain binary/rename metadata and validated hunk line numbers for inspection.

## Project publishing

`publish:account` reports `installing` while Cloudflare sign-in adds a missing project Wrangler as
a development dependency with the site's package manager (package.json's `packageManager` field,
else its lockfile, else npm). Only an explicit sign-in start can trigger installation; discovery
and status polling cannot. The same session continues to browser sign-in after a successful
install. Cancelling skips login but lets the package manager finish, so node_modules is never left
half written; another sign-in is refused until it does. A ten-minute installation timeout or
excessive output stops the process tree and prevents login. Installer output is discarded, and
failures expose only sanitized messages. Login retains its separate five-minute timeout. Existing
project/workspace dependencies skip setup.

`.stacki/component-sources.json` registers bounded, read-only installed component roots for both
hosts. `shared/properties/componentSources.ts` parses package names, relative directories and
import prefixes. Scan entries carry a discriminated `origin`: local or package with an explicit
import specifier. Package identity remains its project-relative `node_modules` path, distinct from
the canonical filesystem location and insertion import. This prevents a local copy with the same
name from silently replacing the package. Only configured roots are scanned; linked package roots
are supported, internal links are refused, and ordinary document writes still reject installed files.
The shared metadata transport includes these settings, so sync and publishing preserve them.

The optional `githubWorkflow` in publish settings selects `direct` or `pull-request`. Absence
preserves direct publishing. A successful review returns `review-open` with the validated
`ReviewReceipt` from `shared/properties/publishReview.ts`; this state is not a published revision.
Review branches identify their parent and captured tree, so retries recover an unchanged branch
and open PR. New content produces a new review; changed branches and closed PRs require attention.
Review submission does not advance the draft baseline, clean assets, run hooks or deploy. Hosted
review credentials use the authenticated `/studio/internal/review-connection` endpoint and add
Pull requests write permission to the existing repository-scoped Contents write permission.

`.stacki/publish.json` is shared metadata parsed by `shared/properties/publishConfig.ts`.
It stores provider/project identifiers, a Desktop GitHub username, and bounded npm script names;
credentials stay in each host's authentication store or environment. Metadata reads and writes use
the existing witnessed, conflict-checked project metadata transport.

`defaultTarget` selects the main Publish button's action: `all`, `github`, or `hosting`.
Missing settings and older version-1 files default to `all`. Desktop and Studio share the
same settings form and resolve this preference from project metadata when Publish is clicked;
the dropdown's explicit destination actions do not change the saved preference.

`publish:start` accepts a project path, `all`, `github`, or `hosting`, and an optional validated
`commitMessage` (1–4000 trimmed characters); `publish:state` accepts
that project path. Both return `DesktopPublishState`, parsed by `publishState.ts` before renderer
use. One Desktop job runs at a time. Failures preserve which external actions completed, so a
hosting retry cannot be mistaken for rolling back a successful GitHub push. Studio's publish
route accepts the same target and reads the same config before selecting Git-only or hosting work.
Desktop resolves `github`, and `all` with hosting `none`, to a Git-only plan. It captures a bounded
private index/tree without checking out files or running build/publish scripts. Hosting plans
retain isolated snapshots and scripts. The Git inspection budget is 100,000 files / 8 GiB;
the hosting checkout budget remains 10,000 files / 256 MiB. NUL-separated file and tree listings
are streamed with bounded records, buffers, work and time. Source, branch and HEAD are rechecked
before committing; the staged and committed trees must match the captured tree. Incoming remote
commits return a failure directing the user to the existing Pull flow, without merging or stashing.
Operational failures in capture, inspection and commit return `Result`; invariant failures escape.
Running Desktop states may include validated `progress` with completed and total stages
(at most five). The dialog uses an indeterminate bar until this is known, then advances only
when a stage completes. Successful URL-based pushes update the matching origin tracking ref;
failed pushes leave it unchanged, and concurrent newer tracking refs are preserved.
Desktop prompts for a message after flushing edits when GitHub publishing needs a new commit.
The backend also refuses to build or commit dirty changes without a message. Existing commits
push without a new message, and hosting-only publishing does not require one.

`publish:availability` may include `githubPush` with a bounded commit count and a validated
HTTPS GitHub repository URL. The count compares HEAD to the destination branch on origin and
includes the commit Publish will create from the current worktree. A new remote branch counts
the local history; staged-only differences that Publish would discard do not add a commit.
The Publish menu owns push status and its independent repository link; the Git panel owns
local branches and commits. Saves and refreshed Git state invalidate the menu's count.

`publish:discover` accepts `{ projectPath, request: { provider, account } }`, where provider is
Cloudflare, Vercel or GitHub and an empty account requests available connections/linked projects.
`shared/properties/publishDiscovery.ts` parses bounded account labels and hosting destinations.
Failures carry a sanitized message, never provider credentials or command output. Studio exposes
the same discovery service at `/studio/api/publish/discover`; both hosts preserve saved publish
destinations. When publish settings are absent, an explicit
Publish action can import a single complete existing provider link through the witnessed metadata
write before starting the job. Ambiguous or incomplete links still require settings.

`publish:repository` accepts bounded `list`, `create`, and `connect` requests parsed by
`shared/ipc/publishRepository.ts`. Lists retain the actual Git origin even if discovery fails.
Creation makes an empty GitHub repository using the selected account; it does not push files.
Connecting validates write access and a revision of the current origin before changing it.
Studio exposes the same contract at `/studio/api/publish/repository`; hosted deployments report
their managed repository as read-only because deployment and synchronization share that binding.

Cloudflare Workers have their own `cloudflare-workers` hosting variant. Discovery also accepts
`linked` to inspect local Wrangler/Vercel destinations before settings exist. A discovered Worker
may have an empty account ID when its local name is known but its account is unresolved; the saved
publish-config parser rejects that incomplete value. This prevents assigning an unrelated account.

## Error notifications

Desktop and Studio report application errors through the shared toast stack. `src/ui/ErrorToast`
bridges component error states without adding inline messages; `reportErrorToast` handles action
boundaries. The internal handoff and visible stack keep at most five messages, deduplicated by
text. Recovery actions stay available until dismissal, and use the latest component callbacks.
The stack follows the top native dialog so modal validation and retry controls stay accessible.
Normal progress, empty states, and successful receipts remain part of their feature UI.

## Studio large-project publishing

Studio captures up to 100,000 files / 8 GiB into a private Git object store under its mutation
coordinator. Its manifest contains paths, modes, sizes and blob identifiers, never file bodies.
Only `src`, `public` and shared project metadata are replaced; explicit asset deletions and all
other repository paths are preserved in one commit whose parent is the witnessed baseline.
Git fetches a shallow, blob-filtered parent and pushes missing objects with an exact expected-head
lease. A confirmed mismatch before pushing can refresh and recapture, at most three attempts.
Rejected or ambiguous pushes are never retried automatically. Baselines and upload cleanup advance
only after a confirmed push. Build mutations do not enter the captured Git objects.

GitHub-only and `all` with hosting `none` skip builds and hooks. Hosting copies are bounded to
100,000 files / 2 GiB and preflight available disk for the copy, output and a 1 GiB reserve. Native
Git commands have ten-minute, 1 MiB output and free-disk guards; listings stream with bounded
records. Native Git pack work uses one thread and bounded window/cache settings. The default build
has a 2 GiB Node heap ceiling; this does not bound non-Node build tools or total container memory.

The authenticated `/studio/internal/publish-connection` POST returns a repository-scoped GitHub
App installation token and validated destination. `/studio/internal/bootstrap` additionally
returns the saved baseline. Both require the existing private container token, use `no-store`,
and never expose the App private key. Installation tokens are passed only in the Git child's
environment, not command arguments, persistent Git configuration, logs, browser responses or
build/hook environments. The old full-content commit and archive endpoints are removed. Startup
fetches objects directly to disk, rejects linked or special files and runtime-state paths, checks
disk capacity, checks out the witnessed revision and removes temporary Git objects.

The Worker and container must be deployed together for the new internal protocol. Existing
container instance sizes are preserved by updates; the supplied template now selects standard-2.


## Studio Git history

Studio uses the shared Desktop history graph, commit-file classification and diff viewer.
The authenticated `/studio/api/history/log` and `/studio/api/history/diff` routes read a
private Git object store without changing the collaborative checkout. History reads have
their own bounded queue, retain at most 300 commits per view and 64 branch references, and
reuse each fetched snapshot for one minute. Credentials use the existing repository-scoped
container grant and remain in child-process environment variables. They never reach the
browser or Git configuration. Diff requests use the shared commit/path parser, require a
commit reachable from fetched branches, and retain the Desktop diff size limits.

The shared viewer only offers restore and preview actions when its host supplies them.
Studio's published-history view currently provides graph and diff inspection; it does not
expose Desktop checkout/restore operations against a shared collaborative draft. Session
Undo/Redo remains available independently.

Studio graph reads return commit metadata without changed-file lists. Expanding a commit
loads its files through `/studio/api/history/commit?hash=…`, which validates the full commit
hash and requires reachability from fetched branches. This keeps rename detection and lazy
blob downloads off the graph's loading path; file details still use Desktop's classification
and rename handling. Reopened graphs retain the last successful page while refreshing.

CMS read operations capture their source snapshot under the project mutation coordinator,
then release it before staging files and executing schema inspection. This keeps a slow
content config from blocking collaborative saves and heartbeat replies. CMS mutations keep
the existing coordinated, witnessed transaction.

Studio broadcasts validated collaborative `update` messages before projecting the source to disk.
`writePending: true` lets peers apply the CRDT delta and mapped text immediately without requesting
a render of the old file. The subsequent `source-written` message starts source-dependent refreshes
only after the atomic file replacement. `saved` remains a separate acknowledgment after durable
storage succeeds. Failed writes retain the accepted draft in memory and use the existing replay
recovery; delivery alone never acknowledges persistence.

Accepted updates leave the project mutation queue before disk I/O. A bounded writer coalesces
source and CRDT snapshots over 300 ms, preserving their order and acknowledging each edit only
after a snapshot containing it reaches both stores. Structural actions request an immediate flush.
Publishing, repository synchronization and multi-file transactions persist accepted room state
under the project coordinator before reading filesystem snapshots, so batching cannot omit an
accepted edit from a publish or rollback. Unchanged synchronization emits no edit or render notice.

Studio's Vite watcher ignores its reserved `.studio-tmp` staging files. Only the completed
atomic replacement reaches Astro's source watcher; staging creation/removal must not rebuild
routes, invalidate CSS modules or refresh project catalogs. Project-provided ignore rules remain
in force, and ordinary edits plus route creation/removal still reach the watcher.

Literal Astro text edits share the same source-range check as immediate canvas text updates.
Their authoritative renders wait for 300 ms of quiet, capped at two seconds during continuous
typing, so full-site execution does not compete with every keystroke. Structural actions and
other source changes cancel that delay. Queued renders announce their pending state to all
subscribers so clients do not start duplicate fallback requests during the typing window.

## Studio shared Git workspace

Studio adapts the Desktop Git transport to authenticated HTTP commands parsed by the same
shared IPC contracts. The single container serializes Git operations with document writes.
A commit is acknowledged only after its immutable bundle and conditional manifest reach
storage. Partial commits retain unselected changes; publishing preserves committed ancestry.
Branch checkout and pull persist a complete replacement draft before changing live files.
Each activation replaces the document namespace and closes existing rooms, so offline edits
and queued mutations from the old checkout cannot apply to the new branch. Branch changes
are shared by all editors. History exposes branch commits but excludes parked draft refs.
Bundles are bounded at 96 MiB, branch lists at 64, and cloud checkpoints/draft namespaces at
128. Old unreferenced checkpoints and document namespaces expire after a 30-minute grace
period. Interrupted checkpoint acknowledgement blocks edits until startup recovers storage.

## Canvas interaction mode

The canvas cursor toggle starts in selection mode for each project session. The parent sends
`avb:interaction` with `select` or `interact`; both frame clients validate the mode and accept it
only from their parent. Desktop and Studio replay it after each frame load. In interaction mode,
the page owns clicks, forms, focus, keyboard input and pointer feedback; selection and hover outlines remain.
In selection mode, capture listeners stop click actions before page handlers run. Pointer streams
remain available to slider libraries, and a drag of at least six pixels does not select a node on
release. Libraries that require an uncancelled mouse-focus default may still need interaction mode.
Navigation reports are bounded local paths from the current frame and preview origin. Each
navigation immediately opens the matching project page while preserving interaction mode; a route
without editable source restores the editor preview. Mode is session UI state and is not written into project settings.

### Page and folder rename

`shared/properties/pageRename.ts` validates page-relative identities at both host boundaries.
Desktop's `page:move` and `pagefolder:rename`, and Studio's `POST /studio/api/pages/rename`, use
one planner. It rejects occupied paths and equivalent page URLs (including `index` routes,
case-folded names and dynamic parameter aliases). Dynamic parameters keep their names so a
rename cannot silently invalidate `getStaticPaths`.

The planner inventories authored UTF-8 files, updates literal internal links and configured-site
absolute URLs, rebases relative/aliased imports, and remaps `.stacki/pages.json` order keys.
It preserves URL query strings and fragments. External sites, generated output, dependencies,
lockfiles and binary assets are excluded. Runtime-computed URLs are not evaluated. The scan is
bounded to 10,000 entries, 32 directory levels, 5 MB per text file and 100 MB total text;
symlinks are refused rather than traversed. Desktop additionally bounds its write batch to
its existing document-actor limit.

Hosts flush pending editor saves before planning. Text witnesses are rechecked before writes;
failed batches restore only bytes still owned by that batch, preserving outside edits.
Studio serializes the operation with collaboration edits and checkpoints the renamed draft
and a new CRDT namespace together before acknowledging cloud saves. This preserves deleted
source paths after container recovery and prevents old rooms from recreating moved files.
Renaming changes source URLs, not inherited layout titles. Display labels remain a projection.

The rename popup is shared by Desktop and Studio. It validates names on every input change
using the same shared URL-conflict rules as the host and requires an explicit Apply; Cancel,
Escape and blur never rename anything. Errors appear below the field, including save-time
conflicts from outside edits. Studio project scans include bounded `pageFolders` entries so
empty folders reserve destinations during live validation as well as during the final write.

### CMS connections

A project's hosted CMS connections (`shared/properties/cmsConnections.ts`) name which CMS its
content comes from and hold the key Stacki writes drafts with. Kinds: Sanity (project, dataset),
Payload (https address, auth collection) and custom (a draft endpoint and the header its key goes
in). Addresses are https, or http on localhost only, with no login or fragment. A key is one line
of printable ASCII, at most 4,096 characters; it crosses the boundary once, in
`cmsConnections:save`, and no reply ever carries it. At most 16 connections per project.

Desktop keeps connections in `userData/cms-connections.json`, keyed by the project's real path,
never in `.stacki/` (which is committed). Keys are encrypted with Electron `safeStorage`; where it
is unavailable nothing is saved, and a key that cannot be decrypted reads as absent. The file is
owner-only and a damaged one reads as empty.

"Log in with Sanity" (`cmsConnections:sanityLogin`) opens Sanity's own login page
(`https://www.sanity.io/login`, `type=stampedToken`, `withSid=true`), where the person picks Google,
GitHub or email, as Sanity's SDK does. It returns to a one-shot `localhost` server, which Sanity
allows as an origin; it is not a documented public API for third-party apps. The session id may
arrive in the query, in a `url` parameter, or in the fragment, which a page on that server reads
and returns once in the query. The id is exchanged for the person's login token, used only in
the main process to list projects and datasets and to create a project key with the Editor
role, then logged out. Only the key is kept. The sign-in page must be on `https://www.sanity.io`.
A suggestion comes from the site's `.env` (`*SANITY_PROJECT_ID`, `*SANITY_DATASET`). Sessions
time out after five minutes. A role that cannot create keys is told to paste an Editor key instead.

While Stacki previews a project with a Sanity connection, its dev server gets
`STACKI_SANITY_PREVIEW=1`, `STACKI_SANITY_PROJECT_ID`, `STACKI_SANITY_DATASET` and
`STACKI_SANITY_TOKEN` (the connection's key). Nothing else receives them, and a site opts in by
reading them; production builds never see them.

### On-canvas text editing

Desktop and Studio share the canvas text catalog and native text editor. In selection mode,
single-click selects an element; double-clicking source-matched text temporarily sets
`contenteditable="true"` on its existing
text container, preserving its authored whitespace behavior. The browser owns caret placement,
pointer selection, and arrow navigation.
No input overlay, substitute glyphs, wrappers, or changes to typography are introduced. The
original editing attributes are restored on exit. Clicking another element applies changed
text and selects that element; Enter applies and Escape cancels. Unchanged text never writes.

Native `beforeinput` target ranges must stay within the source-owned text segment. Plain text
operations update only its existing Text nodes, so selecting across a protected child cannot
replace or erase that child. Select All is confined to that segment. Single-click selects an
inline child; Delete removes it through structural editing; double-click edits its own text.
Plain-text paste and cut use the same range check. Undo/redo retains at most 64 bounded text
snapshots per editing session. Native composition is accepted only while node structure and
non-owned text remain intact; invalid native changes are restored before cancelling.
Interaction mode retains the page's normal click behavior. Component slots use the same guards.

A catalog names the open file, its SHA-256 source witness, and bounded text targets. The frame
requires the corresponding render stamp before editing. Source offsets never cross into the
frame. The host accepts only current-session target keys and rechecks source before applying
an edit through Desktop's history/save pipeline or Studio's shared document. Catalogs contain
at most 2,000 targets; text values are limited to 10,000 characters. Structure guards inspect at
most 1,000 nodes. Editing state crosses to the host only to annotate its existing selection
outline for shared content; the host may cancel editing when the source or CMS witness changes.

Validated `avb:text-draft` messages mirror typing, composition and local undo/redo in the
Settings Content field before saving. One transient draft is scoped to the current session,
project, file and source node; it does not modify source, history or the preview DOM. Nested
inline markup survives the projection, and expression chips retain their original binding
while displaying the draft value. Cancellation and source changes discard the mirror. A save
precedes the inactive message so the mirror remains until the source acknowledges the edit.
Leaving native editing clears its text selection without clearing another element's selection.

Validated `avb:text-selection` messages report the words selected in the open editor: offsets
counted in shown characters (`canvasTextFolded`: a whitespace run is one space, leading
whitespace is none), because the editor's text and the source may differ in whitespace alone;
the host unfolds them into the text it formats. Offsets are at most the 10,000-character limit,
start before end, with the selection's
box in frame viewport pixels (finite, at most 1,000,000 in any direction, non-negative size).
Only changes are posted; a message with no range clears the selection. Desktop shows the
Settings Content field's formatting bar over literal text only — never shared variables or CMS
fields. A press takes over the session: the host closes the editor with `cancel`, ignores the
save the editor posts on its way out, and applies one `setNodeInline` edit to the element the
Content field would edit, with the typed words and the press together, using the same
formatting code (`src/features/props/richFormat.ts`). The link field ends typing first; leaving
it without a URL saves the typed words as an ordinary text edit.

Words in an inline run carry no markers (`astroSerializeMarked.ts`). The frame places an
unmarked run between its tagged siblings for outlines, and names it for hover and click only
where it sits beside a tagged sibling; a run that is its element's only content leaves the
element as the target. A double-click beside the words of the innermost clicked element edits
its nearest text rather than opening a component.

Exact marked text runs take precedence. A bounded fallback can combine unmarked span/div
animation wrappers when their text matches one unique source segment and every authored child
boundary survives. Changed words, ambiguous duplicates, missing authored spans, and stale
renderings refuse editing. Runtime HTML is never serialized back into Astro.
Component-owned wrappers may be traversed when locating slot text, including slots rendered
through `set:html` with their comments removed. Caller-authored children remain boundaries.

Simple local constant string bindings edit their original declaration, retaining the expression.
Explicit `getEntry` imports from `astro:content` with literal collection and entry IDs can edit
string fields through the existing writable collection adapter and schema validation. Their
purple editing outline identifies shared content and warns that other uses also change.
Read-only remote loaders, computed expressions, unknown record identities and shadowed loop
bindings remain protected; the editor never guesses a record from its displayed text.

`content:writeEntry` may carry an expected data/body snapshot. Desktop checks that snapshot
before applying a source-preserving, actor-witnessed write. Studio uses its coordinated CMS
transaction and source versions. A stale snapshot fails without replacing a newer field value.
CMS notifications refresh the catalog, allowing subsequent edits to use the newly saved data.
