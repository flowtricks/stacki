# Dependencies

AGENTS.md §17: every dependency carries a written justification — what it does, why the platform
can't, and what it costs. `scripts/policy/scan.mts` holds this file to `package.json`: every
entry in `dependencies` and `devDependencies` must have a `### \`name\`` heading here, and every
heading must name a declared dependency. Adding a package without a paragraph fails the gate;
removing one without deleting its paragraph fails it too.

Each entry answers three questions: **Does** (what it does for Stacki), **Why not the platform**
(what Node, Electron, or the browser lacks), and **Cost** (install weight, risk, or lock-in).

## Runtime (`dependencies`)

### `@astrojs/compiler`

**Does:** parses `.astro` files into the AST the page tree is built from (`electron/parse/astroParser.ts`).
**Why not the platform:** Astro's grammar (frontmatter, expressions, components) has no platform
parser; this is the reference implementation. **Cost:** WASM payload; its AST shape is a contract we
pin with round-trip tests.

### `@lezer/highlight`, `@lezer/javascript`

**Does:** syntax-highlight tags for the editors, and the JavaScript parser behind `src/features/props/jsCheck.ts`.
**Why not the platform:** no incremental JS parser exists in the browser. **Cost:** small; already
a transitive dependency of CodeMirror, declared because we import it directly.

### `electron-updater`

**Does:** in-app updates from GitHub releases. **Why not the platform:** Electron's `autoUpdater`
lacks the GitHub provider and differential downloads. **Cost:** runs with network access in main;
its inputs are release metadata we publish.

### `node-pty`

**Does:** spawns the terminal's pseudo-terminal. **Why not the platform:** Node's `child_process`
has no PTY. **Cost:** native module — the reason for `fix:install` and `afterPack` handling.

### `postcss`, `postcss-selector-parser`

**Does:** parses and rewrites stylesheets and selectors for the style panel. **Why not the
platform:** CSSOM drops comments and formatting, and edits must preserve the author's source.
**Cost:** moderate; parsing happens in the renderer on user-sized files.

### `smol-toml`

**Does:** reads TOML content files (`electron/content/formats/toml.ts`). **Why not the platform:** no TOML
parser in Node. **Cost:** small, dependency-free.

### `typescript`

**Does:** at runtime, the compiler API reads component property types
(`electron/property*.ts`); at build time, it compiles the project. **Why not the platform:** no
TypeScript type-checker exists outside it. **Cost:** large install; required at runtime, so it
stays in `dependencies`.

### `yaml`

**Does:** frontmatter and YAML content files, keeping comments and formatting on round trip. **Why
not the platform:** no YAML parser in Node. **Cost:** moderate; its document API is what makes
lossless edits possible.

## Renderer, bundled at build time (`devDependencies`)

Vite bundles these into `dist/renderer`, and neither the main process nor the preload loads
them at run time, so they are `devDependencies`: electron-builder copies only `dependencies`
into the packaged app, and a copy there would be about 30 MB that nothing reads. A package
the main process starts to import belongs back under Runtime.

### `@codemirror/autocomplete`, `@codemirror/commands`, `@codemirror/lang-css`, `@codemirror/lang-html`, `@codemirror/lang-javascript`, `@codemirror/lang-markdown`, `@codemirror/language`, `@codemirror/search`, `@codemirror/state`, `@codemirror/view`, `codemirror`

**Does:** the code editor panels (source, CSS, frontmatter). **Why not the platform:** a
`<textarea>` has no syntax model, incremental parsing, or transactions. **Cost:** the largest
renderer dependency family; split per language so only what is used ships.

### `@sanity/icons`

**Does:** draws the icon a site's Sanity schema gives each document type (`icon: UserIcon`) in
the CMS panel's collection list, reference rows and image-less list rows
(`src/features/cms/SanityTypeIcon.tsx`), so a connected Sanity reads as its own Studio does.
**Why not the platform:** the icons are Sanity's own drawings; the schema names them, it does not
contain them, and redrawing them by hand would drift. **Cost:** MIT, no dependencies of its own
(React is a peer); a 12 KB index whose icons each load lazily, so only the icons a schema names
are ever fetched. Pinned to the version Sanity Studio ships with.

### `@shikijs/core`, `@shikijs/engine-javascript`, `@shikijs/langs`, `@shikijs/themes`

**Does:** read-only Astro highlighting (`src/ui/astroHighlight.ts`) matching Astro's own output.
**Why not the platform:** TextMate grammars need an engine; the JavaScript engine avoids WASM.
**Cost:** grammar and theme payloads; imported per language.

### `@uiw/react-codemirror`

**Does:** the React binding for CodeMirror. **Why not the platform:** lifecycle glue between React
state and CodeMirror transactions. **Cost:** thin wrapper; replaceable by a local hook if it lags.

### `@xterm/addon-fit`, `@xterm/xterm`

**Does:** the integrated terminal renderer. **Why not the platform:** no terminal emulator exists in
the browser. **Cost:** renderer weight; paired with `node-pty`.

### `known-css-properties`

**Does:** the list of valid CSS property names for the style panel. **Why not the platform:**
`CSS.supports` answers per value, not "list every property", and differs by engine. **Cost:** a
data file; no code.

### `react`, `react-dom`

**Does:** the renderer UI. **Why not the platform:** the whole UI is built on it. **Cost:** the
framework choice; pinned to the 18 line.

## Development (`devDependencies`)

### `@astrojs/compiler-rs`

**Does:** the Astro 7+ compiler, exercised by tests that pin behavior across both compilers. **Why
not the platform:** as for `@astrojs/compiler`. **Cost:** native binary; tests only.

### `@types/node`, `@types/react`, `@types/react-dom`

**Does:** type declarations for Node and React. **Why not the platform:** neither ships its own
types. **Cost:** none at runtime.

### `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/utils`

**Does:** type-aware lint rules and the TypeScript parser for ESLint; `scripts/eslintPlugin/`
builds on the AST and rule types from `utils` (type-only imports, same release line as the
parser, so the node shapes the rules see are the ones they were written against). **Why not the platform:** `tsc` has no policy rules (no-unsafe-*,
exhaustiveness). **Cost:** lint time; about 80 s for a full run.

### `@typescript-eslint/rule-tester`

**Does:** runs the local plugin's rule tests (`test/scripts/eslintPlugin/eslintPlugin.test.ts`) under
`node:test`. **Why not the platform:** ESLint's own `RuleTester` is typed for ESLint's rule shape,
not typescript-eslint's, so the tests would need type assertions (AGENTS.md non-negotiable 2).
**Cost:** tests only; same release line as the parser.

### `@vitejs/plugin-react`

**Does:** JSX transform and fast refresh for Vite. **Why not the platform:** browsers do not run
JSX. **Cost:** build-time only.

### `concurrently`, `wait-on`

**Does:** the `dev` script: runs Vite and Electron together, and waits for the dev server port.
**Why not the platform:** npm scripts have no cross-platform process orchestration. **Cost:**
dev-only; candidates to fold into one TypeScript script, as the dev server URL already was
(`scripts/build/devElectron.ts`).

### `electron`

**Does:** the application runtime. **Why not the platform:** it is the platform. **Cost:** large
download; version pins the Chromium and Node the app ships with.

### `electron-builder`

**Does:** packages, signs, and notarizes releases. **Why not the platform:** Electron ships no
packager. **Cost:** large tree; release-time only.

Pinned to 26.15.3 to fix the AppImage search-path vulnerability
[GHSA-7g7r-gx96-252g](https://github.com/advisories/GHSA-7g7r-gx96-252g).
The signing password backport still applies to this upstream version; exact source hashes and
real signing-function regression tests protect it. Separate Apple Silicon and Intel Mac builds
avoid recompressing both Electron architectures when a code signature changes. Each package's
node-pty bindings and executable helper are verified for its target CPU before signing.

The build-time `@electron/get` dependency overrides `global-agent` to 4.1.3. Its compatible
`bootstrap` API preserves proxy downloads while removing the obsolete logging dependency that
pulls in vulnerable `sprintf-js`. This override adds no application runtime dependency.

### `esbuild`

**Does:** bundles the two runtime scripts that cannot load modules — the sandboxed preload
(`electron/preload/`, whose `require` reaches only `electron`) and the canvas's morph client
(`electron/previewClient/`, served as one virtual module's text) — each into one file
(`scripts/build/bundleClients.ts`); tests bundle source modules with it too. **Why not the
platform:** `tsc` emits one file per module and does not bundle. **Cost:** none new: it is the
copy Vite already installs, pinned to that exact version because a bundler upgrade changes what
ships, which must be a deliberate commit.

### `eslint`

**Does:** the linter (AGENTS.md §17: one linter). **Why not the platform:** `tsc` checks types, not
policy. **Cost:** lint time.

### `eslint-plugin-react-hooks`

**Does:** enforces the rules of hooks and effect dependencies. **Why not the platform:** these are
React invariants the compiler cannot see. **Cost:** small.

### `jsdom`

**Does:** a DOM for renderer tests under Node. **Why not the platform:** Node has no DOM. **Cost:**
large tree; tests only.

### `prettier`

**Does:** the formatter (AGENTS.md §17: one formatter; `printWidth: 160`). **Why not the
platform:** no formatter ships with Node or TypeScript. **Cost:** dependency-free; pinned to an
exact version because a formatter upgrade reformats code, and that must be a deliberate commit.

### `vite`

**Does:** the renderer dev server and production bundler. **Why not the platform:** browsers load
modules but do not bundle, transform TSX, or hot-reload. **Cost:** build-time only.

### `sharp`

**Does:** bounded image decoding, orientation, resizing, WebP and AVIF encoding.
**Why not the platform:** Node has no image encoder and browser canvas does not
promise AVIF output. **Cost:** codec binaries, memory and CPU; jobs are serial,
with pixel, byte and processing-time limits. See `docs/image-conversion.md`.

### `@img/sharp-wasm32`

**Does:** portable sharp codecs, including the Apple Silicon and Intel
Mac apps. **Why not the platform:** a native codec binary cannot run on another
CPU architecture. **Cost:** a bundled WASM codec and its runtime; slower than
native encoding but bounded by the same conversion limits. Bundled licenses
are retained; Mac packages exclude architecture-specific sharp binaries.

## Vendored paths, no package

Copied source with no entry in `package.json`, so nothing is installed or updated by npm.

**Phosphor Icons** (MIT, Copyright (c) 2023 Phosphor Icons, https://phosphoricons.com/,
https://github.com/phosphor-icons/core). **Does:** twelve Regular-weight icon paths from
`@phosphor-icons/core` 2.1.1 (`assets/regular/*.svg`), one of the left rail's icon sets under test
(`src/ui/railIcons.tsx`, chosen in Settings → Editor → Rail icons). **Why not the package:** the
rail needs twelve paths; the package ships thousands of SVGs in six weights. **Cost:** none at run
time; a newer Phosphor drawing is a hand copy, and the file's header keeps the licence and source.

## Evaluated, not adopted

These were weighed and declined; the paragraph says why, so the question is not reopened without new facts.

**axe-core** (MPL-2.0), for the Audits panel's rendered accessibility checks. **Would do:** run its
rule set over the rendered page. **Why not:** it must run inside the audited document with its
scripts, which means executing the page's code in a frame the editor owns; its results name CSS
selectors, which do not map back to the `.astro` source element or to a deterministic fix, so
every result would need a second, hand-written mapping anyway; and most of its rules repeat checks
the static pass already makes on the source with a source location and a fix. The rendered checks
Stacki needs (computed contrast, the final heading outline, names that arrive through slots,
page-wide duplicate ids, the final head) are small, pure functions over a plain tree
(`shared/page/auditRendered.ts`, `shared/page/auditContrast.ts`), tested like the rest of
`shared/`, with no runtime dependency and no third-party code in the renderer. **Cost of
declining:** fewer rule families (for example ARIA attribute-value checks beyond role names);
those can be added as hand-rolled checks one at a time.

## Installed on demand, outside `package.json`

These are not dependencies of Stacki's build: nothing installs them until a person asks the AI chat
panel to connect an agent, and then only into `userData/agents/<agent>-<version>/`. They are recorded
here (as bold entries, not `###` headings, which the gate holds to `package.json`) because they are
third-party code Stacki runs. `electron/handlers/ai/agentRegistry.ts` pins each one: an exact
version, the lockfile Stacki ships in `resources/agents/` with its SHA-256, and the SHA-256 of the
installed entry file. `npm ci --omit=optional --ignore-scripts` verifies every tarball against the
lockfile's integrity; install scripts never run.

**`@agentclientprotocol/claude-agent-acp` 0.105.0.** **Does:** speaks the Agent Client Protocol on
stdio for Claude, by driving the Claude Agent SDK, which runs the person's own `claude` binary
(`CLAUDE_CODE_EXECUTABLE`) with their own sign-in. **Why not the platform:** the agent's session
handling, tools, permissions and streaming live in Anthropic's SDK; reimplementing them would mean
reimplementing Claude Code. Stacki's side, the ACP client, is hand-written (`shared/properties/ai/acpWire.ts`).
**Cost:** about 75 MB on disk once connected (the SDK's own platform binary is left out); a new
version is a deliberate pin bump. Runs as Electron-as-Node, so no Node install is needed.

**`@agentclientprotocol/codex-acp` 2.6.0.** **Does:** the same for Codex, driving the person's own
`codex` CLI (`CODEX_PATH`, signed in with `codex login`). **Why not the platform:** as above, for
OpenAI's app server protocol. **Cost:** about 21 MB on disk; the bundled Codex binary is left out.

`@agentclientprotocol/sdk` (the protocol's reference library) is not used at run time. Its
`schema.json` was the reference for the hand-written parsers and the recorded fixtures in
`test/fixtures/ai/acpTrace.jsonl`.
