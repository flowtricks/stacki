# Stacki Studio

An open-source visual CMS for Astro, with a studio at `/studio`. The editor is assembled from Stacki's canonical MIT-licensed source, with browser and Cloudflare host adapters. See [the attribution](vendor/stacki/PROVENANCE.md).

All authored application code, scripts, and tests are TypeScript. Features live together under `src/features`; the app composes them, and the server and Cloudflare Worker handle transport. Strict compiler checks, ESLint, formatting, and regression tests enforce the project rules in [AGENTS.md](AGENTS.md).

## Run locally

In Stacki desktop, adding Studio starts it with the website preview. Open the main
website's localhost address followed by `/studio`. This mode edits the original
website files directly, shows **Local files**, and needs no Cloudflare setup or
Publish action. Stacki keeps the terminal closed and stops Studio with the preview.

The standalone command below is useful for testing an isolated draft or hosting setup.

Requires Node 22.19+ and npm. This CMS lives in the Astro project’s `studio/` directory. The website’s `src/`, `public/`, and Astro configuration remain at the project root; all CMS source, tools, deployment configuration, dependencies, and local drafts live here.

```sh
# From the Astro project root:
npm ci
npm --prefix studio ci
npm --prefix studio run dev
```

In an installed release, `npm run dev` from `studio/` opens the parent Astro project. In the canonical Stacki repository, it opens the fixed test fixture instead.

Open <http://localhost:4350/studio>. The editable copy lives in `studio/.studio/workspace` relative to the website root. Local development trusts loopback requests; GitHub login is enforced by the hosted Worker.

Stacki's interface sound effects are enabled by default. Open the logo menu and
toggle **Sound effects** to mute them. This browser remembers the preference and
shares it between Studio tabs. The role menu uses Phosphor's regular paint-brush
and user-circle icons (MIT; see `vendor/phosphor/LICENSE`).

Open the logo menu → **Project settings** to configure each component's initial
props, literal text, and ordered children. Desktop exposes the same editor in
**File → Settings**. These insertion presets live in `.stacki/components.json`
at the website root and apply when adding new instances.

Column guide controls save automatically to `.stacki/guide.json`, including their
CSS variable connections. Existing browser preferences migrate when that file
is absent. Commit both files to share settings between Desktop and hosted Studio;
hosted drafts include them when publishing. `.stacki/preview/` remains local.

After moving or renaming an Astro component, update its owner key and child
references in `components.json`, or use **Relink a moved or renamed component**
in Project settings. Run `node studio/dist/cli.mjs check-project .` from the
website root to check references and guide settings. No Stacki markup is needed
in component files.

The titlebar play icon opens Stacki's interactive preview across the full workspace.
Click it again or press Escape to return to editing. Links work normally, and the
editor follows the page you browsed to when you exit; the design canvas keeps its
breakpoint and size. Preview still requires the authenticated draft session.

In the code editor, Tab indents the current line or selected lines by two spaces;
Shift+Tab outdents. Press Escape followed by Tab to move focus out of the editor.
The direct `@codemirror/commands` dependency supplies the standard indentation commands.

While editing a component, open **Properties** in the left rail (shortcut **K**)
to manage its prop declarations with Stacki's controls: types, defaults, tooltips,
required/readonly flags, option lists, and ordering. Renames update supported
instances across the draft; undo/redo checks every affected source revision.
Returning to a page hides the component-only panel.

To open another existing Astro project after building:

```sh
STUDIO_WORKSPACE=.studio/my-site node dist/cli.mjs dev /absolute/path/to/site
```

The runner supports `astro.config.ts`, `.mts`, `.cts`, `.js`, `.mjs`, or `.cjs`, and projects without a config. The project should use npm and have a lockfile; the runner reuses installed dependencies when available. Tested with Astro 7.3.8. Other major versions and package managers are not yet certified.

## Available in this implementation

- Stacki-based dark editor shell with pages, navigator, components, assets, collections, AI, and settings.
- Stacki navigator, component palette, props, rich text, code and Style panels. Drag rows or components to reorder/nest, including touch dragging; double-click components to edit their source in the current page preview. Exact Stacki hover/selection outlines, icons, spacing highlights, prop dropdown hover previews, and responsive/multiple-breakpoint canvases.
- Props inferred from Astro source, including imported local types, variants, defaults, class suggestions, expression controls, and literal object/list fields. No per-component CMS schema registration.
- Yjs merged text editing, project-wide collaborator presence, live named cursors with matching selection colors, profile pictures, and avatar navigation to a collaborator’s page and element. Your own outlines keep Stacki’s normal colors. Press `/` in the preview or choose **Cursor chat** to type a live message beside your cursor. The message follows your pointer and stays until you erase all its text with Backspace; Enter and Escape finish typing without clearing it. Everyone can select elements and insert children. Settings stay read-only while another editor owns the element; **Take over** in the inspector transfers editing access while keeping both selections. Per-editor text/layout/style undo, persistent draft identities, reconnection, and browser IndexedDB recovery of pending edits.
- Immediate previews for literal text edits, reconciled with server-rendered Astro. A live iframe preview using Stacki DOM morphing. Ordinary prop/text/layout changes do not navigate the page. Astro still renders the affected preview and compiles invalidated modules; script changes or failed morphs may reload for correctness.
- Cross-page copy/paste carries required component imports, asset imports, and dependent frontmatter declarations. Relative module paths are rebased for the destination, existing bindings are reused, and a single undo restores both markup and imports. Component insertion recognizes alias and relative imports of the same file.
- JSON and Markdown/frontmatter collection fields, nested values, and draggable lists. Files remain in the project.
- Shared draft asset uploads, copied into the GitHub publish snapshot.
- GitHub source updates arrive automatically every 15 seconds while editors are connected. Three-way merges preserve draft edits on conflicting lines and bring in unrelated GitHub changes. Runtime/dependency and binary changes still require a fresh container revision.
- Publish refreshes GitHub first, validates a captured snapshot using the site's build script, then commits to the configured branch. A confirmed competing commit triggers a fresh merge/build (at most three attempts); uncertain network failures are not retried. Everyone sees the same progress, including after reconnecting. Connect the branch to your Cloudflare build/deploy pipeline.
- Codex-style AI panel with saved parallel chats, per-chat model selection, browser dictation, image upload/paste/drop, and stop controls. Configurable OpenAI-compatible service with bounded context, reviewable replacements, stale-edit checks, and an explicit apply action. See [AI chat configuration](docs/ai-chat.md).
- Cloudflare Worker/GitHub login, repository collaborator access, verified GitHub profile pictures, an account/sign-out menu, an isolated preview host, a single shared Container, and R2 persistence for draft recovery.

## Privacy

Studio sends no usage tracking. It has no analytics, no usage counter and no background
update service, and it turns off the usage reporting of the tools it starts: Astro, Wrangler
and Vercel's CLI. `scripts/noTracking.ts` checks this in the tests and before each release.

Studio still contacts third parties to do what you ask of it:

- GitHub, Sanity, Cloudflare, Vercel and your AI provider, when you connect them.
- GitHub profile pictures, for people signed in to a hosted Studio.
- YouTube, Vimeo, Loom, Wistia or Dailymotion, when you link one of their videos in a CMS
  field and Studio fetches its preview.
- GitHub's release feed, when you check for a Studio update.
- Your browser's speech service, if you use dictation in the AI panel.

Your website's own code, scripts and embeds also run in the preview and make their own
requests. A `wrangler deploy` you run yourself is covered in the
[deployment guide](docs/cloudflare.md).

## Install and update

Studio is distributed as a versioned source bundle alongside Stacki desktop releases.
It has not been published to npm. See [releases and updates](docs/releases.md) for
installation, project version pinning, customization replacement, and recovery.
For Cloudflare, read [the deployment guide](docs/cloudflare.md).

## Verification

In the canonical Stacki repository, run these commands from `studio/`. Unit and
browser tests use `test/fixtures/site`, never a customer's website.

```sh
npm ci
npm --prefix test/fixtures/site ci --ignore-scripts
npm run verify
npm run dev
npm run test:browser
```

The browser suite uses installed Chrome on macOS or Playwright Chromium elsewhere
(`npx playwright install chromium`). Set `CHROME_PATH` for another installation,
and `STUDIO_URL` to override the local address. It exercises two independent browser
sessions, preview morphing, drag sorting and undo, class suggestions, and mobile
layout. Screenshots go into `test-results/`.

Installed source releases include build and type checks; the full development test
suite stays in the canonical repository. Cloudflare deployment, GitHub authorization,
and release publishing still require verification in the destination account.

### Project insertion defaults

Project settings lists components with insertion defaults. Choose Add or Edit to open one
component inside the selected layout, then use the normal canvas, navigator, and inspector
to set its props, text, and children. Save defaults updates `.stacki/components.json` for
Desktop and Studio; existing page instances stay as they are. Defaults support literal
values, native HTML children, and nested components. Grid guide settings are stored in
`.stacki/guide.json`. Both files travel with the project. Temporary editing pages under
`.stacki/canvas/` are excluded from publication.
