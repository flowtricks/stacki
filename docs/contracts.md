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

## Page templates

The Pages panel's `+` creates a page or a page template. `shared/properties/pageTemplate.ts`
is the contract: `DataSource` is `content-collection`, `sanity` or `http-json`, and the route,
address, variable names, and field paths are checked there for both the form and the IPC
boundary. `pageTemplate:plan` returns every file a template will write, computed from the
disk; `pageTemplate:create` recomputes that plan, so the renderer never sends file text.

Template fields may be nested (`author.name`), and a generated `entry` keeps that shape. A template is an ordinary `[slug].astro` page. It reads `const { entry } = Astro.props`, and
`page:dynamicPaths` samples that prop, so all three sources reach the same data picker with
no per-source code. `getStaticPaths` runs in its own scope, so `parseDeclarations` leaves its
locals out of the page's. Nothing records which source a template came from: its code is the
record, and a developer may change it freely.

`pageTemplate:sample` fetches in the main process with a deadline, a size limit and no
redirects, so a key header cannot follow a redirect to another host. A sample's reply crosses
as fields and short examples, never a body. A request names environment variables; values
are read from the project's env files in the main process and never reach the renderer.
A Sanity template reads through a saved CMS connection, by id: main resolves its project and
key for samples, and asks once without the key to learn whether the dataset is public. A
generated page still reads any token from `SANITY_API_TOKEN`; for a private dataset, creating
can copy the connection's key there under the `project:setEnv` rules. A
secret travels once, through `project:setEnv`, which refuses a tracked `.env`, adds `.env` to
`.gitignore` when it is missing, and restarts the preview because Astro reads env files only
as it starts. Addresses with credentials or secret-looking query parameters, and `PUBLIC_`
variables, are refused because each would publish the secret.

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
  collection limits. The scan also carries the project's `lengthUnit`.
- `lengthUnit.ts` decides what the style panel writes lengths in: rem in a Lumos project (a
  `lumos` block in package.json, or a LUMOS.md), px elsewhere, at the root font size a global
  stylesheet sets statically (16px otherwise). `electron/project/lengthUnitMarkers.ts` reads the
  markers for both Desktop's `project:scan` and Studio's `/studio/api/project`, so the two hosts
  and the baked demo agree. `parseLengthUnit` checks the setting at the scan boundary.
- `propSchema.ts` validates component field schemas and their nested options, including the
  optional `deprecated` notice and `usage` the prop model adds.
- `propModel.ts` is the one description of a component's props (docs/plans/prop-controls.md §2):
  `parsePropModel` checks every control kind, fallback and union table, and the nesting
  (`propNestingDepthMax`, twice `LIMITS.listFieldDepthMax`) and variant (`propVariantsMax`) bounds kept beside it.
  A `text` control may carry the `@format` word of its member (`color`, `date`, `longtext`), and a schema
  `PropShapeField` carries that `format`, an enum's `options`, and the `shape`/`shapeIsList` of a nested object
  or list of objects, nested at most `LIMITS.listFieldDepthMax` levels (`parseField` refuses deeper). The main process
  builds it (`electron/parse/propModel/readPropModel.ts`, on the TypeScript syntax tree) and
  parses its own output; `propModelSchema.ts` projects it onto `PropField`, and the Properties
  panel's list comes from the same model, so the panels cannot disagree. No IPC channel carries
  the model yet; the scan still carries its `PropField` projection.
- `propTags.ts` reads a prop's JSDoc tags (`@min @max @step @decimals @int @format @group
  @deprecated`) for every reader: the model in main and the renderer's
  `propDocumentation.ts`. Legacy `@onLabel`/`@offLabel` switch labels are ignored (kept out of
  the tooltip, never written); a switch control shows True and False.
- `frontmatter.ts` validates import members and source slots.
- `boundary.ts` supplies bounded primitive, list, dictionary, and data parsers.
- `result.ts` defines the expected-failure channel.

## Project roles

`.stacki/roles.json` says which parts of Stacki each person may use in a project, for Desktop and
Studio alike. `shared/properties/projectRoles.ts` is the contract: the `AccessFeature` union, the
bounded parser (`ROLE_LIMITS` beside it), resolution and `can(role, feature)`. The file is a
project metadata kind (`roles`), so both hosts read and write it through the witnessed metadata
transport (`project:metadata` / `project:writeMetadata`, `/studio/api/metadata`).

```json
{ "version": 1, "defaultRole": "admin",
  "roles": [
    { "id": "admin", "name": "Admin", "members": ["owner"] },
    { "id": "client", "name": "Client", "members": ["acme-marketing"], "access": ["panel:pages", "publish"] },
    { "id": "writer", "name": "Writer", "members": ["sam"], "access": ["panel:cms", "panel:apps", "app:seo"] } ] }
```

- Built-in `admin` and `client` are always present, admin first. Admin has every feature, stores no
  `access`, and must name at least one member: the parser refuses a file that would leave no admin,
  and the Roles tab refuses a save that would make the person saving it non-admin. `developer`
  (Studio's old label) and `designer` (its old stored value) read as admin.
- `client` without `access` gets `CLIENT_DEFAULT_ACCESS`, Studio's former Client mode: Pages,
  Navigator, Components, Assets, CMS, Git and the Settings panel; creating, renaming and deleting
  pages; publishing; Editor settings. It lacks `page:layout`, so its edits stay inside the page layout.
- Custom role ids are lowercase slugs; names are 1 to 60 characters. A name is for display only:
  grants, `defaultRole` and both hosts' checks use the id. Client's name may change like a custom
  role's (a file without one reads "Client"); admin is always named "Admin". The Roles tab keeps
  names unique, ignoring case; the parser accepts duplicates written by older versions. Members are GitHub usernames,
  matched case-insensitively; a person is in at most one role. At most 32 roles, 200 members a role,
  256 grants a role, 256 KiB a file.
- Apps: `panel:apps` shows the Apps panel and `app:<appId>` allows one app (`app:*` every app).
  `can(role, 'app:x')` needs both. `settings:roles` is never grantable: only admin edits roles.
- App permissions: a non-admin role may hold `appPermissions: { "<appId>": { "<permissionId>": true | false } }`
  for the switches apps declare in their manifest (`permissions`, `shared/properties/appPermissions.ts`).
  `appPermissionsFor(role, appId, declarations)` resolves them: admin has every one, a role that may
  not use the app has none, any other role has the stored value, else the manifest's `default`. At
  most 64 apps a role and 24 values an app; ids no installed manifest declares are kept (reinstalling
  restores them) and ignored. The key is written only when non-empty, so older files read unchanged.
  Stacki never enforces them: apps read them through `role.get` / `role.can` and enforce them themselves.
- Rail pins: any role, admin included, may hold `pinnedApps: ["<appId>", …]`, at most 12 app ids in pin
  order (a repeat is read once), written only when non-empty. The left rail (Desktop's `LeftRail.tsx`,
  Studio's `EditorRail.tsx`, through `src/app/railApps.tsx`) draws each pinned app the role may use and
  has installed as its own button below the panels; other ids are kept and ignored. The Roles tab pins
  only apps the role may use. `RoleView.pinnedApps` carries them, so "View as" shows another role's pins;
  admin resolves to the file's admin role (`roleViewOf(roles, 'admin')`) for the same reason.
- No file means everyone is admin, exactly as before. Studio gives a signed-in GitHub user the role
  naming them, else `defaultRole` (admin unless set). A local Studio, with no sign-in, is admin.
  Desktop resolves the GitHub account it publishes with (the project's `githubAccount` when signed
  in on this machine, else `gh`'s active account, via `roles:identity`); nobody signed in, or a
  person named in no role, is admin there, because the local user owns the files anyway.

Enforcement: the renderer hides what `can()` refuses (rail buttons and their shortcuts, right
tabs, Settings tabs, the publish button, the terminal and code window, page create, rename and
delete, component creation). Main refuses the matching IPC writes before their handlers run
(`electron/handlers/channelAccess.ts`, through the registrar's gate in `ipcRegistrar.ts`); a broken
file is admin on Desktop so it can be fixed. The Studio server refuses write routes the sender's
role lacks with 403 (`studio/src/features/roles/serverAccess.ts`), trusting the login only from the
worker's authenticated `x-studio-user`; a broken file fails closed to the client role there.
Document edits over the collaboration socket stay UI-gated, as Client mode was.

"View as" (Settings → Roles on Desktop, the account menu in Studio) lets an admin preview another
role's UI. It changes only the renderer's active role (`src/lib/currentRole.ts`: `currentRole()` and
`onRoleChange()`), never the file or what main and the server allow. Studio keeps the choice for the tab in sessionStorage (`studio-role`).

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
state lives in `.stacki/studio/state`, inside the self-ignored `.stacki/studio/`, not a copied
draft workspace; an older `.studio-state` moves there on start.
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

`.stacki/styles.json` contains `{ version: 1, keep: [...], lockedStylesheets?: [...] }`
(`shared/properties/styleKeepList.ts`). `keep` lists class or id names, `*` matching any run of
characters, that the unused-selector clean-up never removes. `lockedStylesheets` lists
project-relative stylesheets (`src/styles/patterns.css`) and folders ending in `/`
(`src/styles/`), `/`-separated with no `.`/`..` steps, at most 500; a folder covers every file
under it, including files added later. The check reports a would-be `unused` selector in a
locked file as `kept`, so the panel's clean-up, the delete offer, `style:removeSelectors` (which
re-runs the check) and `check-project` all leave it. `style:removeSelectors` with `reach: 'chosen'`
(one row's own trash) runs that check as if no stylesheet were locked, so a hand deletion goes
through while name locks still hold. Unlocking one row under a sheet lock removes that lock and
writes every other selector it held as a name lock, one write and one undo step, refused past the
1,000-name bound; locking a sheet drops name locks only its selectors use. The key is written only when non-empty. The
style selectors panel writes the file through `project:writeMetadata` against the bytes it read.
A `trustedScripts` key from an earlier version is read and dropped.

The unused-selector check (`electron/properties/selector*.ts`) reports through
`style:selectorUsage` as a `SelectorReport` (`shared/properties/selectorUsage.ts`). A verdict
is `unused` only when no project text, installed package or code that assembles class names
can produce a name the selector requires. Classes a script adds at runtime are not tracked: a
script's class names count as mentions, and no script, remote or local, weakens a verdict.
What does is `unknown` with a reason, never removed: outside data that an import chain carries
to a template's `set:html` or computed `class` (`electron/properties/selectorFlow.ts`; a fetch
of the site's own path is not outside data, and a package content loader reaches every page),
unread files, and missing `node_modules`. `<style>` blocks are located by the editor's parser,
or by a bounded template scanner for files it cannot represent — never by Astro's compiler,
which aborts the process on very large files. CSS is read the way a browser recovers: a missing
semicolon, a dropped declaration and a block left open at the end are repaired in a copy, with
offsets mapped back to the original. Installed Studio folders and stylesheets outside `src/`,
`public/` and `styles/` are not checked. `style:removeSelectors` re-runs the check and refuses
ids that are no longer `unused` or files whose digest changed; it verifies each edited region
re-parses with exactly the removed selectors gone and no byte changed outside its style blocks,
writes through the document actors, and returns each file's before and after text.
`style:restoreSelectors` writes one side back, refusing a file that no longer holds the other.
`astro-studio check-project` prints the same report.

`.stacki/folders.json` contains `{ version: 1, folders: { components?, layouts?, assets?, styles?, variables? } }`
(`shared/properties/projectFolders.ts`): for each panel, the project-relative folders it reads.
A missing file, an invalid one, or a missing key reads that panel's defaults — `src/components`,
`src/layouts`, `public` + `src` for assets, `src` + `public` + `styles` for both stylesheets (`styles`:
the style panel, the selectors panel and the unused-selector check) and variables (`variables`: the
variables panel, on Desktop and in Studio) — so an
unconfigured project behaves as before and nothing is written until a folder changes. Folders are
`/`-separated, at most 16 per panel, 200 characters and 8 levels deep, with no empty, `.`, `..`,
hidden, `node_modules` or `dist` segment, absolute path or drive letter; one panel's folders never
repeat or nest. Components and layouts live under `src/` and outside `src/pages`; assets under
`public/` (served, every file) or `src/` (imported, media only); styles and variables under `src/`,
`public/` or `styles/`. A file written before `variables` existed has only `styles`, which chose the
variables panel's folders too: it reads as `variables` equal to `styles`, and the next save writes both.
So that rule never applies to a new file, a save that writes `styles` always writes `variables` too,
at the defaults when the variables panel has no choice of its own. A list equal to its defaults is not
a change to the Folders tab: its title stays plain, without the blue reset label.
A file in a layout folder is a layout even when a component folder covers it. Pages
are fixed at `src/pages` (Astro's routing root) and content collections follow the content config.
Keys and panels this version does not know (written by a newer Stacki) are ignored for reading and
written back unchanged; a known panel with a bad folder makes the whole file invalid. A host that
predates the `folders` kind refuses it with "Unknown project metadata file"; the Folders tab then
shows the defaults read-only with "Restart Stacki to edit folders." (Studio: its own note). Older
readers only open the metadata kinds they name, so the file's presence changes nothing for them.

The same file's `cms` key (`{ files?, hiddenCollections?, pickerExcluded?, …unknown keys kept }`) chooses what the CMS
panel lists. `files` (at most 64, project-relative under `src/`, `.cjs .cts .js .jsx .mjs .mts .ts .tsx
.json .astro`, not `.d.ts`, no repeats) replaces automatic detection: `cms:list` then reads exactly
those files, single values included, on Desktop and in Studio (whose CMS stage carries the file).
`.astro` files are never data files: every page, layout and component stays a source whatever
`files` says (the open one is always included), the Folders tab neither lists nor accepts them, and
a saved `.astro` entry parses but is ignored. Without it, detection is unchanged (Desktop: every data module under `src/` except `src/assets`,
single values only from `src/data/` and root consts files; Studio: single values from every module).
`hiddenCollections` (at most 256 names) leaves content collections out of the CMS panel only;
`content:collections` and every other reader still see them. The Folders tab seeds a first add or
remove from the detected files, and "Reset to default" removes `files`; an empty `cms` is not written.
`pickerExcluded` (at most 512 entries, no repeats) leaves project data out of the binding picker
only, never out of the CMS panel: a data file (`src/consts.ts`, same rules as `files` but not `.astro`),
one of its exports (`src/consts.ts#SITE`, an identifier or `default` for a JSON file's data), or a
content collection (`blog`, no `/`). An export is also left out with its whole file. No key, or an
empty list (never written), shows everything (`isPickerShown`).

Pages are shown, not configured: `project:scan` reports `pagesFolder` (`<srcDir>/pages`, `srcDir` read
from the first `astro.config.*` Astro loads, as a string literal only; the config never runs) and
`astroConfig`. Everything else still assumes `src/pages`: the scan's page list and `routeForPage`,
page create/rename/delete (`pageHandlers.ts`, `pageRequests.ts`, `pageRename*.ts`), page templates
(`pageTemplatePlan.ts`), `.stacki/pages.json` keys, preview markers (`previewMarkers.ts`,
`markerConfig.ts`'s page glob, `componentPreviewContext.ts`), `defaultsCanvas.ts`, the components
folder rules, and Studio's paths (`shared/validation.ts` accepts only `src/` and `public/`), its
page list and route helpers. A project with another `srcDir` is shown its real pages folder but not
yet edited there. Every scanner asks `foldersFor(kind, config)`: Desktop's project scan,
component creation and undo, the component preview route's globs (written at dev server start),
the assets panel listing and every asset write (`assetAbs`), the style panel, the variables panel,
the unused-selector check, and Studio's scan, asset catalog and writes, style list and variable
snapshot. Studio lists every `.astro` outside `src/pages` as a component until components or
layouts are configured. Under `src/` an asset write — replace, rename on either side, upload —
still refuses anything that is not media, whichever folders are listed. Settings → Folders edits
the file through `project:writeMetadata`; `project:pickFolder` opens the system folder dialog on the
project and answers `picked` (project-relative, links resolved) or `outside`. A saved change, or
an outside edit of the file, sends `fs:changed`, `assets:changed` and `css:changed`.

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
defaults”, in Desktop and Studio. A role without `component:edit` (the built-in client role
by default) has no such action and cannot save defaults.
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


## Instructions panel

`shared/properties/instructions.ts` is the contract for the Instructions rail panel
(`panel:instructions`; writes need `instructions:edit`, the hidden-paths list
`settings:instructions` or `instructions:edit`).

- **Sections by path alone.** `classifyInstruction` puts `…/skills/<name>/SKILL.md` in
  Skills, AGENTS.md, CLAUDE.md, GEMINI.md and the like (any depth) and everything in the
  root rule folders (`.claude/rules/`, `.cursor/rules/`, `.github/instructions/`, …) in
  Rules, and every other `.md` in Docs. `.mdc` is listed only in a rule folder.
  `parseInstructionListing` refuses an entry in the wrong section, or skill frontmatter
  on a file that is not a skill.
- **Channels.** `instructions:list` (`{ files: [{ path, section, sizeBytes, skill }],
  folders, truncated }`), `instructions:read`, `instructions:write` (`{ file, source,
  base }`: refused with `conflict` unless the disk still holds `base`),
  `instructions:create` (never overwrites), `instructions:createFolder`,
  `instructions:reveal`. Main resolves every path inside the project once links are
  followed, refuses links and the skipped folders, and writes through the document
  actors (`documents.writeText` witnessed by `base`, `documents.create`). The event
  `instructions:changed` `{ files }` comes from `electron/project/instructionsWatcher.ts`
  (recursive on macOS and Windows; the root and the agents' folders elsewhere); an
  empty list means "list again". The app's own writes are not echoed.
- **Bounds.** `INSTRUCTION_LIMITS`: 2,000 files and 500 rule folders per listing, 20,000
  directories and 200,000 entries walked, depth 24, 2 MiB per file, 64 KiB of
  frontmatter, skill names 64 and descriptions 1,024 characters, 200 hidden paths of
  256 characters. Past a walk bound the listing says `truncated`.
- **Skipped folders.** node_modules, .git, .stacki, dist, build, out, .astro, .output,
  .next, .nuxt, .svelte-kit, .vercel, .netlify, .wrangler, .turbo, .cache, coverage,
  .pnpm-store, .yarn — wherever they are.
- **Hidden paths.** `.stacki/instructions.json` is a project metadata kind
  (`instructions`): `{ "version": 1, "hidden": ["docs/archive", "**/CHANGELOG.md"] }`.
  Paths are anchored at the project root; a match hides everything below it; `*` stays
  within a name, `**/` spans folders, `?` is one character. `parseInstructionSettings`
  refuses absolute, `..`, backslash and duplicate entries. Main applies them during the
  walk.
- **Editing fidelity.** The view edits the body with `MarkdownField` and
  `extensions: 'gfm'` (`src/ui/markdownBlocks.ts`): GitHub tables and task items are
  shown as tables and boxes, everything else as before; untouched blocks, table rows and
  list items keep their bytes, and a rewritten block keeps the gap and line endings of
  the block it replaces. The CMS still reads CommonMark. Frontmatter is spliced line by
  line (`src/features/instructions/frontmatterFields.ts`).

## Historical file diffs

`git:commitDiff` accepts a project path, a full SHA-1/SHA-256 commit hash, a repository-relative
file path, and an optional previous path for renames. The shared parser rejects ambiguous refs,
path traversal, empty paths and oversized strings. The renderer parses replies as a bounded
`Result<string, string>`; operating failures remain visible instead of masquerading as empty diffs.

Git reads the selected commit against its first parent (or the empty tree for a root commit),
using literal pathspecs and disabling external diff/text conversion programs. The working tree
is untouched. Patches exceeding 500,000 characters or 10,000 lines return an explicit error;
smaller patches retain binary/rename metadata and validated hunk line numbers for inspection.

## Commit author pictures

`git:avatars` (Studio: `POST /studio/api/history/avatars`) takes a project path and at most 100
full commit hashes with their author emails, parsed by `shared/ipc/commitAvatars.ts`. The reply
lists `{ hash, url }` only for commits with a picture; its URLs must be `https:` on
`avatars.githubusercontent.com` or `github.com`, without credentials or ports. GitHub noreply
emails name their picture with no request, in the renderer and in main alike. Any other commit
is looked up by `electron/git/commitAvatars.ts` with one GraphQL query per page, only when
origin is a github.com repository and the existing GitHub CLI credential (Studio: the
repository connection) is available; the credential never leaves main or the Studio server.
Answers are cached by commit and email (2,000 entries each). A 403, 429, GraphQL rate limit,
refusal or failure silences that repository until GitHub's reset time (else 15 minutes) and
the rows keep their initials.

## Role member suggestions

`github:searchUsers` (Studio: `GET /studio/api/github/users?q=`) takes a project path and the
typed start of a GitHub username (`parseGitHubLoginQuery` in `shared/properties/projectRoles.ts`:
1 to 39 characters, the login rules, a trailing hyphen allowed). Main gates it to `settings:roles`
(`channelAccess.ts`); the Studio route refuses anyone without it with 403. The reply, parsed by
`shared/ipc/githubUserSearch.ts`, is `{ users, github }`: at most 8 users, one per login
(case-insensitive), each `{ login, name?, avatarURL?, source }` with `source` one of
`collaborator`, `author` or `search` and pictures on the commit-avatar hosts only; `github` is
`searched` or `unavailable`. `electron/git/githubUserSearch.ts` (shared by main and the Studio
server) ranks the repository's collaborators (one cached page of 100), then recent commit authors
whose noreply email names a login (Desktop reads 200 commits; Studio none), then
`api.github.com/search/users?q=<query>+in:login`, which receives the typed query and nothing else.
The credential is the publishing GitHub CLI account on Desktop and the repository connection's
installation token in Studio; it never reaches the renderer. Answers are cached per query (256,
10 minutes); a 403, 429, failure or malformed body silences the search until GitHub's reset time
(else one minute), and the picker shows its local matches and "Can't search GitHub right now".
Typing a username and pressing Add never depends on the search.

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

## Live style previews

Two parsed `shared/properties` contracts let a canvas show a style edit before its file holds
it, with one frame half each in `electron/preload/` that Desktop's preload and Studio's preview
client both run. The parent sends both through `tellCanvas` (`src/editor/canvasQuery.ts`).
`avb:live-variable` (`liveVariables.ts`, `frameLiveVariables.ts`) overrides a custom property;
`avb:live-rule` (`liveRules.ts`, `frameLiveRules.ts`) sets one declaration of a Style panel rule.
A rule preview names its source file project-relative, its condition at-rules, its selector as
written and the property; the frame patches only the stylesheets compiled from that file
(`data-vite-dev-id`, or a link's path), sets aside only that sheet's own Astro scope when it
compares selectors, and records each rule's own value. `set` shows an edit (`value` with a
boolean `important`, or `removed`); `drop` without `until` restores the recorded values at once
(a refused, failed or held save, an abandoned edit); `drop` with `until` keeps the preview until
the page's own sheet holds that edit, at most `settleFramesMax` frames, then restores. Bounds
live in `LIVE_RULE_LIMITS`; a sheet over `sheetRulesMax` rules is refused with a
`rules-over-cap` problem rather than searched in part. Rules nested in other style rules and
members of a grouped rule the save splits are not previewed; their saves show them.

## Canvas interaction mode

The canvas cursor toggle starts in selection mode for each project session. The parent sends
`avb:interaction` with `select` or `interact`; both frame clients validate the mode and accept it
only from their parent. Desktop and Studio replay it after each frame load. Interaction mode is
selection mode plus one difference: the page also receives the activation. A click still selects
(`avb:click-node` / `studio:select`), and double-click text editing, component drill-in, the context
menu, editor shortcuts and outlines behave as in selection mode. The click then reaches the page, so
buttons, `<summary>`, labels and page scripts run, presses focus fields and forms submit; the page
shows its own cursors. A click on a link is held for `LINK_HOLD_MS` (350 ms,
`electron/preload/frameInteraction.ts`) and then replayed once to the page, so the page's own
handlers and the browser's navigation see one click; the second click of a double-click cancels it,
so the link's words open for editing instead. Leaving interaction mode cancels a held click.
Only a link that stays in the frame on the frame's own origin is replayed, and it loads with
`#avb-design` kept (a plain visitor's URL would have its markers stripped). Any other web link
(another origin, `_blank`, `_top`, a modifier) opens through `window.open(…, 'noopener')`: a new tab
in Studio, the system browser on Desktop through the window-open handler. Other schemes
(`mailto:`, `tel:`) do nothing, as Desktop's `isBrowserLink` allows only http(s). Canvas frames
cancel off-origin navigations with the Navigation API where the browser has it; Desktop's main
process refuses them for every preview frame directly in the window (`will-frame-navigate`, and
`will-redirect` for a site route the server redirects off-site, such as `/download`;
`electron/app/previewNavigation.ts`) and opens web links externally. The interactive preview frame
is held to the same rule and to nothing else: no inert links, no held clicks. Frames post `avb:leaving` on
`pagehide`; Studio (`offSite` in `useCanvasInteraction`) clears outlines on it and, when the next
document loads without reporting `avb:navigated` within 1.5 s, sets the frame back to the open page.
The host also sends `avb:site-pages` (`{ base, routes }`, parsed by `parseCanvasSitePages`): a
same-origin link whose path matches none of the routes (`[param]` one segment, `[...rest]` any), or
one marked `download`, opens in the browser like an off-site link, so a download route the site's
own server answers works as on the live site. Until the list arrives every same-origin link counts
as a page. In interact mode the canvas cursor is the editor's arrow over text (no I-beam), the
pointer over links, buttons, `<summary>`, labels and controls, the page's own cursor where it sets
one, and the I-beam in fields; select mode keeps the arrow everywhere (`canvasCursorCSS`). Arrow keys
pressed in a canvas frame move the editor's selection in both modes (Desktop `avb:shortcut` arrow,
Studio `studio:key`, caught at capture so the page neither scrolls nor takes them); a page field or
the canvas text editor keeps them.
A node with no element whose markers are gone (a component that renders its slot to a string
and strips comments, such as a `<Section>` using `slots.render()` and a regex) is derived from its
items: a path no element carries and no marker pair encloses, but the parent of paths elements do
carry, gets one run per holding element of those elements (`collectHollowRegions` in
`electron/preload/frameRegions.ts`). Hit-testing, outlines and rendered-node reports then treat it as
a marked node. Marker pairs always win; derived runs tag nothing and are recollected every pass.
Studio's `studio:preview-ready` names the frame's path, and the loader counts it as ready for any
URL with that path, so a URL change that does not reload the frame cannot leave the loader up.
In selection mode, capture listeners stop click actions before page handlers run. Pointer streams
remain available to slider libraries, and a drag of at least six pixels does not select a node on
release. Libraries that require an uncancelled mouse-focus default may still need interaction mode.
Navigation reports are bounded local paths from the current frame and preview origin. Each
navigation immediately opens the matching project page while preserving interaction mode (Studio
first removes the path the frame's pages are served under, the static demo's bake base, by
comparing the frame's URL with the route it was opened on: `studio/src/features/preview/canvasRoute.ts`); a route
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

One element can hold several source texts, such as the words either side of a `<br>`. A drag
that began in the editor belongs to it wherever it is released. The editor also holds the
literal texts of the same element next to the opened one (`textRunsAround`), marked `literal`
in the catalog, so a selection across a wordless element can be typed over or deleted: only
words change, and the element stays. Any other words end the run list: an inline child's, a
shared variable's or a component's. A selection reaching them stays selected and can be copied,
and typing over it is refused, so authored content is never replaced. A caret's delete stops at
a run's edge. An edit across runs is one
`avb:text-save` naming the other texts in `also`, at most 100, which the host writes as a
single source edit. All of them land together or none does. Drafts describe the opened text
alone, and the formatting bar is withheld once another text has changed.

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


## AI panel

The AI chat panel (`src/features/ai/`, rail button at the foot of the left rail, docked or popped out
in a `DockableWindow`) drives the person's own Claude and Codex through the Agent Client Protocol
(ACP v1, JSON-RPC 2.0 over stdio). Stacki never shows a login form and never reads a token: an
agent that needs signing in is signed in by the person in Stacki's terminal (`claude` then `/login`,
or `codex login`), opened by the panel's "Open terminal to sign in".

**Contracts.** `shared/properties/ai/` holds the agent ids (`agentIds.ts`), the bounds (`aiLimits.ts`,
beside the code, since `shared/core/limits.ts` is a gate file), the ACP parsers (`acpWire.ts`: every
message and session update as a discriminated union; an update kind it does not know is kept as
`unknown-update` and shown as a quiet row; a malformed line from an adapter is a `Result` failure,
never a crash) and the chat model (`chatModel.ts`: branded `ChatId`, `TurnId`, `PermissionRequestId`,
the `ChatSummary`, and the `ChatEvent` union a transcript is made of). `shared/ipc/aiChat.ts` holds the
channels' payload parsers (spread into `IPC_PAYLOADS`), result types (extended by `IpcResults`) and
the renderer's reply and push parsers.

The panel overhaul adds `agentPresentation.ts` (the composer's static tables: mode order and the one
"Recommended" mode, which modes ask for confirmation, effort names and copy, which options are
switches, which agents can compact; the protocol carries none of this, see "Protocol capabilities
Stacki declares") and `mentions.ts` (`MentionChip`, `ComposerSegments`, `PromptPart`,
`MentionCandidate` and their parsers: a draft read back from browser storage is a `Result` that reads
as empty on failure, a prompt's parts are refused by the channel's parser; chip paths are
project-relative with no `..`, absolute, backslash or empty segments). New bounds live in `AI_LIMITS`:
`queuedPromptsMax`, `sectionsMax`, `sectionNameCharsMax`, `mentions*Max`, `composerSegmentsMax`,
`draftsStoredMax`, `promptPartsMax`, `promptBlocksExtraMax`, `backgroundTasksMax`, `compactionsMax`,
`transcriptUiEntriesMax`, `contextTokensMax`, `compactionErrorCharsMax` (500), `mentionCacheMs`,
`mentionCachedProjectsMax`.

**Channels.** `ai:agents`, `ai:installAgent`, `ai:trust`, `ai:chats`, `ai:chatCreate`,
`ai:chatUpdate` (rename, pin), `ai:chatDelete`, `ai:chatRead`, `ai:prompt`, `ai:cancel`,
`ai:permission`, `ai:setOption` (an agent's session setting: model, mode, effort), `ai:review` (keep,
undo or resolve one file's change), and, for chat management and the composer: `ai:steer`,
`ai:compact`, `ai:chatFork`, `ai:chatMove`, `ai:sections`, `ai:diff`, `ai:mentions`. `ai:chats`,
`ai:chatMove` and `ai:sections` answer the whole `ChatList { chats, sections }` (chats in display
order) so the renderer replaces its copy in one update; `ai:chatUpdate` also takes `archived` and
`unread`; `ai:prompt` also takes `parts` (mention chips; `text` stays the plain fallback, each chip read
as `@path`, `/skill` or its title) and `mode` (`send`, or `steer`). Absence on the wire is `undefined`:
`ai:chatMove` without `section` means the first, unsectioned section and without `before` means last.
`AiFailure.code` adds `unsupported` (the agent lacks steering, fork or compaction), `section-missing`
and `invalid` (a repeated section name, too many sections, an archived chat moved). `ai:steer` and
`ai:compact` are the host's (below); `ai:diff` reads a pending file's text from the chat's live change
ledger and answers `invalid` once the change is settled (settled entries keep no content); `ai:mentions` lists files and skills (below). All seven are gated on `code:edit`; the main
process also exposes `invalidateMentions` for the window-focus hook. Pushes: `ai:events` (batched `ChatEvent`s with their character
count) and `ai:agentStatus`. One-way: `ai:ack` (`{ chars }`, parsed before use, registered by main.ts
beside the terminal's sends). Every project path must be the open project. Every write channel is
gated on `code:edit` (an agent edits and runs anything, as the terminal does); the panel shows for
roles with `panel:ai` and `code:edit`.

**Main process** (`electron/handlers/ai/`, in the `handlers` area so it may use `lib`, `documents` and
`git`). `agentRegistry.ts` pins each adapter (`@agentclientprotocol/claude-agent-acp`,
`@agentclientprotocol/codex-acp`; docs/dependencies.md) and finds the person's CLI on the shell PATH
(`lib/shellEnvironment.ts`, shared with the terminal). `agentInstaller.ts` installs on request into
`userData/agents/<agent>-<version>/`: staged, `npm ci --omit=optional --ignore-scripts` against the
shipped lockfile (its SHA-256 pinned), the entry's SHA-256 checked, then renamed into place; the
digest is checked again at every start. `agentHost.ts` runs one adapter per agent per project as
Electron-as-Node, with the person's shell environment minus Stacki's and any host agent session's
variables; it starts on the first prompt, stops after `idleMsMax`, restarts after a crash with
doubling delays at most `restartsMax` times, and stops on project close and quit. A chat is one ACP
session: resumed (`session/resume`), else loaded (`session/load`, replay ignored), else started
anew with a notice. Nothing starts before the person trusts the project (`ai:trust`, remembered in
the chat index); each new session is put in the agent's asking mode (Claude `default`, Codex
`read-only`). `acpConnection.ts` frames lines (at most `lineBytesMax`, past which the connection
closes) and bounds pending requests (`pendingRequestsMax`, each with a timeout).
`permissionBroker.ts` holds requests until answered (bounded; a stopped turn answers `cancelled`).
`eventPump.ts` batches events every `eventBatchMs`, joins streamed text, appends each chat's batch in
one write and sends one push; above `flowHighWatermark` unacknowledged characters it stops reading
every adapter until acks bring it under `flowLowWatermark` (the terminal's scheme).

**Host protocol features** (`agentHost.ts`, `promptBlocks.ts`). Steering: `ai:steer` (or `ai:prompt`
with `mode: 'steer'`) sends `_session/steering` with `idleBehavior: 'promptRequired'` to the running
turn and records a `user` event with `mode: 'steer'`; with no turn running the message is an ordinary
prompt (`startedNewTurn`); an agent that did not advertise `_meta.steering.supported` answers
`unsupported`, an adapter that refuses answers its failure (`agent-failed`), and in both cases nothing
was sent, so the renderer queues the message. A plain `ai:prompt` while a turn runs stays `busy`.
Compaction: `ai:compact` sends `/compact` as an ordinary prompt in a turn of its own (no `user` event,
no change ledger) for agents whose presentation says `canCompact` (Claude; Codex answers `unsupported`),
only while idle and only for a chat that has a session (`invalid` otherwise). Both the
`compaction_update` shape and the "Compact conversation" tool call (`toolName: 'compact'`, also by
remembered call id) become `compaction` events; a compaction ends once, repeated or later updates of an
id are dropped, a compaction still open when its turn ends is closed (`completed` after `end_turn`,
`cancelled`, else `failed`), and a compaction turn that saw no signal at all still ends with one
`completed`/`failed` row (id `compact-<turn>`). A `compaction` event may carry an optional `error`: the
reason a compaction failed, only on a `failed` one (an adapter's text on a compaction that went well is a
summary, not an error), trimmed and cut to `compactionErrorCharsMax` characters with a closing ellipsis
(`compactionError` in `chatEvents.ts`), read back by the event parser with the same bound, so a long
message can neither make the update vanish nor reach the panel unbounded. Absence is `undefined`, and a
chat stored before the field existed reads as before. Fork: a chat with `forkOf` and no session opens with
`session/fork` from the original's stored session id when the agent advertises `fork`; a fork whose
original was left unrestricted (`isDangerousMode`) starts asking again; no fork capability, no original
session or a failed fork starts a new session and says so in a notice (the copied transcript stays).
Modes and settings: everything is `session/set_config_option`, except an agent that offers modes only as
session modes (no `mode` config option): the host builds a `mode` option from them and sets it with
`session/set_mode`. Choosing an unrestricted mode (`isDangerousMode`: Claude `bypassPermissions`, Codex
`agent-full-access`) is confirmed by the renderer once per choice; the host does not enforce it, and
every new chat still starts in the asking mode. Record: the last `usage` of a turn is written to the
chat's `context` when the turn ends (at once when it arrives outside a turn), `unread` is set when a
turn ends other than cancelled or by the sign-in card (before the `turn-end` event is sent, so the
renderer's clear comes later), and `text` and `tool` events carry `at` from the host's clock. Background
work is derived: a tool call whose `rawInput.run_in_background` is true is remembered per chat, its late
updates after `turn-end` are stored under the turn that started it, and `ai:cancel` still reaches the
adapter while one exists ("Stop agent"; no per-task stop exists without declaring AIR). Terminal output:
with `_meta.terminal_output_delta` declared the adapter streams a command's output as deltas and repeats
it in the completed result, so the result text of a call that streamed deltas is dropped. Notices: the same
`notice` text twice in a row within a turn is stored once. A model API 401 (an internal error carrying
`API Error: 401`, `authentication_error` or "Please run /login") ends the turn as `sign-in`, like ACP's
authentication-required code. Mentions: `promptBlocks.ts` builds the ACP blocks of a prompt with `parts`:
a file chip is read inside the project (links that leave it are refused; the prompt is refused with
`invalid`) and embedded as a `resource` when it is text within `mentionFileCharsMax`, within
`mentionTotalCharsMax` in all, and the agent advertised `embeddedContext`, else it travels as a
`resource_link` and its stored part is `truncated`; a skill chip first in the message for Claude and
advertised by the agent is the leading `/name `, otherwise "Use the `name` skill." plus a link to its
SKILL.md (a project skill under the project, a `~/` skill under the person's home, nothing else); a
built-in chip is its own text block wrapped in `<app-builder-instructions>`, kept in the transcript as a
hash only. More than `mentionsMax` chips is refused. `AgentHost.diff` reads the live ledger.

**Changes.** Edits apply when the agent makes them; each turn's changes are offered for Keep or Undo
per file (`changeLedger.ts`). The spike found that neither adapter writes through the client's
`fs/write_text_file` (Claude's CLI and Codex write files themselves, Codex often with a shell
command), so the ledger reads each file a tool call names before the call changes it, and in a git
repository takes a tree snapshot at each end of the turn (`treeSnapshot.ts`: `git add --all` and
`write-tree` against a temporary copy of the index, never touching the person's index, branches or
stash) to catch edits no call named. Undo writes the earlier text through the document actors,
witnessed by the agent's version; when the file changed since, the undo becomes a three-way merge
(base: the agent's version, ours: the file now, theirs: before the turn) shown in the existing merge
editor, and `resolve` writes the person's answer. Text files only; a binary file is not offered.

**Storage.** Chats are private to the computer and never committed:
`userData/ai/projects/<sha256(realpath)>/index.json` (chat list, trust, each chat's session id;
replaced whole), `chats/<id>.jsonl` (append-only, every line parsed on read, a torn or bad line
skipped), `reviews/<id>.json` (pending reviews, settled entries keep no content). Bounded by
`chatsMax`, `chatEventsMax`, `chatBytesMax`, `ledgerFilesMax`, `ledgerBytesMax`, `ledgerTurnsMax`.

**Chat management** (index version 2, `chatStore.ts`). The index adds `sections` (id `s<16 hex>`,
name at most `sectionNameCharsMax` characters and unique ignoring case, `collapsed`, `rank`) and, per
chat, `section` (absent: the implicit first section), `rank` (position in its section), `archivedAt`,
`unread`, `context` (last `{used, size}`) and `forkOf`. Invariants, restored by `normalizeIndex` after
every operation: sections are numbered 0..n-1; every chat is in a section that exists (else the first);
within a section pinned chats come first and ranks are a permutation 0..n-1. So a drop of an unpinned
chat among pinned ones lands at the boundary, a newly pinned chat goes to the top, a section's deletion
moves its chats to the end of the first section (nothing is deleted), and archiving keeps section and
rank so a restore puts the chat back. A fork is a record right below its original with `forkOf` set and
no session, plus a copy of the transcript in which pending reviews are settled as kept (the fork has no
ledger). **Migration:** a version 1 index (no sections, no list fields) reads as version 2 with ranks
taken from the order the old list drew (pinned first, then newest update), unsectioned, nothing unread
or archived; a bad record loses only itself; the file is rewritten as version 2 on the next write. An
older build reads a version 2 index as empty, so the migration is one way. Transcripts are not
rewritten: new event fields (`at`, `until`, `toolName`, `command`, `background`, `parts`, `mode`) are
optional and the `compaction` kind is new, so chats stored before read as before, without durations.

**Composer, mentions and chips.** `@` lists project text files (tracked and untracked via git, else a
bounded walk; never `node_modules`, `.git`, `dist`, `.astro` or `.stacki/preview`) and skills from
`<project>/.claude/skills/*`, `<project>/.agents/skills/*`, `~/.claude/skills/*` and
`~/.codex/skills/*` (the last is Codex's convention, read only if present, not checked against an
installed Codex). `AGENTS.md` and `CLAUDE.md` first, then Markdown, then other files, each by match
quality; skills first within the result bound `mentionResultsMax`; a project skill hides a user skill of
the same name. The scan is cached `mentionCacheMs` per project. A prompt carries at most `mentionsMax`
chips; a "Build an app" task may carry `draftChip: 'app-builder'` (only with `delivery: 'draft'`) in
addition to its prompt text.

The composer's input is a CodeMirror editor (`src/features/ai/composer/ComposerInput.tsx`, on the generic
`src/ui/chipEditor/*`): a chip is one placeholder character drawn as a purple pill, so Backspace removes it
whole and undo restores it, and a placeholder typed or pasted is refused. `@` at a word start opens the picker
(`ChipPicker`) under the caret: Built-in (App builder instructions, matched here), Skills and Files (asked of
`ai:mentions` after a 60 ms pause, an older answer dropped), at most 12 rows, skills holding back so files keep
four. It reports a draft as `ComposerSegments` (`onSegmentsChange`) and takes one back through `segments`; a
change from outside (a send that cleared it, dictation, "Build an app") replaces the text and is not undoable.
Enter reports `send`, Cmd or Ctrl+Enter `queue`, Shift+Enter is a new line, and a composing input method owns
Enter. A file dragged from the Pages (`avb/page`) or Assets (`avb/asset`) panel becomes a file chip when its path
is a project file (no folder, no `..`). The built-in text is not in the project: `src/lib/builtinInstructions.ts`
is where the Apps panel provides it at load (features may not import each other) and
`src/features/ai/mentions/builtinChips.ts` registers it with the store, so a send expands the chip; clicking the
chip, in the box or in a sent message (`MentionChipView`), copies the text and shows "Copied" for 1.5 s.

**Protocol capabilities Stacki declares.** The host declares only open ACP capabilities
(`session.compaction`, `session.notices`, `_meta.terminal_output_delta`; not `jetbrains`, not
`session.configOptions.boolean`, not `elicitation`): the adapters send background-task data, the
recommended effort and native subagent sessions only to JetBrains AIR clients, and Stacki does not
impersonate one. Spike of the installed Claude adapter 0.105.0 (recorded in
`test/fixtures/ai/acpTrace.jsonl`): `_session/steering` on an idle session answers
`{outcome: 'promptRequired', reason: 'noRunningTurn'}`; `session/fork` answers a new session shaped
like `session/new`'s; `/compact` is accepted as an ordinary prompt even though the command list does not
name it, reports as `compaction_update` (`in_progress`, then a terminal status, with `error` on failure)
when the client declares `session.compaction` and as a tool call titled "Compact conversation"
(`_meta.claudeCode.toolName: 'compact'`) when it does not, and its turn ends `end_turn` even when
compaction failed. Not exercised (the CLI's sign-in had expired during the spike, so no model turn could
run): steering a running turn, `terminal_output_delta` streaming, `run_in_background` Bash; those are read
from the adapter source. Codex is not installed here: everything about it is from recorded lines.

**Starting a chat.** The composer's status line (`composer/ComposerStatusLine.tsx`) holds the settings: a
model chip ("Sonnet 5.5  Medium", opening the model menu with the agent's first models, an Effort
submenu, the Ultracode and Fast switches the agent offers, More models and an Agent submenu for the
provider, whose rows carry the official Claude and OpenAI marks, `src/ui/agentLogos.tsx`), a mode chip
(the Mode menu) and the context ring. Model, effort and switches are remembered per provider in the
renderer; the mode never is, so a new chat always starts in the mode that asks first, and choosing
Bypass permissions or Full access (`isDangerousMode`) asks once per chat through `confirmDialog`. A mode
picked before the session exists is stored with the chat (`ai:chatUpdate` `settings`) and applied after the
asking mode. `ai:agents` returns each agent's settings as it last reported them (main keeps them in
`userData/ai/agent-options.json`). In a trusted project, an agent that has never reported them is
probed once in the background: a throwaway `session/new`, its config options read, then
`session/delete`, and the result pushed on `ai:agentStatus`. So the menus list exactly what the
person's installed Claude Code or Codex offers, with its own names. Before any report there is a
documented fallback (`FALLBACK_OPTIONS` in agentRegistry.ts). The
choices ride on `ai:chatCreate` (`settings`) and are applied with `session/set_config_option` once
the chat's session exists, after the asking mode; a setting the agent no longer offers is skipped.
The AI channels accept the open project's root itself (`MainHost.openProject`, compared through
links), never a folder inside it or elsewhere.

**Guided setup** (`ai:setup`, push `ai:setupState`; `agentSetup.ts`). Buttons that run the agent's
own CLI, so no one needs a terminal. Install: Claude's native installer
(`curl -fsSL https://claude.ai/install.sh | bash`, PowerShell `install.ps1` on Windows) and Codex's
npm package (`npm install --global --prefix ~/.local @openai/codex`); neither needs sudo, and a step
that would ask for a password fails with "Copy details" rather than asking in Stacki. Status:
`claude auth status`, `codex login status`. Sign in: `claude auth login --claudeai`, `codex login`,
in a hidden pseudo-terminal: the first https page the CLI prints on the provider's own hosts is opened
in the browser, a paste-back prompt shows a code field whose line is typed into the CLI, and the
sign-in ends ready, failed (with the CLI's output), cancelled or timed out. Sign out: `claude auth
logout`, `codex logout`. The CLI stores the credentials; Stacki reads only what the status command
prints, shows the account's name and plan, and the email only inside the account menu (held in
memory, never stored or logged). Setup is detected again each time a chat opens and after each step.

**Trust and opening.** Opening the panel in a project allows agents there and is remembered, unless
Settings → AI "Ask before allowing agents in a new project" is on (then the trust card asks first).
Every new chat still starts in the agent's asking mode. An agent starting in a project also runs that
project's own agent hooks and `.mcp.json` servers. Opening the panel goes straight to a chat (the last
one open in the project, else the newest, else a new one with Claude, the default provider) with the
composer focused; the list is behind the back chevron. The composer's toolbar holds the provider,
model and effort: before a chat's first message they apply to that chat (another provider replaces
the empty chat); after it, another provider opens a new chat and the model or effort applies to the
next message.

**Renderer.** The feature folder is split by area: `AiPanel.tsx` is the shell (header slot, body switch,
the trust and agent gates, sign-in and setup cards, `aiShell.css`); `transcript/` draws the conversation
(`TranscriptView` and `Messages`, `ActivityGroup` for the agent's work between two messages, `ToolCard`,
`ThinkingBlock`, `PlanCard`, `BackgroundTasks`, `CompactionRow`, `DiffView`, `ChangesCard`, `PermissionCard`,
`SentParts` for a sent message's chips, `TurnStatus` and `ticker.ts`, the one clock every live timer reads,
`ErrorRow`, with `transcript.css`, `chrome.css` and `diff.css`); `composer/` the message box (`ChatComposer`, `ComposerInput` for the text and the `/`
menu, `ComposerStatusLine` for the provider, model and effort, `composer.css`); `sessions/` the chat list
and header (`SessionsView`, `ChatHeader`, `sessions.css`). The first overhaul's flat files are gone, each
replaced by the folder that now owns its job: `ChatComposer.tsx`, `EffortControl.tsx` and `ai.css` by
`composer/` and the per-area sheets, `ChatList.tsx` by `sessions/`, `ChatItems.tsx` (with `MessageRows.tsx`
and the one-line `PlanStrip.tsx`) by `transcript/` (`Messages.tsx`, `ToolCard`, `PlanCard`). The panel's
background is the rail's own `--bg-panel` (`aiShell.css`), so the two read as one dark side. `aiBridge.ts` parses every reply and push (a
reply that does not parse is a failure the panel shows, never an exception) and has one call per channel;
`aiStore.ts` keeps the state outside React
(so chats stream while the panel is closed, and a hand-off works without it) and acknowledges each
push after folding it. Besides the open chat, views, agents and setups it holds the project's `chats`
(in the order main gave) and `sections` (a reply to a list change replaces both whole), the list `filter`,
whether the panel is on screen (`visibility`), each chat's `queue` of messages waiting for its turn to
end (at most `queuedPromptsMax`, in this window's memory only) with `queuePaused`, and `drafts`: a draft
is `{ segments, attachments }`, text runs and mention chips in typed order (`draftText` is the plain
text; `boundSegments` cuts to the limits; a built-in chip's text comes from `registerBuiltinChipText`).
Drafts are written to browser storage per project after typing pauses (`draftStorage.ts`: parsed with
`parseDraftSegments`, a bad entry skipped alone, at most `draftsStoredMax`) and restored for chats that
still exist. `steerPrompt` sends the draft into the running turn (an agent that cannot take it gets the
message queued instead), `queuePrompt` sets it aside (and sends it when no turn runs); the next queued message is
sent only after a turn that ended `end_turn`, and after an error or a stop the queue is held (shown as
paused) until Resume. A turn that ends in the open chat while the panel is on screen marks it read,
otherwise unread, as main does. `chatReducer.ts` is the pure fold from events to the transcript view:
every item has an increasing `id`, tool calls and thoughts carry the host's `at` stamps (a chat stored
before timings shows no durations), a compaction is one item per id that only moves from in progress
to a final state (with the usage before and the first usage after, derived), and `activeTasks` lists the
open tool calls that are subagents, run in the background or outlived their turn (the protocol's
background-task data is not sent to Stacki). `chatStatus.ts` holds the pure wording (ring tone, durations,
the running-turn line, the activity headline) and `moveInList.ts` the optimistic reorder. All
property-tested. "Fix with AI" (`src/lib/agentTasks.ts`) reaches the panel first
(`aiAgentTask.ts`, priority 20, above the terminal's 10): a new chat with the task's prompt, sent at
once when the project is trusted and the agent ready, otherwise left in the composer. A task with
`delivery: 'draft'` (the Apps panel's "Build an app") is never sent: it waits in the composer, and the
terminal's handler declines it. With `draftChip: 'app-builder'` it is the App builder instructions chip that
waits: appended to the end of the open chat's draft when that holds anything (the words stay, and a second
click adds no second chip), else in an empty open chat or a new one; a draft already at `mentionsMax` declines
the task, so the prompt goes to the clipboard.

**Diffs, changes, permissions, messages.** `DiffView` draws one file's before/after as a unified diff
(unified only: split would leave each side about 150px in the docked panel): line numbers, folded
unchanged stretches behind "Show N lines", marked words inside an edited line, every line coloured as
its file's language, and bounded (a compact row cap before "Show full diff", a larger one after, and an
uncoloured fallback past `highlightCharsMax`). The rules are pure, in `diffModel.ts` and `lineDiff.ts`
(shared head and tail are set aside before alignment, so one edit in a long file stays exact). `ChangesCard`
shows "N files changed +A −R" with a row per file; the counts come from `ai:diff` for pending files
(`changeDiffs.ts` asks once per file and remembers the counts after Keep or Undo, because the host keeps
no text for a settled file). Its Keep, Undo, Keep all and Undo all call the caller's `onReview`, which
is the existing review flow (`runReview`): the bulk actions wait for each file's review before the next,
so a drifted undo opens one merge editor at a time. "Open file" appears only when `onOpenFile` is given.
`PermissionCard` shows the command or the edit's diff of the tool call with the same `call` id (passed as
`tool`), the options allow-first with the recommended one primary, answers to the keys 1..n and Esc
(deny, only when a reject option exists; never inside a text field; only the oldest waiting request hears
them), and collapses to "Allowed · the command" once answered; `PermissionPin` repeats the oldest waiting
request above the composer while its card is scrolled away. `Messages.tsx` is presentational: the
caller supplies `onEdit` and `onResend` (the last user message only), `partsView` (mention chips) and,
if it wants to own the fold, `expanded`; a message over 40 lines or 4,000 characters folds behind
"Show more".

**Studio chat.** Studio has its own chat (`studio/src/features/ai/`) and does not use ACP or the IPC bridge:
it sends one HTTP request per message to the model the server is configured with (`/studio/api/ai/models`,
`propose`, `apply`) and gets one proposal back (a summary and per-file before/after changes), so there is no
session to steer, queue, compact or fork. What is shared is drawn, not reimplemented: Studio's inventory
(`studio/scripts/shared-source.json`) vendors Desktop's `Menu`, `LoaderDots`, the chip editor (`ChipPicker`,
`chipEditor`, `chipTrigger`), the sectioned drag (`useSectionedDrag`), `DiffView` with `diffModel.ts`,
`lineDiff.ts` and the ticker, `StatusChip`, and the stylesheets `composer.css`, `sessions.css`,
`transcript.css`, `diff.css` and `mentions.css`, so Studio's composer, chat list, diff card and "Worked for
12s" line carry Desktop's classes. Studio adds only adapters over its own transport and storage: the status
line's model chip (a `Menu` of the server's models; no effort, mode or context ring, since the model has no
settings and no usage to report), the `@` file picker over the project's pages, components and assets
(`mentionFiles.ts`; a chip is sent as the text `@path`, which the server's model reads itself; no skills or
built-in instructions, which need Desktop's main process), the chat list (pinned and other chats,
drag-to-reorder, rename, delete through `confirmDialog`; no custom sections, unread, fork or archive) and a
proposal card of the changed files, each opening to `DiffView`, with Apply to draft and Discard. Chats are
kept in the browser (IndexedDB `studio-ai-chats`): version 2 stores the list in display order with `pinned`,
`updatedAt`, `segments` (the draft with its chips, `parseDraftSegments`) and each reply's `durationMs`; a
version 1 history (no `version`, oldest first) is read and turned around, and a draft that does not parse
falls back to its words. The panel is `--bg-panel`, the rail's colour. Proofs: `studio/test/chatState.test.ts`
(migration, pin and reorder, chips, mention search, durations) and `studio/test/ai.browser.ts` (the panel in
a real browser, including a legacy history).

Proofs: `test/shared/properties/ai/acpWire.test.ts` (recorded adapter lines, each bad shape, bounds,
unknown variants), `test/shared/ipc/aiChatContract.test.ts`, `test/electron/handlers/ai/agentHost.test.ts`
(a stand-in adapter process through whole turns; connection bounds; pump flow control; store
round-trip and bounds; ledger keep, undo, drift and snapshots), `test/renderer/ai/chatReducer.test.js`
(properties over seeded random streams), `test/renderer/ai/aiStore.test.js` (lists, sections, queue,
unread, drafts), `test/renderer/ai/chatStatus.test.js` and `test/renderer/ai/aiPanel.test.js` (the panel
in jsdom).

## Audits

`.stacki/audits.json` (`shared/properties/auditIgnores.ts`) is the tracked audit configuration:
`{ "version": 2, "ignored": [{ "id", "reason" }], "checks"?, "tokens"?, "placeholders"? }`. One file
holds both ignores and settings, rather than a second `.stacki/lint.json`: both are "how this
project audits itself", edited from the same panel and Settings tab, and one file is one write
witnessed against one set of bytes. Version 1 (ignores only) still reads and is written back as
version 2; settings at their defaults are left out of the file.

- `checks`: by check id (`^[a-z0-9-]{1,40}$`, at most 100), `{ "enabled"?: boolean, "priority"?: "high" | "medium" | "low" }`.
- `tokens`: `properties` (names, `padding*` matching a prefix), `colors`, `px`, `remOutsideVariables`
  (booleans), `allowed` (raw values, compared lower-cased).
- `placeholders`: phrases; one word must be the whole text, several may be part of it.
- Lists hold at most 200 items of at most 120 characters; ignores at most 2,000 entries, ids at
  most 1,024 and reasons at most 500 characters. Unknown fields, blank reasons, a repeated id and
  settings under version 1 are refused.

It travels as the `audits` metadata kind through `project:metadata` / `project:writeMetadata`
(writes need `panel:audits` or `settings:audits`). An id is `findingId`
(`shared/page/auditFindings.ts`): check, file, structural path and detail.

`audit:measure` loads one route of the loopback dev server in a hidden, sandboxed window with its
own session and answers `{ ok: true, measurement }` or `{ ok: false, message }`. The measurement is
unparsed data; `shared/page/auditPerformance.ts` parses it with bounds (200 images, 500 resources,
50 shifts, 100 fonts, 2,048 characters per string) before anything reads it. A page has 30 seconds.

`audit:render` asks main for one route of the project's dev server for the rendered checks. The
payload's `devUrl` must be a loopback `http:` origin and `route` a site-relative path; main
fetches with a 15-second timeout and refuses HTML over 4,000,000 characters, answering
`{ ok: true, status, html }` or `{ ok: false, message }`. The renderer parses the HTML itself
(`src/features/audits/renderedDom.ts`) into the plain tree `shared/page/auditRendered.ts` checks,
reading source locations from the dev server's `avb-s:` markers.

A fix is a plan of attribute patches and appended elements on nodes named by path; the renderer
turns it into `propsGesture` / `insertGesture` gestures, so it reaches disk as ordinary edit
requests (`src/features/audits/auditFixes.ts`). An agent hand-off is an `AgentTask`
(`shared/properties/agentTask.ts`), bounded where it is built.

## Stacki Apps

`shared/properties/apps.ts` is the contract for installed apps: the bundle manifest
(`stacki-app.json`: id, name, version, description, icon, entry, window, `author.github`, GitHub
source, and the `stacki` minimum version, `">=1.1.0"`, parsed as `stackiVersionMin` by
`parseStackiRange`; `stackiVersionProblem` is the one check, run by `appService.ts` on every stage and
install and on each update found, with the host's version passed as `stackiVersion`), the lockfile `.stacki/apps/apps.json` (version, SHA-256, install source and tag, an
available update), bundle paths and file types, the GitHub chooser's repositories and releases
(`releaseAssetChoice`, `orderReleases`), and the IPC values. `shared/properties/appBundle.ts` reads a
zip with the platform's raw inflate (no dependency), refusing zip64, encryption, symlinks, unsafe
paths, unknown file types, CRC mismatches and anything past `APP_LIMITS`, and checks the icon
(square, 256 KB, 512 px). `electron/project/appStore.ts`, `appGitHub.ts` and `appService.ts` are the
one install, update and GitHub flow, shared by Desktop's main process and the Studio server
(`studio/src/features/apps/appsServer.ts`): a bundle is staged in memory, installed only by
`apps:commit`, written to a staging folder and renamed into `.stacki/apps/<id>/`. Updates are
recorded as available and `apps:applyUpdate` installs only bytes whose SHA-256 equals the checked
ones. A private repository is read with the publish flow's GitHub account token, sent only to
`api.github.com`. Installing, updating, removing and reading the account's repositories are
admin-only in main (`electron/handlers/channelAccess.ts`) and on the Studio server.

The folder is what is installed (`shared/properties/appFolders.ts`, `electron/project/appScan.ts`):
every `.stacki/apps/<folder>/` whose files read as a bundle (`appBundle.ts` `bundleFromFiles`, the
same checks and bounds as a zip) and whose manifest `id` is the folder's name is an installed app,
with its lock entry, or with a `source: { kind: "local" }` entry built from the folder (its digest,
no updates) that is never written. `apps:list` returns them; `apps:folders` returns the folders that
do not read as an app, as `{ folder, message }` rows (`parseAppFoldersBroken`); the file route serves
only folders that read as their app. Every lockfile write drops entries whose folder is gone. The
project watcher (`electron/project/appsWatcher.ts`) compares folder stamps after events settle and
sends `apps:foldersChanged` (`parseAppFoldersChange`); Studio's editor polls `/studio/api/apps/stamps`
(`parseAppFolderStamps`) instead. `apps:revealFolder` takes a `parseAppFolderName` and shows the folder
in the file manager.

The official marketplace's index is `shared/properties/appMarketplace.ts` (`parseMarketplaceIndex`:
bounded entries, versions, categories and strings; icons only under `https://stacki.build/api/marketplace/icons/`;
a version's optional `stacki` range, parsed as `stackiVersionMin`). The parsed index parses again (`iconURL`,
`stackiVersionMin`), because the renderer re-checks the IPC reply with the same parser.
`electron/project/appMarketplace.ts` fetches it (a constant address on stacki.build; a development build may override
it with `STACKI_MARKETPLACE_INDEX_URL`) and downloads approved versions as public, refusing any whose
SHA-256 differs from the index. `apps:marketplace` needs `marketplace:view` and
`apps:installMarketplace` needs `marketplace:install`, in main and on the Studio server; the lockfile
records such installs as `source: { kind: "marketplace", id, version }`. Each lock entry carries
`autoUpdate` (absent reads as `false`), switched by `apps:setAutoUpdate` (admin-only); an update check
installs nothing unless it is on (docs/apps.md, "Update policy").

Where an installed app lives is `shared/properties/appPlace.ts`: the row's pills ("Local", "GitHub ·
Private" or "GitHub · Public", "Marketplace"), the marketplace match by id and repository, and
`parseAppRepositoryPlaceReply`. `apps:repositoryVisibility` (`panel:apps`; Studio's
`/studio/api/apps/visibility`) takes an installed app's id and answers its GitHub repository and
visibility (`electron/project/appRepositoryPlace.ts`: the install's account token on Desktop, anonymous
in Studio, cached ten minutes for at most 100 repositories). A failed lookup answers no visibility,
never an error.

Sharing and publishing apps is `shared/properties/appPublish.ts` (share requests and outcomes, a
repository's marketplace status, visibility refusals, the submission and the marketplace's
pre-submission check), with `shared/properties/appSecrets.ts` (the bounded secret scan, its
`secretsAllowlist`) and `shared/properties/appSettings.ts` (the manifest's `settings`, their values
and `.stacki/apps/settings.json`). `electron/project/appPublishService.ts` and `appGitHubWrite.ts`
make every GitHub write in main with the publishing account's token: `apps:share` and
`apps:switchSource` need `apps:share`; `apps:makePublic`, `apps:addLicense`, `apps:checkMarketplace`
and `apps:submitMarketplace` need `marketplace:publish`; `apps:scanSecrets` and
`apps:repositoryStatus` need either. Each of making public, sharing and submitting scans the bundle
again in main and refuses unless clean. `apps:share` reports its steps as `apps:shareProgress`
events. `apps:readSettings` and `apps:writeSettings` (`panel:apps`) check values against the app's
declarations; secrets go to a vault outside the project (`electron/project/appSettingsStore.ts`:
Electron `safeStorage` on Desktop, AES-GCM in the user's home folder in a local Studio), never under
`.stacki/`. Apps read their settings with the RPC's `settings.get`.

App storage is `shared/properties/appStorage.ts` (scopes, the key grammar, every bound, the file
format and the change notice) over `electron/project/appStorageStore.ts`, which Desktop's main and
the Studio server share. `apps:storageGet`, `apps:storageSet` (`panel:apps`; the renderer also checks
`app:<id>`), `apps:storageKeys` and `apps:storageWatch` keep project values in
`.stacki/app-data/<id>.json` and local ones under the user data folder; main pushes
`apps:storageChanged` with the writer token a write carried, or none for an outside change.
`apps:person` (`panel:apps`) answers `AppPerson` (`shared/properties/appsRpc.ts`, made by
`electron/project/appPerson.ts`), the id only while the `appsPersonHidden` preference is on, and main
pushes `apps:personChanged` when it flips. `apps:hostVersion` answers the version `app.info` reports.
`apps:canvasSnapshot` `{ rect, widthMax }` photographs that region of the sender's own window
(`capturePage`; whole pixels within 16384, `widthMax` 1–800) and answers a PNG data URL of at most
200 KiB, halving its width until it fits, for `canvas.snapshot`.
The `stacki-app:` scheme is registered `corsEnabled` and serves bundle files with
`Access-Control-Allow-Origin: *`, so an app's opaque-origin frame can fetch its own files.

Apps run in sandboxed frames without `allow-same-origin`, served from `stacki-app://<id>/` on Desktop
and `/studio/api/apps/files/<id>/` in Studio under a `sandbox` content security policy
(`shared/properties/appSdk.ts`), with the SDK at `stacki-sdk.js`. The preload installs nothing in a
`stacki-app:` frame, and main keeps an app frame on its own origin
(`electron/app/appFrameNavigation.ts`). `shared/properties/appsRpc.ts` is the RPC: every message is
parsed and bounded, every method is every app's (apps are first-party), and the role gates an app
as a whole (`app:<id>`) and the panels it can open. `src/features/apps/appRpcHost.ts` dispatches to
`AppHostCommands`, which Desktop (`src/app/shell/desktopAppHost.ts`) and Studio
(`studio/src/features/apps/StudioApps.tsx`) implement with the UI's own setters and gestures.
Overlays are declarative items drawn in the canvas overlay layer from the outlines' measurements;
their anchors are added to the paths the canvas measures, as are the elements `node.measure` waits
on (`src/features/apps/overlayMeasure.ts`). Canvas click capture goes through
`src/ui/canvasClickSlot.ts`: the canvas frames add the pointer (`x`, `y`) and the clicked copy's box
to `avb:click-node` (Desktop) and `studio:select` (Studio), parsed with `canvasClickBox` and
`coordinateOf` before use, and the editor tells a frame its cursor with `avb:app-cursor`
(`electron/preload/frameAppCursor.ts`): a name, or an app's image as a PNG or SVG `data:` URL the
editor read from the bundle and checked (`src/features/apps/appCursorImage.ts`), which the frame
checks again. An overlay drag (`src/features/apps/overlayDrag.ts`) asks the frame what is under a
point with `avb:point-query` `{ id, x, y }`; the frame answers `avb:point-result` `{ id, path,
occurrence, box, layers }` by its click's hit test (`electron/preload/framePointQuery.ts`), and
`src/ui/canvasPointQuery.ts` checks the reply before use. `layers` (at most 32 `{ path, occurrence,
copy }`, innermost first) are every file's marked node under the point (`electron/preload/frameLayers.ts`);
a query sending `chain` (1–32 `{ path, copy }`, outermost first) instead of a point asks which copy a
node ref names, answered in the same shape. `src/features/apps/nodeRefs.ts` names layers in their
files and reads refs back; `parseNodeRef` (`shared/properties/appsRpc.ts`) parses an app's ref. `canvas.scrollTo` sends `avb:app-scroll`
`{ space, x, y, w, h, block }` (`electron/preload/frameAppScroll.ts`) for a point or a `start`
alignment. `apps:fileStamps` answers each named project file's
modification time and size (at most `APP_FILE_STAMPS_MAX`, 2000, each confined to the project), and
Studio's `/studio/api/file-stamps` (`panel:pages`) the same; `src/features/apps/appPageIndex.ts`
caches other pages' trees by them for `page.getTree` and `page.findByAttribute`. `node.key` writes
`data-stacki-key` through the app's attribute edit (`src/features/apps/nodeKeys.ts`). The "Build an app" prompt is generated
from `docs/apps-prompt.md` (`scripts/build/appsPrompt.mts`); `docs/apps.md` is the full guide.

## List item fields

A List prop's item fields (`src/editor/itemFields.ts`, written and read by `src/editor/listPropType.ts`) have sixteen
kinds: Text, Long text, Rich text, Number, Switch, Image, Video, File, Link, Email, Phone, Color, Date, Option, List
and Group. Each is written as TypeScript on the item type and read back as the same field:

| Kind | TypeScript | Tag |
| --- | --- | --- |
| Number, Switch | `number`, `boolean` | none |
| Text, Long text, Rich text, Image, Video, File, Link, Email, Phone, Color, Date | `string` | `/** @format <word> */` on the member, left out when the member's name already says it (`heroImage`, `ctaHref`) |
| Option | `"a" \| "b"` (two to `LIMITS.listOptionsMax` words) | none |
| List | `readonly { … }[]` with fields of its own | none |
| Group | `{ … }` with fields of its own | none |

Lists nest `LIMITS.listFieldDepthMax` (3) levels of fields (a list in a list in a list), with at most
`LIMITS.listFieldsPerLevelMax` fields per level and `LIMITS.listFieldsTotalMax` in all; the pop-up offers no List or Group
on the last level, `fieldsProblem` refuses deeper fields, and `listFieldsOfType` reads a deeper type as code. Names are
identifiers, unique per level, and never `__proto__`, `constructor` or `prototype`. A type outside this set (a `Date`, a
list of words, a method, an index signature) is not read: the panels show it as "Set in code". A nested list or group is one
field of an item in the default array literal (`arrayValue.ts`), kept exactly as written. The data picker reaches nested
fields as `item.children[0].title`; the loop's Filters and Sort list a Group's fields by path (`address.city`) and a nested
List as a field that is set or empty.
