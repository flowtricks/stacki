# Architecture and current limits

## Vertical features

`src/features` groups source editing, collaboration, component discovery, settings, navigator, preview, pages, assets, collections, GitHub synchronization, publishing, authentication, storage, and AI. Each feature owns its domain functions and UI where applicable. `src/app` composes the editor. `src/server` adapts these features to Astro/Vite HTTP and WebSocket transports. `src/cloudflare` handles cloud bindings and the authenticated gateway. Shared code contains validation, a bounded serialization queue, and generic value controls.

The code uses Stacki's strict TypeScript approach: unchecked-index and exact-optional-property checking, explicit unknown-value validation, source-preserving edits, bounded work, and no `any`, non-null assertions, or ignored compiler errors. Vendored Stacki code is attributed and type-checked separately from our formatting rules.

## Drafts, collaboration, and preview

One Yjs text document represents each editable source file. Minimal source edits preserve unrelated bytes. Structural operations use parsed source ranges and a source checksum; overlapping stale drags are rejected with a retry message. Source text merges automatically, while structural conflicts are not silently guessed. Each editor's undo manager tracks its own operations.

Selections are shared: every editor can select an element and insert children while one editor owns its settings. The room confirms selection and separately tracks editing ownership. Settings and Style show the owner and a Take over action when read-only. A takeover includes the expected owner ID and element, transfers editing access atomically, and preserves both selections; stale requests are rejected. When the owner selects elsewhere or disconnects, one remaining inspector inherits editing access. Settings updates and destructive structure actions are guarded by ownership; child insertion does not require takeover.

Cursor presence uses a separate, ephemeral WebSocket message path, coalesced at 50 ms on both the client and server. The server assigns identity and stable session colors, broadcasts across file rooms, and sends current cursors to new connections. Preview coordinates include a rendered element anchor and document-relative fallback, so cursors track scroll and viewport changes. Local chat follows the physical pointer and remains until its text is erased; leaving the canvas hides it without discarding the message. The editor keeps chat in memory across preview frame replacement. Cursor chat is bounded to 160 characters and never enters the source document, undo history, or durable storage. Remote cursor DOM updates bypass React rendering, stale cursors expire, and disconnects clear them immediately.

A project coordinator sequences accepted mutations and snapshot capture. Draft persistence is acknowledged before Saved. The filesystem powers the preview; R2 stores collaborative recovery state in hosted deployments. Browser IndexedDB preserves pending document updates. Closing a tab while offline does not constitute publication. If server draft identity is deliberately replaced, the old browser draft is retained and editing stops instead of merging unrelated histories.

Durable writes normally batch for two seconds. An unacknowledged edit has a separate
25-second deadline: socket heartbeats and subsequent typing cannot postpone it. Studio
reconnects and replays the retained Yjs document at most three times before showing Needs
attention. A replay retries filesystem and durable writes even when Yjs already merged it;
an in-memory duplicate is not proof of a successful save. Edits during a reconnect handshake
remain local until synchronization completes. Preview subscriptions request a current render
on connection so changes made during sleep are visible without another edit.

An Astro integration marks page-authored nodes in memory. The parent selects instances, and the iframe morphs the rendered DOM. HTML preview responses embed their exact initial HTML as inert, escaped JSON (bounded at 4 MB), so edits during script loading do not corrupt the comparison baseline. Component template source is edited only through an explicit code change such as an AI proposal. Preview instrumentation applies only to the dev server and is excluded from production builds.

The hosted preview uses a sibling subdomain, such as `preview.example.com`, with its own audience-restricted session. GitHub credentials and the studio session secret stay in the Worker. The Container receives a narrower token for draft storage, GitHub operations, and the AI gateway. Site code and dependencies execute in that Container, so site contributors and invited editors are trusted to change application code. This is not a multi-tenant hostile-code sandbox.

Prop changes and hover previews reuse the authenticated Vite preview socket for rendered
HTML. After Vite invalidates the source, the container renders subscribed page URLs through
its loopback Astro server and pushes each result to the matching frames. This removes the
browser's second network round trip without predicting component output. Work is bounded
to 10 page URLs, 30 frames per URL, 100 subscriptions, two concurrent renders, and a
15-second render timeout. Superseded renders are discarded. The initial baseline is removed
from pushed HTML, and normal page fetching remains the fallback after failed delivery.

## Publishing and GitHub synchronization

A publish captures immutable Git objects under the project coordinator. GitHub-only actions skip
builds and hooks; hosting actions copy and build an isolated snapshot. Git transfers missing
objects directly, preserving unrelated repository paths and publishing captured asset deletions
in the same commit. An exact expected-head lease prevents overwriting concurrent changes. The
Worker grants repository-scoped installation access only to the authenticated container; the
App private key stays in the Worker. The UI shows completed stages and, when configured, confirms
the exact revision from the live gateway before reporting deployment success. Otherwise it reports
only the GitHub commit.

While the studio is open, GitHub source changes are checked at most once per minute per visible active editor. Disjoint edits merge into the active shared documents. Conflicts leave the previous baseline in place and let the editor choose draft or GitHub versions for conflicting files. Resolutions are tied to the inspected GitHub revision. No publish is performed by synchronization.

## AI

The provider receives the user's prompt, the current file, a source-file inventory, and requested source files. It can read up to five additional rounds and propose up to twenty files. Total context, output size, request duration, and pending proposals are bounded. The UI displays exact before/after replacements. Applying a proposal rechecks current source, validates Astro markup/JSON, and runs through the project coordinator. A failed storage operation attempts recovery and reports any recovery failure.

The default has no AI provider and incurs no AI token charges. A compatible model served locally can omit `AI_API_KEY`. Hosted deployments need an endpoint the Worker can reach; self-hosting still has compute costs. This implementation does not reuse a ChatGPT subscription or automate a consumer chat website.

## Runtime dependencies

- React: the editor UI, matching Stacki's component approach.
- Yjs and y-indexeddb: merged source text, local undo, and pending-edit persistence.
- ws: the Node preview server's collaboration transport.
- Stacki native navigator drag/drop plus a touch adapter; dnd-kit remains for collection list sorting.
- CodeMirror and its language packages/Lezer: Astro, CSS, JavaScript, and Markdown code fields.
- PostCSS, postcss-selector-parser, known-css-properties: Stacki stylesheet editing, selectors and CSS completion.
- Astro compiler: validation of AI-authored Astro markup.
- TypeScript: safe parsing of imported type declarations without executing them.
- JSON5: literal object/list props without `eval`.
- jsonc-parser and YAML: field editing with preservation of neighboring JSON text and Markdown frontmatter comments.
- Cloudflare Containers SDK: preview lifecycle and authenticated request forwarding.

Build/type-check/test tools remain development dependencies. The deployment template installs development tools to build the studio and compile the TypeScript container bootstrap to JavaScript.

## Known boundaries before a production release

- This is an initial working implementation, not certified parity with every Stacki feature. The navigator, props/rich text, styles, code, component palette, responsive canvas and outline renderer reuse Stacki directly. Desktop-only terminal/Git workflows, variables panel, cross-file clipboard imports, layout switching, component creation, and complete accessibility parity are not implemented. Loop binding renames require Code so references are not silently broken.
- Static component props and the shapes Stacki's parser understands are inferred. Arbitrary runtime-generated props, complex type-programming, custom alias configurations beyond `@/`/relative imports, computed routes, framework-island internals, and generated loop children may need source editing. No automated claim is made that every Astro project can be edited without limitations.
- Markdown body editing is plain Markdown, not a rich text editor. Existing fields are inferred from content; collection validation schemas and reference pickers are not yet implemented.
- The GitHub sync service handles source-file changes. External binary assets or dependency/config changes stop synchronization with a message and require an operator-managed refresh. Do not discard R2 documents to refresh a repository without first exporting/backing up the draft.
- GitHub file history, branch switching, deployment rollback, file renaming/deletion UI, and granular client roles are not implemented. In repository-access mode, accepted GitHub collaborators with Write or Admin permission can edit and publish. The alternative numeric-ID allowlist remains available.
- Offline edits are retained locally, but there is no offline service worker to load the entire editor without network access. Conflict recovery/export UI remains basic.
- A single Container serves a project, capped at 30 connections per file and 100 opened documents. Multi-tenant provisioning, distributed scaling, eviction, and performance tuning are not implemented. Source files are capped at 1 MB, collaboration state at 8 MB, uploads at 20 MB, and a publish at 1,000 files / 24 MB total.
- Multi-file changes are serialized and recovery is attempted on failure; they are not a cross-R2-object database transaction. Fault-injection testing of interrupted cloud writes and restarts is still required.
- Optional D1/R2-backed **live SSR collections** are a future adapter. R2 currently holds private drafts/uploads for recovery. GitHub files remain the published content default.
- AI can edit site source, but cannot currently install dependencies, change deployment secrets, or execute an unrestricted shell. Its provider compatibility and quality need testing with the selected model.
- The example deployment runs on Cloudflare with GitHub OAuth, a repository-scoped App, private R2 drafts, and an authenticated preview. Custom domains, fault-injected R2 recovery, and an end-to-end publish/deploy still need validation. The public website uses Cloudflare Workers Builds on main, with Studio verifying the live revision after a publish.

## Preview responsiveness and presence

Literal text changes are posted directly to measured text regions; a component with one literal child can update a uniquely matching text descendant. Expressions and arbitrary component rendering remain server-owned. The normal three-tree morph reconciles the rendering while preserving runtime state. Bounded pending text patches are discarded on structural changes. Browser regression holds server renders and verifies both editors see text without waiting for compilation.

Enum hover previews are private, request-scoped Astro renders. The selected component's actual props and slots remain in the page; a preview-only frontmatter hook applies one enum override before the component evaluates. AsyncLocalStorage isolates concurrent renders. The existing authenticated Vite socket prepares up to 32 options, prioritizes an uncached hovered option, and sends complete HTML snapshots to a 16 MB browser cache. Hover and cancel never write the shared document; a click commits through the normal source editor. Source changes invalidate cached snapshots and stale replies. Accepted source writes invalidate Vite's module graphs and start the authoritative render immediately, without waiting for filesystem/HMR notification.

Numeric props with a verified direct CSS variable binding can update the existing canvas element immediately. The scanner rejects defaults, derived values and props also used for HTML. Patches target both the instance and component-template markers, preserve the latest value over stale renders, and retire when authoritative HTML catches up. Other props continue through Astro's complete render path.

Preview sockets negotiate gzip for large HTML payloads, including enum snapshots. Old clients retain plain HTML. The browser limits expanded HTML to 4 MB and ignores superseded asynchronous decodes; compression never changes the rendered markup.

Stacki's insertion recipes initialize the requested Lumos text, nested children and numeric props only when adding a new component instance. Recipes reuse existing imports and insert missing nested dependencies without rewriting unrelated source. Component definitions and existing instances are unchanged.

Presence is aggregated across up to 100 file rooms (30 sockets per room). Connections retain server-verified GitHub identities; the people list chooses each account’s latest active connection. Each peer reports its source file, preview page, selection and repeated occurrence. Own-account selections are excluded from remote outlines. Avatar clicks make a one-time jump, select and reveal the peer’s element. Parent/frame messages verify both source window and origin.

GitHub comparisons that reach the API’s 300-file response cap fall back to complete tree comparison. Studio code is excluded before deriving site changes, so large editor releases do not block site synchronization or silently skip later files. Truncated repository trees are rejected.

Collaboration sockets send heartbeats and renew repository authorization in the background. Successful permission checks keep the socket open; expired sessions or removed write access close it with a distinct sign-in-required status.

### CMS collections

`features/cms` adapts Stacki's CMS and Astro content collection controls. The panel
scans JSON, exported data modules, current-page frontmatter, and declared content
loaders. Upstream handlers run against a temporary snapshot (2,000 paths / 32 MB),
not the live draft. Changes are bounded to 50 source files, checked against client
revisions, and applied through the project coordinator and shared rooms. Failed
batches restore prior text. Path validation restricts content loaders, renames and
entry writes to `src/` and `public/`. Schema inspection runs the project's config
in Stacki's bounded worker process; the process and snapshot are removed after
each request. Preview events refresh other open CMS sessions.

Reserved `src/data/studio-cms-schema.json` and `studio-cms-deleted.json` hold field
types and deletion tombstones. They are hidden from collection navigation, saved
with shared draft state, and restored before a container starts previewing. Normal
publishing still determines when content reaches the live website.
