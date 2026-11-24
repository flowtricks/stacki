# Releasing Desktop, Studio, and create-stacki

> Releasing is `npm run release:ship -- --confirm`; [release-runbook.md](./release-runbook.md) has the
> stages and what to do when one stops, [release-speed.md](./release-speed.md) the design and its
> measurements. This file is the history and rules reference.

These are separate publication paths. A successful `Check` run publishes nothing:

- While the version on `main` is unreleased, every push starts `.github/workflows/candidate.yml`:
  Desktop installers (signed, notarized), Linux install checks and the Studio browser test, kept as
  that run's artifacts. A version tag starts `.github/workflows/release.yml`, which publishes exactly
  those files, and only when Check and the candidate are green on the tag's commit.
- `.github/workflows/publish-create-stacki.yml` is dispatched from the same tested tag by
  `.github/workflows/release-post.yml` once the desktop release is public.
  See [create-stacki publication](./create-stacki.md) for authentication and registry verification.

Run the fast checks and complete regression suite locally before pushing. Also run Studio's
`npm run verify` and `npm run test:browser` against a disposable fixture workspace before tagging:
the Desktop regression gate does not run that separate Studio browser scenario.

Pushing a version tag runs the Linux preflight automatically: the `pre-push` hook runs it after the
full gate has rebuilt `dist/`, and a failure stops the tag reaching GitHub, so no release build
starts. The release scripts push the bump commit and the tag in one atomic push, so after a failure
neither reached GitHub and the tag exists only locally: fix the finding, delete the local tag, and
run again; never move a pushed tag. Run `npm run check:linux` by hand (about 30 seconds) to find problems before
tagging. It checks, on a Mac, the ways the Linux release job has failed:

- relative imports and package or workflow paths match their files' case exactly (macOS ignores
  case, Linux does not), and no two tracked paths differ only in case;
- files run directly are executable in git, and every `#!` line works under Linux's `env`;
- no test names a git-ignored file that a clean checkout lacks (the 1.0.4 failure);
- both lockfiles hold every platform's dependencies (`npm ci` refused them in 0.1.52);
- electron-builder's Linux settings, icon and targets are valid, and the deb's maintainer script
  renders from the builder template and parses as shell;
- every suite that opens an Electron window passes with animation frames delayed 200 ms and CSS
  motion at quarter speed (`scripts/release/linuxSlowMotion.ts`). That is the hidden window on the
  slower runner: it reproduced the 1.0.11 sourceMenu failure to the pixel, and most Linux release
  failures have been probes that measured before a popup, scroll or hover finished moving. A
  warning lists probes that measure after a fixed sleep without waiting for the motion.

By hand, it runs the probes from the existing build, so run it after the regression suite. `--static`
skips the probes, `--repeat=3` runs them three times, and `--only=<name>` narrows them. What it
cannot reproduce stays with the Linux job: xvfb's GPU and capture paths (`thumbs`), inotify watcher
timing in Studio, the packaged deb and AppImage installs, and native module builds.

Use an isolated checkout when other tasks are editing the working directory. Match the root,
Studio, Studio release manifest, and npm starter versions. Never move an existing release tag to
include later changes.

## 1.4.18

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.18.
- **Features**
  - audits: flag px on by default; shorten the hidden-by-folder note
  - welcome: open a project by dropping its folder on Stacki
  - rail: right-clicking a rail icon opens nothing
  - audits: custom audits model, regex guard and bounded matcher
  - audits: add, edit and test custom audits from the Audits panel
  - cli: stacki audits list, presets, add, update, remove and test
- **Fixes**
  - preview: canvas frames keep the breakpoint's whole width
  - preview: Desktop's outlines and guides sit on the page again
  - publish: Save names the empty required field in a toast, marks it
  - cms: read content configs with rolldown on Astro 7 projects
  - preview: reload when a page script sized the variant being switched
  - studio: sign-in wait is a button countdown, limits name their step
  - ui: the (i) tip no longer shows the native title over it
  - ai: Running panel is opaque, stale agents stop ticking, Stop all
  - publish: Add Worker sets the site up so Publish works at once
  - publish: Connect Cloudflare installs what it needs in one click
  - audits: placeholder findings sit on their copy; Ignore is one click
  - audits: Broken link sees links from components, props and slots
  - code-chips: chip references in --_private custom property values
  - audits: list every raw value, open it at its line, unit settings
  - preview: one canvas scrollbar, no setting; every frame gets it
  - navigation: audit jumps replace the open component, not stack it
  - cli: the audits registry covers tokens.sizes and allowedUnits
- **Maintenance**
  - dictation: red remove action, accessible quality cards

## 1.4.17

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.17.
- **Features**
  - phone preview over the LAN, Dictation tab, Astro copy
  - ai: designer-friendly tool cards and a Running agents panel
- **Fixes**
  - preview: hover and pick by stacking order; one label; morph holds
  - ui: Settings and dialogs tell problems as toasts, not paragraphs
  - props: Props panel tells problems as toasts, not paragraphs
  - style: Style and Insert tell problems as toasts and tooltips
  - ui: Pages, CMS, Git, Apps and the rest tell problems as toasts

## 1.4.16

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.16.
- **Features**
  - ai: screenshots capture canvas outlines and the hover pin
  - ai: recording keeps its scrim; scrubber triangle; 16 frames
  - ai: show thumbnails of the screenshots a message sent
  - style: hover a variable in the picker to preview it on the canvas
- **Fixes**
  - settings: Settings no longer crashes before the AI panel opens
  - preview: one owner per outline on closed components and text
  - preview: place the caret on a heading's empty-corner double click
  - preview: morph moved and removed nodes; log why a page reloads
  - navigator: show the drop refusal as a toast and tooltip
  - code: the style and code editor window stays open
  - style: Enter keeps the focus in Style and Props inputs
  - style: the easing popup is as wide as its field
  - style: the CSS variable chooser reads the property correctly

## 1.4.15

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.15.
- **Features**
  - ai: redesign the subagent overview, flush-left command rows
  - props: loop settings for destructured .map(({ data }) => heads
  - preview: show prop-bound text inside loop cards on the canvas
- **Fixes**
  - preview: let the Desktop canvas fill its pane
  - navigator: no chip on expression text rows; Image icon stays green
  - preview: outline pseudo-state targets on components and text marks
  - preview: keep focus in a canvas text editor after it opens
  - preview: prop edits morph the page instead of reloading it

## 1.4.14

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.14.
- **Fixes**
  - preview: fall back to an OS port when all probed ports are reserved

## 1.4.13

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.13.
- **Fixes**
  - studio: keep every demo file within stacki.build's 20 MB bound

## 1.4.12

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.12.
- **Features**
  - voice: pure core for dictation: cleanup, dictionary, commands, session, waveform
  - ai: voice input in the chat box: hold to talk, hands-free, live waveform, cleanup, commands
  - update: redesign the up-to-date popup, no outline or divider
  - ai: see each subagent at work and open its own transcript
  - i18n: thirteen more languages, Arabic and Hebrew right to left
  - voice: on-device Whisper dictation with model download
  - ai: screenshots and screen recording in the composer
  - ai: composer, mentions, sessions and project agents
  - studio: upgrade an installed Studio and show its status
  - cms: file fields and constants in CMS settings
  - style: CSS value chips in the code editor
  - app: Add elements panel, rail in Settings, roles cache and fixes
  - i18n: catalogs for the new features in every language
- **Fixes**
  - preview: cmd+R in the canvas refreshes the site, not Stacki
  - i18n: the rail tooltip's shortcut keeps its gap in right to left
  - studio: add, delete and reorder show before a slow render lands
- **Documentation**
  - voice: competitor research for voice dictation (Wispr Flow and rivals)

## 1.4.11

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.11.
- **Features**
  - studio: one status row and a determinate bar on the boot screen
  - studio-setup: colour shell commands in the install output
  - rail: show the icon order reset only when the order is not default
  - update: in-app popup with live download progress
- **Fixes**
  - studio: preview frames address the editor by its origin tag
  - studio: restore the stuck-canvas report and preview-host log
  - studio: a ready hosted frame clears the loader; Retry starts over
  - pages: folder management follows the project's srcDir
  - studio: the page comparison takes its base from the caller

## 1.4.10

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.10.
- **Features**
  - security: a Content Security Policy for the main window
- **Fixes**
  - studio: the preview cookie is allowed in a cross-site frame
  - style: keep the source menu's search field inside its frame
  - publish: a stuck temp directory no longer fails a publish
  - roles: Desktop previews roles and never enforces them

## 1.4.9

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.9.
- **Features**
  - assets: list each asset file's modified time
  - editor: one drop model for canvas and Navigator drags
  - canvas: drag elements on the canvas with live drop lines
  - assets: grid, list and compact views, and a sort, in Assets
  - navigator: mirror canvas drags live in the Navigator
  - pages: plan and write page settings steps atomically
  - pages: a Page settings dialog replaces the rename pencil
  - pages: move a page between folders from Page settings
  - canvas: a hovered slot reads muted, with its reason on hover
  - studio: the save status names why it needs attention
  - cms: repeaters: a list's items are values or groups of fields
  - canvas: text a component draws from a prop is editable
  - ai-panel: render replies as real Markdown, options as buttons, a labelled mode control
  - ai-panel: AI changes apply at once; "Ask me to keep AI changes" brings Keep back
  - assets: search bar in the Assets panel, shared with Components
  - instructions: search bar in the Instructions panel
  - navigator: search bar in the Navigator
  - preview: address-bar loading line replaces "Loading page" text
  - navigator: search reads .class, #id, [attr], <tag>, /* comments
  - audits: Find & replace is a compact card that holds at 260px
  - canvas: prop text hovers before its component is selected
  - navigator: choosing a search result ends the search
  - studio: boot screen and canvas name the container start stage
  - canvas: trace an image src and alt text to the props feeding them
  - canvas: double-click an image to edit picture and alt in a popup
  - canvas: every closed component's text hovers, picks in one click
  - canvas: one state machine for text inside closed components
  - studio: Settings panel in the hosted rail, on Desktop's frame
  - studio: canvas loader names the handshake step it waits on
  - ui: the busy cover holds the window while work runs
  - palette: Create component can move the markup's styles with it
  - studio: frame reports its own load errors to the loader
  - palette: Move styles starts with every class unchecked
  - palette: Move styles list scrolls, cut at five and a half rows
  - navigator: search finds text content, string props and attributes
  - roles: provider-qualified identities for roles.json members
  - i18n: neutral sign-in copy for a non-GitHub provider
  - studio: authentication-provider interface, GitHub as the default
  - cms: a group's and a repeater's fields carry the settings a field has
  - cms: configure a group's fields and a list item's fields with icons
  - selectors: remember the Style selectors tab per project
  - studio: container and editor follow the qualified identity
  - studio: the build installs studio/cloudflare/auth-provider.ts
  - style: new style locations model, store and writers per scope
  - settings: New style locations tab with icons and search
  - ui: a Dropdown row that makes a new option in place
  - pages: Select mode deletes several pages as one undo step
  - pages: Page settings moves pages with a confirm beside the field
  - pages: wire Select mode into the Pages panel and Desktop shell
  - settings: Settings lists Secrets, MCP and Instructions views
  - pages: confirm the homepage swap in a popover by its button
  - rail: drag rail icons into any order, kept per person
  - studio-auth: built-in provider config, policy, core callback path
  - studio: shared sign-in choices for Studio setup
  - create-stacki: ask how people sign in to Studio
  - studio-auth: Google, SSO (OIDC) and Cloudflare Access providers
  - ui: shared PanelHeader with one set of header tokens
  - settings: chords for AI chat, Secrets, MCP; Back closes the file
  - studio-auth: passkey provider with WebAuthn on Web Crypto
  - desktop: choose Studio's sign-in type when adding Studio
  - studio-auth: AUTH_PROVIDER registry, build slot, check-project
  - studio-auth: name non-GitHub editors in publish commits
  - roles: detail model, mixed group switch, show/hide all
  - studio-auth: first-admin setup page for passkey sites
  - studio: a stuck canvas reports itself to the Worker's log
  - settings: reset the sidebar icon order from Editor settings
  - roles: compact role cards that drill into detail views
  - studio: a real Roles view with provider-aware member invites
  - documents: edit text that spells entities as its characters
  - roles: provider-aware member add; Roles in shared Settings list
  - studio: passkey setup code steps in sign-in setup
- **Fixes**
  - release: deploy stacki.build after npm, and always verify it
  - preview: a self-closing <style /> no longer unstyles the next block
  - pages: no Homepage section or missing-fields note on templates
  - studio: treat GitHub 403 limits as waits, spare GitHub on login
  - canvas: steadier canvas drags; Navigator drags draw on the canvas
  - style: a commit as the first tag lands is not overwritten
  - pages: the Page settings body never scrolls sideways
  - canvas: smooth side-handle resize; Desktop covers the canvas
  - audits: the panel stays whole at every left-panel width
  - style: sections keep their controls across a switch, no skeleton
  - ai-panel: nothing in a reply can widen the message column; Chromium layout test
  - canvas: Card prop text was cut off by a 64-instance cap
  - menu: one outside press closes a menu and its submenu together
  - canvas: text hover survives a click; parent and solid cue
  - canvas: only the owning component reads as the hovered text's field
  - canvas: a Card hovered over selected words is a green hover
  - canvas: image popup opens on linked Card images; compact, draggable
  - canvas: slot hover shows its reason when selected, black 10% fill
  - canvas: slot hover is a muted fill only, black 20%
  - canvas: text under a stretched link is the text hovered and edited
  - canvas: a selected owner keeps its tag while its text is hovered
  - canvas: words over a cover image keep their double click
  - canvas: caret at the click, owner tag kept while editing prop text
  - canvas: clicks inside edited words move the caret, under a link too
  - preview: canvas tag icon for Astro assets follows the tag colour
  - style: list a new component's <style> in "Add custom styles in"
  - palette: name a style move's page with / on Windows too
  - palette: Create component writes each moved @layer once
  - cms: field-type tiles are uniform; List and Group explain in a tooltip
  - studio: drop RemoteListItems from the shared-source list
  - assets: draw thumbnails from small copies, never half-painted
  - palette: Move styles adds no blank line between moved rules
  - studio: list assetThumbnails once, in order; drop a duplicate
  - selectors: a locked stylesheet locks every selector in it
  - pages: show the page's address under Folder without a prefix
  - rail: keep the anchored list last so a failed assert cannot hang
  - menu: end every trailing hint, value and check at one right edge
  - preload: frameReports loads without a window
  - test: CI-only reds on 010980b8 wait for state, not frames or time
  - studio: the AuthProvider check starts the compiler on Windows
  - studio: a refused internal request is read before its 403
  - studio: the test container stub reads a POST before it answers
- **Performance**
  - studio: warm catalog and home page at boot, restore in parallel
  - selectors: load the list 100 rows at a time, 1.5 screens ahead
- **Changes under the hood**
  - panels: every Desktop panel draws its heading with PanelHeader
  - ai: the chat header follows the panel header row
  - studio: Studio panels draw their heading with PanelHeader
  - shared: assert the invariants of Studio sign-in checks
- **Documentation**
  - studio: authentication providers, experimental
  - studio: document choosing a sign-in type
  - studio-auth: built-in providers, config contract, invites
  - studio: passkey setup code, setup page and Roles view invites
- **CI and build**
  - gate: a test-timing scan with an expiring allowlist
  - studio: smaller container image, startup timing doc
- **Maintenance**
  - ai-panel: quieter replies, flat change rows, neutral mode label
  - ai-panel: a 1rem inset for the transcript, composer and footer rows
  - ai-panel: quiet aligned tool rows, one spacing scale, solid jump pill
  - regenerate the app UI kit bundle

## 1.4.8

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.8.
- Style panel: every keyword control (display, position, alignment and the rest) can connect to a variable, and copy and paste keep variable chips as `var()` references.
- Style panel: `=` opens the value editor on the value the field shows; committed and cleared values update in the same frame as the press; the Follow canvas toggle edits Base, and picking a breakpoint moves the canvas to it.
- Delete a component together with its instances and imports, from the palette. Instance counts follow the open page as you edit.
- Preview: the canvas resize handles work in preview mode, number keys switch breakpoints, and the Desktop device draws at its frame width, scaled to fit the pane, wherever no breakpoint applies.
- A new `<style>` tag's rules have no blank lines, and deleting a `<style>` block never shows the error overlay.
- Canvas: a scrubbed Fragment's outline wraps all its children; editing bound text writes back through function calls and parsed YAML; interact-mode link cards keep the page's own modal instead of flashing Stacki's.
- Navigator: pseudo-elements belong only to an HTML element.
- Settings: the Desktop breakpoint input aligns with the other rows.
- Releases are now built once and promoted: installers are built, signed and tested before the tag, and a version is tagged only when every check is green, so a test failure can no longer burn a version number (`npm run release:ship`, docs/release-runbook.md).

## 1.4.7

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.7.
- 1.4.6 was tagged but never published: its release tests failed in the test harness, so 1.4.7 carries everything below plus that fix.
- TypeScript prop manager: create and edit any prop shape, including discriminated unions, with per-option types, tooltips and defaults. Visibility, Default value and Tooltip can be set by conditions (Show, Hide and Required icon buttons, blue set-labels, a `{}` code view), and any prop can control any other.
- Delete a prop across the whole site from a confirm dialog. Component code that still reads it keeps working through a constant, and one Undo restores everything.
- Attributes such as `aria-label`, and class lists, open in the visual conditions UI: If first, Computed in code, a Same-as shortcut and editable Computed parts.
- Every `if` in the Navigator opens as visual condition rows with readable labels.
- New Class list property in the class menu.
- Style panel: a Follow canvas toggle, smarter desktop-first and mobile-first breakpoints, and one mode control per grid axis.
- New selectors default to the page's `<style>` tag. A new Style tags settings tab keeps one locked `<style is:global>` block, with `is:global` as the default.
- Choose the folder when creating a component.
- Paste into another file brings what the markup needs, and every gesture is pre-flighted.
- The canvas recovers from an error page by itself. Zero-size elements get a crosshair and a tag.
- Stylesheet locks are shown explicitly when selector usage is uncertain.
- Page chooser rows keep their icon; CMS rows use the CMS icon and the Pages panel purple.
- The Secrets tab edits each dev env file, and Stacki suggests the Sanity project a site's config files name and says when a site uses Sanity without a Sanity connection (PRs #86 and #87 by Sylvain Druaux).
- The easing editor works for long curves.
- A Label placeholder follows the variant's default, and a Card's `theme` and other inherited props show in the props panel.
- Hover previews on variant dropdowns work in projects that use the Cloudflare adapter.
- While editing text, the source tag shows only during the edit, below the element, and the element's top tag hides.
- The breakpoint dropdown shows the canvas device icon.
- CLI and MCP: `stacki breakpoints sync --value` works, `doctor` exits non-zero on errors, every command has its own `--help`, MCP sends tool-list notifications, and there is no default admin when roles exist.
- Fixes: one drag no longer writes duplicate `<style>` tags, stale selector chips no longer flicker, every scroll container keeps a stable scrollbar gutter, tests use less memory, and the canvas outline is faster in big loops.
- Release tests: the soak driver presses the canvas, never a palette component picture loaded from the same dev server.

## 1.4.6

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.6.
- TypeScript prop manager: create and edit any prop shape, including discriminated unions, with per-option types, tooltips and defaults. Visibility, Default value and Tooltip can be set by conditions (Show, Hide and Required icon buttons, blue set-labels, a `{}` code view), and any prop can control any other.
- Delete a prop across the whole site from a confirm dialog. Component code that still reads it keeps working through a constant, and one Undo restores everything.
- Attributes such as `aria-label`, and class lists, open in the visual conditions UI: If first, Computed in code, a Same-as shortcut and editable Computed parts.
- Every `if` in the Navigator opens as visual condition rows with readable labels.
- New Class list property in the class menu.
- Style panel: a Follow canvas toggle, smarter desktop-first and mobile-first breakpoints, and one mode control per grid axis.
- New selectors default to the page's `<style>` tag. A new Style tags settings tab keeps one locked `<style is:global>` block, with `is:global` as the default.
- Choose the folder when creating a component.
- Paste into another file brings what the markup needs, and every gesture is pre-flighted.
- The canvas recovers from an error page by itself. Zero-size elements get a crosshair and a tag.
- Stylesheet locks are shown explicitly when selector usage is uncertain.
- Page chooser rows keep their icon; CMS rows use the CMS icon and the Pages panel purple.
- The Secrets tab edits each dev env file, and Stacki suggests the Sanity project a site's config files name and says when a site uses Sanity without a Sanity connection (PRs #86 and #87 by Sylvain Druaux).
- The easing editor works for long curves.
- A Label placeholder follows the variant's default, and a Card's `theme` and other inherited props show in the props panel.
- Hover previews on variant dropdowns work in projects that use the Cloudflare adapter.
- While editing text, the source tag shows only during the edit, below the element, and the element's top tag hides.
- The breakpoint dropdown shows the canvas device icon.
- CLI and MCP: `stacki breakpoints sync --value` works, `doctor` exits non-zero on errors, every command has its own `--help`, MCP sends tool-list notifications, and there is no default admin when roles exist.
- Fixes: one drag no longer writes duplicate `<style>` tags, stale selector chips no longer flicker, every scroll container keeps a stable scrollbar gutter, tests use less memory, and the canvas outline is faster in big loops.

## 1.4.5

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.5.
- The same app as 1.4.4, which never became public: its release run failed in the test stage
  (`renderer/style/selectionPureRead`: the soak test's Vite server scanned `studio/demo/index.html`
  on a cold cache and the page never loaded). The test server now scans only the renderer entry.
  Everything below ships here, with the changes since 1.4.3.
- **Breakpoints**: breakpoints are set per project and live in `.stacki/breakpoints.json`, shared by
  Desktop and Studio. A Laptop breakpoint joins Tablet and Phone, you can add and remove your own
  (wider than Desktop too), and Desktop's frame width is configurable. Each card shows where its
  breakpoint is used (CSS files, style tags, components), and changing one can update the matching
  media queries across the project, with a preview of every place before anything is written.
- **Style panel follows the canvas**: the edit target follows the canvas width by default and
  holds a chosen query for the session. The query dropdown is flat and compact, one section header
  per group, fits a typical list without scrolling, and scrolls like a menu when it is longer. Add
  query suggests the project's breakpoints.
- **Class expressions**: `class:list` and other class expressions are read with a real parser, so
  Delete on a chip removes a class written inside `class:list` and the keyboard keeps going.
- **Variables**: an eye over each value hides it from suggestions. Suggestions follow the grammar
  slot at the caret, and search ranks by name first.
- **EmDash**: add EmDash to the open project from a dialog; it shows as a button in the CMS row
  with a status popup, and it no longer blanks the canvas.
- **Publishing**: choose the owner (your account or an organization) when creating a new repository.
- **Startup**: the first frame is the real app, drawn from a boot snapshot, and the window reopens
  at its last size, place and mode.
- **Fixes**: hovering in the Style panel never writes a file; undo after an inline style edit keeps
  the undo; switching elements paints in one step; a late canvas click never closes a new picker;
  inserting a Grid selects the Grid; typed spaces in value fields stay spaces; Claude Code and Codex
  are found on a Windows Path; blue buttons stay blue on hover and pressed; the German "Details"
  label is marked as the same word as English.
- **Studio**: hosted app frame files load through signed links, Git checkpoints are stored in R2,
  and a private repository can be published from a blobless workspace.
- **Release tooling**: the release is prepared by script, `Check` runs in shards, and the push gate
  skips only trees already proven. Several tests were made reliable on all three platforms.

## 1.4.4

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.4.
- **Breakpoints**: breakpoints are set per project and live in `.stacki/breakpoints.json`, shared by
  Desktop and Studio. A Laptop breakpoint joins Tablet and Phone, you can add and remove your own
  (wider than Desktop too), and Desktop's frame width is configurable. Each card shows where its
  breakpoint is used (CSS files, style tags, components), and changing one can update the matching
  media queries across the project, with a preview of every place before anything is written.
- **Style panel follows the canvas**: the edit target follows the canvas width by default and
  holds a chosen query for the session. The query dropdown is flat and compact, one section header
  per group, fits a typical list without scrolling, and scrolls like a menu when it is longer. Add
  query suggests the project's breakpoints.
- **Class expressions**: `class:list` and other class expressions are read with a real parser, so
  Delete on a chip removes a class written inside `class:list` and the keyboard keeps going.
- **Variables**: an eye over each value hides it from suggestions. Suggestions follow the grammar
  slot at the caret, and search ranks by name first.
- **EmDash**: add EmDash to the open project from a dialog; it shows as a button in the CMS row
  with a status popup, and it no longer blanks the canvas.
- **Publishing**: choose the owner (your account or an organization) when creating a new repository.
- **Startup**: the first frame is the real app, drawn from a boot snapshot, and the window reopens
  at its last size, place and mode.
- **Fixes**: hovering in the Style panel never writes a file; undo after an inline style edit keeps
  the undo; switching elements paints in one step; a late canvas click never closes a new picker;
  inserting a Grid selects the Grid; typed spaces in value fields stay spaces; Claude Code and Codex
  are found on a Windows Path; blue buttons stay blue on hover and pressed; the German "Details"
  label is marked as the same word as English.
- **Studio**: hosted app frame files load through signed links, Git checkpoints are stored in R2,
  and a private repository can be published from a blobless workspace.
- **Release tooling**: the release is prepared by script, `Check` runs in shards, and the push gate
  skips only trees already proven. Several tests were made reliable on all three platforms.

## 1.4.3 Variable picker overhaul, hidden variables, faster style panel

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.3.
- **Variable picker**: variables are offered by whether they fit the property's slot, and the
  Weight, Font, line height, letter spacing and text transform pickers filter by computed value.
  Suggestions are grouped, with view options and local and computed values; each row shows the
  declaration written for the element. Hovering a variable previews it live on the canvas, a
  dismissed picker always puts the original value back, and the popover is capped at 18rem in
  every host with more room and a clearer hierarchy between rows.
- **Hidden variables**: a variable can be hidden from picker suggestions (the applied one still
  shows). The choice lives in the new tracked file `.stacki/variables.json`
  (`{ "version": 1, "hiddenFromSuggestions": ["--name"] }`), shared by Desktop and Studio.
- **Query dropdown**: the context dropdown groups its queries by where each is written, and Base
  lands the canvas where Base is in effect for the project's convention.
- **Style panel speed**: dropdown hover and label reset answer instantly, switching element paints
  in one step, placeholders (not plain fields) hold the place while an element loads, and the
  panel keeps its lists when a re-render brings the same ones.
- **Fixes**: undo steps and a cleared segment bar's chip, a popover closes on scroll only when its
  anchor moved, and the title bar's Play button is as tall as Publish.
- **Icons**: a reset arrow for Clear and a pie chart for percentage variables (Central).
- **CI**: GitHub Actions moved off Node 20 to the Node 24 majors (checkout v6, setup-node v6,
  cache v5, upload-artifact v6, download-artifact v7). 1.4.3 is the first release built with them.
- Tests: the marked-row check in `renderer/variables/variableCellArrows` reads the row's binding
  (rows now show a label and the written value). `studio/test/demoAssetMap` retries folder removal
  after Windows `EBUSY`, and `renderer/apps/appUiKitTooltip` waits, within a bound, for Escape to
  hide the popup, the two 1.4.2 release-run flakes.

## 1.4.2 the 1.4.0 changes, through the Settings hover probe

- The same app as 1.4.0, which never became public. 1.4.1 fixed the Windows `ELECTRON_RUN_AS_NODE`
  probe crash, then failed on Linux (the create-stacki publish's test run) and Windows: the three
  "hovering the (i) shows a tooltip" checks in `renderer/app/settingsLayout` need pointer input that
  xvfb and Windows hidden windows never deliver. They run on macOS only now, as in
  `appUiKitTooltip`; the keyboard-focus check still runs everywhere. No app code changed. Everything
  in the 1.4.0 and 1.4.1 entries ships here; Desktop, the Studio bundle and `create-stacki` are
  aligned at 1.4.2 (`create-stacki` 1.4.0 is on npm; 1.4.1 was never published).
- Lesson: a new probe that moves the pointer belongs in the macOS-only set from the start. Search the
  new tests for `sendInputEvent` before tagging.

## 1.4.1 the 1.4.0 changes, through Windows

- The same app as 1.4.0, which never became public: Linux, macOS and Studio's browser test passed,
  but the Windows job failed two new Electron probes (`renderer/app/settingsLayout` and
  `renderer/publishing/branchChipLook`). They started Electron with `ELECTRON_RUN_AS_NODE` set to an
  empty string, which Windows still counts as set, so Electron ran as plain Node and `app` was
  undefined. Both now delete the variable. No app code changed. Everything in the 1.4.0 entry ships
  here; Desktop, the Studio bundle and `create-stacki` are aligned at 1.4.1 (`create-stacki` 1.4.0 was
  published with the same Studio at the old version).
- Lesson: never set a spawned Electron's `ELECTRON_RUN_AS_NODE` to `''`; delete the key
  (`grep -rn "ELECTRON_RUN_AS_NODE: ''" test`).

## 1.4.0 Full translations, Payload CMS, git branch chip and faster first open

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.0.
- **Languages**: the catalogs for Spanish, French, German and Brazilian Portuguese now cover the
  interface, not a part of it, and are split into one file per feature under
  `shared/properties/i18n/messages/<locale>/`. Menus and many error messages follow the Language
  setting. The policy scan's `layout-unique` rule exempts these folders because each language
  repeats the same file names (approved by the maintainer).
- **CMS**: a Payload provider (API-key or email login) browses and edits through the CMS panel and
  saves drafts, tested against a real Payload server (`docs/cms-testing.md`). Custom CMS is still
  not browsable, and Studio cannot browse Payload yet.
- **Git**: a branch chip beside Publish opens the branch switcher, it updates when the AI creates
  or switches branch, and publishing from a non-default branch asks first.
- **First open**: a dark boot screen with a circular spinner paints before any script, and the
  editor shell and Settings load lazily (`docs/startup.md`).
- **AI**: chat settings are remembered, a session pool keeps agents warm for the first message,
  prompt suggestions are turned off, a chat title can come from the agent, and a Settings option
  snapshots before and after each AI change.
- **Settings**: the Instructions tab has an empty state.

## 1.3.0 Settings, Secrets and MCP, audit ignores, languages and AI polish

- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.3.0.
- **Settings panel**: Secrets (`.env` values) and MCP server tabs for the project.
- **Audits**: Raw values are editable in place; findings can be ignored per page and restored
  from an Ignored filter.
- **Languages**: English, Spanish, French, German and Brazilian Portuguese, with a Language
  setting and a catalog parity check.
- **AI**: Windows Codex install fix, sign-in and microphone fixes, an agent switcher, duplicate
  permission answers dropped, message actions, lighter tool rows and a wider default panel.
- **Editor**: loop-instance outline and create-component frontmatter fixes; Navigator scroll and
  icon fixes; a Skeleton primitive for instant UI.
- `create-stacki` 1.3.0 follows when npm publishing is approved.

## 1.2.2 the 1.2.0 changes, through Windows

- The same app as 1.2.1, which never became public: Linux, macOS and Studio's browser test passed,
  but the Windows job failed. 1.2.1 fixed the first path assertion in the local-excludes ESLint
  test for `\` and left the second one (`notes/bad.js`) matching `/` only. Both now accept either
  separator. Everything in the 1.2.0 and 1.2.1 entries ships here; Desktop, the Studio bundle and
  `create-stacki` are aligned at 1.2.2.
- The Studio source-watch test (`studio/test/sourceWatch.test.ts`) failed twice in the pre-push
  gate under load: macOS replays the events of fixture files written just before the watcher
  starts, and they arrive late. It now writes a sentinel file once the watcher is up and drops
  everything before the sentinel's own event (the stream is ordered), and passed 36 parallel
  runs.
- Lesson: after fixing a platform assertion, search the whole test for the same pattern before
  tagging (`grep -n '\\/' <test>`).

## 1.2.1 the 1.2.0 changes, through Studio's undo and two slow-runner tests

- The same app as 1.2.0, which never became public: Linux passed, but Windows, macOS and Studio's
  browser test failed. Everything in the 1.2.0 entry ships here; Desktop, the Studio bundle and
  `create-stacki` are aligned at 1.2.1.
- **Studio undo after a drag**: pressing undo right after a navigator drop undid the step before
  the move, because the move's undo step exists only when the server answers. Undo now waits for
  the unanswered action (bounded at 3 seconds), and the Navigator forgets a shown move on any
  document change, so an answer and an undo that land before React renders cannot leave the
  moved order on screen over the restored source (`studio/test/editorHistorySettled.test.ts`;
  `npm run test:browser` reproduced it on a fresh copy of the fixture and passes ten runs in a row).
- Windows: the local-excludes ESLint test matched `src/bad.js` where ESLint prints `src\bad.js`.
- macOS: the app-frame transparency probe sampled the canvas before the iframe's card painted;
  it now captures again, within a bound, until the card shows.
- The source-watch test settles macOS's replayed startup events before it asserts (added in the
  1.2.0 push, after the pre-push hook failed under load).

## 1.2.0 AI panel overhaul, nested list props and Apps polish

- Desktop, the Studio source bundle and `create-stacki` are all at 1.2.0. 1.1.9 never became
  public (its macOS job failed on a flaky probe), so its changes ship here.
- **AI panel**: a Claude-desktop-style composer with model, effort and mode menus, a context
  ring with Compact, and queue and steer. `@` mentions files and skills as purple chips. Build an
  app inserts an "App builder instructions" chip (click to copy).
- **AI transcript**: live timers, loading dots, collapsible activity groups, thinking blocks, a
  plan card, background tasks and compaction rows. A real diff view has Keep and Undo per file,
  and permission cards ask before risky steps.
- **AI chats**: a chat list with sections, pin, unread, rename, fork, archive, delete and
  drag-to-reorder. One calm sign-in card replaces five notices, and the panel background matches
  the dark rail. Studio's chat shares the look and every part it can.
- **Style panel**: a project with no style tags and no CSS files gets a `<style is:global>` block
  on the page and a `.class` (then `.class-2`...) on the selected element at the first style.
  Selector chips paint in their final colours from the first frame.
- **Loops and props**: List props take 16 item field kinds with icons, and lists nest inside lists
  and groups (3 levels). The loop Source menu lists "Project data": arrays exported from
  `src/consts.ts` and other data modules, and JSON. A loop reading data shows purple, and the
  custom list has a `{}` toggle for raw array code.
- **Apps**: one origin badge per app (Local, GitHub or Marketplace). Marketplace rows have a
  details popup, an update button and an "Update automatically" switch for apps from others; an
  update that adds network hosts, sign-in providers or permissions waits for your OK. Build an
  app is first in the + menu and Upload app file is gone from it. Feedback pins appears in the
  marketplace, and listed apps follow their GitHub releases automatically.
- **Polish**: Central trash-can-simple and arrow-rotate-clockwise icons. The Audits panel shows
  one row per style tag with its values and an Apply button, without per-issue paragraphs, and
  severity colours stay on hover. Value conditions have better contrast. The Variables panel
  starts docked and remembers its mode. The preview toolbar's taller-than-neighbours ⋯ is fixed,
  tooltips show over popups, and the account menu is a popup.
- **The gate**: the pre-push gate now works from folders with apostrophes and respects
  `.git/info/exclude`. Electron test windows stay out of the Dock and run at most 4 at once. The
  hook's ESLint no longer uses a cache.

## 1.1.9 the 1.1.7 changes, through Studio's browser test

- The same app as 1.1.8, which never became public: Linux, Windows and macOS passed, but Studio's
  browser test failed. Since 1.1.0 the element panel's Settings group is open by default and
  remembered, and the test clicked its header to open it, which closed it, so `.class-input-field`
  never appeared. The browser tests now open the group only when it is collapsed
  (`studio/test/settingsGroup.ts`). `npm run test:browser` reproduced the failure on a copy of
  the fixture site and passes after the fix. No app code changed.
- Run `npm run test:browser` before tagging, as above: the Desktop gate does not run it.
- `create-stacki` 1.1.9 follows when npm publishing is approved.

## 1.1.8 the 1.1.7 changes, through Windows and macOS

- The same app as 1.1.7, which never became public: its Linux job lost DNS during the .deb install
  (the runner's mirror, as in 1.1.4), and its Windows and macOS jobs failed tests. Windows
  checked paths and messages with `\` where the app writes `/` (shared-property messages now use
  `/`, the Vercel prefix and shortcut tests compare with the platform's separator), the AI fakes
  were named without `.cmd`, which Windows needs to find a CLI, and four apps UI probes need input and motion
  Windows's hidden window never delivers (they run on macOS only, as the slide check runs locally only).
  macOS's theme test now waits, within a bound, for the click's re-render.
- Only shared-property messages changed in the app; everything else is test code.
- `create-stacki` 1.1.8 follows when npm publishing is approved; npm can trail Desktop.

## 1.1.7 the 1.1.0 changes and Central icons, public

- Everything in 1.1.0, plus Central icons across the editor: selectors, locks, elements, style,
  layout, typography, variables, cursors and clip paths.
- 1.1.6 was never tagged on GitHub; its macOS test fix ships here.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.1.7.

## 1.1.6 the 1.1.0 changes

- The same app as 1.1.0. 1.1.5's macOS job failed the apps tab test again: GitHub's macOS
  runner never runs a hidden window's animation frames, so the pill's slide never turns on.
  The slide checks now run locally and on Windows. No app code changed.

## 1.1.5 the 1.1.0 changes

- The same app as 1.1.0. 1.1.4's Linux job passed every test, then failed to install its own
  .deb: the runner's package index named archive files that were gone. The release now refreshes
  the index first and retries once. `renderer/app/pageNavigation` hung the 1.1.0 and 1.1.3 jobs
  for hours; it now exits after its tests, and the gate kills any test process after ten minutes.
  No app code changed.

## 1.1.4 the 1.1.0 changes

- The same app as 1.1.0. 1.1.3 never became public: GitHub's macOS runner never ran the hidden
  window's frames in the apps tab test, so its pill never turned its slide on. The test's windows
  now run without background throttling. No app code changed.
- `create-stacki` stayed at 1.1.3.

## 1.1.3 the 1.1.0 changes, past two slow-runner tests

- The same app as 1.1.0. 1.1.2 never became public: on Windows a demo test gave three renders
  only 20 ms, and on macOS the apps tab test read the pill a frame before its slide turned on.
  Both now wait, within a bound, for what they measure. Linux's install check also lost DNS
  for a moment. No app code changed.
- `create-stacki` goes from 1.1.1 to 1.1.3; 1.1.2 was never published.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.1.3.

## 1.1.2 the 1.1.0 changes, through Windows and older Linux

- The same app as 1.1.0. 1.1.1 never became public: on Windows one batch of Studio suites never
  exited (the batches now run with `--test-force-exit`, and a failed batch names its suites), and
  on Ubuntu 22.04 the popover dropdown probe missed its first press (it now presses again, within
  a bound) and one kit popup was read mid-scale (heights now match within a pixel). No app code
  changed.
- `create-stacki` 1.1.2 was never published.

## 1.1.1 the 1.1.0 changes, through every platform's build

- The same app as 1.1.0, which never became public: GitHub's runners failed three checks.
  ESLint ran out of Node's default heap on macOS (the gate now gives it 6 GB), Studio's tests
  passed the five-minute child limit on Windows (they now run in batches of 20 suites), and four
  new apps UI probes need pointer input and motion that Linux's hidden xvfb window never
  delivers (those checks run on macOS and Windows). No app code changed.
- `create-stacki` 1.1.0 was published; 1.1.1 carries the same Studio at the new version.
- Desktop, the Studio source bundle and `create-stacki` were aligned at 1.1.1.

## 1.1.0 apps platform, Audits, Instructions and an AI panel

- Apps: apps can read canvas layers and node references, watch edits as they happen, highlight
  canvas elements, outline deeply and drag to insert. The UI kit adds a confirm dialog, tooltips
  and dropdowns with icons. An app can require a minimum Stacki version (`"stacki": ">=1.1.0"`),
  and the marketplace shows it. A bug that re-read the marketplace index is fixed.
- Roles: pins are ordered per role, roles can be duplicated and deleted, and each app has its own
  access switch.
- Audits panel: accessibility, SEO, launch checks, design tokens, style blocks, placeholders,
  find and replace, and Speed, configured under Settings → Audits and saved in
  `.stacki/audits.json`.
- Instructions (in Settings): edit the project's `.md` instructions in a CMS-style editor, listed in
  `.stacki/instructions.json`.
- AI panel: chat with Claude or Codex through ACP, with guided install and sign-in, model and
  effort pickers in the composer, and keep or undo for each change.
- Editing: conditional values and class lists, spread attributes, and an inline-styles chip whose
  branches are editable, one declaration per line. Prop settings share SeoProps editing and save
  automatically. The data picker offers instance values in collapsible sources.
- Interface: three rail icon sets (Stacki, Phosphor, Custom), no flicker when switching panels,
  a canvas that follows a resize live, and a smaller welcome split button.
- Vercel: the connection installs the CLI and signs in, says why a step failed, and refreshes.
- Desktop, the Studio source bundle and `create-stacki` were aligned at 1.1.0; 1.1.1 published it.

## 1.0.24 the 1.0.23 changes, through the Windows build

- The same app as 1.0.23, which never became public: its Windows build failed one test. It
  checked that the media-hosting keys file is owner-only (`0600`), but Windows has no POSIX
  permission bits and reports `0666` for any file. The check now runs off Windows only, as the
  Studio key tests already do; the keys are checked to be encrypted everywhere. No app code changed.
- `create-stacki` 1.0.23 was never published; npm goes from 1.0.22 to 1.0.24.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.24.

## 1.0.23 media hosting, instant style previews, a live component grid

- Assets: connect Cloudflare R2, Bunny Storage or any S3-compatible host beside the project's own
  files. The panel heading switches source; hosts can be browsed, uploaded to, renamed, reordered
  and deleted, and every asset picker can choose from them. Font files preview as "Aa", every file
  type can be selected, and Replace and Copy link are on each tile's menu. Keys stay in the main
  process, or on the Studio server.
- Style panel edits show on the canvas before the save lands, on Desktop and in Studio. This
  rewrites #77: previews keep Astro scoping, skip grouped rules and are undone if a save fails.
- Search: the Components tab is a grid of live previews that render each component with its
  `.stacki` defaults, filtered by component folder. This rewrites #76's screenshots. The other
  tabs use the list again, tabs slide, and the last tab and folder are remembered.
- Style selectors: lock a stylesheet or a whole folder so cleanup never removes from it.
- Git panel: optional commit types (`feat`, `fix`, `content`, …), app dropdowns in place of the
  browser's, and "Version history".
- Editing: inserted HTML lines up with its siblings, the Navigator and canvas show `.class` labels,
  dropdowns preview on hover only where the canvas previews, and arrow keys step a value with the
  caret after its unit.
- Desktop 1.0.23 never became public; 1.0.24 is the same app. See above.

## 1.0.22 live component props and regression fixes

- Hovering an enum prop option previews it on the canvas and survives a page pull; number props
  show each value at once in Desktop. Saves no longer reload the canvas on pages whose JSON-LD
  script carries a source marker.
- The Studio demo bake sizes its build heap: on a 2 GB heap it silently shipped no component
  states, so prop changes did nothing on stacki.build. A lost probe is now logged.
- Demo notices use Stacki's toasts.
- Update checks stay quiet on dropped connections and GitHub 5xx or 429 responses, and the File
  menu reports a running download.
- Fixes eight regressions found by auditing the changes since 1.0.15.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.22.

## 1.0.21 the 1.0.16 changes, with undo after a reorder

- Desktop 1.0.20 never became public: Studio's browser test failed. After a Navigator drag,
  undo restored the page but the Navigator still showed the dragged order, because the drop's
  order was hidden rather than forgotten once the server answered, and the undo restored the
  exact source it was planned over. The order is now forgotten on the first source change.
- `create-stacki` 1.0.20 shipped that Studio; 1.0.21 replaces it.
- The browser test holds a touch past the drag threshold it reads from the Navigator, and finds
  the phone toolbar's single style and settings panel button.
- `npm run verify` does not run the browser test; run `npm run test:browser` against the fixture
  site before tagging.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.21.

## 1.0.20 the 1.0.16 changes, published

- The same app as 1.0.19, which never became public. On the Linux runner, the reveal let go
  between two widely spaced frames of a smooth-scroll library's glide, so the glide carried the
  node off screen; it now waits for the page to hold at the landing spot (2 s, or three times the
  longest gap between its scroll events) and jumps once more after a glide.
- On Windows a bake test imported by `D:\` path, which ESM refuses; it now uses a `file://` URL.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.20.

## 1.0.19 the 1.0.16 changes, through every platform's build

- The same app as 1.0.18, which never became public: its Mac build passed, but Windows and Linux
  failed.
  - Windows could not start `npm` from the bake tests (a `.cmd` file) and needed junctions.
  - On the Linux runner the Navigator reveal overshot its target. The browser's smooth scroll kept
    animating after the reveal had jumped, which the local slow-motion preflight cannot show.
- Every reveal now jumps instantly to an absolute landing spot, recomputed from the box and the
  scroller each time, so repeating it never moves the page. Desktop's Navigator reveal jumps
  rather than glides, as Studio's already did.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.19.

## 1.0.18 the 1.0.16 changes, through a clean checkout

- The same app as 1.0.17, which never became public. Its Linux build and the `create-stacki`
  workflow failed Studio's verify on a clean checkout: the demo bake tests borrowed Astro from the
  git-ignored `test/fixtures/site/node_modules`, copied a `dist/` that verify builds only after its
  tests, and shared one `node_modules` whose `.astro` and `.vite` caches parallel bakes overwrote.
- The tests now install the fixture site and build the preview runtime once under a lock, and each
  test project gets its own `node_modules` of linked packages. Run on a fresh clone with no build
  and no fixture packages, Studio's verify passed 667/667 and the full gate 604/604.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.18.

## 1.0.17 the 1.0.16 changes, with a Studio bundle that installs

- The same app as 1.0.16, which never became public. Its Studio bundle shipped
  `scripts/buildDemoAssets.ts`, which imports from `demo/`, a folder a release leaves out, so
  installing it failed Studio's type check and kept the old version. Installing the packed
  `create-stacki` into a test site caught it before anything was published; both 1.0.16 workflows
  were cancelled and the tag stays where it is.
- The release collector now leaves that script out (`RELEASE_EXCLUDED_FILES`), and the demo-release
  test allows a file to import `demo/` only when the release really leaves it out.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.17.

## 1.0.16 the editor on stacki.build, instant reorders, touch and rem

- stacki.build opens every page in the Studio demo, starting in preview: docs entries through
  their template page and entry switcher, prop edits rendered without Astro (variants, lists and
  layouts included), preview links, downloads and back/forward behaving like the site, and the
  reset bar shown only once there are edits.
- Drag to reorder updates the canvas the moment you drop; the render then confirms it, and a
  refused write puts the page back. Reordering works by touch on iPhone.
- Style drags and Variables nudges preview at once and write one at a time, so fast drags no
  longer report "This file changed". Lumos projects write rem for every length.
- Selector chips include classes an instance passes in, no longer flicker, and are ordered by
  specificity with a styled tag first. The canvas preview keeps the file's whitespace.
- Studio: Navigator picks scroll the canvas, through smooth-scroll libraries too; the editor
  collapses by canvas width; Safari and iOS fixes; swipes scroll the Style panel.
- Desktop: preview mode opens off-site redirects in the browser; the app is 28.8 MB smaller.
- Each release uploads the optional Studio demo and asks stacki.build to rebuild.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.16.

## 1.0.15 collection fields stick, prop renames follow through

- Fields added in a content collection's settings now stay. A name like `My Field` becomes the key
  `my-field`, an invalid name keeps its text and shows why, and a refused save no longer wipes the
  form (#75).
- Renaming a prop renames its local variable and every use in the file, in one undo step. A clash
  is refused under Name.
- With `::before` or `::after` selected, Duplicate, Wrap, Make component and Copy no longer act on
  the parent element.
- Studio: the chat no longer stacks copies of its transcript (#74).
- Pushing a version tag now also runs the Linux preflight.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.15.

## 1.0.14 the 1.0.13 Desktop release, through the Linux build

- The same app as 1.0.13, which never became a public Desktop release: its Linux build failed on
  two tests, and a tag is never moved. A reveal check read a smooth scroll the runner had paused
  10px in, and a chip width compared exactly differed by a pixel in Linux text rendering. Both
  tests are fixed; no app code changed.
- `create-stacki` 1.0.13 is on npm, and it creates the same project as 1.0.14. It is republished
  when someone can approve the sign-in, so npm can trail Desktop by this one version.

## 1.0.13 page templates, moving frontmatter into components, prop settings

- Create page template: the Pages `+` menu makes a template from a content collection, a Sanity
  connection or JSON from a link. The form fills itself from a fetched sample, shows the pages it
  will make, and keeps secrets in `.env`.
- Making a section a component moves the frontmatter it reads into the new component, leaving a
  copy when the parent still uses it. Passing a prop is the secondary choice. Extracting a section
  inside a loop no longer breaks the page.
- Props: a settings gear in the data picker opens the Properties form, existing props save as you
  edit, and list item fields can bind to data. Reset moves to the label's menu.
- Loops over a List prop have Filters, Sort and Limit, each with a code view for code the controls
  cannot show. Renaming a loop's variable updates every reference and refuses names that would
  break the page.
- Canvas: a click in a loop's outline selects the loop, an element in view no longer scrolls, and
  Delete on `::before` or `::after` no longer deletes the parent element.
- Code shown anywhere in the app is syntax highlighted, and the page dropdown matches the Pages
  panel's names. Switching CMS entries no longer flashes a slug error.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.13.

## 1.0.12 clip-path SVG paste is back, a new default shape, quieter undo

- Pasting an SVG into the clip-path tool works again. ⌘V never reached the tool: Desktop's Paste
  menu item pasted the copied element when no field had focus, and Studio cancelled ⌘V with an
  element selected. The open tool now claims ⌘V; straight lines become `polygon()` and curves
  `shape()`, with holes and fill rules kept.
- Choosing Shape starts from a new default shape, converted exactly as pasting it would be.
  Size, Offset X and Offset Y bind to variables like every other value field.
- An undo or redo that is declined (the element moved, unsaved edits, a syntax error to fix
  first) shows an orange warning instead of a red error.
- `npm run check:linux` runs before tagging and catches the causes of recent Linux build
  failures locally. v1.0.11's first Linux build failed on a menu measured mid-animation; the
  test now waits for the motion to settle.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.12.

## 1.0.11 style panel fixes: nested queries, live drags, !important, prop binding

- Spacing drags update the canvas while the pointer moves: a live save was a debounce that every
  animation frame pushed back, so nothing saved until the hand rested. It now throttles.
- Nested media queries are read from where they are written: the wrapper selector shows over the
  query for every element it reaches, a nested query is listed only for its wrapper and its
  descendants, each row names its stylesheet, and edits in a nested block land in that block live
  and on commit. The menu lists only authored queries; picking a px/rem query sizes the canvas,
  and Desktop returns an @media context to Base.
- `!important` shows in every Style panel field, and swatches, variable picks and list editors keep
  it instead of dropping it.
- The CSS Code editor shows two-space levels with selectors flush left, and new nested rules are
  written at the file's own depth. Clip path keeps the authored text and writes the shortest form.
- `--` suggests variables, and the bind circle sits on the field, in the clip-path and CSS Code
  editors. A click past a variable chip puts the caret after it.
- Components: plain text connects to a string prop, the bind dot replaces the value or inserts at
  the caret, the Settings pop-up and Properties panel share one property editor, and double-clicking
  slotted text edits it on the page instead of opening the component.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.11.

## 1.0.10 new collections load in a running preview, clean new entries

- Astro reads `src/content.config.*` only when the dev server starts, so a collection added while
  the preview ran (the CMS's first collection, or a config written by hand) read as empty and the
  data picker said "Reading one entry…" forever. An empty read from a preview that started before
  its content config existed now restarts the preview once, on the same address, and reads again.
- A new Markdown entry starts as an empty `---`/`---` frontmatter, which was not recognised: the
  first field written added a second block above it, and new or duplicated entries kept `---`
  lines in their body. The empty block is now filled in place.
- `create-stacki` 1.0.9 was never published. Desktop, the Studio source bundle and
  `create-stacki` are aligned at 1.0.10.

## 1.0.9 one-letter tags no longer crash the app

- 1.0.8's element tooltip asserted that every chip was longer than one character, so selecting
  a `<p>`, `<a>` or any other one-letter tag threw while the Style panel rendered and blanked
  the whole window. A one-letter tag is now a chip like any other, and a nameless token is left
  out instead of asserted on.
- A render error now stays in the panel it happened in: the Style, Settings and Navigator panels,
  the app root and Studio's Style panel show what broke with a Try again button, and retry on
  their own when the selection or page changes.
- 1.0.8 is superseded; its `create-stacki` was never published. Desktop, the Studio source
  bundle and `create-stacki` are aligned at 1.0.9.

## 1.0.8 typed classes land on the element, element tooltip

- A name typed without a dot in the Style panel's selector box (`hero_wrap`) was read as a tag
  selector for an element nobody has, so the class never went on the element and the Settings
  class box missed it until a style was set. It is now a class, added at once, unless it is an
  HTML or SVG tag or the selected element's own tag; `.`, `#`, `[` and `:` stay as typed.
- Resting on the element line above the selector field shows the whole element as chips: the
  tag and id grey, each class blue, every authored attribute purple.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.8.

## 1.0.7 loops that hold text, data picker marks

- A Text element dropped into a loop was written as `( Text )`, which Astro reads as a
  JavaScript name: the loop read back as code, its Settings lost the source picker, the
  Navigator showed nothing inside it and nothing could be dropped in. A loop body that is not
  made of tags (text, an expression, a `{/* */}` comment, a nested condition or loop) is now
  written inside `<>…</>`, and a loop's `<>` or `<Fragment>` is shown as the loop's own
  contents, written back as it was.
- The data picker marks where values come from: the component on its props heading, Astro on
  Content Collections, and the CMS mark on each collection.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.7.

## 1.0.6 a selection is revealed even when the smooth scroll stalls

The 1.0.5 release stopped at the Linux build, and this time it was the app: selecting an
element far down the page started a smooth scroll that stopped 9px down on that runner, and the
selection stayed below the fold until it was selected again. The canvas now watches the scroll
it starts and, when the page stops short of the element, jumps the rest of the way; a person
who scrolls meanwhile is left alone. The reveal test halts the first smooth scroll itself, so
the stall is reproduced on every platform. Version 1.0.5 has its tag but no Desktop release;
Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.6 with the 1.0.4
changes below.

## 1.0.5 release correction

The 1.0.4 release stopped on every platform at the prop model's parity test: its snapshot
listed six generated benchmark pages under `test/fixtures/large/`, which are git-ignored and so
exist only in a working copy that generated them, never in a clean checkout. The snapshot now
holds only files the repository carries, and the test asserts that none from there return. On
Linux, the reveal test also read a smooth scroll 9px into its way; it now waits until the
element is on screen and the page has stopped, or the page has held still, within a bound.
The app was not at fault. Version 1.0.4 has its tag but no Desktop release; Desktop, the
Studio source bundle and `create-stacki` were to align at 1.0.5; they align at 1.0.6.

## 1.0.4 component props, variable chooser, welcome screen

- Component props: the bind dot on a class, data attribute or text lists the component's props
  and creates a new one (name, tooltip, default and kind: plain text, number with min, max and
  decimals, switch with On/Off labels, attributes, list, image). Every prop shape Astro can
  express is read correctly — code-only props show "Set in code" instead of a text box — by one
  prop model all panels share. Instances mark required props, show defaults dimmed, reset a
  prop from its label, tag deprecated props and give colour props a swatch. Saving a property
  unchanged no longer rewrites the file.
- Variable chooser: scrolls with the wheel from the custom-value box; a chip opens it on its
  own variable and a pick swaps that chip only; typing `var(` or `--` suggests as you type;
  ↑/↓ preview variables live, and a press outside puts the original back; a pick replaces
  selected text; only variables that fit the property are offered.
- Undo and redo work while typing in Style fields and the custom-value box.
- Selector field: click between class chips to type there; Delete removes a selected class or
  data attribute when it is written literally; class suggestions match fuzzily ("btnprim"
  finds `button-primary`) here and in the Settings class box. The filter checkboxes are always
  available.
- ⌘K opens the insert palette; ⌥P toggles the preview, and the preview button names it.
- Every new Style Block is `<style is:global>`; making a component leaves page CSS untouched.
- The data picker heads project collections "Content Collections" with the Astro logo, closed
  until opened, and pages through a list's entries.
- Welcome screen: a slow WebGL background; readable text contrast across the app.
- Desktop, the Studio source bundle and `create-stacki` were to align at 1.0.4; they align at 1.0.6.

## 1.0.3 Linux release correction

The 1.0.2 release stopped at the Linux build: the Style panel surface test moved the pointer
once and read the grid row's hover 300 ms later, while the grid editor, now a pop-up over the
panel, could still be easing into place on the slower Linux runner. The app was not at fault.
The test now aims at the row where it is and moves again until the row reports `:hover`, a
bounded number of times. Version 1.0.2 has its tag but no Desktop release; Desktop, the Studio
source bundle and `create-stacki` are aligned at 1.0.3 with the 1.0.2 changes below.

## 1.0.2 pseudo-element layers, loop settings, Style panel fixes

- ::before and ::after are Navigator layers. Picking one selects the rule that styles it and
  lists only the selectors that style that pseudo-element; hovering or selecting it outlines
  its own box on the canvas.
- Loops: Selected items show each item's picture and start with none picked (Undo returns to
  Dynamic); sorts by natural text order, length, list size and image file size; Custom code
  filters and sorts; filter and sort fields picked from a tree that reaches nested fields; a
  Sanity loop item's fields can be bound. Changing a loop's source, filter or sort is written
  as one edit, so the page no longer flashes "teamEntries is not defined".
- A comment typed in a `<style>` block and a deleted trailing space no longer fail with
  "couldn't apply this edit"; text is pasted plain, and pasting code into Content no longer
  crashes the page; paste and undo work while editing canvas text; copying shows no toast.
- Style panel: nested selectors (`.faq_summary{&::before}`) are written inside the existing
  rule, indented as the file is; selectors such as `:open > &::after` show for the element;
  padding is written as one shorthand; the variable chooser shows a swatch per variable and
  only variables defined on the element; the align box steps with the arrow keys.
- ⌘Enter puts the caret in the selector field; → in the empty field fills in the parent's
  class up to its last underscore (`.stat_card_`). Class suggestions include classes used in
  markup and scripts, in src/ and public/.
- Grid, background, object-position, easing and clip-path editors open over the Style panel
  only; the clip-path editor reopens on the value it was given; a new effect layer opens on
  the first click; menu group headings are easier to read.
- Desktop, the Studio source bundle and `create-stacki` were to align at 1.0.2; they align at 1.0.3.

## 1.0.1 content collection fixes, quieter guide

- A content collection's list shows each entry's picture when its image field holds a root path
  such as `/src/assets/images/staff.webp`: Stacki looks in public/ and then from the project
  root, as Astro does.
- Glob collections list their entries newest first, so a new entry is on top; data-file
  collections keep their file's order.
- Deleting a collection removes its `defineCollection` const even when its name also appears in
  a loader path, so no dead definitions are left in the content config.
- A collection whose entries the dev server had lost (an entry saved while a required field was
  empty stops Astro's loader for the session) is resynced when a picker samples it: the Loop
  Source tree opens to its fields instead of "Reading one entry…" forever, and a loop's item can
  be bound again. A schema error is shown instead of nothing.
- Removing a query Stacki wrote no longer leaves a stray `// stacki:query` line behind.
- A loop whose callback returns several elements side by side stays a loop of elements instead of
  turning into a code block.
- Turning the column guide on or off shows no toast; only a failed load or save does. Toast icons
  say their kind: white for information, green for success, orange for warnings, red for
  errors. The guide button keeps its fill while the guide shows.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.1.

## 1.0.0 collection lists, linked list settings, selectors panel

- A loop's Settings work like a builder's collection list. Source opens a tree of the
  project's collections (Astro and Sanity, each opening to a sample item), the page's lists,
  None and a Custom list typed as rows; a list inside a collection's items can be chosen too
  (every campus's pastors). Then Items (Dynamic or Selected, picked and dragged into order),
  Filters (all or any), Sort (Is Off First / Is On First for switches) and Limit items. It is
  read from the code however it is written — by hand, by an AI assistant or by a Webflow
  export — and every change is one undo step that cleans up what the old source left behind.
- Filters, Sort, Show, Skip and Selected items link to component properties with a purple dot:
  "New property" asks for a name, tooltip and default; a linked setting shows as a purple bar
  with Edit settings, Disconnect, New property and Connect. A page using the component edits
  the property with the same editors, its label blue once set. A list written as code is
  rewritten as data, read through a small `listItems` helper, when a setting is first linked.
  The Properties panel recognises these props as Filter, Sort or Selected items.
- Sorts and filters drag to reorder; a newly inserted loop opens with these settings instead of
  breaking the page; a selected loop's outline wraps every item.
- The binding picker shows a builder export's loop items with their values, a renamed prop once
  by the name the code uses, and a field named with dashes as one chip
  (`item0.fields["campus-name"]`); samples come from a published entry, not a draft.
- Styles: a Selectors panel that finds selectors nothing uses and removes them, with a delete
  prompt, and a check-project report.
- CMS: Sanity reference pictures, readable dates and switches in tables, and content
  collection fields written by hand editable in collection settings.
- Image defaults written as expressions show their thumbnails; text inside a component no
  longer draws a second tag over the component's; variable tables keep their columns aligned.
- Code style: Prettier at 160 columns, with no line, function or file length check
  (AGENTS.md, docs/enforcement.md).
- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.0.0.

## 0.1.99 Windows release correction

The 0.1.98 release stopped at the Windows build: the collection-delete test recorded the
trashed file with Windows path separators (`src\data\people.json`) and compared it with a
forward-slash path. The app was not at fault. The test now compares project-relative paths with
forward slashes on every platform. Version 0.1.98 remains an unpublished Desktop draft with its
original tag (its `create-stacki` package was published); Desktop, the Studio source bundle and
`create-stacki` are aligned at 0.1.99 with the 0.1.98 changes below.

## 0.1.98 content collection settings

- A content collection's row shows a settings gear on hover. Its settings open in the main
  view: the collection's name, and its fields — dragged to reorder, opened to edit, deleted,
  duplicated, or added from a grid of every kind a collection can hold (plain and rich text,
  image and multi-image, video link, link, email, phone, number, date, switch, color, option,
  file, reference and multi-reference, list, group, key–value, constant and any value).
  Changes are made to a copy and written on Save collection; Cancel drops them.
- A field's settings state every zod check its kind supports: lengths, ranges, a pattern,
  starts and ends with, contains, trim, letter case, whole numbers, sign, exclusive bounds,
  multiple of, earliest and latest dates, an image's width and height range, option values, a
  default, and allowing null. The common ones show at once; the rest are under Advanced.
- Each change is written to the content config, rewriting only what it touches. Renaming a
  field renames it in every entry and in code that reads the collection; renaming a collection
  moves a glob folder named for it and updates `getCollection`, `getEntry`, `reference` and
  `CollectionEntry` in src. Deleting a field removes its values; deleting a collection moves its
  entries to the Trash, removes fields that point at it, and gives code that reads it nothing to
  read, so the site still builds.
- Collections list their item counts beside their names.

## 0.1.97 Astro content collections in the CMS panel, richer CMS fields

- The CMS panel always lists the project's Astro content collections, beside its CMS
  connections, and opens them with the same browser, table and item editor as Sanity: search,
  select and delete, new items, and the narrow and phone layouts. Entries are the project's own
  files, edited in place; publish, discard, history and the status column are left out.
- A collection can be created from the panel: it is added to `src/content.config.ts` (created
  when missing) with a glob loader and a starter schema, and its folder is made.
- New items and deletes work in glob collections (a file per entry, deleted to the Trash) and in
  collections kept in one JSON or YAML data file, including an empty one.
- A collection's schema becomes the panel's fields: kebab-case and digit-led keys, nullable
  values, `image()` fields with a preview and a picker that opens the Assets panel in a pop-up
  over the entry, `reference()` fields, and plain id fields that name another collection's
  records (a Webflow export's campus ids), offered as that collection's entries by name with
  their images. Lists show each entry's first image as its thumbnail.
- CMS fields: a custom date and time picker; a slug that follows its document's name until it
  is written by hand; video links shown as cards; colour functions recognised as colours;
  dropdowns that choose on click rather than on hover; a richer rich-text editor with
  Markdown shortcuts as you type, cleaned-up pastes, word counts and undo through every edit; rich text that stays editable with list
  and link attributes exported by other CMSs; Sanity choices shown by their titles.
- New items and duplicates open as unsaved drafts with Create and Cancel: nothing is written
  until Create, and opening another item cancels one. An item's fields end with Delete and
  Duplicate. Select turns the toolbar into what is chosen, Delete and Cancel, with a box that
  chooses every row. Opening an item keeps the list's header and rows where they were, and a content
  collection always shows its list, even with one entry. Clicking an open collection closes it.
- Collection tables sort by any column (smallest first, then largest first), and the pin at
  the end of the header chooses which fields show as columns, remembered per collection; a
  reference shows its record's name. Many columns scroll sideways.
- Data files up to 32 MB are read (a few hundred sermons with transcripts); saving is still
  limited to 10 MB, and a larger file says so.
- The CMS panel's + opens Settings at CMS connections; a Sanity connection is labelled Sanity.
- Canvas text keeps the typed words on screen while a save is checked, and the title bar keeps
  room for the window buttons at any page zoom.
- Stacki Studio gets all of it through its CMS route. Desktop, the Studio source bundle and
  `create-stacki` are aligned at 0.1.97.

## 0.1.96 component text on the canvas, live CMS data, Studio parity

- Text a component shows from a prop is edited on the canvas like any other text. Select the
  component and its text is outlined dashed; hover outlines it with its own tag and tints the
  component; a click picks it, with the component shown as its parent; a double click types in
  it. Plain props save the words to the attribute; props a component renders as HTML
  (`set:html`) edit one run at a time with the canvas formatting bar and save back as HTML. The
  matching prop field in Settings follows each keystroke.
- Slot text inside a selected component gets the same outlines, and double-clicking slot text
  passed through a wrapper component (a Section's container) now opens the editor.
- Canvas text no longer carries a component template's indentation into the Content field or
  the source: an edit keeps only the words, with the source's own edges.
- The binding picker shows real data a page reads from its own code — `const pastors = await
  getCampusPastors()` — sampled by the dev server the way the page's render runs it (only a
  project module under `src/`, only an export called with no arguments). A loop item lists every
  field with its value and steps through entries; images show as thumbnails. The picker's rows
  are calmer: a quiet hover, a shallower indent, values without quotes.
- Stacki Studio gets all of it: prop text editing and outlines on the canvas, saved through its
  own attribute edits, and the binding picker with the page's data (a new
  `/studio/api/sample-value` route runs the same bounded sample inside the dev server).
- Studio keeps its own files under `.stacki/studio/`, which ignores its contents: drafts,
  history and uploads in `state/`, update backups in `updates/`. An older `.studio-state/` or
  `.stacki-studio/` moves there whole on first start.
- The Cloudflare template turns Observability off by default to avoid diagnostic logging
  charges (Studio's docs/cloudflare.md says how to apply it to an existing installation).
- Fixes the Windows test that held back the 0.1.95 Desktop release. Desktop, the Studio source
  bundle and `create-stacki` are aligned at 0.1.96.

## 0.1.95 connected CMS and canvas editing

- Connect Sanity from Settings with "Log in with Sanity" (or a pasted key) and edit its content in
  the CMS panel. Collections follow the site's Studio order and icons; lists show each type's
  preview picture, title and subtitle. Every field type is editable — text, numbers, switches,
  dates, choices (including ones built from project constants), slugs, locations, groups, lists,
  images and files (uploaded to Sanity), references and rich text — read from the site's own
  schema, including field helpers, hidden fields, required fields and stated validation rules.
- Edits save as drafts. The item header shows draft or published state with times, and offers
  Publish (blocked while a stated rule fails), Discard changes, Unpublish and History with
  restore. Items can be created, deleted after a confirm, and dragged into order where the
  collection uses the orderable plugin.
- Sanity reads are cached and refreshed in the background, so panels open at once; nothing waits
  on the network, and offline the panel keeps what it last read.
- CMS fields, local and Sanity, use the component prop fields: blue labels when set, the `?`
  help, the `{}` switch from a dropdown to free text, locale and time-zone choices, real toggles,
  and dropdowns capped in height with search for long lists.
- `consts.ts` lists are fields inside their file; canvas text, palette search, outlines and the
  canvas formatting toolbar carry the editing improvements made alongside.
- Stacki Studio connects Sanity too, by pasted Editor key from the CMS panel's "Connect a CMS"
  row (Studio's docs/cloudflare.md, "CMS connections"). The Worker keeps keys encrypted in R2 and
  decrypts one only for the request that needs it; only GitHub Write or Admin collaborators may
  add or remove a connection. A local Studio keeps its connections in the user's home folder.
  Desktop and Studio answer every connected-CMS call with the same service.
- Text fields holding a hex colour use Stacki's colour picker, with `{}` for any other value;
  SVG files preview as pictures.
- New dependency `@sanity/icons` (docs/dependencies.md). Desktop, the Studio source bundle and
  `create-stacki` are aligned at 0.1.95.

## 0.1.94 Windows release corrections

The 0.1.93 release stopped after Windows exposed two failures. A preview-port probe rejected
Windows-reserved sockets with `EACCES` instead of continuing its bounded search. An inherited
page-title lookup compared unresolved source spellings with native resolved import paths.

Local regressions reproduced both causes before the fixes: socket-boundary injection replays
`EACCES`, occupied ports, exhaustion and unrelated errors; equivalent source paths demonstrate
the missed inherited title. The probe now skips reserved ports, and title lookup normalizes both
sides without changing page identities. Native Windows verification remains required in CI.
Version 0.1.93 remains an unpublished draft with its original tag. npm's publishing approval
expired before completion, so that package was not published. All release versions are 0.1.94.

## 0.1.93 updates (included in 0.1.94)

- Double-click source-matched canvas text to edit it in place. Single-click selects elements.
  Native caret movement preserves typography and authored spans; unsafe runtime markup refuses
  editing. Content fields mirror typing and undo immediately. Leaving editing clears its text
  highlight. Supported variable and CMS edits retain their bindings and identify shared content.
- Desktop and Studio share canvas interaction mode, delayed toolbar tooltips, readable page and
  template labels, searchable URL paths and safe page/folder renaming with conflict validation
  and project link updates. Shared page order remains in `.stacki` metadata.
- Published-site links resolve existing hosting destinations. Desktop includes PR #70's window
  navigation, external-link and sensitive-permission restrictions.
- Desktop, the Studio source bundle and `create-stacki` are aligned at 0.1.93.

## 0.1.92 standalone Studio verification

The 0.1.91 release stopped at Studio verification: the new cross-host metadata test loaded
Desktop source, but the standalone job installs only Studio dependencies. Its subprocess could
not resolve TypeScript from the repository root. A fresh local source archive without a root
install reproduced the failure; normal workspaces had masked it with their root dependencies.
The test now explicitly resolves shared dependencies from Studio's installation. The same
isolated test and full Studio verification must pass before publication.

Version 0.1.91 remains an unpublished draft with its original tag. Desktop, Studio and the starter
are aligned at 0.1.92, retaining the project-settings updates below.

## 0.1.91 project settings

Opening a project without saved guide preferences now uses in-memory defaults without creating
`.stacki/guide.json`. The first guide edit still saves the file, and readable legacy preferences
still migrate. Missing, corrupt and inaccessible browser storage do not create a defaults file.

Settings saves remain independent: slot component defaults, publish destinations and scripts,
page order and component sources create their own `.stacki` files when first saved. Desktop and
Studio read and write `.stacki/publish.json`; credentials remain in host authentication storage.
Regression tests exercise first saves without a metadata directory, named-slot insertion,
stale-write protection and publish settings exchanged between the actual Desktop and Studio hosts.

PR 66's Windows failure was the creation-event watcher assertion already corrected in 0.1.89.
Updating the branch from main retains that regression fix and the removed variables-panel probe.
The refreshed Ubuntu check exposed a separate first-capture `UnknownVizError` from Electron.
Replaying that exact rejection in the real local capture test reproduced the missing thumbnail.
Capture now retries that error once, bounds each attempt to three seconds, and preserves the
previous image on failure. Tests cover recovery, persistent failure, other errors and a stalled
capture without showing the window. The native Ubuntu gate remains required for verification.
Desktop, Studio and the starter are aligned at 0.1.91.

## 0.1.90 release validation

At the user's request, remove the variables-panel layout probe because its visible Electron
window interrupts local work every time the full regression gate runs. Other variables-panel
unit and integration tests remain. The removed probe's row-alignment, scroll and hit-testing
measurements are no longer covered by that browser test; application behavior is unchanged.

The 0.1.89 release run was canceled before publication to include this removal. Its tag remains
unchanged. Desktop, Studio and the starter are aligned at 0.1.90.

## 0.1.89 release validation

The 0.1.88 Windows gate caught a watcher test that assumed creating a file only emits `add`.
Windows also emitted `change` before the file was removed. Replaying the recorded event trace
reproduced the assertion locally. The test now accepts creation writes only between the new
route's add and unlink events; fixtures reject missing, reordered, unrelated and staging events.
The real-watcher test still requires one atomic-save event and preserves project ignore rules.

A native Windows runner is unavailable locally; the hosted Windows gate remains required.
Release 0.1.88 stays an unpublished draft with its original tag. Version 0.1.89 aligns Desktop,
Studio and the starter and includes the Mac packaging changes below.

## Separate Mac architectures

Mac releases produce `Stacki-VERSION-arm64.dmg` and `Stacki-VERSION-x64.dmg`, plus
matching `.zip` archives and blockmaps. Architecture-specific Electron binaries avoid the
compressed universal binary's mid-file signature changes; download savings must be measured
between consecutive signed builds with the same Electron version, not promised in advance.

Keep the app ID, signing identity and GitHub feed unchanged. One `latest-mac.yml` lists both
architectures; the metadata step rejects a missing ZIP or DMG before the draft can publish.
The existing updater selects ARM on Apple Silicon (including Rosetta) and x64 on Intel.
The migration may fall back to a full download if the old archive or blockmap cannot be reused.

Local regressions exercise the installed updater's architecture filter, per-target terminal
binaries, and dual-architecture metadata. Before publishing the first split release, verify
signed universal-to-native installation on Intel and Apple Silicon, including a Rosetta launch.
Unsigned packaging cannot verify Squirrel.Mac signature acceptance or notarization.

The marketing site's `/download/mac` selects ARM and `/download/mac-intel` selects Intel.
Both can use an older universal DMG until split assets are published. Browser CPU hints select
the button automatically; browsers without them show a choice because `MacIntel` and Intel UA
strings also occur on Apple Silicon. The website never substitutes the opposite-CPU installer.

## 0.1.87 startup correction

The live 0.1.86 cold-start check found that Git restoration checked out the baseline a second
time, hydrating every blob in its partial clone. Bootstrap now retains the already-restored
files when the active Git target equals that baseline. Divergent branches and unpublished drafts
still restore before CRDT updates. A real Git regression checks both paths, including an absent
object store to prove the identical-baseline path cannot download repository blobs.

## 0.1.86 release validation

The 0.1.85 Windows gate caught a test that expected `chmod(0755)` to set an executable bit.
Windows does not expose that POSIX mode change, so the assertion failed even though source
comparison correctly retained the regular-file mode. The replacement test checks remote mode
changes on every platform and actual executable-bit changes on POSIX. All other new Git
workspace tests passed on Windows. A native Windows runner is unavailable locally; the hosted
Windows gate remains required before publication. The original 0.1.85 tag remains unchanged.

A live rollout check also exposed Git status hydrating partial-clone blobs for file sizes.
Status now reads only paths, modes and hashes; a real partial-clone test disconnects its remote
and verifies that status succeeds without downloading the missing repository blobs.

Version 0.1.86 retains the updates below and aligns Desktop, Studio and create-stacki.
The 0.1.85 npm workflow passed all tests and packaging but npm rejected its publishing
identity with E404; no 0.1.85 package was published. npm remains a separate authorization step.

## 0.1.85 updates

- Studio uses Desktop's Git controls for commits, partial commits, pulls, branches and merge
  review. One container keeps one shared checkout: changing branches affects every editor.
  Durable Git checkpoints preserve unpublished commits and parked drafts across restarts;
  replacement document namespaces reject stale edits from an older checkout.
- Panel loading uses compact skeletons without visible loader labels. Catalogs, Git history,
  component counts and font thumbnails reuse bounded caches and refresh in the background.
  Assets initially open images when available, then assets, and retain later navigation.
- Publishing exposes its progress, favicon activity and published-site link, improves status
  checks, and protects active operations from idle shutdown. Component focus, collection
  overlays, active-page styling and preview controls match the shared Desktop behavior.
- Desktop, the Studio source bundle and the npm installer share version 0.1.85.

## 0.1.84 release validation

This release retains the application updates below and corrects the Linux installation probe.
The 0.1.83 Linux regression suite passed, but its packaged-app smoke test still called
`terminal:start` without the dimensions required by the terminal startup update. Publication
stopped before the draft became public; the 0.1.83 tag remains unchanged.

A local regression executes the actual generated renderer probe against the shared IPC parser.
It reproduced the same `Expected number` error, then passed after the probe supplied an 80-column,
24-row startup grid. A typed fixture now checks required IPC fields during compilation, and the
runtime test checks startup, command output handling, and cleanup. Native packaged Linux terminal
verification remains required in the hosted installation checks.

Desktop, the Studio source bundle, and the npm installer are aligned at version 0.1.84.

## 0.1.83 release validation

This release contains the 0.1.82 updates below with corrected cross-platform test setup.
The 0.1.82 Desktop release remained unpublished after Linux failed three scrollbar assertions;
its npm installer had already published successfully. The existing tag remains unchanged.

The failure reproduced in a local Linux container with Electron's sandbox enabled. An unmapped,
hidden BrowserWindow delayed native scroll and ResizeObserver notifications. Disabling background
throttling alone did not fix it. The layout probe now maps its window without taking focus and
waits for bounded, measured synchronization instead of short sleeps. All 36 original assertions
pass on Linux and macOS. Application behavior is unchanged by this test correction.
Windows reported the same three failures. A local Windows runner is unavailable, so the hosted
Windows regression gate remains required to confirm the fix there before publication.

Versions were aligned at 0.1.83, but the packaged Linux check described above stopped publication.
The npm installer remained at 0.1.82.

## 0.1.82 updates

- Variables open in a dockable, resizable window. Group menus remain clickable above the window,
  and the shared horizontal scrollbar aligns with the values on Desktop and mobile Studio.
- Editor side panels resize and remember their bounded widths. Asset grids add thumbnail columns
  as the panel widens and keep sparse folders compact.
- Sibling placement works inside repeated markup containers while preserving source structure.
- Terminals start with their measured dimensions, avoiding an incorrectly sized first shell prompt.
- Preview element lookup targets matching paths, and attribute changes avoid unnecessary page
  reports while structural changes still refresh the page.
- The welcome background limits resolution and frame rate, pauses when inactive, and uses a
  static fallback for reduced motion or constrained devices.
- Desktop, the Studio source bundle, and the npm installer share version 0.1.82.

## 0.1.81 updates

- Collaborative edits continue reaching peers during slow saves. Source and draft writes are
  batched, while save confirmations and publishing still wait for persistence.
- Preview rendering avoids duplicate work, preserves newer text while older renders arrive,
  and recovers more reliably from disconnects and delayed startup.
- Desktop and Studio share source-preserving structural edits and faster component usage scans.
  Atomic staging files no longer trigger unnecessary Astro route rebuilds.
- Assets, CMS and Variables retain loaded content between visits and distinguish loading from
  empty results. Studio adds the shared Git history graph and file diffs.
- Collaboration locks appear in element settings with the editor's avatar. Connection status
  replaces the Draft badge; loading counts and sign-in rate limits provide clearer feedback.
- Cloud rendering remains dependent on project work and container capacity. These changes do
  not promise instant rendering on every project or add independent per-editor Git branches.

### 0.1.80 release validation

The 0.1.80 release stopped before publication when cross-platform checks exposed two races in
the new watcher regression. Vite can emit `ready` before `createServer` returns, and its watcher
coalesces rapid changes to the same file. Waiting for the missed event stalled Linux and one
macOS run; expecting a second immediate event failed Windows.

The stall reproduced in a local Linux container. The test now checks the public watched-file
inventory with a bounded wait and uses a separate existing file for the outside-edit case.
Canonical temporary paths also account for macOS symlinks. It still checks atomic rename,
staging-file ignores, project ignore rules, outside edits, and route addition/removal. The
replacement release is 0.1.81; the original tag remains unchanged for diagnosis.

## 0.1.79 updates

- New Astro and Lumos projects let you choose npm or pnpm. Stacki checks that the chosen
  manager is installed before creating the project and includes its lockfile in the first commit.
- Selected starter templates use a white background with dark text and preserve their spacing.
- Desktop, the Studio source bundle, and `npm create stacki@latest` share version 0.1.79,
  including the editable merge review and Windows merge fixes from 0.1.78.

### 0.1.79 browser failure investigation

The first hosted Studio browser run failed after leaving interactive preview: Astro's
`Unhandled rejection` overlay added another heading, so Playwright correctly refused the
ambiguous selector. The log captured the overlay title but omitted its error message and stack;
it does not establish the underlying cause. All Desktop platform gates and installers passed.

The exact release passed locally with the installed Chrome and with the same Chromium version
used by CI. Four additional runs, each with a new draft workspace and server, also passed.
This macOS reproduction cannot establish why the Linux runner showed the overlay. A rerun of
the unchanged tagged Studio job must still pass before the draft can become public.

Future browser failures now log bounded preview error messages and stacks alongside the editor
inspector and browser errors. The assertions, selectors, and timeouts remain unchanged; an error
overlay must not be hidden by narrowing the heading selector. These diagnostic-only test changes
do not change the tagged application or its published npm package.

## 0.1.78 updates

- Merge review now opens in a wider, editable final-code view. Branch-colored highlights show
  where each change came from, with independent choices for text and attributes, manual overrides,
  and undo/redo. Automatic merging still combines compatible edits; stale reviews are rejected
  before they can overwrite newer work.
- Branches have distinct colors throughout the branch list, commit destination, and history graph.
  Commit controls clearly identify the destination branch while the graph preserves real ancestry.
- Merge confirmation has cleaner spacing and shorter copy.
- Content fields preserve the caret when deleting spaces, so Backspace continues editing where
  expected instead of jumping to the beginning.

### 0.1.77 release validation

The 0.1.77 release was stopped before publication after Windows CI exposed CRLF conflict markers
being treated as ordinary source. A local reproduction with `core.autocrlf=true` failed the same
real-Git merge test. The parser now accepts CRLF marker endings while retaining source line endings;
regression checks cover both Git conversion modes, exact output, and unclosed markers.

An Ubuntu check also read a popup before its exit timer removed it. The browser probe now waits
for bounded popup presence/removal instead of assuming a fixed sleep is enough. This scheduler
race did not reproduce locally; the strengthened probe passes locally and still runs in CI.
The replacement is 0.1.78; the existing 0.1.77 tag and unpublished draft are retained for diagnosis.

## 0.1.76 updates

- Astro `.map()` callbacks recognize async, function, block, typed, destructured, and referenced
  forms while preserving source and exposing their markup as editable elements.
- Optional content fields use blue reset labels: Option-click to clear, or click and choose Reset.
- Project startup shows one loading indicator while dependencies and the preview are starting.
- [PR #54](https://github.com/flowtricks/stacki/pull/54): Project dependencies and Cloudflare's
  Wrangler install use the site's package manager, preferring `package.json` over its lockfile.
  Cancelling Cloudflare sign-in lets installation finish, and pnpm installs tolerate blocked
  dependency build scripts while keeping those scripts blocked. The sign-in dialog keeps one
  screen through installation, browser sign-in, and retry.
- [PR #55](https://github.com/flowtricks/stacki/pull/55): Start from Astro now asks where the site
  should go, then lets you name it and preview its folder, matching Start from Lumos. Both flows
  share name validation and improved label spacing. Failed Astro creation removes its new folder
  only when it is still empty, so retrying the same name works without deleting generated files.
- The welcome screen uses folder, GitHub, Lumos, and Astro icons with concise action labels.
  Dropdowns expand from their buttons as one white surface and animate closed before opening
  the next dialog, with reduced-motion support.

## Learn from publishing failures

Whenever a GitHub release or publishing workflow fails, inspect the failure before retrying.
Reproduce the cause locally whenever possible, then add or improve a local regression test that
fails for that cause and passes after the fix. Run the regression test and the required local
release checks before pushing again. Include the regression coverage in the fix so future releases
catch the same problem before reaching GitHub.

Match the conditions that caused the failure: a clean checkout, the Git hook environment, the
affected operating system, or the packaged installation. Prefer deterministic reproduction over
repeated retries, longer timeouts, or weakened assertions. For timing failures, synchronize on the
actual event or inject the failing condition instead of relying on a lucky test run.

Some failures depend on external services, signing, authentication, or hosted runner infrastructure.
When a local test cannot reasonably reproduce the cause, document why, record the verification
that is possible, and keep the required remote check. Never skip a gate to make publishing succeed.

## One draft per tag

On 2026-11-12 the v1.2.2 release made two drafts: build-mac, build-windows and build-linux start
together, and each `electron-builder --publish always` (`EP_DRAFT`) creates a draft when it finds none
for the tag. The installers went to one draft and the later `gh release upload "$TAG"` steps (mac's
`latest-mac.yml`, the Studio bundle) to the other, so publish refused (`missing latest.yml`) and the
release was completed by hand. The workflow's `draft` job now creates the draft once (idempotent,
titled with the version as electron-builder does), and every job that uploads `needs` it.
After the first run with this job, confirm only ONE draft exists for the tag
(`gh release list --repo flowtricks/stacki-releases`).

## Browser tests and animated popups

Shared popups remain mounted while their close animation runs, and consume outside clicks during
that time. After closing a popup, wait for that popup to detach before clicking another control.
Do not use an arbitrary sleep or weaken the assertion.

The same holds for input. A hidden (`show: false`) window is not guaranteed to paint: GitHub's macOS
runner never ran its animation frames (1.1.6), and Chromium holds a mouse move until the next frame,
so a probe that moves the pointer and sleeps 60 ms hears nothing on such a machine (issue #78, the
dropdown highlight probe). A probe that needs pointer input or motion renders offscreen
(`webPreferences: { offscreen: true }`), which paints on its own clock, and waits for the page to
report the event it sent (a counter its own capture listener bumps) within a bound, then for a frame.
`test/renderer/apps/appUiKitDropdownHighlight.test.js` is the pattern. Probes that wait for a popup
wait for its rows to mount and for it to detach, not for 400 ms.

Probes run without a Dock icon. On macOS every Electron process started from a terminal gets its own
Dock tile, and sixteen suites at once filled the Dock. The gate adds `test/helpers/hideDockPreload.js`
to `NODE_OPTIONS` for its test commands, so every probe's main process hides its tile before its first
window with no edit to the probe; windows, focus and pointer input are unaffected. The gate runs at
most four Electron suites at once (`--electron-jobs=<n>` changes it), starts each command as its own
process group, and kills that whole group when the command ends, times out, or the gate exits.

In the 0.1.64 release, the Studio browser scenario closed the account menu and immediately clicked
`Expand all`. The closing popup consumed that click, leaving the navigator collapsed. The test
then timed out looking for Heading, even though the component existed. Waiting for
`.account-popover` to detach fixed the scenario.

## 0.1.64 recovery record

The tested release tag points to `6903fb2825006cd79eff99bfbacae2fd51a3b38c`. All three platform
builds, Linux installation checks, and Studio's compilation, lint, formatting, and unit tests passed
in GitHub Actions. The browser scenario reproduced locally against that exact source. After the
test-only popup wait was added, the complete browser scenario passed against the same release.

The existing Desktop installers were preserved. The Studio bundle built from the tested tag was
uploaded, all platform update metadata and installer assets were verified, and the draft was
published as the latest release. No application code or published version tag was changed.

The npm workflow separately failed authentication after passing its tests and building the package.
The maintainer authenticated a local publication of the exact-tag package after a fresh installation
smoke test. The registry's package checksum matched the tested tarball, and both `dist-tags.latest`
and the downloaded CLI reported 0.1.64.

The original failed workflow runs remain red; publishing manually does not rewrite their history.
Confirm live availability through the latest GitHub release and npm registry, rather than inferring
it from workflow badges. Do not bypass an unresolved application failure to publish a draft.
