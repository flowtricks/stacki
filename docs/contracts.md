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

`dev:network` and `dev:setNetwork` (`shared/ipc/devNetwork.ts`) carry the phone preview: whether the
project's dev server listens on the local network (`--host 0.0.0.0`) or on 127.0.0.1 only. The request
names the project and a mode, `local` or `network`; the state is `off`, or `on` with the server's port and
at most eight IPv4 addresses with their interface names; a refused change is one of five failure codes
(`no-address`, `no-server`, `external`, `busy`, `restart-failed`), each a toast in the renderer. The mode
lives in main for the running app only: it is never written, it is off at launch, and `stop()` (project
close, quit) clears it. The canvas, thumbnails and main's own requests keep the loopback address in both
modes. Stacki's own dev-server routes (`/__avb/*`, `/studio`, Vite's `/__open-in-editor`) answer only a
loopback socket with a loopback Host and Origin (`electron/previewServer/loopbackGuard.ts`), in both modes.

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

Every git child process runs with `LC_ALL=C`, no credential prompt, no editor and no optional index lock (`git()` in
`electron/lib/nodeTools.ts`), and a failed command's message is git's own output, never the command line. Every `git:*` failure
leaves main through `explainGitFailure` (`electron/git/gitFailure.ts`): a locked index, missing identity, refused sign-in, offline,
rejected push (never forced), timeout, a missing git or a folder git does not trust becomes a referenced sentence; anything else keeps
git's words. `git:info` throws, instead of answering "not a repository", when git is missing or refuses the folder's owner.
`git:status` and `git:info` read `status --porcelain=v1 -z`: paths are unquoted and relative to the project folder, which may sit inside
a larger repository, and a list over 20,000 files is refused rather than truncated. `git:commit` is scoped to the project folder, treats
paths literally, takes long lists through a pathspec file, finishes a merge with a plain commit, and refuses to commit during a
cherry-pick, revert or rebase. `git:checkout`, `git:merge`, `git:pull` and `git:restoreProject` refuse while one of those is unfinished;
branch names are checked with `git check-ref-format --branch` and refs or names that start with a dash are refused before reaching git.
`git:push` sends `refs/heads/<branch>` to the same name on origin and refuses a detached HEAD.
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

Deleting a prop is asked first: `component:previewPropertyRemoval` (`{ projectPath, file, name }`)
plans the deletion from disk, writes nothing, and answers with a
`PropertyRemovalPreview` (`shared/properties/propertyRemoval.ts`): the instance
values it would remove per file, and the lines left for review. The deletion is
the `{ kind: 'remove' }` batch on `component:editProperties`, planned again
(docs/component-properties.md, "Deleting a prop").

A component's variant rules travel on the same channels: `component:properties`
answers with `variantGroups` (`shared/properties/variantRules.ts`, parsed by
`parseVariantGroups`), and a `{ kind: 'variantRules', edit }` property change
carries one `VariantRuleEdit`, parsed by `parseVariantRuleEdit` and applied by
main against the current source as one undoable batch
(docs/props-variant-rules.md).

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
  forged shapes: page code can write any comment. The frame reads stamps with
  `parseStampData` too, so a forged one is skipped rather than dropping the
  rendering. A rendering it cannot name posts `avb:render-problem` `{ problem }`
  (`FRAME_RENDER_PROBLEMS`, parsed by `parseFrameRenderProblem`), and the frame
  re-reads markers and stamps after `avb:morphed` and Astro's `astro:after-swap`.
- `avb:click-query` `{ id, x, y }` (editor → frame; id a safe integer 1–2³¹,
  coordinates finite within 10⁶ px) asks where a point lands now. The frame
  answers with `avb:click-node` carrying `replay: id` and the current token,
  never dispatching anything to the page (docs/canvas-click.md).
- `avb:click-node`, `avb:open-node` and `avb:context-node` carry `pressedAtMs`, the input
  event's own time on the clock both windows share (`performance.timeOrigin + event.timeStamp`).
  A popover (`popupDismiss.ts` `isCanvasPressMessage`, `useDismiss`, the variable picker's
  `pickerExit`) closes on a canvas press only when it was made after the popover opened and is
  not a `replay`: a freshly reloaded page posts its click late, and the click ladder's replay is
  the same press answered again, so either used to close what the person had opened since (soak
  SP-04). A press without `pressedAtMs` (Studio's preview client) is taken at its word.
- The page's scrollbar (`shared/properties/canvasScrollbar.ts`, frame half `electron/preload/frameScrollbar.ts`,
  canvas half `src/features/preview/CanvasScrollbar.tsx`). A canvas frame scrolls inside itself, and Chromium's
  classic scrollbar there took about 15px from the page (a 320px phone frame laid out in 305px while its media
  queries read 320). Every canvas frame (`SizedFrame`: the canvas, interact mode and preview mode, Desktop and Studio;
  and each frame of the all-breakpoints canvas, `CanvasView`) is told on each page load `avb:canvas-scrollbar` `{}`
  (other fields are ignored); the frame then hides the scrollbar of its scrolling root (`html, body { scrollbar-width:
  none }`), so the page always has the breakpoint's whole width. There is no setting. The frame reports `avb:page-scroll`
  `{ topPx, heightPx, viewHeightPx, chromium }` (finite, never negative, at most `pagePxMax`) at most once per
  animation frame and only when it changed: on scroll (captured, so a scrolling `<body>` counts), resize, load,
  `avb:morphed` and a change of the page's height; `chromium` stays true until the app's word arrives, so the canvas
  never draws a second bar. The scrolling root is the document's scrolling element, or `<body>` when only `<body>`
  scrolls. The canvas draws its own thin bar from it, outside the frame's inline end, and a press or drag on it sends
  `avb:page-scroll-to` `{ topPx }`, which the frame scrolls to at once. The page's inner scroll areas keep their bars.
- `preview:check` `{ projectPath, render }` → `PreviewVerdict`: main re-derives
  the token from the manifest, then reads every stamped file from disk
  (`electron/preview/previewCheck.ts`; a path outside the project is `missing`, a file
  past `sourceBytesMax` changed) and answers `current` or `stale` with one of
  `PREVIEW_STALE_REASONS`.
- The renderer (`src/features/preview/previewGate.ts`) accepts a click or double-click only when
  the event's token is the frame's latest, the open file's stamp is the bytes
  the editor shows (the clean checksum, or the origin while unsaved edits keep
  every path), and main answers `current` — judged again after main answers. A
  refused click climbs the recovery ladder (`canvasClickRecovery.ts`,
  `canvasClickRetry.ts`: look again, reload once, select the page, then one
  notice); nothing is ever selected from a refused rendering. Hover needs the
  latest token only, or no rendering vouched for at all.
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

## Scan warnings (`shared/properties/projectScan.ts`)

A project that is odd must still open. `project:scan` never throws for a project's contents: each
step of the scan (config, folders, pages, components, instance counts, titles) runs guarded, and a
step that fails is replaced by an empty result plus a warning. `ScanResult.warnings` lists what the
scan could not read or had to assume; `parseScanResult` refuses a warning with an unknown code, an
empty message, or a file that is not project-relative. A warning never blocks anything: the UI
shows it (the notice is the UI's work, not the scan's) and everything else stays usable.

| Code | `file` | `detail` | Meaning |
|---|---|---|---|
| `dependencies-missing` | none | the package manager | Astro is not installed in the project or any parent folder (`hasDependencies`); the preview cannot start until the manager installs. |
| `folder-unreadable` | the folder | system error code | A folder could not be listed (`EACCES`, `ENOTDIR`); what it holds is missing from the lists. A folder that is simply absent is not a warning. |
| `link-broken` | the link | error code | A symbolic link points at nothing; it is skipped. |
| `link-cycle` | the link | none | A link leads back into a folder already listed; it is skipped, which is what ends the walk. |
| `config-unreadable` | the config | error code | The astro.config exists but cannot be read; Astro's default folders are assumed. |
| `config-computed` | the config | `srcDir`, `publicDir`, `outDir`, `root` or `cacheDir` | The config builds that setting in code (an environment read, a variable, a spread that may override it, a config that is itself a call); Astro's default is assumed. |
| `config-folder-custom` | the config | `srcDir=<folder>` | A literal `srcDir` other than `src`: pages are read from `<folder>/pages`. |
| `scan-step-failed` | none | the step | One step threw; the others' results are still here. |

`ScanResult.packageManager` is `package.json`'s `packageManager` field, else the lockfile
(`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `package-lock.json`),
else npm, asked of the project folder and then each parent, nearest first, because a workspace
package keeps neither in its own folder (`detectPackageManager`).

How the scan reads the disk:

- Every folder walk is `walkFolderSliced` (`electron/project/projectWalk.ts`): iterative, links are
  followed, each real folder is opened once (a set of real paths ends any cycle, so the bound is the
  tree's own size and no cap applies), unreadable folders and broken links are returned as data.
  `node_modules` and `.stacki` are not walked.
- A page is a `.astro` file, or a `.md` / `.mdx` file, under the pages folder. A file or folder whose
  name starts with `_` is not a route (Astro's rule) and is not listed; endpoints (`.ts`, `.js`),
  images, styles and text files under `src/pages` are not pages. Markdown counts as a page only
  inside the pages folder, whatever the project's own path is called.
- `astro.config.*` is read as text by `shared/properties/astroConfigText.ts`: it finds the exported
  object (`export default {…}`, `defineConfig({…})`, an arrow or function returning one,
  `module.exports =`, a named `const`), walks only its top-level keys, and reports each as a literal,
  computed or unset. Comments, nested blocks (`vite: { … }`), strings and regular expressions that look like
  settings are never mistaken for them.
- A save never replaces a read-only file: `replaceFileAtomic` answers a `filesystem` failure naming
  the file (renaming over it would succeed and quietly override the protection).

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
  A field may carry a `computedDefault`: the code of a default the component computes from
  other props (`label ?? named[variant]`, a destructure default reading another prop), the
  prop each destructured local holds and the lookup tables the code reaches, each entry as
  code (`electron/properties/computedDefaults.ts`). The instance panel weighs it for one
  instance's values (`src/features/props/propRules.ts`); code it cannot read shows nothing.
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
  `access`, and must name a member as soon as any other role does: the parser refuses a file where
  another role lists a member while admin lists none (`adminMembershipRefusal`), and the Roles tab
  refuses a save that would make the person saving it non-admin. `developer` (Studio's old label)
  and `designer` (its old stored value) read as admin.
- Unclaimed: a file in which no role lists any member, admin included, is valid (`rolesClaimed` is
  false), so a framework can ship its roles without naming a real person to every user. Its role
  definitions, `defaultRole`, access, app permissions, pins and component rules load and are kept,
  but access is exactly that of no file: `resolveRole` gives everyone the file's admin role (its pins
  and component rules apply), the default role restricts nobody, the CLI's MCP server needs no
  `--role`, and Studio's sign-in policy keeps `AUTH_BOOTSTRAP_ADMIN` as it does with no file
  (`editorPolicy.ts`). It never changes who may sign in or edit. The first admin added claims it.
  Editing one: Desktop's Roles tab and the Components panel change it as read and never add the
  signed-in login (that happens only when creating a new file while signed in); the last admin may
  be removed only while no other role has members; adding a member to another role while admin is
  empty is refused (`roles.error.adminFirst`), and hosted Studio's invite form starts on admin.
  Example:
  `{ "version": 1, "defaultRole": "client", "roles": [{ "id": "admin", "name": "Admin", "members": [] },
  { "id": "client", "name": "Client", "members": [], "access": ["panel:pages", "panel:cms", "publish"] }] }`.
- Older versions refuse an unclaimed file as invalid (`At least one person must be an admin`):
  Desktop still acts as admin, but its Roles tab reports the file unreadable and its next change
  replaces the file with the built-in roles (losing the shipped definitions); hosted Studio keeps
  the same sign-in rules as with no file, but every hosted write acts as the built-in Client role,
  the owner's included; every `stacki` command refuses with `invalid-file`. Nobody gains access.
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
- Add elements: `panel:elements` shows the Add elements rail button, its `A` shortcut, its Settings row
  and its drag-insert; inserting through the palette (⌘K) is not gated. Files written before it existed
  have no grant, so `can` gives it by default to a role that holds `panel:navigator` or a page edit
  permission (`page:create`, `page:delete`, `page:rename`, `page:layout`), and not to any other role;
  admin always has it, and the built-in client holds it explicitly. Because of the default, a role
  with a design panel cannot be denied Add elements on its own. `stacki roles access grant <role>
  panel:elements` works like any feature.
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
- Hidden components: any role, admin included, may hold `componentRules: [{ kind: "component" | "folder",
  path, effect?: "hide" | "show" }]` (shared/properties/componentAccess.ts), at most 1024 rules, project-relative
  `/` paths (`src/components/interactive`), `effect` defaulting to `hide` and written only for `show`. It is a
  deny-list: no rule means visible, so new, moved and renamed components are enabled for every role with no
  migration. The most specific rule wins (component, then the nearest folder above it); a `show` rule
  re-enables one component inside a hidden folder. A rule for a path that no longer exists is kept, listed as
  missing in the Roles tab and ignored. What a rule takes away depends on who holds it, and one rule answers
  for every surface (`componentOffer`, same module). An **admin's** hidden component leaves only what searches
  for something to add (the insert palette that ⌘K and every canvas "+" open, and the Tag and layout fields'
  suggestions); the Components panel (its own filter box too) and the new-page layout dropdowns still list it,
  its row dimmed with a "Hidden from search" tip, and adding it by hand is allowed. **Every other role** loses
  it from all of those and may not add it: Desktop's `addComponent`, layout and kind changes, apps'
  `node.insert`, and Studio's room (`insert` actions, and a text edit that newly imports a hidden component,
  refused with a typed `component-hidden` Result before any write). Add elements lists no project components. Instances already on a page stay, stay editable, show in the
  Navigator, and may be copied, pasted or duplicated. It never changes `can()`, so a restricted admin keeps
  Settings. Nothing in the app moves or renames a component yet; `moveComponentRules` is ready for the
  rename that does, and until then a moved path shows as missing.
- Editing options: any role but admin may hold `editorOff: ["sidePanel", "navigator", "canvasBar", "drag", "text",
  "images", "elements"]` (any subset; shared/properties/projectRoles.ts), written only when non-empty. It is a deny
  list: an option only takes away, and a file without it grants and reads exactly as before. `sidePanel` is the
  right panel (Style and Settings), `navigator` the element tree, `canvasBar` the bar over the page; `drag`, `text`,
  `images` and `elements` (add, paste, duplicate, delete) are what may be done on the page. With `drag`, `text` and
  `images` all off the role is read only and `elements` goes with them (also when a role with neither right panel
  permission switches off `drag` and `text`: it never changed pictures). A value this version cannot read, an unknown
  part included, reads as every part off. `can()` withholds what would reach a switched-off option another way
  (`editorWithholds`): `navigator` takes `panel:navigator`; `sidePanel` takes the Style, Settings, Selectors and
  Variables panels and breakpoint settings; `sidePanel` or any page option takes Code, `code:edit`, AI chat, Git,
  Audits, component properties, creating and editing components and `page:create`; `text` or `images` takes the CMS;
  `images` takes Assets; `elements` takes Add elements and Components; read only also takes publishing, renaming and
  deleting pages, settings writes and the CLI's write commands. The navigator and canvas bar alone limit no write.
- Studio enforces editing options on the server. A read only role sends no write route at all but the few POSTs
  that only read (`READ_ONLY_POSTS`, editorRoutes.ts) and changes no document. A limited role may not create page
  files or save markup through `/studio/api/create` or `/studio/api/source`. Over the socket, named actions are
  judged by kind (`editorActions.ts`: `move` is `drag`; `insert`, `duplicate`, `delete` and `paste` are `elements`;
  a paste must be a verbatim copy of a node on that page; app markup is refused). A plain text edit is judged by what
  it changes (`editorContent.ts`): without the panel only the allowed words and pictures may differ, byte for byte;
  with it, what is switched off must read the same. Which component props are words, and which frontmatter strings
  the page prints, come from the canvas text editor's own tracers. A limited person may undo and redo their own
  accepted changes while nobody else has changed the file (`editorUndo.ts`).
- Editing options and older versions: 1.4.21 and earlier ignore the unknown key, so they apply none of these options
  (nobody gains anything the role's `access` did not already give), and their Roles tab or CLI drops the key when it
  saves the file. Options therefore hold only once the Studio server runs this version or later. A broken roles file
  still falls back to Client on Studio, as before, and to a read only Client when the file names `editorOff`.
- No file means everyone is admin, exactly as before. Studio gives a signed-in GitHub user the role
  naming them, else `defaultRole` (admin unless set). A local Studio, with no sign-in, is admin.
  **Desktop never resolves a restricted role**: whoever is signed in, and whatever the file says, the
  local person acts as admin (`desktopRoleOf` in `src/app/roles/useProjectRoles.ts`).

Enforcement: **Desktop previews roles, Studio enforces them.** On Desktop the person works on their own
files on disk and can edit `.stacki/roles.json` or the site directly, so a role there would only lock the
owner out (it did, in 1.4.9: a named non-admin got a read-only Roles tab). So Desktop has no IPC role gate,
Settings → Roles is always editable, and nothing in main refuses a write for a role. The renderer still
hides what `can()` refuses, but only for "View as" (below). The Studio server refuses write routes the
sender's role lacks with 403 (`studio/src/features/roles/serverAccess.ts`), trusting the login only from the
worker's authenticated `x-studio-user`; a broken file fails closed to the client role there, and Studio's
Roles view is read-only for a non-admin. Document edits over the collaboration socket stay UI-gated, as
Client mode was. The CLI and MCP server act as a role only when asked (`--role`, `--login`), a cooperative
tier for agents (docs/stacki-cli.md).

"View as" (Settings → Roles on Desktop, the account menu in Studio) lets an admin preview another
role's UI. It changes only the renderer's active role (`src/lib/currentRole.ts`: `currentRole()` and
`onRoleChange()`), never the file or what the server allows; Settings → Roles stays editable while previewing. Studio keeps the choice for the tab in sessionStorage (`studio-role`).

## Settings panel and secrets

The Settings rail button (`projectSettings`, access feature `panel:projectSettings`, admin only until a
role is granted it; shortcut ⌥Z) sits directly above the AI button and opens a panel whose root is a short
list of links (`SETTINGS_VIEW_IDS` in `src/lib/settingsSections.ts`): Secrets, MCP and Instructions. A link
replaces the panel with that view under a back chevron and the view's title; back, or Escape outside a field,
returns to the root, and the panel always opens on the root unless something asked for a view
(`requestSettingsSection`: ⌥I, an app naming the `instructions` panel, a session that left the retired
Instructions panel open). Which links show follows the role (`settingsViewsOf` in `src/lib/roleAccess.ts`):
`panel:projectSettings` gives Secrets and MCP, `panel:instructions` gives Instructions, so a role with only
the second sees Settings with one link. The frame (`ProjectSettingsShell.tsx`) is shared with hosted Studio,
which lists Secrets and MCP with honest unavailable states and no Instructions. Back or Escape from the
Instructions view also closes the instruction file opened from its list (its edits are saved as the reading
view unmounts, as with its own close button).

Rail chords live in one table, `src/app/railShortcuts.ts`, which Desktop's and Studio's keys, the tooltips and the
Settings root rows all read (a test holds it free of duplicates, the preview toggle among them). Each is ⌥ (Alt) plus a
letter, matched on the physical key: E Add elements, P Pages, N Navigator, K Assets, D CMS, V Variables, G Git,
C Components, B Apps, O Code, F Files, S Style selectors, U Audits, Z Settings, A AI chat, R Secrets, M MCP,
I Instructions, Q Agents. Properties alone is a plain K. ⌥⇧P is the interactive preview; the right panel's Style and
Settings tabs are plain S and D (`src/app/inspectorTabKeys.ts`). ⌥I, ⌥R, ⌥M and ⌥Q open Settings at their view, and
toggle the panel closed when that view is showing; ⌥A toggles the AI chat. Each follows the role (no access, no key)
and is ignored while typing in a field, a code editor or canvas text, so macOS dead keys (⌥E, ⌥N, ⌥U, ⌥I) still type
there. With keyboard focus in the canvas, outside interact mode, the frame forwards them (`avb:shortcut` `panel` in
Desktop, `studio:key` in Studio).

Desktop alone also has ⌥⇧G (Alt+Shift+G), pull from GitHub, under the same typing rule and forwarded from the canvas in
both modes (`avb:shortcut` `pull`). The chord, the title bar's pull button (drawn only while there is something to pull)
and the Git panel share one session and lock (`src/features/git/useGitSession.ts`), so one pull runs at a time and the
merge review opens with the panel closed. A pull is refused over the component defaults page, the component canvas, a
property save, Design mode and the busy cover, and a role without `panel:history` has neither. Nothing pulls by itself.

Settings (⌥Z) is the project's settings,
apart from the app's own Settings screen (`src/app/settings`). Its Secrets view edits one of the project's dev env files
at a time (`SECRETS_FILE_NAMES`: `.env`, `.env.local`, `.env.development`, `.env.development.local`, the
dev server's load order), picked in a dropdown that opens on `.env`. `.env.production` is not listed.

- `shared/properties/envFile.ts` is the codec. It keeps comments, blank lines, quoting, `export`
  prefixes, spacing, the byte-order mark and line endings: parse then serialize is byte-identical, and an
  edit rewrites only the line it touches. Bounds: names 128 characters, values 16 KiB, 512 variables,
  4000 lines, 256 KiB. Multi-line quoted values are listed but not edited here.
- Every `secrets:*` message names its `file`, and the parser refuses any name outside `SECRETS_FILE_NAMES`.
  `secrets:list` returns names only; a row whose name a file loading later sets again carries
  `overriddenBy` (the last such file, worked out from that file's names alone). `secrets:read` returns one
  value, for a person who revealed or began editing it. `secrets:apply` applies one change (`add`,
  `update`, `remove`, `create`) against the revision (digest of the file's bytes) it was authored on; a
  file that changed since is refused with `changed`. `secrets:ignore` appends the file to `.gitignore`; it
  refuses `.env.development`, which is usually committed on purpose and gets no Git warning in the tab.
  A missing file is the ordinary empty list. The MCP tab stores secrets in `.env` only.
- Writes go through the document actors (atomic, mode kept); a new `.env` is made mode 0600 first.
  No value appears in a log, an error, a listing or the DOM of a hidden row; failures are fixed text per code.
- The list reloads when the window regains focus; there is no file watcher for `.env` yet.
- A running app whose main process or preload predates these channels shows "restart Stacki" rather than a
  read failure (`SecretsUnavailableError`).
- Studio does not show the panel: its project files live in a browser store or a repository, where a
  `.env` would be committed or shared, so Studio's rail does not list it and `panel:projectSettings` has no
  Studio route.

## Settings panel: MCP servers

The Settings panel's second tab, MCP, lists the servers in the project's `.mcp.json` (Claude Code's project
file, top-level `mcpServers`) as cards, adds one from a typed provider catalog or from a pasted line, edits and
removes them, and offers a JSON view of the whole file. It follows the Secrets tab's architecture.

- Wire shapes and parsers: `shared/properties/mcp.ts`. The model, bounds and summaries: `mcpConfig.ts`
  (`MCP_LIMITS`: 64 servers, names `[A-Za-z0-9_.-]{1,64}`, 64 arguments of 2 KiB, 64 variables or headers, file
  256 KiB). The `.mcp.json` codec: `mcpJson.ts`. The pasted-command reader: `mcpCommand.ts`. The provider catalog:
  `mcpProviders.ts` (entries marked `// verify` were not checked against the provider's current documentation).
- Channels: `mcp:read` (summaries, never a literal variable or header value), `mcp:readText` (the file's text, for
  the JSON view), `mcp:reveal` (one server's values, for a person who began editing it), `mcp:apply` (`add`, `update`,
  `remove` against a revision, a digest of the file's bytes), `mcp:saveText` (the whole text from the JSON view, checked
  again in main), and for Codex `mcp:readCodex`, `mcp:revealCodex` and `mcp:applyCodex`.
- `.mcp.json` is edited by region: an edit replaces, inserts or deletes only the entry (or the managed fields of the
  entry: `type`, `command`, `args`, `env`, `url`, `headers`) it names. Indentation, key order, line endings, unknown
  top-level keys and unknown per-server fields keep their bytes. A repeated key, a comment or a trailing comma is a
  refusal with a line and column. Writes go through the document actors; a stale revision is `changed`.
- A pasted line (`claude mcp add ...`, `add-json`, `codex mcp add ...`, a URL, an `npx` line) is parsed as inert text
  into a typed server and shown as a preview; it is never passed to a shell. Unquoted `;`, `&&`, `|`, `>`, backticks,
  `$(`, newlines and comments refuse the whole line. The panel always writes the project file, whatever scope was
  pasted. Literal variable and header values move to `.env` through the Secrets store and `.mcp.json` keeps `${NAME}`.
- Codex keeps servers in `~/.codex/config.toml`, user-wide. No channel takes a path: main builds that one path from the
  home folder. A change names a project server by name; main reads it from `.mcp.json`, maps it (`mcpCodex.ts`), and
  `mcpToml.ts` splices only that `[mcp_servers.<name>]` table (and its `env`, `http_headers`, `env_http_headers`
  sub-tables), refusing on any doubt about the file. The file is replaced atomically beside itself, keeping its mode,
  after a digest check; the panel asks first and says the file is outside the project. The Codex CLI's HTTP keys
  (`url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`) come from its documentation, not from a
  checked install.
- A running app that predates the channels shows "restart Stacki" (`McpUnavailableError`), as the Secrets tab does.
- Studio does not show the panel; `mcp.ts` and `mcpConfig.ts` reach Studio only because the shared IPC types import them.

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

The install payload may carry a bounded `auth` choice and `studio:setAuth` changes it later
(`github`, `access`, `google`, `oidc` or `passkey`). `shared/ipc/studioAuth.ts` is the one parser:
unknown keys are refused, so a client secret has no field to ride in; every value is checked with the
same rules `npm create stacki` uses (https issuer, bounded lists, email and domain shapes). Absent
`auth` means GitHub. Main writes only the sign-in variables into `studio/cloudflare/wrangler.jsonc`
(`shared/ipc/studioAuthConfigFile.ts`, a surgical edit that keeps comments and every other member):
into the staged copy on install, into the installed file on `studio:setAuth`, which needs the
`settings:studio` feature. `studio:status` reports the file's current type as `signIn`
(`custom` when `AUTH_PROVIDER` is something Stacki did not write). Secrets are never written
anywhere; the dialog only shows the `wrangler secret put` commands to copy.

Each installation carries a bounded `requestId`. The `studio:progress` event echoes
that ID and the requested project path alongside the current stage and a bounded
tail of command output. Preload exposes `onStudioProgress`; the renderer parses
each snapshot before use and ignores other projects or previous attempts. Main
batches output at 150 ms intervals, flushes on stage changes and completion, and
caps command time and output. Progress counts completed stages, not elapsed time.

### Upgrading an installed Studio

`studio:upgradeCheck` (project path) answers what Settings > Stacki Studio may offer; `studio:upgrade`
(project path, `requestId`) runs it and reports through the same `studio:progress` event as an install.
`shared/ipc/studioUpgrade.ts` holds the pure rules and both parsers. The latest version is the newest
`flowtricks/stacki-releases` release that carries a Studio bundle (`latestRelease`); offline or
unparsable versions answer `unavailable` and the box shows nothing. Only an exact stable version is compared.
A behind version is `ready` only when nothing an upgrade would lose or break exists. The updater replaces
the whole `studio/` folder and keeps just `retainedPath` entries (no merge), so a conflict is: an edited
Studio file, an added file outside retained folders, a deleted release file, `cloudflare/auth-provider.ts`
(kept, but its interface is experimental) or a custom `AUTH_PROVIDER`. Main compares the folder with the
installed version's own release (line endings normalised); if that cannot be done, or the folder exceeds
the scan bounds, the answer is `unverified` and no run is offered. `studio:upgrade` repeats the check in
main and refuses anything but `ready`, then downloads the latest release and runs the same transactional
`installRelease` as `astro-studio update` (npm ci, check and build run through `runStudioCommand`: argument
arrays, 180 s per command, 2 MiB output cap), keeping the previous folder under `.stacki/studio/updates`.
`npm create stacki@latest` is not used: it leaves an installed Studio untouched.

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

`codeChips` (Settings > Editor > Code, "Show CSS chips in code"; default on, kept per person in
`settings.json`) draws CSS values in the code editors as chips: variables as the purple chip, easings,
clip-paths, shadows and gradients with a small preview that opens the Style panel's editor for that
value (`src/features/style/codeChips/`). It changes only what is drawn: the text, a copy and every save
are the CSS as written. Turned off, each open editor shows plain CSS at once. Studio and the demo have
no app settings file and keep the default.

## Interface language in the main process

`locale:set` takes `{ preference }` (`"system"` or a shipped locale; anything else is refused) and returns `{ saved }`. The shipped locales are
`LOCALES` in `shared/core/i18n/locales.ts`: `en` (source), `es`, `fr`, `de`, `pt-BR`, `it`, `nl`, `pl`, `tr`, `ru`, `id`, `hi`, `ar`, `he`, `ja`, `ko`, `zh-CN`, `zh-TW`; each has a row in `LOCALE_INFO` (native name, catalog directory, text direction),
and a stored value that is not exactly one of them (`zh`, `AR`, `he-IL`) is ignored, never guessed. `ar` and `he` are right to left: the renderer
sets `dir="rtl"` on the document root, main sets it on the recovery page. The renderer sends its stored
choice at startup and on every change; main keeps it as `localePreference` in `settings.json` (absent means `"system"`), rebuilds the application
menu, and translates native dialogs with the same catalogs (`menu`, `dialog`, `error` namespaces). A failed disk write applies for the session only.
Failure results may carry an optional `messageRef` (`{ key, params? }`, `parseMessageRef`) next to their English `message`; readers that do not know the key show the message.

## Astro copy of a plain website (`shared/ipc/astroCopy.ts`)

The Welcome screen's "Open from folder", File > Open Project and the recovery screen call
`project:openSiteDialog` (no payload): main shows the folder picker and answers `SiteFolderChoice`, one of
`canceled`, `astro` (open it), `nestedSites` (websites inside the folder, below),
`plainWebsite` (the folder, its parent, the suggested `<folder>-astro` name and the home folder for display)
or `notWebsite` (a toast; `searched` is `part` when the search inside the folder stopped at a bound). Detection (`electron/project/plainSiteScan.ts`) is `isAstroProject` or a
`src/pages/*.astro`, else at least one `.html`/`.htm` page in the folder's top two levels, skipping installed
packages, build output, vendored code and hidden folders; it reads names only, bounded by depth and entries
(`PLAIN_SITE_LIMITS`), and never follows a link to a folder or out of the picked folder.

`project:checkAstroCopy` and `project:createAstroCopy` take `AstroCopyRequest` (`sourcePath`, `parentPath`,
`name`): both paths absolute and normalized in shape by `parseAbsolutePath` and by the platform in main
(`path.resolve(p) === p`), the name one folder name (no separator or NUL). The check answers
`Result<{ targetPath }, AstroCopyTargetProblem>` (`name-empty`, `name-invalid`, `target-exists`,
`location-missing`, `location-unwritable`, `inside-original`); `astroCopyNameProblem` is the same name rule in
the renderer and main. The create answers `Result<AstroCopyCreated, AstroCopyFailure>`: the project path,
counts, the pages kept as plain files (at most `ASTRO_COPY_LIMITS.reportPathsMax` listed, all counted) and
the install outcome; or a failure code (a target problem, `not-plain-website`, `too-many-files`,
`too-many-bytes`, `file-too-large` with the file, `package-manager-missing`, `copy-failed` with the detail).
Its progress streams on `create:log`, as the new-site wizards' does.

The original is only read. The plan (`electron/project/astroCopyPlan.ts`) puts each page at
`src/pages/<same path>.astro` and every other file at `public/<same path>`; `astro.config.mjs` builds with
`format: 'preserve'` and `inlineStylesheets: 'always'`, so every old address, relative URL and CSS `url()`
resolves as before. Pages Astro cannot route as themselves (`_` or `[`/`]` names, the loser of two pages on
one route) are copied unchanged under `public/`; a `.htm` page gets a forwarding page at its old address.
`htmlToAstro.ts` changes only what Astro reads differently from a browser (braces in text, capitalised tags,
unquoted braced values, `is:inline` scripts and slots, `is:global` styles, a leading `---`). The copy is
written into a `mkdtemp` sibling and renamed into place after the target is checked missing again; any
failure removes that temporary folder and nothing else. A failed install keeps the finished copy.

## Websites inside a picked folder (`NestedSitesChoice`, `electron/project/nestedSiteScan.ts`)

A folder that opens as a project answers `astro` at once and is never searched. The one exception is a folder
that opens only because its package.json lists astro: no config, no `src/pages`, no script that runs a site from
there (a workspace root, or a package that builds on astro). It is searched, and stays `astro` unless a site is
found. A folder that does not open is searched before it is called a plain website or neither. `git:clone`
asks the same question and may answer `nested` with the same choice.

The search goes by what folders hold, never by their names or a workspace file's globs: a site has an Astro
config, or `.astro` pages directly in `src/pages`, or a package.json that lists astro beside a `src/pages`
folder, or installs astro and runs `astro dev`, `build` or `preview` in place (no `--root`). Depending on astro
alone is not enough. It skips installed packages and hidden folders, looks at build-output and `public` folders
without reading below them, does not search inside a found site, never follows a link to a folder, and does not
walk the home folder or a folder that holds it. It goes level by level, yields after each folder, and is bounded
by depth, folders, entries and time (`NESTED_SCAN_LIMITS`) and by `NESTED_SITE_LIMITS.sitesMax` results.
Folder names such as `examples` or `fixtures` only move a site down the list.

The choice holds the picked folder, the sites (absolute path, `/`-separated path below the folder, package name),
`searched` and `instead`: what the folder offered by itself (`openFolder`, `plainWebsite` with the copy offer, or
`nothing`). Nothing opens until the person picks one (`src/features/welcome/nestedSites.ts`).

A site in a workspace may have no `node_modules/.bin/astro` of its own. Preview, old-version preview and
thumbnails ask the site's folder first, then the folders its workspace installs into
(`electron/lib/installFolders.ts`), never above the repository or workspace and never the home folder or above.
Yarn Plug'n'Play has no command to run there; the preview says so.

## Folders from outside the app (`shared/ipc/folderOpen.ts`)

A folder dropped on the window, dropped on the app's icon (macOS `open-file`, which a Dock drop sends only in a
packaged build whose Info.plist declares `public.folder`: `build.mac.extendInfo.CFBundleDocumentTypes`), named on
the command line, or named by a second launch (`second-instance`; packaged builds take the single-instance lock)
gets the answer "Open from folder" gives: `FolderOpenChoice` is `SiteFolderChoice` without `canceled`, or
`rejected` with `missing`, `notFolder` or `unreadable`. Main decides (`electron/project/folderOpen.ts`): the path
is absolute, within `BOUNDARY_LIMITS.pathLengthMax` and NUL-free, `lstat`, `realpath` and `stat` succeed (a link
opens its target, a dangling link is `missing`, a loop is `unreadable`), and it is a directory; then
`siteFolderChoice` classifies it. Answers go out one at a time, in the order the folders arrived.

`project:inspectFolder` (a path) answers for a window drop; the renderer names the path from the drag through the
preload's `getFilePath` and never opens it unanswered. Folders from the icon and the command line wait in main's
queue (at most `FOLDER_OPEN_LIMITS.queueMax`, a waiting duplicate dropped) until the page calls
`project:takeOpenedFolders` (no payload; the waiting answers, oldest first); after that take main pushes each one
on `project:folderOpened`, and holds again from the moment the main frame starts a new document, crashes or
closes. The renderer listens before it takes, once per page (`FolderDropHost.tsx`).

The window shows its drop fill only while a drag holds `Files` and nothing but untyped file items (a folder from
Finder or Explorer) and no drop target under the pointer has called `preventDefault`; in-app drags and typed files
stay with their own targets. The first dropped folder opens; the rest are counted in one toast. With a project
open, an Astro project opens through `leaveProject` (edits flushed, the window reloads into it), and a plain
website gets the Astro copy dialog in the project window.

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

`.stacki/breakpoints.json` contains `{ version: 4, desktop: { value, unit }, breakpoints: [...] }`
(`shared/properties/projectBreakpoints.ts`): Desktop's frame width and an ordered list of `{ id, name?, value, unit }`,
`unit` `rem` or `px`. Desktop is 90rem (1440px) unless set. It is **never a media query**: its only uses are the width of the
Desktop frame in the side-by-side (all breakpoints) view, the single canvas's Desktop width, and the line that decides on which
side of Desktop a breakpoint is. The single canvas is the pane's own width and reflows; it draws that Desktop width, framed
and scaled to fit, only while a pick of Desktop made in a pane too narrow for the desktop layout is held, and the next resize
of the pane ends the pick (`DesktopPick`, docs/style-follow-canvas.md). A breakpoint has no stored direction: it is DERIVED from its
number against Desktop's (`directionOf`). Wider than Desktop it is `up`, the query `width >= X` (mobile first), and its canvas is
exactly X (100rem is 1600px); narrower it is `down`, `width < X`, canvas X less 1px (64rem is 1023px); equal to Desktop is refused.
The defaults, with no file, are the Lumos 64rem, 48rem and 30rem breakpoints (ids `laptop`, `tablet`, `phone`, names read in the
person's language until renamed) around a 90rem Desktop. The list is strictly decreasing in pixels with Desktop in it (the wider
ones, Desktop, the narrower ones), so each card's neighbours, Desktop among them, are its limits, and Desktop may only move between
the largest narrower breakpoint and the smallest wider one (`desktopBlocker` names the breakpoint in the way); each boundary from
281px to 7681px (what the canvas can draw), px whole and rem to four decimals; ids (`bp-1`; `desktop` is reserved) and names (1 to
24 characters) are unique; at most 11 breakpoints; the list may be empty. `canvasWidthPx` is the only resolver; the preview bar
(wider ones widest first, Desktop, narrower ones, the canvas; shortcuts 1 to 9 follow that order), canvas sizing and the
all-breakpoints view read widths only through it, and icons are chosen by position (`breakpointIcon.ts`). Versions 1 (whole pixel
widths), 2 (laptop, tablet, phone as `{ value, unit }`) and 3 (a list with a stored `direction`) are read as version 4 without being
rewritten: Desktop is 90rem when absent, a stored direction is ignored and recomputed from the number (a file that disagrees with
itself is read as derived), and no canvas width moves. Unknown keys and every other bad shape are refused by
`parseBreakpointsSource`, a `Result`; a refused file shows the defaults with a notice and is never overwritten. Reading never
writes: the file is created by the first edit, and a save equal to the file's bytes, or to the defaults when there is no file, writes
nothing. Removing a breakpoint never edits project CSS. Desktop and Studio read it through the `breakpoints` metadata kind
(witnessed, atomic writes; written with `settings:breakpoints`) into one per-project store (`src/ipc/projectBreakpoints.ts`, whose
state carries `config`, `list`, `resolved` and `desktop`). Stacki writes no media query from these numbers; authored queries keep
their own unit and Base (`baseWidth.ts`) is read from those.

**Following the canvas in a desktop-first component.** The style panel's Follow canvas size toggle normally checks the query that
already holds at the canvas width (`followWidth.ts`). When the component is desktop-first, the breakpoint that holds at the canvas
width is the target even with no rule written for it: Tablet at 700px reads `< 48rem`, never Base (`embed/followBreakpoint.ts`).
The direction is read from the component's own width queries (mostly `width >= X` is mobile-first, mostly `width < X` is
desktop-first, the Add query form's `detectConvention`); with no width query or an even split the project's breakpoints decide
(breakpoints narrower than Desktop are desktop-first, and a project with only wider ones is mobile-first), so a silent guess never
picks the direction. A mobile-first component keeps Base at the smallest width. Selecting writes nothing: the breakpoint is
registered like a typed query, and the first style written under it creates `@media (width < 48rem)` after the existing rules, in the
same file the panel writes Base to, as one edit; later styles go into that block. A held panel (Follow canvas size off) ignores
the canvas width entirely.

**Where breakpoints are used.** Settings > Breakpoints shows each breakpoint's places before anything is changed: `breakpointSync:usage`
(`scanBreakpointUsage`) answers, for the breakpoints' CURRENT saved values, the places per file (one pass for all, files cached
by time and size, re-run when the tab opens, a value is saved, the window returns or a sync is applied). A card says
`Used in N places · M files`, and its chevron opens the same file rows as the sync dialog, with a box per file and per place; while
a different valid value is typed it says what that change will touch. Each tick is one write to `.stacki/breakpoint-sync.json`
through the metadata transport (`recordWithChoices`): an exact place is remembered only when unchecked (`excluded`, "Not synced"),
an inclusive or exclusive one only when checked (`linked`), and a scan itself writes nothing. The dialog after a change starts from
the same set.

**Breakpoint sync.** Committing a changed breakpoint in Settings scans the project (Desktop only; Studio has no Settings
dialog) for `@media` width bounds equal to its OLD value (`shared/properties/mediaBreakpointSync.ts`, executed in main by
`electron/project/breakpointSync.ts`; channels `breakpointSync:scan`, `:apply`, `:restore`). Matching reads only `@media`
preludes (comments and strings skipped) and only `width`, `min-width` and `max-width` in `px` or `rem`: `(width >= X)`,
`(width < X)`, `(width <= X)`, `(X <= width)`, `(a < width <= b)` (each bound on its own), `(min-width: X)`, `(max-width: X)`,
inside `only screen and`, `and` and comma lists, in any case and spacing, including nested in `@supports` and `@layer`. A bound
is **exact** when it equals the old boundary in either unit (64rem = 1024px, 16px per rem). For an `up` (`width >= X`)
breakpoint, `(width > X)` and `(X < width)` are the **exclusive** form (ambiguous, unchecked, rewritten as written). It is
**inclusive** (ambiguous, unchecked) when it is 1px short in the form that includes its own edge: `(max-width: 1023px)`, `(width <= 1023px)`,
`(width > 1023px)`, `63.9375rem`. `height`, `min-height`, `prefers-*`, `em`, `vw`, `calc()` and `@container` are never touched.
Only the number+unit token is replaced (CRLF, tabs and minified text stay byte for byte): an exact match takes the new value as
typed, an inclusive one the new boundary minus 1px; a Lumos project (rem only) is always written in rem. It scans `.css`,
`.scss`, `.sass`, `.less`, `.pcss` files, `<style>` blocks of `.astro` pages and components (the editor's own style-region
parser, blocks inside expressions left out) and `.html`, skipping dotted folders, `node_modules`, `dist`, `build`, `out`,
`vendor`, `coverage` and plain folder or `*.ext` patterns in the root `.gitignore`, within named limits (files, bytes, depth,
places). Nothing is written by a scan. Apply checks each file's digest against the scan (a changed file is skipped and
reported), each edit's text, the bound count and locators of the result and that the CSS still parses, writes through the
witnessed document writer, puts back the files already written on any failure, and journals the sync for Undo and Redo.
`.stacki/breakpoint-sync.json` (`shared/properties/breakpointSyncRecord.ts`) holds, per breakpoint id, `excluded` places (listed
unchecked as "Not synced" on every later sync, whatever value they hold) and `linked` places with `appliedAt`; a place is a
project-relative file and a locator (the masked prelude hashed, plus its ordinal), which survives the number and line changing.
It is bounded, canonical (sorted, deduplicated), created by the first sync that has something to remember, and never written
over when unreadable.

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

**New style tags** (`newStyleTag`, `shared/properties/newStyleTag.ts`). An optional section of
`.stacki/styles.json`, `{ version: 2, attributes?: string, content?: string }`, says what a `<style>` tag
the Style panel creates starts with. `attributes` is the opening tag's attribute text as written
(`is:global lang="scss" media="screen"`): Astro attribute names, quoted values, no `{expressions}`, no
name twice; `""` is a plain `<style>`. Absent (the section or the key) means `is:global`, Stacki's
default, because the panel writes plain selectors and a scoped tag would hash them away from elements
rendered through components; projects made by Stacki also have it written out
(`electron/project/newProjectDefaults.ts`). Version 1 (`{ version?: 1, isGlobal?: boolean, content? }`,
written by earlier Stacki versions) is still read: `isGlobal: true` is `is:global`, `false` is a plain
`<style>`, absent is the default; the next save writes version 2. A version 2 section with `isGlobal`
is refused. In code the setting is `{ attributes: StyleTagAttribute[], content }`; the hosts write the
attributes in order (`styleTagNode` in Desktop, `addStyleBlockSource` in Studio). `content` is a
template; the rules placeholder is the CSS comment
`/* stacki:rules */`, at most once, at the top level or inside at-rule blocks (never inside a style
rule). With no placeholder, a template ending in a block `@layer`/`@media`/`@supports`/`@container`/`@scope`
takes rules inside that block, after what it holds; any other template gets rules after it, at the top
level. A placeholder at the top level means after the template's own content. A template that does not
parse (unclosed brace, comment or string, repeated or misplaced placeholder) is refused by the file
parser and by the Settings page, which never saves it. A tag follows the template when its top level
already holds the wrapper chain (same at-rule names and parameters, whitespace-insensitive): new rules
go inside the innermost wrapper after the rules there; a one-line wrapper (`@layer components {}`) is
opened onto its own lines when its first rule goes in; any other tag is written exactly as before.
Stacki never wraps or moves rules a person wrote. Settings > New style locations edits it, once per scope
(below), as one code block holding the whole tag (`src/app/settings/StyleTagSettings.tsx`): the attributes
and the content are editable, `<style`, the opening `>` and `</style>` are locked (`styleTagEditor.ts`), and
attributes that do not parse mark the block invalid and are not saved. The Style panel's "Add custom styles
in" list links to it (New style locations…).

**New style locations** (`shared/properties/newStyleLocations.ts`, the `newStyleLocations` section of
`.stacki/styles.json`). Two scopes, `page` (a style created while a page is open) and `component` (while a
component is open, and the tag a component made by Create component starts with). Each is
`{ use: "tag" | "file", file?, tag }`: `tag` is a `<style>` tag in the open file, started from the scope's own
`tag` (the `newStyleTag` shape above); `file` is an existing stylesheet of the project, a project-relative
path with a `.css`/`.scss`/`.sass`/`.less` extension, no `..`, at most 512 characters and 32 steps. The scope's
`tag` is kept beside a file, because it is what a switch back starts from and what is used while the file is
missing: a chosen file that is not among the project's stylesheets is never written to; the panel writes
the tag and the Settings tab shows a warning chip. A project that holds only the older `newStyleTag` reads it
as both scopes, so nothing changes until a person changes a setting; the first save writes the new section and
mirrors the page's tag into `newStyleTag` for an older Stacki. A new rule goes into the chosen file by these
rules (`fileRuleWrappers`): where a `/* stacki:rules */` marker in the file sits; else inside the file's LAST
top-level `@layer` block, after what it holds; else at the top level. A file that ends in `@media` or
`@supports` gets the rule at the top level, because a base rule written inside would become conditional. Only
the file the scope chose is placed this way; every other stylesheet is written as ever. The scope is the open
file's kind (`openStyleScope`); "Add custom styles in" defaults to the chosen file, and Create component's
moved styles use the `component` scope's tag. The CLI reaches the section as `newStyleLocations.page.use`,
`newStyleLocations.page.file`, `newStyleLocations.component.tag.content` and so on. The CLI reaches it as `newStyleTag.attributes` and `newStyleTag.content`
(`stacki config set styles newStyleTag.attributes 'is:global lang="scss"'`).

**The first tag is created once** (`model/firstTagLane.ts`, driven by `embed/useEditorResolution.ts`).
Every write that needs a new tag before the panel's scan shows it joins the one tag being created for the
open file: writes made in the same event (the four sides of a Shift-drag) go into the tag as one host
edit and one undo step; writes made while it saves wait, one per selector and property (the last value
wins), and are written into that tag once the scan shows it. A failed tag drops what waited; a scan that
never shows the tag stops being waited for after a bounded number of scans. Duplicate `<style>` tags a
page already has are never merged or rewritten.

**Where a new selector's first style goes** (`model/newStyleTarget.ts`, consumed by
`embed/useEditorContexts.ts`). A selector with rules keeps going to the file that defines them
(`selectorHome.ts`). A selector with none goes to the open page's or component's own `<style>`: the
first that is not `define:vars`, preferring one whose scope matches the setting, else the first. With no
`<style>` in an `.astro` file the dropdown lists a virtual `Create <style>` entry first and the chip shows
it with a plus icon. Selecting, hovering and choosing it write nothing: the tag is created, with the template
and `is:global` per the setting, by the first style written, as one page edit (one undo step; undo removes
the tag, and the class it needed). It is appended at the end of the file, never inside the frontmatter.
Picking another source holds until the element or selector changes; inside a component opened from an
instance the source stays pinned as before. Studio uses the same panel code; its `styleBlockEdit.ts`
writes `<style>` or `<style is:global>` from the request's `scope`.

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

`component:classUsage` takes `{ projectPath, pagePath, classes }` and answers which files other than
the page mention each class (`shared/properties/classUsage.ts`, `electron/properties/classMentions.ts`):
one entry per class, at most `filesPerClassMax` project-relative paths each, `[]` when none does. It
reads the project as the unused-selector check does: an `.astro` file by its text with its style blocks
blanked, other texts as they are, stylesheets not at all, since a rule for a class is not a use of it.
Only files under `src/` count: a README or a framework's notes use class names as plain words.
Create component asks it before offering to move CSS: a class no file mentions, and no other element of
the page carries, is offered checked; a utility (`u-`) is never offered, and a stylesheet locked in
`.stacki/styles.json` keeps its rules, so a project marks its own utilities whatever their convention
(`src/editor/componentStyles.ts`).

Creating the component then moves the checked classes' rules, read again from disk at that moment: the
new file gets one `<style>` shaped by `newStyleTag`, written after the markup in the same `component:create`
nodes, and the rules leave the page's `<style>` tags (in the extraction's gesture; a tag left empty is
removed) and each unlocked stylesheet (`style:writeFile`). What is carried and what is removed are judged
by the paste rule, `carriedStyles` and `withoutCarried` (`src/editor/pasteStyles.ts`), so no rule is lost
or written twice; a selector list keeps its other members, an emptied wrapping at-rule goes, keyframes
stay. Copy first, delete last: the component is written and read back, the page is saved using it (its save
state reaches `clean`), and only then do the stylesheets lose the rules, so a crash at any point can leave a
rule twice, never nowhere. Each stylesheet write carries `expected`, and main's actor refuses it unless the
file still holds that text. It is one undo step, all or nothing: `StepFiles.check` asks every stylesheet first
and a sheet edited since refuses the whole step before anything is written; undo puts the rules back in the
sheets before the page is reverted, then deletes the component, and redo mirrors it. A page `<style>` that
changed between the plan and the write cancels the creation. With nothing checked, no CSS is touched.

A move is journalled in main (`styleMove:record`, `styleMove:clear`, `styleMove:pending`, `styleMove:resolve`;
`shared/properties/styleMoveJournal.ts`, `electron/content/styleMoveJournals.ts`): one journal per project in the
app's `logs/` folder, as `<project>-<8 hex of its path>-style-move.json`, never in the project, written durably (temporary file, `fsync`, rename, folder
`fsync`). It holds the plan, not the progress: each file with its exact text before and after. It is recorded once
the component is written and read back, before the page or a stylesheet is; it learns the page's saved text, and
goes once the stylesheets are clean. Where a move stands is read from the disk against it: a file at its before text
is left, at its after text done, at neither changed by someone. When a project opens, a journal found untouched or
done just goes; an interrupted one asks to finish or undo (both exact, written in the copy-first order and the
reverse, each write refused unless the file holds what was read); one with a changed file writes nothing and names
it. Undoing is refused for a page whose saved text the journal never learnt, since it cannot be told from later edits;
finishing is refused (and not offered: `canFinish`) for a page not saved yet, since the stylesheets would lose rules
the page does not take from the component yet. While a move runs, the busy cover holds the window (`src/ui/busyLock.ts`):
it takes the pointer and every key, and the menu's edit commands do nothing; it shows only after 300ms.

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

Pages follow the config: `project:scan` reports `pagesFolder` (`<srcDir>/pages`, `srcDir` read from
the first `astro.config.*` Astro loads, as a plain value only; the config never runs, see
"Scan warnings") and `astroConfig`, and lists pages from that folder (`routeForPage` takes it, page
create, delete and `page:dynamicPaths` use `pagesDirectoryOf`). Still assuming `src/pages`: page
rename and move (`pageRename*.ts`, refused with the reason when the folder moved), page templates
(`pageTemplatePlan.ts`), `.stacki/pages.json` keys, preview markers (`previewMarkers.ts`,
`markerConfig.ts`'s page glob, `componentPreviewContext.ts`), `defaultsCanvas.ts`, the components
folder rules, and Studio's paths (`shared/validation.ts` accepts only `src/` and `public/`), its
page list and route helpers. A project with another `srcDir` is shown and edited in its real pages
folder, with a `config-folder-custom` warning. Every scanner asks `foldersFor(kind, config)`: Desktop's project scan,
component creation and undo, the component preview route's globs (written at dev server start),
the assets panel listing and every asset write (`assetAbs`), the style panel, the variables panel,
the unused-selector check, and Studio's scan, asset catalog and writes, style list and variable
snapshot. Studio lists every `.astro` outside `src/pages` as a component until components or
layouts are configured. Under `src/` an asset write — replace, rename on either side, upload —
still refuses anything that is not media, whichever folders are listed. Settings → Folders edits
the file through `project:writeMetadata`; `project:pickFolder` opens the system folder dialog on the
project and answers `picked` (project-relative, links resolved) or `outside`. A saved change, or
an outside edit of the file, sends `fs:changed`, `assets:changed` and `css:changed`.

An asset listing's file entry (`WireAssetEntry`, from `assets:list`, Studio's `/studio/api/assets` and the demo's
store) carries `size` and, when the host can tell, `modifiedMs`: the file's `stat.mtimeMs` in whole milliseconds,
read by the same stat as the size. It is optional (a demo upload restored from browser storage has none) and, when
present, a non-negative safe integer; `parseAssetEntry` (`src/ipc/assetBridge.ts` and Studio's adapter) rejects
anything else. The Assets panel's Newest first and Oldest first sorts read it, never a birth time, which many file
systems do not keep; a file without one sorts after every file with one (`src/features/assets/assetOrder.ts`). The
panel's view (Grid, List, List - Small) and sort are a person's way of looking, not part of the site: they are kept
per project in the app's local storage (`stacki.assetsPanel.views`, the 50 most recently changed projects), never in
a `.stacki/` file. The List view's pixel sizes come from `assets:dimensions` (Studio: an image load), read only for
rows on screen, four at a time, and cached per path, size and `modifiedMs`.

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


## Update popup

Auto-update never opens a native dialog. `electron/app/autoUpdate.ts` turns electron-updater's events into
`UpdateEvent`s (`shared/ipc/updateState.ts`) and sends them on `update:state`; the renderer's popup
(`src/features/update/`) draws them. A state is `idle`, `downloading` (bytes transferred, total or unknown,
whole percent), `ready`, `notice` (the File menu's "latest", "development build" or "already checking"
answers, shown once and never stored) or `error` (a check or a download that failed, with the first line of the
cause). `reveal` marks news that must open a popup the person hid; progress ticks are not news.

- Progress is untrusted when it arrives from the updater (`NaN` for an unknown length is real). `advanceProgress`
  keeps bytes and percent monotonic and within 0 to 100, reads a total that is not a positive count as unknown
  and keeps the last known total; main sends an event only when the popup would look different.
- `update:read` returns the current state for a window that mounts mid-download; `update:act` carries `install`
  (restart into a downloaded update; ignored otherwise) or `retry` (check again). Hide, Later and Close are the
  renderer's alone: the download carries on. Preload exposes `readUpdateState`, `actOnUpdate` and `onUpdateState`;
  the renderer parses every reply and event (`parseUpdateState`, `parseUpdateEvent`) before use.
- A window that is not open when a notice is sent does not see it; the next mount reads `update:read`.
- Every state has the same shape: a tinted circle holding a Central icon (check for latest and ready, arrow down while
  downloading, red close for an error), a headline, secondary text and the buttons. "Latest" is headlined "You're up to
  date" with the version under it. The dialog has `role="dialog"` named by the headline, no outline and no rule above
  the buttons (fills only), and the button Enter presses has focus once the dialog is open; Escape hides it.
- The popup is a pure view of a state (`UpdatePopup`), so tests and harnesses can show any state; there is no
  production switch for previewing it. Dev builds skip update checks, as before.

## Instructions panel

`shared/properties/instructions.ts` is the contract for the Instructions view of the Settings panel, once a
rail panel of its own (the rail has no Instructions button; ⌥I opens Settings at it; the folded Skills, Rules and
Docs sections are remembered per project in `src/lib/settingsSections.ts`)
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

## Agents (Settings > Agents and the AI panel's agent choice)

`shared/properties/projectAgents.ts` is the contract; `electron/project/agentFiles.ts` does the work behind
`agents:list`, `agents:save` and `agents:delete` (`shared/ipc/projectAgentChannels.ts`, renderer calls in `src/ipc/agentsBridge.ts`).

- **Where each CLI reads agents.** Claude Code: `.claude/agents/<name>.md`, YAML frontmatter with `name` and
  `description` (required), `tools`, `model` (optional), the body is the prompt. Codex: `.codex/agents/<name>.toml`
  with `name`, `description`, `developer_instructions` (required), `model` and other config keys (optional), from
  OpenAI's Codex subagents page; not checked against an installed Codex. User-level folders (`~/.claude/agents`,
  `~/.codex/agents`) are not listed: the panel shows the project's.
- **Listing.** Each folder is read flat (no subfolders), at most `agentsMax` (200) definitions each and
  `pairedMax` paired agents, 256 KiB per file. A definition that does not read stays listed with its problems
  (`AgentProblem`: no or unclosed frontmatter, YAML or TOML syntax with a line, a top-level key written twice,
  a missing or wrong-typed field, past a bound). A byte-order mark and CRLF read; YAML aliases are refused.
- **Editing.** A definition opens in the Instructions editor over the canvas (`selectInstruction`), with its
  save, conflict and outside-change handling and line-by-line frontmatter; `parseInstructionFilePath` accepts a
  Codex definition, which opens as TOML source only (`src/ui/tomlSyntax.ts` colours it). The watcher hears
  `.codex/agents/*.toml` and `.stacki/agents/*.json`.
- **Paired agents.** "New agent" writes `.stacki/agents/<name>.json` (`version`, `name`, `description`,
  `instructions`, `tools`, `models.claude`, `models.codex`) and generates both definitions from it; each begins
  with a "Generated by Stacki from …" comment. A generated file's state is `in-sync`, `edited` or `missing`,
  decided by comparing it with what the fields generate now (CRLF ignored). `agents:save` with `mode: 'update'`
  overwrites an edited file only when its provider is in `overwrite`, which the renderer sends after the confirm
  dialog. Names are lowercase letters, digits and single hyphens, unique ignoring case across every agent of
  either CLI. Tools are Claude's only (Codex has no per-agent tool list); each CLI has its own model field.
- **Delete** moves files to the Trash (`shell.trashItem`), a pair with its source.
- **Command line.** `stacki agents list|show|create|sync|delete` (docs/stacki-cli.md, "Agents") runs the same rules:
  `agentSaveDecision` in `shared/properties/projectAgents.ts` decides a save for both `saveAgent` and the CLI, and
  `planAgentSave`, `applyAgentChanges` and `agentDeleteFiles` in `agentFiles.ts` read and write for both, so the two
  write byte-identical files. The CLI's writes are journalled effects (`agent-files`) instead of the Trash, a sync
  refuses an `edited` file (with its `pairedFileDrift`) unless `--force`, and a write needs `instructions:edit` as the
  panel does. `.stacki/agents/` is a CLI domain folder (`STACKI_DOMAIN_FOLDERS`): `config` never writes it.
- **AI panel choice** (`shared/properties/ai/agentChoices.ts`, `src/features/ai/agentChoiceStore.ts`). Surfaces:
  `chat` (new chats), `auditFix` ("Fix with AI", `AgentTask.surface`), `appBuild` ("Build an app"). Kept per
  project in browser storage (`stacki.ai.agentChoices`, at most 50 projects, parsed totally). A usable Claude
  choice rides on `ai:chatCreate` as the setting `{ option: 'agent', value: <name> }`, the session option
  claude-agent-acp 0.105.0 offers for the project's agents, applied like every chat setting once the session
  exists. Codex agents are listed but disabled with the reason: neither Codex nor its adapter documents a way to
  run a session as a custom agent. A choice whose agent is gone or broken resolves as `missing` (or
  `unsupported`), sends nothing, and the open chat shows a notice. A task with a chosen agent always opens a new
  chat, since an existing chat's session would not take it.

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
1 to 39 characters, the login rules, a trailing hyphen allowed). Desktop does not gate it (it only
previews roles); the Studio route refuses anyone without it with 403. The reply, parsed by
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

### Custom hosting

A host Stacki has no integration for is `customHosting` beside `hosting`, which stays
`{ "provider": "none" }`: `{ deploy: "github" | "script" | "link", script?, hostName?, siteUrl? }`.
The shape is deliberate. Stacki 1.4.21 throws on an unknown provider but ignores an unknown key, so
it reads such a project as GitHub only (and its own Save drops the block). A file naming both a
provider and `customHosting` is refused, as is any unknown key inside it. `github` only ever pushes;
`script` builds the publish snapshot and runs that package.json script; `link` pushes, then sends
one POST to the deploy link, with no local build. `script` is a name, never a command, and nothing
runs or is sent except from an explicit publish to the host.

A deploy link is a secret. It is never in a project file, receipt, log, message or child process
environment. `publish:custom` (`shared/properties/publishDeployLink.ts`) carries it once, from the
form to main; only its mask (`https://host/••••••••`) comes back. `deployLinkStore.ts` seals it with
`safeStorage` in `<userData>/deploy-links.json` together with the project path, the origin repository
and the destination, and refuses to keep it where real encryption is unavailable (including Linux
`basic_text`). A binding that does not match is never sent. `deployRequest.ts` requires https, sends
once with a 30-second deadline, never retries, follows only same-origin 307/308 redirects (at most
three), drops the response body, and never repeats a transport error. Studio and the demo keep no
links: the option is unavailable there and Studio refuses such a publish before committing.

### Staging

`.stacki/publish-destinations.json` (`shared/properties/publishDestinations.ts`) holds the
destinations besides production: a bounded list, today only `staging`. It is a separate file because
1.4.21 rewrites `publish.json` from the keys it knows, sometimes without a Save. Provider kinds borrow
production's account and project and say only how they differ. `publish:start` accepts the target
`staging`; it is never a `defaultTarget`. Staging runs its own flow (`publisherStaging.ts`), its own
hooks and its own receipt, with `STACKI_PUBLISH_ENV=staging` (production's scripts get `production`).

**Publishing to staging never changes production.** It never commits to or pushes the person's
branch. Only the `github-branch` and `link` kinds touch GitHub, pushing the captured files to the
staging branch, never forced, never with tags, and never to the checked-out branch, the repository's
default branch, a conventional production name or a Pages project's production branch. Every check
fails closed, before anything is built or pushed:

- Workers (`publishStagingWorker.ts`): wrangler uses `--name` verbatim even with `--env`, so staging
  passes its own resolved name, which must differ from production's. `env.*` inherits top-level
  `routes`, so a route naming a production hostname is refused, as are workflows, queue consumers and
  containers production declares. A separate Worker drops routes, triggers and queue consumers.
  `WRANGLER_CI_OVERRIDE_NAME` and the computer's `CLOUDFLARE_ENV` are withheld. A generated
  (redirected) config must target the chosen environment.
- Pages: the project's production branch is read from Cloudflare and must differ.
- Vercel: never `--prod`, and a ready production deployment must exist, because a project's first
  deployment is production regardless.
- Netlify: `--alias` draft deploys only, never `--prod` or `--prod-if-unlocked`.
- Custom: the script cannot be production's or be named like a production deploy (its content cannot
  be checked); a staging deploy link is stored apart from production's and may not equal it.

A project with the pull request review workflow cannot publish to staging. Studio does not publish to
staging; both Studio and Desktop treat the destinations file as publish settings (`publish` access).

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
Cloudflare, Vercel, Netlify or GitHub and an empty account requests available connections/linked projects.
A Netlify project also names its `account` (team slug), which its saved destination, a site ID, does not.
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
`linked` to inspect local Wrangler, Vercel and Netlify destinations before settings exist. A discovered Worker
may have an empty account ID when its local name is known but its account is unresolved; the saved
publish-config parser rejects that incomplete value. This prevents assigning an unrelated account.

`publish:netlifySite` accepts `{ projectPath, site: { team, name } }`, parsed by
`shared/properties/publishNetlify.ts` (Netlify's subdomain rule, bounded team slug), creates that
site with `netlify api createSiteInTeam`, and returns `ready` with its name and Netlify hosting or
`failed` with a described sentence, never CLI output. The settings choose it; Save writes it. Design
mode refuses the channel. Studio exposes it at `/studio/api/publish/netlify-site`; hosted
deployments refuse it, as they refuse account sign-in.

`publish:workerSetup` accepts `{ projectPath, worker: { accountId, project } }`, parsed by
`shared/properties/publishWorkerSetup.ts` (Cloudflare's Worker name rule, bounded account), and returns
`ready` with the Worker hosting or `failed` with a described sentence. Main writes `wrangler.jsonc`
only when the site has no Wrangler config (static assets from the build folder, or the Cloudflare
Astro adapter's server and assets), never rewrites an authored one, and adds Wrangler as a development
dependency with the site's package manager when it is missing. It reports `ready` only after
`checkWorkerReady`, the check Publish runs before it builds or pushes, so Add Worker and Publish cannot
disagree. The renderer then saves the Worker as hosting through the witnessed metadata transport.
Studio exposes the same contract at `/studio/api/publish/worker`. A publish refused by that check fails
with `publish.worker.setup.needed`, which the Publish dialog answers with a one-click setup.

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

`avb:hover-style` (`liveRules.ts`, `frameLiveRules.ts`, through the same `receiveLiveRules`
entry) is every hover preview of the Style panel, and it is never a write: no save, history
entry, dirty flag, autosave or snapshot follows it. Two kinds of hover use it: a variable hovered
or arrowed in the picker, and an option hovered or arrowed in a dropdown (`Select`'s hover-scrub,
a deliberate scrub-to-preview, so canvas-only too). `show` names the selected node's rendered path
and one to `declarationsMax` declarations (property, value, boolean `important`); the frame sets
them inline on the node's elements (at most `elementsMax`), recording each element's own inline
values. One preview is up at a time: `show` replaces the last; `clear` (idempotent) restores each
element's style attribute exactly, removing one the preview added; `settle` (a pick of the
previewed value is being saved) keeps the preview until the page computes the same values
without it, at most `settleFramesMax` frames, then restores as `clear` does. The panel sends it
through `PreviewPropContext` (`useEditorWrites`' `previewProp`, with liveSetProp's shape, and the
`hoverStyle` controller in `model/liveRuleEdits.ts`): `VariableConnect` owns a picker preview (the
wrapped field never sees it) and shows it on the canvas when the field holds a property's whole
value (`canvasProperty`); a field that is one part of a value previews in the field alone. A write
of the previewed value settles it, any other write or a way out clears it, and so does unmounting.
A state or pseudo-element context is previewed in the control only.

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

### Page settings

The gear on a page row opens the Page settings dialog (`src/features/pages/PageSettingsDialog.tsx`, shared by Desktop
and Studio; Desktop's host is `src/app/shell/PageSettingsDesktop.tsx`). Its contract is
`shared/properties/pageSettings.ts`: `isHomePage` (only a root `index.astro`, `index.md` or `index.mdx`), `homeSwapPlan`
(which page may become the homepage, and the two moves), `checkUrlName` (the rename field's live check: the page
rename rules plus `index` reserved beside the homepage) and the wire parsers of the channels below.

- `page:planSettings` plans a step without writing and answers its summary: files changed, links rewritten (or, for a
  deletion, links that would break), the moves, and lines listed for review (file and 1-based line, bounded).
- `page:applySettings` plans again from disk and writes the step all or nothing (`electron/project/pageRelocationWrite.ts`),
  answering one undo token; `page:revertSettings` undoes and redoes it. A step is texts edited in place plus files that
  move, appear or go. Every byte is witnessed first; texts are written through the document actors, then each arriving
  file's final bytes are staged in `.stacki/io`, every leaving file is moved there, and every staged file is moved to
  its destination, so the dev server never sees a page whose imports do not match its folder, a swap never collides and
  a case-only rename works on a case-insensitive disk. A failure puts back every byte; undo is the inverse step.
- Making a page the homepage swaps two files, each keeping its extension (`about.md` becomes `index.md`, `index.astro`
  becomes `about.astro`; a page in a folder sends the homepage into that folder). Links to `/` and to the page's route
  swap in one pass (`electron/project/pageSwapLinks.ts`), so none is swapped back: attributes, Markdown destinations,
  sitemap locations, configured-site absolute URLs and string literals, with `base` and `trailingSlash: 'always'`
  respected. A bare `'/'` string is the homepage only after a link key (`href:`, `url:`, `"to":` …): elsewhere it is a
  path separator, and lines comparing it with `Astro.url` are listed for review. astro.config files are never rewritten
  (a redirect's source is a route of another kind): their redirect lines are listed, as are feed and sitemap files.
  Relative imports in both files follow the move (the page rename's import rewriter). `.stacki/pages.json` keeps its
  rows: the new homepage takes the old homepage's place. Refused, nothing written: a dynamic page (a `[param]` file or
  one that declares `getStaticPaths`), a root 404 or 500 page, a page in an i18n locale folder, a project with two
  homepage files or none, a route another file also answers, and any changed text that would not parse.
- Duplicate copies beside the page as `<name>-copy` (then `-copy-2` …), so relative imports still resolve; deleting
  lists every link that would break by file and line and refuses the homepage.
- `page:planRemoveMany` and `page:removeMany` are the Pages panel's Select mode (`shared/properties/pageBulkRemove.ts`,
  `electron/handlers/pageBulkRemovePlan.ts`): several pages and folders deleted as ONE step. The request names pages and
  folders relative to `src/pages`, at most 500 pages (a folder's own pages count) and 100 folders (its subfolders count),
  no duplicates, never empty. The plan is the single deletion's (the homepage is refused, every page must be UTF-8 text,
  broken links are listed) read once for all pages; a folder that holds anything but pages (Finder's `.DS_Store`
  aside) is refused whole, because Undo restores only what the plan read. `page:removeMany` plans again from disk and
  writes through the same writer (all pages or none), answering one undo token that `page:revertSettings` takes back
  byte for byte, folders included, as one Cmd+Z step. Role gate: `page:delete`.
- `page:readTemplate` reads a CMS template page back into the Create page template dialog's settings
  (`electron/content/pageTemplateRead.ts`): only by writing its pieces again and finding them byte for byte, so a
  template changed by hand reads as `custom` and is shown as code, never rewritten. `page:retargetTemplate` replaces
  exactly the paths function and the entry type, as an undoable step.
- The Layout props section draws the layout instance's props with the Properties panel's own editors
  (`InstancePropFields`) and the same handlers, so an edit there is the panel's edit, one undo step.

### Data file variables

A data file's row in the CMS panel (`src/consts.ts`, the open page) carries a gear that opens its
settings (`src/features/cms/CmsFileFields.tsx`), on hosts that pass `renderFileSettings` (Desktop;
Studio shows no gear yet). `cms:constants` takes `{ projectPath, rel }` (the file under `src/`) and
answers `ConstantListingReply`: the file's variables (a module's exported `const`s, a page's
top-level `const`s), every name its top level binds, and the style it writes them in.
`cms:editConstants` takes an `edit` (`add` a field, `remove` a name, `reorder` them all, each moving
with the comments directly above it and after it on its line, or `restore` a text over the exact text
it replaced, for undo and redo) and answers `ConstantEditReply`: the text before and after,
or a refusal (`syntax`, `fence`, `invalidName`, `reservedName`, `duplicateName`, `missing`, `inUse`,
`compound`, `changed`, `invalidValue`, `dependency`: an order that reads a constant before it is declared) with the file untouched. Shapes and parsers live in
`shared/properties/cmsConstants.ts`, with the one serializer both the preview and the write use;
reading and editing parse the file with the TypeScript parser (`electron/parse/constantFields.ts`),
refuse any file with a syntax error, and write through the document actor witnessed by the bytes read.

### CMS connections

A project's hosted CMS connections (`shared/properties/cmsConnections.ts`) name which CMS its
content comes from and hold the key Stacki writes drafts with. Kinds: Sanity (project, dataset),
Payload (https address, auth collection) and custom (a draft endpoint and the header its key goes
in). Addresses are https, or http on localhost only, with no login or fragment. A key is one line
of printable ASCII, at most 4,096 characters; it crosses the boundary once, in
`cmsConnections:save`, and no reply ever carries it. At most 16 connections per project.

A Payload connection signs in with an API key (`Authorization: <auth collection> API-Key <key>`) or
with an email and password (`auth: 'password'`: the secret is then the password, any characters on one
line). It may name collection slugs (`collections`, at most 50) for servers that hide their access
list. A connection saved before logins existed has neither field and reads as an API-key connection.
Saving checks the account against the server first (`/api/<collection>/me`, which is HTTP 200 with
`{"user":null}` for a credential Payload does not accept). A login's token lives in main-process
memory only, never on disk, never in a reply or a log; a failed login is remembered for a minute (ten
for a locked account) so a wrong password is sent once, not in a loop. `cmsConnections:check` is
"Test connection" for a saved connection and "Detect" for the form's draft (`{ action: 'test', id }`
or `{ action: 'detect', draft }`); it returns the account, its collections (with whether each keeps
drafts and whether it takes uploads), the locales and whether GraphQL answered, never the secret.
Failures carry a `messageRef` the interface translates beside the English `message`.

Payload content in the CMS panel (`electron/content/payloadService.ts`): a document is named
`<collection>.<id>`; lists are read 100 at a time and stop at 500; every write is
`PATCH ?draft=true` (without it Payload publishes); a collection without drafts is edited live and
its documents say `appliesLive`; a localized top-level field is one entry per locale; rich text is
editable only while it is plain paragraphs. docs/cms-testing.md lists what was proved against a real
server.

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
A suggestion comes from the site's `.env` (`*SANITY_PROJECT_ID`, `*SANITY_DATASET`); when that
names none of the person's projects, from a `projectId: '…'` string literal in the site's `astro.config.*`,
`sanity.config.*` or `sanity.cli.*`, at the root or in `studio/`, read without running them.
Only a project the person belongs to is suggested. Sessions
time out after five minutes. A role that cannot create keys is told to paste an Editor key instead.

While Stacki previews a project with a Sanity connection, its dev server gets
`STACKI_SANITY_PREVIEW=1`, `STACKI_SANITY_PROJECT_ID`, `STACKI_SANITY_DATASET` and
`STACKI_SANITY_TOKEN` (the connection's key). Nothing else receives them, and a site opts in by
reading them; production builds never see them.

### EmDash

EmDash (the `emdash` package, an Astro-native CMS whose content Astro reads at request time through the `_emdash`
live collection) is detected from the project, not connected: there is no key and no connection record.
`shared/properties/emdash.ts` is the contract; `electron/content/emdashProject.ts` reads the project.

- Detection follows EmDash's documented setup: `emdash` in `package.json`, `emdash()` imported from `emdash/astro` in
  the Astro config, and `emdashLoader()` / `_emdash` in `src/live.config.*`. What is missing, a static `output`, a local
  database or uploads folder that `.gitignore` does not list, and an unreadable schema are reported as `EmDashProblem`
  values the settings card words in each language.
- Content types and fields are defined only in EmDash (its `_emdash_collections` and `_emdash_fields` tables) and Stacki
  reads them from there, most exact first: the local SQLite database (opened with `readOnly: true` through Node's
  `node:sqlite`; every statement is a fixed `SELECT`), then `.emdash/schema.json` (written by `emdash types`), then a seed
  file (`.emdash/seed.json`, `seed/seed.json`, or `emdash.seed` in `package.json`). Each passes `parseEmDashSchema`; a
  slug EmDash refuses is dropped, a field type Stacki does not know is `unsupported` and never bound.
- A field's `binding` says how it fills an element: text, rich text (`PortableText` from `emdash/ui`), image (`Image`),
  link, number, boolean, date, list, reference, or data (JSON, repeaters and blocks, written by hand).
- `emdash:project` returns the detection result (read only, never a secret). Studio shows no EmDash card yet.
- Dynamic routes: an EmDash route (`posts/[slug].astro`) declares no `getStaticPaths`, so `page:dynamicPaths` falls back
  to the published entries in the local database (`emdashPaths.ts`) and the canvas previews each through the project's own
  dev server, which renders from the same database. Page templates (`kind: 'emdash'`) write that route:
  `getEmDashEntry(collection, decodeSlug(Astro.params.slug))` with the type's own heading, first image and first rich text,
  never `getStaticPaths` or `prerender`, so a change in EmDash shows on the next request.
- A local database and uploads folder are the designer's copy. A customer's real content reaches them through EmDash's own
  CLI (`emdash login`, `emdash site export`, `emdash site import`), which Stacki only shows the commands for; Stacki holds
  no EmDash credential. Pointing a deploy at the customer's own database and storage stays in the project's config.
- Adding EmDash to an open Astro project (`shared/properties/emdashInstall.ts`, `electron/handlers/emdashInstall.ts`,
  `electron/parse/emdashConfig.ts`) follows EmDash's own "Add EmDash to an existing Astro project" guide. `emdash:installPlan`
  (read only) names the command and every file that can change; `emdash:install` must carry that exact command, or main
  refuses (`notConfirmed`) and runs nothing; `emdash:installCancel` aborts the run; output streams on `emdash:installLog`.
  Order of a run: save unsaved work as one commit named `Before Adding EmDash` (through the Publish commit path; a failed
  save installs nothing), the package manager's add command (fixed package names, args array, no shell, project folder,
  `EMDASH_INSTALL_LIMITS.runMsMax`, cancellable), `src/live.config.ts` only when absent, the missing `.gitignore` lines,
  the Astro config merged with the TypeScript parser by small insertions (verified before and after writing, original bytes
  restored if the check fails; a different existing adapter or an unreadable shape leaves it untouched and is reported),
  then EmDash's key command only when there is no `.env`, its output never logged. Nothing is reverted on failure; the
  result lists the files that changed. `complete` is true only when `detectEmDash` finds the project wired afterwards.
- After the config and key, EmDash's own `npx emdash init` creates and migrates the local database (an unfinished init is not a
  failed install). Then the running preview is restarted through `DevServers.restartForNewIntegration` (Astro never loads an
  integration added to a running server) and the run asks `<origin>/_emdash/admin/` on a bounded schedule
  (`EMDASH_INSTALL_LIMITS.devServerWaitMsMax`) until it answers; the result says `preview` is `running`, `notRunning` or
  `failed` and carries `adminUrl` only when it answered. `emdash:adminUrl` returns the running preview's origin for the open
  project (loopback only, parsed again in the renderer), and the admin opens in the person's own browser through
  `shell:openExternal`, never from a string the project or a page supplied.
- Framing: EmDash answers every page with `X-Frame-Options: SAMEORIGIN`, which blanks the canvas (an iframe of another
  origin; the log shows ERR_BLOCKED_BY_RESPONSE). `electron/app/previewFraming.ts` drops that header and any CSP
  `frame-ancestors` from frame responses from loopback hosts only; nothing else in a response changes.
- Pages panel: routes injected by an integration that are not pages never reach `project:injectedRoutes`: anything under
  `/_emdash`, any route whose entrypoint lives in the `emdash` package, and any endpoint (Astro's route `type`, or a code
  entrypoint when the type is absent). Another integration's HTML routes stay, in a collapsed, quiet group.
- Not built: Stacki does not edit EmDash content or types, the loop builder has no EmDash source (a list is written as
  code), a Cloudflare D1 project is read only from `.wrangler/state` (unverified against a real D1 project), and
  Studio cannot read an EmDash project.

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

**Subagents.** Claude stamps `_meta.claudeCode.parentToolUseId` (the Agent or Task call's id) on
everything a subagent reports, its message and thought chunks as well as its tool calls. `acpWire.ts`
reads it as `parent` on `message` updates and tool calls (a non-string is dropped, an over-long one cut
to `idCharsMax`), `rawInput.subagent_type` as `subagentType`, and `rawInput.model` (the model an Agent
call asks for: `sonnet`, `opus`, `haiku`, `fable`) as `model`. The chat model carries them as the
optional `parent` of a `text` event and `agentType` and `agentModel` of a `tool` event (absent in older
chats, which still read; an absent `agentModel` means the subagent runs on the session's model);
`coalesceEvents` and the reducer never join two speakers' text. The reducer also records where the
update that finished a call began in its output (`resultFrom`), so a subagent's report reads apart from
the prompt its call showed while it ran. The panel derives the subagents from these alone
(`src/features/ai/subagents.ts`, bounds `SUBAGENTS_SHOWN_MAX`, `SUBAGENT_ITEMS_MAX` and
`RESULT_SUMMARY_CHARS_MAX` beside it): each Agent or Task call, and each SendMessage follow-up, is one
unit in the transcript holding every call that names it as parent (directly or through nested calls, at
most 8 deep); a call naming a parent the transcript does not hold belongs to no unit and stays in the
coordinator's groups. Above the transcript, a strip lists the run's units; one subagent's transcript is
the chat's `Transcript` given that subagent's re-rooted items. A subagent's words are drawn only
there. An opened unit shows its calls as steps a designer reads ("Read 5 files", "Ran the tests"):
`transcript/toolWords.ts` (`classifyStep`, a table of tool names, call kinds and recognised commands,
bounds `STEP_WORDS_LIMITS`) sorts each call, `transcript/agentSteps.ts` (bounds `STEP_LIMITS`) merges
consecutive calls of one kind, and `transcript/StepGroups.tsx` draws them, each command behind a
"Show commands" control that is closed by default and not opened by "Expand all". Above the composer, a
chip ("2 agents working, 1 background command") opens the Running panel (`transcript/RunningPanel.tsx`,
model `runningWork.ts`, bounds `RUNNING_LIMITS`): what runs and, folded, what the current run finished,
each subagent opening to the same steps. A subagent's title loses ids (`cleanTitle`). Codex reports a
subagent as one call titled "Start subagent …" and forwards none of its work, so a Codex subagent has a
row but an empty transcript. No row has a Stop of its own: claude-agent-acp stops one subagent only for a
client that declares `clientCapabilities.subagents` (each subagent then streams as its own child
session, cancelled with `session/cancel`) and one background command only for JetBrains AIR clients
(`_session/async_task/stop`); Stacki declares neither, so the panel's one Stop is "Stop agent", the turn's.

**Channels.** `ai:agents`, `ai:installAgent`, `ai:trust`, `ai:chats`, `ai:chatCreate`,
`ai:chatUpdate` (rename, pin), `ai:chatDelete`, `ai:chatRead`, `ai:prompt`, `ai:cancel`,
`ai:permission`, `ai:setOption` (an agent's session setting: model, mode, effort), `ai:remember` (the composer settings last used: one choice, or a reset for one agent; answers the whole set), `ai:review` (keep,
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
(`lib/shellEnvironment.ts`, the app's environment with the common tool folders added, which the
terminal's login shell also starts from). The agents alone also get the sign-in settings set only in
shell startup files (`lib/loginShellSettings.ts`, "Sign-in settings from the shell" below).
`agentInstaller.ts` installs on request into
`userData/agents/<agent>-<version>/`: staged, `npm ci --omit=optional --ignore-scripts` against the
shipped lockfile (its SHA-256 pinned), the entry's SHA-256 checked, then renamed into place; the
digest is checked again at every start. `agentHost.ts` runs one adapter per agent per project as
Electron-as-Node, with the person's shell environment minus Stacki's and any host agent session's
variables; it starts on the first prompt (or earlier, see "Starting early" below), stops after `idleMsMax`
(30 minutes; `idleMsCrowded`, 5 minutes, while more than `processesComfortableMax` adapters are alive or free
memory is under `memoryFreeRatioMin`; at `processesMax` the idle process used longest ago is evicted first),
restarts after a crash with doubling delays at most `restartsMax` times, and stops on project close and quit. A chat is one ACP
session: resumed (`session/resume`), else loaded (`session/load`, replay ignored), else started
anew with a notice. Nothing starts before the person trusts the project (`ai:trust`, remembered in
the chat index); a new session starts with the composer settings last used for its agent
("Remembered settings" below), else the agent's own defaults (the person's own Claude `defaultMode`
included); nothing forces the asking mode any more. `acpConnection.ts` frames lines (at most `lineBytesMax`, past which the connection
closes) and bounds pending requests (`pendingRequestsMax`, each with a timeout).
`permissionBroker.ts` holds requests until answered (bounded; a stopped turn answers `cancelled`).

**Starting early** (`ai:prewarm`, `{ projectPath, agent, action: 'warm' | 'release' }`, reply `{ ok: true }`;
`sessionPool.ts`, `shared/properties/ai/prewarmGate.ts`). The panel sends `warm` when it opens for an agent that
is installed, signed in and allowed here, and when the composer takes focus; `release` when the panel closes or
the agent changes. The renderer sends at most one `warm` per agent per `prewarmRepeatMs`; main debounces
(`prewarmDebounceMs`, last request wins) and is single-flight. A start spawns the agent's process if needed and asks it
for one empty session with the parameters a new chat uses (`cwd`, `mcpServers: []`): no chat record, no
transcript event, no ledger snapshot, no model call. One session is parked app-wide (`WarmSlot`); a start for another
agent or project replaces it (the old one is deleted), `release`, a sign-in change and the process leaving (idle
expiry, crash, quit) discard it. The first prompt of a new chat adopts the parked session through `bindSession`, the
same binding `session/new` gets, and then applies remembered and chat settings, so a setting changed meanwhile is
applied before the prompt. A start is skipped (debug log, no error) when the app is in the background, the agent is
not ready, the project is untrusted, the agent crashed, or the process limit would be exceeded; a start never evicts
a process. The startup probe that learns an agent's settings parks its session in the same slot when free.
The debug log carries `process: spawnMs initializeMs` and `startup: session=prewarmed|cold|resumed spawnMs
initializeMs sessionNewMs firstTokenMs`: durations only.
`eventPump.ts` batches events every `eventBatchMs`, joins streamed text, appends each chat's batch in
one write and sends one push; above `flowHighWatermark` unacknowledged characters it stops reading
every adapter until acks bring it under `flowLowWatermark` (the terminal's scheme).

**Host protocol features** (`agentHost.ts`, `promptBlocks.ts`). Steering: `ai:steer` (or `ai:prompt`
with `mode: 'steer'`) sends `_session/steering` with `idleBehavior: 'promptRequired'` to the running
turn and records a `user` event with `mode: 'steer'`; with no turn running the message is an ordinary
prompt (`startedNewTurn`); an agent that did not advertise `_meta.steering.supported` answers
`unsupported`, an adapter that refuses answers its failure (`agent-failed`), and in both cases nothing
was sent, so the renderer queues the message. A plain `ai:prompt` while a turn runs stays `busy`.
Keep or apply: an agent's edit is on disk the moment it is made; "Keep" only settles the ledger entry
(`pending` to `kept`, dropping the saved text), and "Undo" writes the saved text back. The app preference
`aiReviewChanges` (the AI panel's "..." menu and Settings > Editor > AI, "Ask me to keep AI changes";
`settings:get` and `settings:set`, default off, kept per person in `settings.json`, never in the project)
only changes what the changes card offers, applied at once in every open card: off, a pending file reads
"Applied" with Undo (the entry stays pending so Undo keeps working); on, it waits for Keep or Undo as before.
The ledger, the `ai:review` channel and the stored reviews file are the same either way.
Change snapshots (a hidden git tree, never a commit in the project history): the app preference `aiTrackChanges` (Settings > Editor > AI, "Snapshot before & after each AI change"; `settings:get`
and `settings:set`, default on, kept in `settings.json`) decides whether the change ledger snapshots the
project (`git add --all` against a temporary index, `git write-tree`) before and after a turn. The agent host
asks `trackChanges()` once when a turn begins and the ledger keeps the answer on that turn, so a toggle applies
from the next turn and never splits one. Off, the turn takes no snapshot, reads no file for the ledger and
keeps no entries; when the agent still announced an edit, delete or move, the turn records a
`changes-untracked` event (`reason: 'off'`) and the transcript shows one line, "Snapshots are off", with
a "Turn on" button. A snapshot that throws, or outlasts `AI_LIMITS.snapshotMsMax`, never blocks the turn: it
runs without it and (when edits were announced and nothing was kept) records `reason: 'unavailable'`. Chats
recorded while on keep their stored changes. Per turn, the main-process log gets one debug line with the mode
and `snapshotBeforeMs` / `snapshotAfterMs` (durations only, no prompt text, no paths). The start-of-turn
snapshot is not run beside the model call: the agent's own tools edit files without asking Stacki (auto-accept
modes), so only finishing the snapshot first guarantees it sees the tree as the turn found it. Stacki Studio
has no ledger and no such setting.
Auto-compact: `ai:autoCompactGet` and `ai:autoCompactSet` read and save the person's "Auto-compact at" percentage (an integer 30 to 95,
or none for the agent's default; `shared/properties/ai/autoCompact.ts`), stored in the main process's settings file as `aiAutoCompactPercent`.
It reaches Claude Code as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in the environment of each adapter process spawned afterwards (so it applies to
adapters started after the change); Codex takes a token limit, not a percentage, and gets nothing, so the setting is hidden for it.

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
`agent-full-access`) is confirmed by the renderer once per choice; the host does not enforce it. A
fork whose original was unrestricted still starts asking again. Record: the last `usage` of a turn is written to the
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

**Remembered settings** (`shared/properties/ai/rememberedSettings.ts`, `userData/ai/remembered-settings.json`,
`{ version: 1, agents: { claude: [{option, value}], codex: [...] } }`, replaced whole). Whatever the composer's
menus set (mode, model, effort, Fast mode, Ultracode, Codex's plan switch: every option id the agent offers, none
hard-coded) is remembered per agent, last writer wins. Written by the person's own picks only: `ai:remember`
(a pick before the chat has a session) and a successful `ai:setOption` (a pick in a live chat, in any chat); a
mode the agent changes by itself is never remembered, so Bypass permissions comes back only because it was chosen
(through its confirmation) and starts a new chat red from the first frame. Read back by `parseRememberedFile`:
total, so a corrupt file is the defaults and a damaged entry loses only itself; each agent holds at most
`configOptionsMax` entries of at most `idCharsMax` characters. `ai:agents` carries the set (`remembered`) beside
the options, so the composer's first frame already shows it. At `session/new` the host sets each remembered option
the session offers, in the agent's option order, only when it differs and the value is still offered (else dropped
silently); an adapter refusing one does not stop the chat (one quiet `info` notice). A resumed, loaded or forked
session keeps its own values. The cache of each agent's options keeps the agent's own defaults as current values
(`OptionsSource`), so "Reset to defaults" (last row of the model menu, `ai:remember` `{ kind: 'reset' }`) shows
true defaults. Studio's chat has a model chip only, with no mode or effort menus, so it has nothing to remember.

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

**Component mentions.** `@` also lists the project's components (the scan's `components`, handed to
`src/features/ai/mentions/componentMentions.ts` by `DesktopAi`; at most four rows, by name then path), and `@`
right after a component chip, or after one of its member chips, lists that component's props, each followed by its
values (a choice's options, a switch's `true`/`false`: its variants), then its slots. A `component` chip carries the
project-relative file (the scan's `file`, relative to the project root the agent runs in, whatever the components
folder or the project's depth in its repository; a package component's path is made relative the same way); a
`member` chip carries that file, `role` (`prop` or `slot`), `name` and, for a prop, an optional `value`. The agent
reads each as its compact reference inside the text (`plainTextOf` writes the same), and nothing else
(no type, description, schema or file contents): `src/components/Hero.astro`, then `prop:variant=large`,
`prop:title` or `slot:header`; a token that is empty or holds whitespace, `"`, `=` or a control character is a JSON
string; a member not right after its component (only whitespace or that component's members between) carries the
path first. Deleting a component chip deletes the member chips no other chip of that component keeps, in the same
undoable change. A chip whose component, prop, value or slot is no longer in the scan is drawn red with the reason
as its hover text, and a send, steer or queued send with one is refused (`ai.store.mentionInvalid`) with the draft
kept; a queued message is put back and the queue paused. Component and member chips are the components green
(`--component-green`), not purple. Clicking a valid component chip opens `ComponentMembersPopover` (320 px, start-aligned,
scrolling, a search field past 12 props): the Properties panel's own `PropField` for each prop, as for an instance
(the default dim), grouped as Props, Variants (props that control a union) and Slots (a switch per slot). The AI
feature may not import the props feature, so `src/app/shell/aiMemberField.tsx` registers the field as an adapter
(value in, value out). An untouched row adds nothing; a changed value adds or updates `prop:name=value` right after
the component chip, a cleared one (or the default) removes it, and a row's include dot toggles `prop:name`. Each change
is one isolated history event and leaves the caret where it was; Tab moves between controls and Escape returns focus
to the composer.

**Add to chat** (`shared/properties/ai/mentions.ts`, `src/features/ai/addToChat.ts`,
`src/app/shell/aiAddToChat.ts`). A selection (the Code panel's selected text; or the selected element, from the
composer's "+" menu "Add selected …", the canvas or Navigator menu, the Code panel or ⌘L / Ctrl+L) becomes two chips
at the composer's caret: a `code` chip (path, lines, element name and the code as it read when added, unsaved text
included) and a `page` chip (the file it is in: `page`, `layout`, `component` or `file`, plus `viewedOn`, the page on
the canvas when that is another file). No route adds component or member chips; those come from `@`. Every element
route is one function, which saves pending edits first and cuts the element, opening to closing tag with all its
children, from the saved file; on the component canvas's generated page it is refused with a toast. Bounds
(`AI_LIMITS`): `codeChipCharsMax` per selection, `codeChipsMax` and `codeChipsCharsMax` per message; a selection past
one, or past `promptCharsMax`, is refused with a toast and never cut.

**What a message keeps.** A prompt's parts are `text`, `file`, `skill`, `builtin`, `reference` (a component,
element, member, CSS, asset or page chip with the words the agent reads) and `code`. The host sends a reference's
words inside the text, and a code part as its own text block, fenced with more backticks than the code holds, never
read from disk and never the message's last text block (`@` in selected code is not a mention). The stored `user`
event keeps every chip (`SentPart` kind `chip`), so the transcript, a reopened chat, Edit, Resend and Retry have
them; chats stored earlier hold reference chips as words and read as before. `sentMessage.ts` turns a stored message
back into its draft and into the plain text Copy gives (the button and a selection, `chipCopy.ts`): each chip written
out where it stood, code under a line with its path and lines. Every chip shows its value in a card on hover or
keyboard focus (`useChipCard.tsx`).

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

A status check answers `ready`, `signed-out` (the CLI said so) or `unchecked` (it timed out after
`statusMsMax`, crashed, or printed something unreadable). Claude's answer is read from normal output
only; Codex answers on the error stream, so both are read. `unchecked` blocks nothing: a quiet note
under the composer checks again when pressed, as does focusing the window or opening the chat, and main
retries on its own after each of `STATUS_RETRY_DELAYS_MS` and then stops. An agent that refuses a
prompt still shows the sign-in card. A `ready` account carries `source` (`account`, `api-key`, `token`
or `cloud`), the kind only; anything but `account` is named under the composer, because it may be
billed differently. `api-key` and `cloud` are Codex's alone.

**Claude on a subscription only** (`lib/claudeSubscriptionOnly.ts`, `agentSetup.ts`). Three layers, each failing closed.

1. *Routes switched off.* Every Claude process the panel starts (status, token check, sign-in, sign-out, install, MCP
   commands, the adapter, so chats, pin subagents, resumed and forked chats and model listing) has
   `CLAUDE_BLOCKED_VARIABLES` removed (API key, bearer token, API address, extra headers, Unix socket, named and
   federation profiles, the Bedrock, Mantle, AWS, Vertex, Google Cloud, Foundry and gateway switches),
   `ANTHROPIC_CONFIG_DIR` pointed at the null device, and the flag settings `CLAUDE_SUBSCRIPTION_SETTINGS`: an empty
   `apiKeyHelper`, the same variables empty and the same folder (`--settings`; through the adapter,
   `_meta.claudeCode.options.settings` on every session request). Why both: a settings file's `env` block replaces the
   inherited environment, and command-line settings rank above user, project and local files. With Claude Code 2.1.332,
   made-up credentials and a local fake API, each route planted at each of those levels was neutralised. Commands the
   agent runs inside a session see the same empty variables.
2. *Proof of a subscription* (`readClaudeStatus`). Signed in needs `apiProvider` `firstParty` and either `authMethod`
   `claude.ai` with `subscriptionType` `pro`, `max`, `team` or `enterprise`, or `authMethod` `oauth_token` that the
   token check names `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`). `auth status` says `oauth_token` for every
   token, so the check (`CLAUDE_TOKEN_CHECK_ARGS`) writes only the `initialize` control request, which sends nothing to
   the model, and reads `account.tokenSource` (within `tokenCheckMsMax`; the CLI calls Anthropic first for a token, so
   offline this is slow and then unchecked). Anything else, including a claude.ai sign-in without a plan and a method
   not known here, is `signed-out` with `reason: "not-subscription"`: the card says a subscription sign-in is needed.
   `permit` asks again for every message and new session (messages asking together share one check). While the status
   cannot be checked the composer still takes typing, but the send is refused (`ai.error.signInUnchecked`).
3. *What the running session says* (`shared/properties/ai/claudeBilling.ts`). Every session asks the adapter
   (`_meta.claudeCode.emitRawSDKMessages`) for `system`/`init` and `rate_limit_event`, passed on as
   `_claude/sdkMessage`. An `apiKeySource` other than `none` cancels the turn and holds Claude `signed-out` with
   `reason: "billed"` until a sign-in or sign-out in Stacki (or a restart). `/login managed key` is also reported
   beside a subscription that pays, so it asks the status again and stops only when that finds no proven subscription.
   `rate_limit_info.isUsingOverage` puts `billing: "extra-usage"` on the `ready` state until a later event says
   otherwise or `resetsAt` passes. Both billing states show `BillingWarning` or its card ("Billed per use, not your
   subscription"), in the panel and, because pins start work without it, under the comment pins' bar.

What this cannot see: managed (organisation) settings outrank the command line. A key, token or cloud provider they set
fails the proof; a custom API address they set is reported nowhere. Extra usage is only known once a reply reports it,
and an API key a session picks up is only known as its turn starts, so that one request may already be charged. Whether
a `CLAUDE_CODE_OAUTH_TOKEN` was made by a subscription is taken from its documented meaning. `CLAUDE_CONFIG_DIR` is not
a billing route; the sign-in in that folder is checked like any other. Codex and the built-in terminal are unchanged.

**Sign-in settings from the shell** (`lib/loginShellSettings.ts`; macOS and Linux). An app opened from
the Dock never runs shell startup files, so the person's shell is run once per app run, as a login and
interactive shell (`-ilc`, as the terminal behaves), the first time an agent is checked or started:
never at boot, asynchronously, within `LOGIN_SHELL_LIMITS`, and its `env -0` is read between two
random marks. Only the names in `SIGN_IN_SETTINGS` are kept (for Claude, nothing that changes how it is billed), each
agent gets only its own, and the app's own environment wins. They reach
the agent's status, sign-in and sign-out commands and its adapter, never installers, the dev server,
git or the window; values are never logged or stored. A read that fails leaves the app's environment.
Windows reads nothing: user and system variables already reach the app, and variables set only in a
PowerShell profile are not read. A custom Codex provider's own `env_key` variable cannot be listed.

**MCP server sign-in** (`ai:mcpAuth`, push `ai:mcpAuthState`; `shared/properties/mcp.ts`,
`mcpSignIn.ts`). The MCP tab and a note above the AI composer sign servers in through the agent's own
CLI, in the project folder, with the environment the agent's sessions start in, so the token lands
where they read it and lasts across chats and restarts; Stacki handles no token. Claude: status from
the `Status:` line of `claude mcp get <name>`; sign in with `claude mcp login <name> --no-browser` in
a pseudo-terminal (it gives up without one; nothing is typed); `claude mcp logout <name>`. Those
refuse a `.mcp.json` server not yet approved in Claude's own screen, so each gets
`--settings {"enabledMcpjsonServers":["<name>"]}` (with the subscription settings in the same argument): one server, one command, written nowhere; a
rejected server stays rejected. Codex: `codex mcp list --json` (`auth_status`),
`codex mcp login <name> [--no-browser]`, `codex mcp logout <name>`. A CLI whose help lists no
`mcp login` is too old and says so. With `--no-browser` main opens the printed page itself, only an
https address without a user name; the page never reaches the window or a log, and the CLI receives
the localhost callback. States: `none` (local commands, servers with their own Authorization header,
and whatever the CLI says needs none), `needs-sign-in`, `connected`, `signing-in` (at most
`signInMsMax`), `unknown`, `not-checked` (the project may not run agents yet, so no Claude server is
contacted until the person presses Check), `unsupported-cli`, `blocked`. After a sign-in or sign-out
idle adapters are restarted. Only names the project's `.mcp.json` or Codex lists are shown. Roles:
the rows need the AI panel's access (`panel:ai` and `code:edit`). Design mode refuses the channel.
Studio has neither the MCP tab nor the panel; a host without the bridge draws nothing.

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
`ThinkingBlock`, `PlanCard`, `BackgroundTasks`, `RunningPanel` and `StepGroups` (with `running.css` and `steps.css`), `CompactionRow`, `DiffView`, `ChangesCard`, `PermissionCard`,
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

**Screenshots** (Desktop only). The composer's Screenshot button (`screenshot/ScreenshotButton.tsx`, crop icon,
shortcut ⌘⇧S / Ctrl+Shift+S told by the app's tooltip) starts the one capture there is, a dragged region
(`RegionSelector.tsx`: a crosshair layer over the whole window, Escape or a right click cancels, a drag under
4 px is a click); there is no menu and no element or whole-canvas mode, and the shortcut starts the same drag.
Whether a region is over the canvas comes from `src/lib/screenshotSource.ts`, installed by the shell
(`src/app/shell/aiScreenshotSource.ts`: the `.frame-clip` box and the `.frame-sized` width as the breakpoint).
For the capture's frame the source's `prepare` pins the canvas's last hovered node (`src/ui/canvasHoverPin.ts`: the pointer has left the canvas for the button, so the hover outline would be gone; a memory under 30 s old, held until the capture ends, the frame's hover reports ignored meanwhile) and the body takes `is-taking-screenshot`, which hides only transient tooltips. Selected outlines, tag labels and text marks are drawn as on screen: the capture is the window's pixels, so it shows them. `ai:screenshot` (`{ projectPath, rect }`, whole CSS
pixels within `SCREENSHOT_RECT_PX_MAX`) photographs that rect of the sender's own window with
`webContents.capturePage` and answers `Result<{ mimeType: 'image/png' | 'image/jpeg', data, width, height }>`:
scaled to `SCREENSHOT_EDGE_PX_MAX` (1600) on the longer side, PNG when its base64 is within 1.5 million
characters, else JPEG at 90, 75, 60, 45; a failed, empty or too detailed capture is `invalid`.
**Privacy.** The bytes are never written to disk and never logged: a NativeImage in main's memory, the invoke
reply, the draft's in-memory attachment (browser-stored drafts keep no attachments), then the `ai:prompt`
payload and the ACP `image` block (base64 `data`) on the adapter's stdin. No temporary file exists, so there is
none to sweep: the Claude adapter passes the block to the CLI as a base64 `source` (read in the installed 0.105.0 adapter); the Codex adapter
is not installed here, so its handling of the block is unverified. The transcript stores only the attachment's name (`Screenshot 2 (1600×900)`). What the
person's own CLI keeps in its own session history (`~/.claude/projects`, `~/.codex/sessions`) is the CLI's,
outside Stacki's control. **Note.** An image attachment may carry `note` (one line, at most
`SCREENSHOT_NOTE_CHARS_MAX` characters, no control characters), sent as a text block right before the image and
never stored: `Screenshot 1: region, 768px breakpoint`, `Screenshot 2: panel` (a region whose centre is
off the canvas). **Bounds.** Every attachment, pasted, dropped, picked or captured, enters the draft through
`appendAttachments` (`screenshot/draftAttachments.ts`): at most `attachmentsMax` (16: twice the 8 the "Pick frames" sheet once
offered) and at most `DRAFT_IMAGE_CHARS_MAX` (`attachmentsImageCharsMax`, 24 million, about 18 MB) base64 characters of images in all,
which the `ai:prompt` parser checks again (16 is far under the Claude API's 100 images per request; the Codex adapter's cap is unverified). Chips show the thumbnail, open it in a lightbox
(`AttachmentChips.tsx`, the app's `Popup`) and remove. Proofs: `test/electron/handlers/ai/screenshotCapture.test.ts`,
`test/shared/ipc/screenshotContract.test.ts`, `test/renderer/ai/screenshot.test.js`, and in
`agentHost.test.ts` and `promptBlocks.test.ts` the stored chat without bytes or note and the note block.

**Recording.** The capture control is one bar (`ScreenshotButton.tsx`): at rest the crop button alone; on hover or
focus it grows upward (160 ms, anchored at the crop button's bottom, overlaying, closing after 180 ms) to reveal
Record above it, with a pill that slides to the pointed segment; Record is `visibility: hidden` until then;
ArrowUp and ArrowDown move between them; while a recording runs the crop slot is Record in red. Record opens the
same region selector (with a size readout) and nothing records until the drag is released. `ai:record`
(`{ projectPath, action }`) takes `start` (a rect, as `ai:screenshot`), `status`, `stop`, `frame` (`index` below
`RECORDING_FRAMES_MAX`, 240) and `discard`, each but `start` naming the recording (`r` and 16 hex digits); the
answer is `Result<RecordReply>` by kind. Main (`electron/handlers/ai/screenRecorder.ts`) photographs the rect with
`capturePage` (both channels map the page's CSS-pixel rect to window pixels by the page's zoom factor, `cssRectToWindow`); the first frame is taken at once, the rate is `fpsForCost`: `floor(1000 / (cost × 1.5))` of the
measured per-frame cost (capture and encode), within 2 to 15 fps, chosen from the first frame, every 10 frames and
at once after an overrun; Stop waits for a capture under way and takes the last frame. Frames are never
deduplicated. Each frame is scaled to `SCREENSHOT_EDGE_PX_MAX` as JPEG 70 plus a 640 px JPEG 80 thumbnail (sharp enough to stand in for the full frame in the preview), held as
Buffers in memory only: no file, no temporary file, no log, never persisted. Bounds (`RECORDING_LIMITS`): 15 s of
capture time, 240 frames, 40 MiB of frames and thumbnails; at a bound the recording stops by itself (not a ring)
and the sheet says why. Capture pauses while the window is hidden or minimised (the handlers' `isForeground`), and
paused time does not count. One recording exists app-wide: a new start, `discard`, the sender's window being
destroyed, `stopAll` at quit, or ten minutes stopped and untouched frees it. The bar beside the region
(`RecordingBar.tsx`) polls `status` every 250 ms and stops on Stop or Escape. The "Pick frames" sheet
(`FramePicker.tsx`) shows the whole current frame, never cropped (a box of the recording's own aspect fitted in a
fixed stage, `fitContain`, `object-fit: contain`), over a timeline of the whole recording that never scrolls: evenly
sampled tiles across the width (`timelineTiles`), every frame addressable by position (`frameAt`), blue ticks for
the chosen frames and a time scale beneath. All thumbnails are decoded once into object URLs; a drag reads the strip's
box once and then only does arithmetic, writing the playhead's transform, the preview's source and the time label at
most once per animation frame, and renders no tile again (about 0.03 ms per move in the 200-frame test); full frames
are fetched around the playhead when it rests, at most 5 held. The composer lightbox sizes its image to the window at
the image's own aspect (`lightboxSize`). After a screenshot or added frames the composer takes the keyboard again
(`requestComposerFocus`). Add fetches the chosen frames and appends them through `appendAttachments` as "Recording frame 3
(t=1.2s)" with the note `Screenshot 4: recording frame at 1.2s, region, 1280px breakpoint`, then discards.
Selection (`frameSelection.ts`): Enter or "Use this frame" toggles, shift-click adds the range from the last frame
toggled, "Pick evenly" takes every 2nd, 3rd, 5th or 10th or clears; never more than the draft's free attachment
slots. Proofs: `test/electron/handlers/ai/screenRecorder.test.ts`, `test/electron/handlers/ai/screenRecordingElectron.test.js`
(a hidden window, a synthetic animated page, three region sizes for about 2 s each, no file writes, a small region
at 10 fps or more), `test/renderer/ai/screenRecording.test.js`, `test/shared/ipc/screenshotContract.test.ts`.

Proofs: `test/shared/properties/ai/acpWire.test.ts` (recorded adapter lines, each bad shape, bounds,
unknown variants), `test/shared/ipc/aiChatContract.test.ts`, `test/electron/handlers/ai/agentHost.test.ts`
(a stand-in adapter process through whole turns; connection bounds; pump flow control; store
round-trip and bounds; ledger keep, undo, drift and snapshots), `test/renderer/ai/chatReducer.test.js`
(properties over seeded random streams), `test/renderer/ai/aiStore.test.js` (lists, sections, queue,
unread, drafts), `test/renderer/ai/chatStatus.test.js` and `test/renderer/ai/aiPanel.test.js` (the panel
in jsdom).

## Comment pins

Comment mode (a button in the AI panel's header, `src/features/ai/panelModes.ts`) turns canvas clicks into numbered
pins, each a small message of its own, and "Send all" sends the included ones at once, whatever else is running. Desktop
only: the shell's host (`src/app/shell/DesktopPins.tsx`) registers the mode, so Studio and the demo never offer it.

**Mode buttons.** `registerPanelMode({ id, order, label, icon, isActive, setActive, subscribe })` adds a mode and
returns its removal; the header (`sessions/ModeButtons.tsx`) draws one icon button per registered mode, in `order`,
right before "+", its tooltip and accessible name the mode's `label`, pressed (`aria-pressed`, accent) while it is
on; clicking it again turns the mode off. A mode that is not registered has no button. Turning one mode on turns the others off
(`setPanelMode`). At most `PANEL_MODES_MAX` (8). Comment pins register `comment-pins` at order 10
(`pins/commentMode.tsx`); another mode registers from its own file and removing that file removes only its button.

**Contract** (`shared/properties/ai/commentPinBrief.ts` under the chat model, `commentPins.ts` above it). A pin is
`{ id, number, createdAt, updatedAt, comment, segments?, images, anchor, place, included, delivery }`: `anchor` is the canvas
path clicked (`<file>|` scoped inside an open component), the copy, the point in the box (0 to 1) and the element's
tag and words; `place` is the page, its display name, the open component, the element's file, locator and name, an
instance's component file and the canvas width. `delivery` is `draft` or `sent` (chat, turn, mode `subagents` or
`single`). `comment` and `images` are what was saved (`savedAt`, absent on a pin never saved); `edit` is what its box
holds unsaved, kept on the board so a crash loses nothing and never sent. Save (or Enter) needs words or an added image
(a crop alone is not a comment); the close button and Escape drop a pin never saved and only the unsaved changes of a
saved one (the latter has an Undo toast). Removing a pin (that way, or Delete in the list) shows no toast: it is a
command on the app's undo history (`pushCommand`, installed by the shell as `setPinHistory`), so Undo and Redo take it
in order with every other change, restoring its words, chips, images, model and number; a pin Stacki deletes because
its work finished is not recorded; a press elsewhere, another pin, leaving the mode or the page save a box with content and
let an empty one go. A draft's marker drags onto another element (anchor, place and crop renewed; words, changes and
number kept; Undo in a toast); a sent pin does not move. While comment mode takes the canvas, the frame's forwarded edit
keys (`avb:shortcut`, except Escape and ⌥P) are dropped (`canvasClicksIntercepted`). Bounds `PIN_LIMITS`: 40 pins, 4,000
characters a comment, 4 images a pin, the board's images within `boardImageCharsMax` (40 crops of 1.5 million
characters). The board is the only bound on running pins: one send holds all 40 and their 160 images
(`pinsPerSendMax`, `sendImagesMax`; `ai:prompt` allows past an ordinary message's attachment bounds only for a
`subagents` pins message). `parsePinBoard` is total (a damaged pin is left out
alone); `parsePinBoardStrict` (what a writer sends) refuses the whole board.

**Mentions.** The box takes `@` as the chat does. `comment` is always the words' plain text, each chip as the reference
the chat's composer sends; `segments` (the chat draft's own shape and bounds, `parseDraftSegments`) is kept only while
there is a chip, on the pin, its `edit`, its brief entry and its sent pin, so older pins read unchanged. Chips that do
not parse, or whose plain text is not `comment`, are dropped and the words stay (`pinSegmentsField`). On send, the
files, skills and built-in instructions the pins mention travel as `parts`, each once, at most `mentionsMax`, after a
line "Pin <n> mentions:"; every other chip is already in the comment. A component mention that no longer matches the
project refuses the send, as in the chat.

**Storage** (`electron/handlers/ai/pinBoardStore.ts`): `userData/ai/projects/<sha256(realpath)>/pins/board.json`
(replaced whole after a 400 ms pause in typing) and `pins/images/<id>.bin` (each written once, removed by the save
that stops naming it). Never in the project. Unlike a composer draft, a pin's images are stored: the crop of what it
points at is the point. Channels `ai:pinsRead` (`{ projectPath }`, answers the board and the images still on disk; a
missing image leaves its pin) and `ai:pinsWrite` (`{ projectPath, board, images }`, the images not stored yet;
`invalid` when the board's images would pass the bound, nothing changed). A pin stored as sent with no turn (an older
Stacki's queue) reads back as a draft.

**Anchoring** (`pins/pinModel.ts` `resolveAnchor`). The stored path holds while the open file's element there has the
pin's tag (and words, when both have some); otherwise the one rendered element with that tag and words is the
element moved (the pin follows it); with none, the same tag at the path is the element with its words edited; else
the pin is detached (kept, listed, offered "Move the pin"). Markers are drawn in the canvas overlay layer from the
same measurements as the outlines (`extraTrackPaths`), so they follow scrolling, zoom and breakpoints. Clicks go to
`canvasClickSlot.ts`'s interceptor, ahead of any Stacki app.

**Send.** `ai:prompt` takes `pins` (`PinBrief`: mode and per-pin number, comment, names, page, file, locator, tag,
words, component, width, image indexes). The renderer sends the pins' images as the attachments, each with the note
`Pin 2, image 1: …`, and plain `text` ("Comments on 3 pins" and one line per pin). The host
(`promptBlocks.ts`, `pinInstructions.ts`) puts a `<comment-pins>` text block first and records the user event with
`text`, each pin's first picture only, and a `pins` sent part (number, comment, page and element names, thumbnail index): never the instructions,
a path or a locator. A pin naming an image the message lacks is `invalid`; pins never steer (`ai.error.pinsSteer`).

**Where a send goes** (`pinStore.ts` `sendAllPins`). A send never waits for what is running. It goes to the open chat
while that chat is idle (no reply running, nothing queued; a new chat, opened, when none is open). While the open chat
answers, the pins get a chat of their own, made and sent to in the background (`aiStore.ts` `newBackgroundChat`): the
open chat stays open, is neither steered nor stopped, and a toast says where they went, with "Show chat". The new chat
starts with the open chat's settings, except a mode that skips every permission. A chat that turns out to be answering
(`busy`) is left alone and the pins go to a chat of their own. The pins of a send are taken before anything is awaited
(`sending`, read as "Waiting"), so no pin is ever in two sends; a pin at work (`pinRunning`) has no Reopen, and an Undo
never replaces it with an older draft. Each send is its own chat's reply: its permission cards, questions, changes,
sign-in check, billing watch and Stop are its own. Transcripts of running chats and of chats sent pins name stay in
memory past the usual 16 (`holdChatViews`). A chat that only ever held sends of pins in this run lets its adapter
session go (`session/close`) when each reply ends, which frees that session's CLI process; a later message resumes it
(`agentHost.ts` `closeFinishedPinSession`). Permission cards waiting at once are bounded at 128 and requests to one
adapter at 128 (`aiLimits.ts`).

**Replies that overlap** (`electron/handlers/ai/parallelWrites.ts`). Each reply's ledger snapshots the whole tree, so
while replies of one project overlap, each hears which files the others' edit calls write. Its changes card then leaves
out a file only another reply wrote, and refuses to undo (`ai.error.sharedChange`) a file both wrote, or one none of
its own calls named (a shell command's work cannot be told apart). A reply that ran alone is tracked as before.

**Pictures for subagents** (`electron/handlers/ai/pinPictures.ts`). A subagent gets only the words of the Agent
tool's prompt, never the message's images. So for a `subagents` send the host also writes each pin's pictures to
`userData/ai/pin-pictures/<project>/<chat>/pin-<n>-image-<k>.<ext>` (owner-only, never in the project), lists each
pin's own paths in its lines of the instructions, and asks the main agent to pass them on for the subagent to open
with its Read tool. The message itself carries no image blocks: a full board's would be far more than one message may
hold. Every Claude session of the project gets one added permission
rule, `Read(//<that project's folder>/**)`, in its flag settings, so those reads do not ask. A chat's pictures are
removed when the turn ends, unless a pin asked a question, and in any case at its next pin send, when the chat is
deleted and when the agents stop; folders a day old (a crash's) are swept when the host starts. A picture that cannot
be written refuses the send. A managed policy that ignores added rules would make the read ask on a permission card.

**Per provider** (`agentPresentation.ts` `pinSends`). Claude (`subagents`): one message; the instructions ask for one
Agent call per pin titled `Pin <n>: …`, every call in one single message, so all start at once, shared files included.
Claude Code 2.1.332 refuses the 21st subagent running at once in a session ("Concurrent subagent limit reached… Do not
retry"), so Stacki starts Claude's adapter with its documented `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` at 60
(`subagentsAtOnceMax`), keeping a value the person set (`agentHost.ts` `pinsEnvironment`). Checked with the shipped
adapter and a local fake API: 24 ran at once, and a reply in a second session finished while they ran; the CLI alone
ran 40 and 250. Whether the model puts every call in one message is the model's doing, and rate limits are the
account's. What keeps edits apart, across subagents and sessions: the CLI's edit tools replace an exact passage in the
file as it is, so another's change made meanwhile survives (checked across two sessions); the instructions forbid
whole-file rewrites, writing files with shell commands and project-wide rewrites. That safety is the CLI's, asked for
in words: Stacki does not see or gate those writes, and the person's own chat reply is not given these rules. Codex
(`single`): Codex's own subagents send the panel nothing but their start, so each pin is a message in a chat of its
own, all sent at once through the one adapter's sessions (one pin to an idle chat uses that chat). This relies on the
adapter taking several sessions' turns at once, as ACP allows and the panel already does for two chats; it was not
run against a real Codex adapter. One pin of a Claude send cannot be stopped on its own: Stop is its chat's and stops
that send, never another.

**A pin's model.** A draft's box has a model dropdown (`PinModelPicker.tsx`) of model names, one row per model
(`pinModelRows`). An untouched pin follows the chat's model, whose row is the checked one; picking that row makes a pin
follow the chat again, and a pin that had chosen that same model keeps its choice. A chat model that is not among the
choices, or has no known name ("Chat model"), gets its own row, first. The choice is the pin's `model` (`{ agent, value, name }`, parsed with the board; absent on older pins).
A subagent takes only `SUBAGENT_MODELS` (`opus`, `sonnet`, `haiku`, `fable`), so Claude lists only those; its brief and
sent pin carry `model` and `modelName`, the instructions ask for it as the Agent call's `model`, and the sent card
names what the call really asked for when it differs. For one message per pin, a pin with a model goes to a chat made
with that model: no chat's model is switched. A model no longer available runs
on the chat's, said in a toast. Effort is not per pin: it stays the chat's setting.

**How a sent pin stands** (`pinModel.ts` `pinProgress`). In order: an open question about it; a permission card its
work waits on; its newest subagent, in the send's reply or any later one (a person can have it resumed or restarted);
else the reply it is in. "Needs you" is only ever the first two, so there is always something to answer: the badge
shows the card, or opens the message box on that pin. A question is a written line, `Question for pin <n>: …`, with the
choices listed under it (`pinQuestionsOf`; the instructions ask for it): neither agent can show a question card here
(Claude's question tool is off for a client without ACP `elicitation`). Words that ask without that form are not
detected. The pin shows the question, its choices as buttons and Reply. A reply opens with the pin's quoted words
(`pinReplyLead`) and answers that pin; a message opening with no pin's words answers every question before it. A pin
not done reads "Didn't finish", "Stopped" or "Not started"; "Waiting" is a pin on its way, or one whose subagent has
not started yet.

**When an agent has finished** (`subagents.ts`). A call that returned its result finished. A call that returned the
background launch note did not: Claude's adapter reports a background agent's end only to JetBrains clients, but for
Stacki it holds the turn open until every agent that turn started or woke has finished. So while that turn runs the
agent reads "In the background" (its tooltip says its end is not reported); a turn that ends `end_turn` proves it
finished; any other end means it did not. A follow-up that wakes an agent moves it to the follow-up's turn. Codex's
"Start subagent" call proves only the start ("Started"). A chat read back with a turn nothing runs any more is given an
error end (`closeInterruptedTurns`). Chunks of different ACP `messageId`s are separate messages. The strip, the cards,
the Running panel and pin badges all read the same `deriveSubagentWork`; each state has its own mark shape, and the
strip's head counts each apart, saying "finished" only when all are done. Proofs: `test/renderer/ai/pinLifecycle.test.js`.

**The bar and the list.** The pins' bar stands at the bottom centre of the canvas (16 px up), clear of the page's own
navigation, and stacks upward (the billing warning over it). It has no drag and no saved place. Toasts and the
refused-save notice start above it; while a pin's crop is taken the bar and toasts are hidden; in Design mode, which
has its own bar and canvas, it is not shown. A pin's box ends above it. The list opens upward, centred on the bar and
kept in the window (`PinList.tsx` `listPosition`), at most 520 px high with its own scroll, with the bar's edge and no
shadow; it stays open through the chat's own scrolling, and toasts wait under it. A sent pin's row has a one-line live
status (`PinLiveLine.tsx`): the AI panel's agents-list mark, words (`statusLine`, `activityText`; a search or fetch
reads "Searching" or "Fetching") and clock for that pin's own subagent (`pinModel.ts` `pinWork`); the reply's own
newest step only when the reply works on that pin alone; "Starting" with no clock before then; "Waiting", or the end's
word with no clock.

**Finished pins are deleted** (`pinModel.ts` `pinFinished`, `pinStore.ts` `deleteFinishedPins`). A sent pin that reads
done leaves the board by itself (marker, open box, list row, and its images with the save). Failed, stopped, not
started, asking, waiting and running pins stay with their status. A finished pin holding words typed after the send
and not saved becomes a draft with them instead. The chats sent pins went to are read on load (`aiStore.ts`
`loadChatView`), so pins that finished while the app was closed go too. The chat's message keeps its own words and
thumbnail.

**Transcript.** A message with a `pins` part is drawn by `pins/PinsMessage.tsx`: each pin's words and names, its
status (opening its subagent when it has one) and its thumbnail at the row's end; no pin numbers (the chat refers to
none: subagent titles are shown without their `Pin <n>:`, `withoutPinNumber`, which matching still reads). A pin still
on the board opens on the canvas. No
Edit or Resend. Proofs: `test/shared/properties/ai/commentPins.test.ts`, `test/electron/handlers/ai/pinBoardStore.test.ts`,
`test/electron/handlers/ai/agentHostPins.test.ts` (the stand-in adapter as Claude's coordinator),
`test/renderer/ai/pinModel.test.js`, `test/renderer/ai/pinStore.test.js`, `test/renderer/ai/pinsMessage.test.js`.

## Voice input

The composer's microphone (`src/features/ai/useDictation.ts`). Audio never crosses IPC: the
platform's speech recognizer lives in the renderer, and only text and the microphone report
(`microphone:*`, above) travel. The boundary is the recognizer's transcript: `parseTranscript`
(`shared/properties/voice/transcript.ts`) returns `Result<string, 'not-text' | 'too-long'>` and
nothing downstream sees an unparsed phrase. Everything after it is pure and lives in
`shared/properties/voice/`:

| File | Holds |
|---|---|
| `voiceLimits.ts` | Every bound: phrase length, words, dictionary size, history, bars, hold time, silence, restarts, session length |
| `transcriptCleanup.ts` | Fillers, stutters, spoken corrections, spoken punctuation, capitals; English rules only (`rulesForLanguage`) |
| `voiceDictionary.ts` | Entries from project file names plus built-in terms; whole-word matching, never a pattern built from a name |
| `voiceCommands.ts` | `parseVoiceCommands` to a `VoiceAction` union: insert, newline, deleteLast, send, stop |
| `voiceHistory.ts` | What "scratch that" takes back; never reaches into typed text |
| `voiceSession.ts` | The session state machine (idle, starting, listening, stopping) and its effects |
| `waveform.ts` | Samples to bar heights |

Tests inject the recognizer, the audio meter and the clock through `VoiceEnvironmentContext`
(`src/features/ai/voice/voiceEnvironment.ts`); no test opens a microphone.

## Audits

`.stacki/audits.json` (`shared/properties/auditIgnores.ts`) is the tracked audit configuration:
`{ "version": 2, "ignored": [{ "id", "reason"? }], "ignoredPages"?, "checks"?, "tokens"?, "placeholders"? }`. One file
holds both ignores and settings, rather than a second `.stacki/lint.json`: both are "how this
project audits itself", edited from the same panel and Settings tab, and one file is one write
witnessed against one set of bytes. Version 1 (ignores only) still reads and is written back as
version 2; settings at their defaults are left out of the file.

- `reason` is optional on every entry: Ignore is one click, so a plain ignore is written without the
  key and reads back as no reason. Files written while a reason was required read unchanged and keep
  their reasons. An entry without `reason` is refused by earlier builds, which required it.
- `ignoredPages`: `[{ "file", "reason"? }]`, at most 500, `file` project-relative and unique. A page entry
  silences every finding of every check in that file; finding-level `ignored` entries are separate and
  stay when a page is unignored. Written only when non-empty, so older files read unchanged; a file
  that has the key is refused by older builds (unknown field), as every addition to this file is.
- `checks`: by check id (`^[a-z0-9-]{1,40}$`, at most 100), `{ "enabled"?: boolean, "priority"?: "high" | "medium" | "low" }`.
- `tokens`: `properties` (names, `padding*` matching a prefix), `colors`, `px`, `remOutsideVariables`
  (booleans), `allowed` (raw values, compared lower-cased).
- `placeholders`: phrases; one word must be the whole text, several may be part of it.
- `customAudits` (`shared/properties/customAudits.ts`): the project's own audits, at most 50, each
  `{ "id", "name", "icon", "category", "severity"?, "scope", "match", "exclude"?, "message"?, "enabled" }`. `id` is
  `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` and unique; `icon` is one of `CUSTOM_AUDIT_ICONS` (icons the panel already
  draws); `category` a built-in id (`accessibility`, `seo`, `content`, `tokens`, `performance`) or a name of the project's
  own (at most 40 characters); `severity` `high`/`medium`/`low` (default medium, left out when medium). `scope` is
  `declaration` (`match: { property, valueMustMatch?, valueMustNotMatch? }`, regular expressions on the property name and
  the value) or `css`, `markup`, `rendered` (`match: { pattern }`). `exclude` drops a match whose declaration, or for a
  text scope whose line, also matches. Patterns are at most 300 characters, case-insensitive. The parser checks shape and
  bounds and ignores an entry's unknown keys; it does not compile patterns, so a hand-edited unsafe pattern never makes the
  file unreadable: the run reports that audit (`AuditReport.custom.problems`) and skips it. Every writer (the panel's
  editor, `stacki audits`) refuses a pattern `checkPattern` refuses: invalid, a backreference, a repeat inside a repeated
  group, more than 3 open-ended repeats, or (for a pattern that finds) one that matches empty text. The matcher
  (`shared/page/auditCustom.ts`) reads at most 2,000,000 characters per text, 1,000 per value or line, 200 matches per
  file, 2,000 per run and 1.5 s per audit per run, and says when it stopped early. Written only when non-empty.
  Findings are check `custom` with `custom: { id, name, icon, category, message }`; their id is `custom:<id>|file|path|detail`.
- Lists hold at most 200 items of at most 120 characters; ignores at most 2,000 entries, ids at
  most 1,024 and reasons at most 500 characters. Unknown fields, a reason that is present but blank
  or not a string, a repeated id and settings under version 1 are refused.

It travels as the `audits` metadata kind through `project:metadata` / `project:writeMetadata`
(writes need `panel:audits` or `settings:audits`). An id is `findingId`
(`shared/page/auditFindings.ts`): check (`custom:<id>` for a custom audit), file, structural path and detail.
A broken link listed at the usage that passes its value keeps the id it would have had on the component that
draws it in `formerIds`, so an entry saved under that id still hides it.

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
admin-only on the Studio server.

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

## Attributes props (`ScanComponent.extendsTag`)

`extendsTag` on a scanned component (`shared/properties/projectScan.ts`, Desktop) and on
Studio's `Component` (`studio/src/features/project/projectClient.ts`, parsed as a lowercase
tag of at most 128 characters) is the tag Props takes attributes from, read by
`parseExtendsTag` (`electron/parse/astroComponentApi.ts`) anywhere in an `interface Props`
extends list or at the top level of a `type Props` alias's intersection; the tag-less
`astroHTML.JSX.HTMLAttributes` gives none. The Properties panel passes it as
`attributesTag` to an instance's Attributes section, which checks names against it
(`attributeNameNote`, advisory). Writing the prop, its precedence and disconnecting are in
docs/component-properties.md (An attributes prop).

## Boot snapshot (`shared/properties/bootSnapshot.ts`)

The cross-process cache that lets a window's first frame show the last session's real state. Main reads
`boot-snapshot.json` before the window exists and the preload hands it to the renderer synchronously as
`window.stackiBoot.seed` (an `unknown` until `src/lib/bootSeed.ts` parses it); the renderer sends snapshots back with
`stackiBoot.save(text)`. The raw channels `boot:read` (sendSync), `boot:save` and `boot:first-frame` (send) are outside
the typed invoke contract and answer only the main window's top frame (`electron/boot/bootChannels.ts`). Versioned
(`version: 1`), bounded (`BOOT_LIMITS`), parsed to a `Result`, ignored whole when invalid, never written to a project.
See docs/startup.md.

## Component duplicate and delete

The Components panel's "…" menu (`src/features/palette/PalettePanel.tsx`) adds Edit settings, Duplicate and
Delete through `PaletteManagement` (`paletteManagement.ts`). The channels are `component:duplicate`,
`component:planRemove`, `component:remove` and `component:restoreRemoved`; each takes a `ComponentOpTarget` (`shared/properties/componentOps.ts`:
`component` or `folder`, a project-relative path) and answers a `Result` whose refusals are typed
(`ComponentOpError`: outside the component folders, missing, in use, foreign files, too large, write failed).
Main resolves the path itself: it must sit under a folder from `.stacki/folders.json` `components`, may not climb
or be a link, and a folder may hold only `.astro` files within `COMPONENT_OP_LIMITS`.

- Duplicate copies the bytes to `FooCopy`, `FooCopy2`, ... (dashed names keep their style), case-insensitively free, through the document actors. Nothing is rewritten and no recipe is added.
- Delete is planned first (`component:planRemove` answers a `ComponentRemovalPreview`, `shared/properties/componentRemoval.ts`, parsed at the boundary) and confirmed with what it takes out; `component:remove` carries `uses`: `'remove'` (the panel) takes every instance and import out with the file (see docs/components.md, "Deleting a component"), `'refuse'` (a duplicate's undo) refuses a used component. Either way it removes the component's `.stacki/components.json` recipe and every nested `component` reference, and drops its `.stacki/roles.json` `componentRules`, then moves it to the operating system's Trash. Main keeps the removed texts and the settings as they were and as the deletion left them under a token: Undo restores the files and restores each setting only while it still reads as the deletion left it.
- Folder rows in the panel are real folders, so a folder row offers Duplicate (confirmed from 6 components) and Delete (planned and confirmed the same way, over every component under it).
- Studio's panel passes no `management`, so the rows are left out: its server has neither a copy/trash operation nor an undo store for them yet.

## Dictation model

`dictation:status`, `dictation:download`, `dictation:cancel`, `dictation:remove` and `dictation:reveal`
(`shared/properties/voice/dictationModel.ts`) manage the on-device Whisper model
(docs/voice-engine.md). The renderer names a model id and nothing else: addresses, hashes, sizes
and the folder (`<userData>/models/whisper`) are fixed in main by `whisperModels.ts`. A status lists
each known model once with bytes never past its pinned size; a download resolves to an outcome
(`installed` or a `DownloadFailure`), never a rejection for a network or disk problem. Progress
arrives as `dictation:progress` events, parsed by `parseDownloadProgress`, at most ten a second.
`dictation:reveal` shows a model's folder in the file manager (Settings > Dictation, Model details); it takes the same
model id, opens nothing before the model is downloaded, and never accepts a path.
The worker reads the model through `stacki-model://whisper/<model>/<revision>/<file>`, which serves
only manifest files of an installed model. Messages between the page and the Whisper worker are a
boundary too: `parseToWorker` and `parseFromWorker` (`whisperWorkerProtocol.ts`) bound audio to the
30-second window and text to `segmentCharsMax`.

## Files panel

The Files panel (`src/features/files/`, Desktop's host `src/app/shell/DesktopFiles.tsx`) lists, opens, edits, creates,
renames, moves, copies, trashes, imports, reveals and finds every file and folder of the open project, VS Code's Explorer
as the model. Its contract is `shared/ipc/fileExplorer.ts`; main's side is `electron/project/explorerPaths.ts` (where a
path lands), `explorerOps.ts` (what is done), `explorerWatch.ts` (live changes) and `electron/handlers/fileExplorerHandlers.ts`.

Channels: `files:list`, `files:read`, `files:write`, `files:create`, `files:rename`, `files:transfer` (move or copy),
`files:trash`, `files:import` (files dropped from the operating system), `files:reveal`, `files:find`, `files:watch`,
`files:guardClose` and `files:allowClose`; events `files:changed` (`{ directories }`) and `files:closeRequested`. Every
reply but the last three is `{ ok, value } | { ok, error }` with an `ExplorerError` (`code`, the taken `names` of a
collision, and for `filesystem` the system's error code; never a path or file contents).

- **Paths.** An `ExplorerPath` is project-relative with `/`, no empty, `.` or `..` segment, no backslash or control
  character, at most 4,096 units and 128 segments; `''` is the root. Main accepts a request only for the project it has
  open, resolves every path with `realpathSync.native` and refuses one whose real location is outside the project
  (`outside`). An entry acted on as itself (rename, move, copy source, trash) is never followed: a link is renamed,
  moved or trashed as a link, and its parent's real location must be inside the project.
- **Dot-folders and `.git`.** Nothing is hidden: dotfiles, `.stacki`, `.github`, `.vscode`, `.astro` and `.git` are all
  listed, expandable and readable, and find matches their names. `.git` and `.stacki/io` (the document actors' locks
  and staging) are read-only from the panel: no write, create, rename, move, copy into, or trash, whatever the case of
  the spelling, and also when a link resolves into them (`protected`). Find does not walk the inside of `.git` or
  `node_modules` (generated and large), but matches their own names.
- **Bounds.** A listing returns at most 5,000 entries, folders first in natural order, with the folder's `totalCount`;
  text opens up to 8 MiB; a batch names at most 1,000 items; a copy is walked first and refused past 20,000 entries or
  2 GiB; at most 512 folders are watched (the expanded ones and the open file's); a find visits at most 100,000 entries
  and returns 200 matches, saying when it stopped early.
- **Reading and saving.** A file opens as text only when it is strict UTF-8 with no NUL in its first 8 KiB; anything else
  is `binary` or `too-large` (never decoded lossily, never written), and images, video and audio are `media`, previewed
  through the `stacki-asset` scheme. A leading byte-order mark is a flag, not text, and is put back on save. The editor
  edits `\n` text and puts each untouched line's own break back (`shared/core/lineBreaks.ts`), so a save changes only
  the bytes the person edited. `files:write` goes through the file's document actor and is witnessed by the checksum the
  text was read with: a file that changed since is `conflict`, never written over. Saves are explicit (⌘S / Ctrl+S or
  Save). Unsaved text is settled (save, discard or stay) before the editor shows another file or closes, before the
  project closes (`leaveProject`), and before the window closes or the app quits (main holds `close` and `before-quit`
  while `files:guardClose` says text is unsaved, asks with `files:closeRequested`, and goes on after `files:allowClose`).
  An outside change reloads a clean editor and is a conflict (keep mine, use theirs, or merge) for a dirty one.
- **Single writer.** A file the canvas has open (the page, or the component drilled into) is not edited by the panel's
  writer: the file editor shows the Code panel's editor for it, which writes through `page:edit`. A Files save of any
  other file is announced as the project watcher announces an outside edit (`fs:changed`, `css:changed`, `cms:changed`).
- **Never overwrite.** Create and rename refuse a taken name (`exists`); a rename that differs only in case and finds the
  same entry goes through a free name in the same folder, so it works on case-insensitive disks. Move, copy and import
  answer `collision` with the taken names; the renderer asks and sends `keep-both` ("name copy.ext", "name copy 2.ext")
  or `replace` (the old entry goes to the Trash first). Copies are created with `COPYFILE_EXCL`; links inside a copied
  folder are copied as links. Deleting is `shell.trashItem`, after the app's own confirm dialog.
- **References.** A page or page folder under the pages folder moves through `page:move` / `pagefolder:rename` (links,
  imports, `.stacki/pages.json`), and a component file under a component folder through `component:rename` (imports,
  tags, `.stacki/components.json` recipe keys, roles); both keep their own Undo. Every other move is plain: no code is
  rewritten. Plain renames and moves record an Undo step that moves the entries back (refused, never forced, when the
  old name was taken meanwhile).
- **Ready before it opens.** The app shell mounts `FilesKeeper.tsx` for the open project whenever the role may use the
  panel. It reads the root and the folders left open (never a closed one, so `node_modules` stays unread), follows them
  with `files:watch` while the panel is closed too, reads them again on `files:changed` and on window return, and reads
  a folder again when it is opened, keeping the held listing on screen. So the panel's first frame is the tree. A
  `files:list` that rejects, refuses or does not answer in 10 s is a failure: no placeholder rows stay, the open panel
  says so in a toast and offers Refresh (a listing already held stays on screen).
- **Git marks.** `files:gitStatus` (`shared/ipc/fileExplorer.ts`, read by `electron/git/gitFileStatus.ts` from the
  porcelain the Git panel reads) answers `none` outside a repository, `too-many` past 20,000 changed entries (the panel
  then marks nothing and says so once, never a partial list), or the changed and ignored entries relative to the project,
  which may sit below the repository's root. An untracked or ignored folder is one entry. Past 20,000 ignored entries
  nothing is dimmed. The rows, find results and the open file's header wear a letter (`!` `M` `D` `R` `A` `U`, each told
  in words by a tooltip) in the `--git-*` colours the Git panel's badges use; the working tree's column wins over the
  index's. A folder holding changes wears a dot in the strongest one's colour (that order). Ignored entries are dimmed.
  A deleted file has no row; unlike VS Code, the folders above it still get the dot. There is no timer of its own: the
  keeper reads when the app's git read answers (`useGitInfo`), on every `files:changed`, and on window return. Main
  follows the git directory (index and HEAD) and sends `files:changed` with no folders, so a commit or switch made
  anywhere shows at once. The tree never waits for git, and an unchanged answer draws nothing again.
- **Git panel's list of changes.** Under the commit box (`ChangesList`, `features/git/CommitFilePicker.tsx`, Desktop
  and Studio), closed each time the panel opens: `git:status`, one row per file with the same icons, colours and letters
  (`ui/GitStatus.tsx`), deleted files included, at most 200 rows and then a count of the rest. It does not choose what
  a commit takes; the picker still does. Desktop opens a clicked file in the Files panel; Studio's rows only show.
- **Access.** The panel follows `code:edit` (`src/lib/roleAccess.ts`). Its shortcut is ⌥F. Studio has no Files panel yet.

## Code intelligence

`shared/ipc/codeIntel.ts` is what a full code editor may ask about its file (suggestions, a
suggestion's detail, hover, signature help, errors) and what comes back, bounded by
`CODE_INTEL_LIMITS`. One channel, `codeIntel:request`, carries a question with the editor's whole
text, so unsaved text is what is analysed. Both sides parse: main parses the renderer's question, the
intelligence process parses it again, and main and the renderer parse its answer.

The answers come from `electron/lib/codeIntel/`, run as an Electron utility process
(`serviceProcess.ts`) that `host.ts` starts on the first question, stops when the project closes or
changes or after five idle minutes, times out, and restarts a bounded number of times. Main never reads
types itself. Its memory is bounded twice: V8 ends it at its heap limit, and it ends itself after an
answer that leaves it holding more than `residentMegabytesMax` in all, which counts toward the restarts.

It reads the project and runs none of it:

- The type checker is the app's own `typescript`, with its own libraries (the build copies them to
  `dist/electron/typescript-lib/`, because the packager leaves `.d.ts` files out). A project's
  installed TypeScript is not loaded.
- `.astro` files are printed as TSX by the app's own `@astrojs/compiler`. `astro.config` is never
  loaded, and neither are a tsconfig's `plugins` (the language service has no plugin host).
- From the project it reads sources, `tsconfig`/`jsconfig` JSON (`extends`, `paths`, `baseUrl`,
  references), `package.json`, `.d.ts` files (Astro's, and what Astro generated in `.astro/`) and
  stylesheets.

Without installed dependencies only mistakes in the writing itself are reported. `.vue`, `.svelte`
and `.mdx` components are typed as taking any props. `public/` is taken to be the public folder,
since reading another from `astro.config` would mean running it. Studio has no intelligence process:
its editors pass no extension and are unchanged.
