# Interface translation inventory (phase 2a)

Raw user-visible strings that are not yet routed through `translate()`, measured by a static scan (TypeScript AST, not a grep) on 2026-11-13.
The scan is **approximate**: it counts string occurrences, not unique keys, and it errs toward counting. Expect about 15 to 25 per cent
to collapse into shared keys (`Cancel`, `Remove {name}`, `Close`, `Add`) and a few per cent to be code, not UI. Treat the numbers as sizing, not as a checklist.

Already routed: about 265 `translate(...)` call sites exist today (the pilot slice: Settings shell, project settings tabs, parts of AI and audits, publish).

## Summary

| Class | Count |
|---|---|
| text props | 1783 |
| option/menu labels | 1101 |
| JSX text | 1086 |
| error messages | 721 |
| JSX expr strings | 318 |
| toasts/status | 148 |
| Electron menus/dialogs | 72 |
| **Total** | **5229** in 634 files (766 are dynamic: template literals or concatenation; 143 plural-by-ternary sites in 72 files; 14 files already format dates or numbers) |

Scanned: `src/**`, `studio/src/**` (Studio-only; `studio/vendor` is generated and excluded), `electron/**`, `shared/**` (the catalogs excluded).
Excluded: tests, `.d.ts`, generated files.

## Suggested split for phase 2 (12 areas, disjoint folders)

One agent per area, each owning its own namespace files (see Migration guide). Counts include the strings below the table's class split.

| Area | Files | Strings | Dynamic | Folders |
|---|---|---|---|---|
| A1 shared UI kit and editor core | 38 | 162 | 24 | `src/editor`, `src/ipc`, `src/lib`, `src/ui` |
| A2 style panel (sections and controls) | 58 | 735 | 52 | `src/features/style` |
| A3 style models (style/model, clipPath, embed, components), selectors, variables, structure | 53 | 471 | 65 | `src/features/selectors`, `src/features/structure`, `src/features/style`, `src/features/variables` |
| A4 props and component properties | 57 | 563 | 59 | `src/features/componentDefaults`, `src/features/componentProperties`, `src/features/props` |
| A5 apps | 38 | 409 | 72 | `src/features/apps`, `studio/src/features/apps` |
| A6 CMS and content | 40 | 396 | 37 | `src/features/cms`, `src/features/cmsConnections`, `src/features/content`, `studio/src/features/cms`, `studio/src/features/collections`, `studio/src/features/components` |
| A7 AI chat | 55 | 398 | 69 | `electron/handlers/ai`, `src/features/ai`, `studio/src/features/ai` |
| A8 publishing, git, assets, history | 69 | 525 | 81 | `electron/git`, `src/features/assets`, `src/features/git`, `src/features/history`, `src/features/publishing`, `studio/src/features/assets`, `studio/src/features/bake`, `studio/src/features/github`, `studio/src/features/history`, `studio/src/features/publishing` |
| A9 settings tabs, roles, instructions | 20 | 224 | 43 | `src/app/settings`, `src/features/instructions`, `studio/src/features/roles`, `studio/src/features/settings` |
| A10 audits, palette, welcome, pages, preview, terminal | 61 | 557 | 46 | `src/features/audits`, `src/features/code`, `src/features/notifications`, `src/features/pages`, `src/features/palette`, `src/features/preview`, `src/features/studioSetup`, `src/features/terminal`, `src/features/welcome`, `studio/src/features/code`, `studio/src/features/pages`, `studio/src/features/preview` |
| A11 app shell, state and Studio-only shell | 45 | 236 | 51 | `src/app`, `src/app/model`, `src/app/roles`, `src/app/shell`, `src/app/state`, `studio/src/app`, `studio/src/cloudflare`, `studio/src/features/auth`, `studio/src/features/collaboration`, `studio/src/features/componentProperties`, `studio/src/features/project`, `studio/src/features/updates`, `studio/src/features/variables`, `studio/src/server` |
| A12 Electron main process | 76 | 350 | 124 | `electron/app`, `electron/content`, `electron/documents`, `electron/handlers`, `electron/lib`, `electron/main.ts`, `electron/parse`, `electron/preload`, `electron/project`, `electron/properties`, `electron/terminal` |
| shared | 24 | 203 | 43 | `shared/core/i18n`, `shared/engine/variableRename.ts`, `shared/page/auditFindings.ts`, `shared/page/auditPerformance.ts`, `shared/page/auditRendered.ts`, `shared/page/auditRepairs.ts`, `shared/page/auditSite.ts`, `shared/page/auditStatic.ts`, `shared/page/auditValueEdit.ts`, `shared/properties/ai`, `shared/properties/appConnections.ts`, `shared/properties/appPlace.ts`, `shared/properties/appPublish.ts`, `shared/properties/appSecrets.ts`, `shared/properties/appStorage.ts`, `shared/properties/astroContent.ts`, `shared/properties/componentDefaults.ts`, `shared/properties/instructions.ts`, `shared/properties/pageRenameConflicts.ts`, `shared/properties/pageTemplate.ts`, `shared/properties/projectRoles.ts` |

Notes on the split:

- **A1 goes first** (or at least lands its keys early): `Dropdown`, `Menu`, `ConfirmDialog`, `Popup`, `ErrorToast` and friends are used by every other area. Shared words (`Cancel`, `Close`, `Add`, `Remove`, `Search`) live in the `ui` namespace and other areas reuse them instead of adding their own copies.
- **A2 and A3** are the biggest (about 1206 strings). A2 is 98 files of mostly `title`/`aria-label` and option labels; both can be split further by file range if one agent run is too long.
- **shared/** strings (audit finding titles in `shared/page/auditFindings.ts`, role permission labels in `shared/properties/projectRoles.ts`, `appPlace.ts`) are data used by both processes: they need an **id to key** change (store a stable id, translate in the renderer), not a `translate()` call in `shared/`. Give them to the area that renders them (A10 audits, A9 roles, A5 apps). Excluded from the area totals above are the `shared/core/i18n` parser messages, which are developer diagnostics and stay English.
- **A12 Electron** is not a mechanical migration. The main process has no `LocaleProvider`; the menu bar, dialogs and updater text need the catalogs plus `app.getLocale()` / the stored preference sent over IPC (docs/i18n.md phase 5). Most `electron/**` `message:` hits are `Result` errors that reach the renderer: prefer sending a stable `code` (they mostly exist) and translating **in the renderer** by code; fall back to English text for free-form detail from the OS or git. Do the menu bar and dialogs (about 85 strings) as one agent after a design decision; leave handler error text for last.
- Estimated **12 agent runs** for phase 2 (A1 to A12), plus **1 review run** (parity, pseudo-locale layout check with long German, a native-speaker pass on `// review` lines). If A2 and A4 are each split in two, 14. A1 and A12 (the main-process design) are the only runs with ordering constraints; A2 to A11 are fully parallel.
- Cost of the catalogs: about 4183 new keys, times five locales. English (about 40 characters per message) adds roughly 184 KB to the eager bundle (about a quarter of that gzipped); each other locale is the same size but only downloaded by people who choose it. If the English cost matters later, namespaces can be loaded lazily too (the layout already allows it).

## By folder

`Translate calls` is the number of `translate(` / `t(` call sites already in that folder (context for how migrated it is).

| Folder | Files | Raw strings | Dynamic | Translate calls |
|---|---|---|---|---|
| `src/features/style` | 98 | 1087 | 97 | 0 |
| `src/features/props` | 41 | 427 | 46 | 0 |
| `src/features/apps` | 31 | 371 | 67 | 0 |
| `src/features/cms` | 30 | 297 | 34 | 0 |
| `src/features/ai` | 34 | 250 | 32 | 24 |
| `src/features/publishing` | 11 | 155 | 9 | 5 |
| `src/features/audits` | 7 | 144 | 17 | 25 |
| `src/features/git` | 15 | 136 | 30 | 0 |
| `src/app/settings` | 10 | 135 | 37 | 37 |
| `src/features/componentProperties` | 14 | 132 | 13 | 0 |
| `electron/project` | 28 | 127 | 36 | 0 |
| `src/ui` | 23 | 124 | 9 | 1 |
| `src/features/assets` | 9 | 121 | 18 | 0 |
| `src/features/pages` | 10 | 113 | 8 | 0 |
| `studio/src/features/ai` | 10 | 81 | 6 | 0 |
| `electron/properties` | 12 | 77 | 33 | 0 |
| `src/features/studioSetup` | 5 | 76 | 2 | 0 |
| `src/app/shell` | 8 | 69 | 10 | 2 |
| `src/app/state` | 10 | 68 | 33 | 0 |
| `electron/handlers/ai` | 11 | 67 | 31 | 0 |
| `src/features/instructions` | 2 | 61 | 3 | 0 |
| `src/features/palette` | 8 | 61 | 4 | 0 |
| `src/features/preview` | 9 | 59 | 8 | 0 |
| `shared/page/auditFindings.ts` | 1 | 55 | 0 | 0 |
| `src/features/variables` | 7 | 51 | 8 | 0 |
| `src/features/welcome` | 4 | 48 | 0 | 0 |
| `src/features/history` | 6 | 46 | 7 | 0 |
| `src/features/content` | 2 | 45 | 3 | 0 |
| `src/features/cmsConnections` | 3 | 40 | 0 | 0 |
| `shared/properties/projectRoles.ts` | 1 | 40 | 0 | 0 |
| `src/features/selectors` | 3 | 38 | 11 | 0 |
| `studio/src/features/apps` | 7 | 38 | 5 | 0 |
| `electron/handlers` | 16 | 37 | 13 | 0 |
| `electron/content` | 7 | 33 | 15 | 0 |
| `src/features/structure` | 3 | 30 | 1 | 0 |
| `src/editor` | 8 | 28 | 11 | 0 |
| `studio/src/features/pages` | 6 | 28 | 5 | 0 |
| `studio/src/app` | 4 | 27 | 0 | 0 |
| `src/app` | 6 | 25 | 4 | 2 |
| `shared/page/auditStatic.ts` | 1 | 23 | 9 | 0 |
| `studio/src/features/publishing` | 10 | 22 | 3 | 0 |
| `electron/app` | 1 | 22 | 7 | 0 |
| `electron/main.ts` | 1 | 22 | 0 | 0 |
| `studio/src/features/settings` | 6 | 20 | 3 | 0 |
| `shared/core/i18n` | 2 | 20 | 8 | 0 |
| `electron/documents` | 5 | 18 | 18 | 0 |
| `studio/src/features/auth` | 1 | 14 | 0 | 0 |
| `shared/properties/appPlace.ts` | 1 | 14 | 4 | 0 |
| `src/features/terminal` | 3 | 13 | 1 | 0 |
| `studio/src/features/bake` | 2 | 13 | 9 | 0 |
| `studio/src/features/history` | 4 | 10 | 1 | 0 |
| `studio/src/features/github` | 4 | 9 | 0 | 0 |
| `electron/git` | 6 | 9 | 3 | 0 |
| `shared/properties/componentDefaults.ts` | 1 | 9 | 4 | 0 |
| `studio/src/features/roles` | 2 | 8 | 0 | 0 |
| `studio/src/features/collections` | 1 | 7 | 0 | 0 |
| `studio/src/features/preview` | 4 | 7 | 0 | 0 |
| `studio/src/features/cms` | 3 | 6 | 0 | 0 |
| `studio/src/features/project` | 1 | 6 | 1 | 0 |
| `src/ipc` | 5 | 5 | 0 | 0 |
| `src/lib` | 2 | 5 | 4 | 0 |
| `studio/src/cloudflare` | 4 | 5 | 0 | 0 |
| `studio/src/features/collaboration` | 2 | 5 | 0 | 0 |
| `studio/src/server` | 2 | 5 | 0 | 0 |
| `shared/properties/ai` | 3 | 5 | 0 | 0 |
| `shared/properties/appPublish.ts` | 1 | 5 | 4 | 0 |
| `shared/properties/instructions.ts` | 1 | 5 | 2 | 0 |
| `src/app/model` | 1 | 4 | 2 | 0 |
| `src/features/componentDefaults` | 2 | 4 | 0 | 0 |
| `src/features/notifications` | 1 | 4 | 1 | 0 |
| `studio/src/features/assets` | 2 | 4 | 1 | 0 |
| `electron/parse` | 2 | 4 | 1 | 0 |
| `electron/preload` | 2 | 4 | 0 | 0 |
| `shared/properties/appSecrets.ts` | 1 | 4 | 4 | 0 |
| `shared/properties/pageTemplate.ts` | 1 | 4 | 0 | 0 |
| `src/app/roles` | 1 | 3 | 0 | 0 |
| `src/features/code` | 3 | 3 | 0 | 0 |
| `electron/lib` | 1 | 3 | 1 | 0 |
| `electron/terminal` | 1 | 3 | 0 | 0 |
| `shared/page/auditPerformance.ts` | 1 | 3 | 1 | 0 |
| `shared/page/auditRepairs.ts` | 1 | 3 | 1 | 0 |
| `shared/properties/pageRenameConflicts.ts` | 1 | 3 | 1 | 0 |
| `studio/src/features/componentProperties` | 2 | 2 | 0 | 0 |
| `studio/src/features/variables` | 2 | 2 | 0 | 0 |
| `shared/engine/variableRename.ts` | 1 | 2 | 0 | 0 |
| `shared/properties/appConnections.ts` | 1 | 2 | 0 | 0 |
| `shared/properties/appStorage.ts` | 1 | 2 | 2 | 0 |
| `studio/src/features/code` | 1 | 1 | 0 | 0 |
| `studio/src/features/components` | 1 | 1 | 0 | 0 |
| `studio/src/features/updates` | 1 | 1 | 1 | 0 |
| `shared/page/auditRendered.ts` | 1 | 1 | 1 | 0 |
| `shared/page/auditSite.ts` | 1 | 1 | 1 | 0 |
| `shared/page/auditValueEdit.ts` | 1 | 1 | 1 | 0 |
| `shared/properties/astroContent.ts` | 1 | 1 | 0 | 0 |

## Tricky patterns the scan found

| Pattern | Where | What to do |
|---|---|---|
| Template literals with values: `\`Remove ${name}\`` (766 sites) | everywhere | One message with a placeholder: `'Remove {name}'`. Never split into fragments around the value; word order differs per language. |
| Plural by ternary: `count === 1 ? '' : 's'` (143 sites, 72 files) | AI transcript, git, audits, apps, content, assets, `src/app/state/appNodeEdits.ts` | Plural message `{ one: '{count} file', other: '{count} files' }`. German/French need `one`/`other`; Spanish/Portuguese add `many` for large numbers in Intl but `other` is the required fallback. |
| Concatenation: `'a ' + b + ' c'` (6 sites) | few; mostly `src/app/state`, `style/model` | Same as templates. |
| Strings in JSX with inline code: `Saved in <code>.stacki/roles.json</code> as you change them` | settings tabs, instructions, apps | Do not translate around the `<code>`. Use a message with a placeholder and render pieces (see "Rich text" below). The file path stays English. |
| Option arrays: `[{ value: 'flex-start', label: 'Start' }]` | style, props, cms | Labels become keys; **values never change** (they are CSS keywords or stored data). Build the array inside the component (or a function taking `translate`) because module-level constants cannot call hooks. |
| Module-level constants holding text | `style/model/*.ts`, `shared/` | Store a key (`MessageKey`) in the constant, call `translate(key)` at render. Do not call `translate` at import time. |
| Toasts and `Result` errors built in `.ts` (`src/app/state`, `src/editor`, `style/model`) | `showToast`, `message:` | Keep stable `code`, translate where it is shown. If the helper has no hook, pass `translate` in, or return `{ key, params }` and let the component translate. |
| Strings produced in the main process and shown in the renderer | `electron/**` | See A12 above. |
| Shared strings in `shared/` used by both processes | audit findings, role permissions | Id to key mapping in the renderer; `shared/` keeps the id. |
| Dates, numbers, relative times | 14 files already use `toLocale*` / `Intl` | Pass the locale from `useLocale()` explicitly; never hand-format. `toLocaleString()` with no locale argument follows the OS, not the Language setting. |

## Must stay English (do not translate)

| Kind | Examples |
|---|---|
| Product and platform names | Stacki, Stacki Studio, Astro, Lumos, GitHub, Cloudflare, Claude, Codex, MCP, CMS (as a product term; the long form may translate), Git |
| CSS: property names, values, units, functions | `flex-direction`, `space-between`, `px`, `rem`, `clamp()`, `gradient()`, `:hover`; **labels that name a CSS value in the property editor stay English** when they are the value itself (`flex-start`), translate when they describe it ("Start") |
| HTML tags and attributes | `<div>`, `aria-label`, `href`, `alt` (the word, as a field name in code) |
| Class names, selectors, ids, file names, paths, globs | `.stacki/roles.json`, `**/CHANGELOG.md`, `src/pages` |
| Keyboard key names in shortcuts | `Esc`, `Enter`, `Tab`, `Cmd`, `Ctrl`, `Shift`, `Alt`; modifier glyphs. Only the sentence around them translates (`'{queueKey} to queue'`). |
| Code samples, JSON keys, frontmatter, placeholders that show syntax | `gradient(…)`, `const { x } = Astro.props`, `docs/archive or **/CHANGELOG.md` |
| Developer diagnostics | `assert` messages, parser error text in `shared/`, `console.*`, test names |
| User content | page names, component names, variable names, file names, CMS entry text |

The scan counts some of these (the numbers are an upper bound); the agent decides per string.

## Settings and Style panels: what is still English

### Settings

`Settings.tsx` (the shell, the Editor tab, Language) and the project settings tabs under `src/features/projectSettings/` are migrated. These are not, which is why part of the dialog stays English in Deutsch. Nothing here is a missing key in a catalog: the text is still in the component, so there is **no key yet**. The names below are the raw strings (area A9, plus A10 for audits):

- `AuditsSettings.tsx` (22): `Shared with the team in`, `.stacki/audits.json`, `{…} of {…} on`, `Phrases`, `A single word must be the whole text to count; several words may be part of it.`, `Add a phrase`, `Rules`, `Raw colours`, `Hex, rgb() and hsl() outside variables`, `Flag px`, `Any px value outside a variable definition`, `Flag rem outside variables`, `rem belongs in variable definitions only`, `Properties that need variables`, `Add a property, or padding* for every padding`, `Raw values that are fine`, `Add a value, such as 1px`, `All`, `All {…}`, `{…} priority`, `Default ({…})`, `Remove {…}`
- `CmsSourceSettings.tsx` (16): `Loading CMS sources…`, `CMS collections`, `The content config declares no collections.`, `Show {…} in the CMS panel`, `Read from the content config, where Astro looks for them.`, `Open content config`, `CMS data files`, `A .ts, .js, .json or .astro file under src/`, `Add file`, `Remove {…} from CMS data files`, `No data files: the CMS panel lists only collections.`, `Data picker sources`, `Data picker`, `No data files or collections to bind to.`, `Switched off, a source leaves the binding picker only; the CMS panel still lists it.`, `Show {…} in data picker`
- `FolderSettings.tsx` (20): `Loading folders…`, `Project folders`, `The folders each panel reads, saved in`, `.stacki/folders.json`, `for Desktop and Studio. A panel you have not changed uses its defaults. Changes save as yo`, `The folder settings could not be read (`, `). Every panel uses its defaults; a change here replaces the file.`, `Panels`, `CMS`, `Which collections and data files the CMS panel lists.`, `Default folders.`, `Pages`, `Follows`, `in astro.config.`, `Open astro.config`, `{…} folders`, `A folder inside {…}`, `Add folder`, `Remove {…} from {…}`, `No folders: this panel lists nothing.`
- `InstructionsSettings.tsx` (14): `Reading the hidden paths…`, `Hidden instructions`, `Files and folders the Instructions panel leaves out. Paths start at the project root:`, `hides that folder,`, `**/CHANGELOG.md`, `every changelog. Saved in`, `.stacki/instructions.json`, `, shared with everyone on the project.`, `Nothing is hidden. Build output and node_modules are never listed.`, `Show {…} again`, `Show again`, `Path or pattern to hide`, `docs/archive or **/CHANGELOG.md`, `Hide`
- `MemberPicker.tsx` (4): `Add a GitHub username to {…}`, `GitHub username`, `GitHub users matching {…}`, `Add`
- `RoleAppPermissions.tsx` (4): `{…} permissions`, `Every app is on`, `All permissions`, `All {…} permissions`
- `RoleCard.tsx` (14): `{…} role`, `Full access`, `Duplicate {…}`, `Duplicate {…} as a new role, without its members`, `Delete {…}`, `{…} members`, `Remove {…}`, `No members`, `All`, `All {…}`, `Every app`, `Rename`, `Rename {…}`, `Role name`
- `RolePermissions.tsx` (1): `Permissions ·`
- `RolePinnedApps.tsx` (10): `{…} apps pinned to the sidebar`, `Pinned to sidebar`, `{…} pinned apps, in sidebar order`, `Drag to reorder {…}`, `Unpin {…}`, `No apps installed`, `Also gives {…} access`, `Pin an app to the sidebar for {…}`, `At most {…} pinned apps`, `Add app`
- `RolesSettings.tsx` (22): `Loading roles…`, `Not saved: {…}`, `Delete {…}?`, `Delete role`, `Project roles`, `Choose what each role can use in this project. Roles are saved in`, `.stacki/roles.json`, `as you change them, and apply on Desktop and in Stacki Studio.`, `Sign in to GitHub to be matched to a role; until then you are an admin here.`, `You are signed in as {…}.`, `The roles file could not be read: {…}. Your next change replaces it.`, `Only admins can change roles.`, `Access`, `Roles`, `Members are GitHub usernames. Admin always has full access.`, `New role name`, `Add role`, `View as`, `See Stacki as someone in another role would. Only this window changes.`, `People in no role`, `The role Stacki Studio gives anyone who is not a member of any role.`, `Role for people in no role`

Also still raw and shown in Settings: the Audits tab content under `src/features/audits/` (A10) and, from the Studio-only shell, `studio/src/features/settings/` (A9).

### Style panel

`src/features/style/` has **no** `translate()` calls at all: every label, tooltip, section title and option is English (98 files, 1087 strings). Per-file counts: model/transition.ts 56, FlexChildSection.tsx 42, clipPath/clipPathShortcuts.ts 42, EasingEditor.tsx 38, BackgroundLayerFields.tsx 35, TypographySection.tsx 31, TypographyColumns.tsx 30, DecorationPopover.tsx 28, SizeSection.tsx 27, PositionSection.tsx 25, clipPath/ClipPathView.tsx 25, DisplayControl.tsx 23, GridSettings.tsx 23, embed/ResolvedRows.tsx 23, TransformsRow.tsx 21, ObjectFitFields.tsx 20, TransformSettings.tsx 20, embed/QueryForms.tsx 19, EffectsKit.tsx 17, GradientEditor.tsx 17, AspectRatioField.tsx 16, GradientControls.tsx 16, BordersSection.tsx 15, GridAreas.tsx 15, GridControls.tsx 15, TrackEditor.tsx 15, TransitionsRow.tsx 15, clipPath/ClipPathCanvas.tsx 15, embed/useEditorResolution.ts 14, BackgroundLayerEditor.tsx 13, GridFlowControls.tsx 13, SizeKit.tsx 13, TextStrokeShadow.tsx 13, embed/SelectorPicker.tsx 13, BackgroundSection.tsx 12, EffectsSection.tsx 12, PositionSegments.tsx 12, model/filter.ts 12, BoxShadowsRow.tsx 11, FontFields.tsx 11, TextWrapRows.tsx 10, embed/StyleCard.tsx 10, model/sections.ts 10, model/webflow.ts 10, EmbedEditor.tsx 9, GapControl.tsx 9, LayerList.tsx 9, model/inlineTarget.ts 9, model/transformSettings.ts 9, embed/AddProperty.tsx 8, model/nativeStyles.ts 8, TypographyKit.tsx 7, embed/useEditorRuleEdits.ts 7, DirectionControl.tsx 6, components/ColorPicker.tsx 6, AlignControl.tsx 5, FilterFields.tsx 5, ShadowFields.tsx 5, VariablePicker.tsx 5, embed/LayoutRows.tsx 5, embed/useEditorElement.ts 5, model/inlineBranches.ts 5, BackgroundKit.tsx 4, BordersKit.tsx 4, ClipPathRow.tsx 4, GridAutoSection.tsx 4, OpacityRow.tsx 4, ProvenanceList.tsx 4, SegmentedField.tsx 4, SpacingSection.tsx 4, components/InheritedPropertyLabel.tsx 4, components/SelectViews.tsx 4, embed/useEditorScanning.ts 4, GradientCode.tsx 3, RadiusControl.tsx 3, SpacingEditor.tsx 3, embed/EditorBasics.tsx 3, embed/InlineBranchEditor.tsx 3, embed/InlineStyleChip.tsx 3, embed/useEditorFoundation.ts 3, embed/useEditorNative.ts 3, CustomValueEditor.tsx 2, GridIcons.tsx 2, StylePanel.tsx 2, VariableHint.tsx 2, components/FieldLabel.tsx 2, components/ImportantMark.tsx 2, embed/useEditorWrites.ts 2, LiveTextInput.tsx 1, SizeSegmentBar.tsx 1, components/ClassPicker.tsx 1, components/CodeVariables.tsx 1, components/LiveInput.tsx 1, components/PositionGrid.tsx 1, embed/useEditorContexts.ts 1, model/componentStyleWrite.ts 1, model/css.ts 1, model/nativeStubs.ts 1.

Section headings and control labels sit in the `*Section.tsx` files (`TypographySection`, `SizeSection`, `PositionSection`, `FlexChildSection`, and so on); option labels sit in `model/*.ts` (`transition.ts` 56) and `clipPath/clipPathShortcuts.ts` (42).

## Migration guide for agents

### Layout

```
shared/properties/i18n/messages/
  en/<namespace>.ts      source of truth for that namespace; keys must start with "<namespace>."
  en/index.ts            merges every namespace; defines MessageKey
  es/ fr/ de/ ptBR/      the same files, same keys
```

The namespace is the key's first segment: `style.typography.fontSize.label` lives in `en/style.ts`. One agent owns one or more
namespaces, so catalogs never conflict. See docs/i18n.md for how loading works.

### Steps

1. Pick your namespace(s). Reuse `ui.*` for shared words; add to `ui` only words used across areas (`ui` is shared: append keys in your own run, do not reorder).
2. **Add the key to `en/<ns>.ts` and to all four other locales' `<ns>.ts`**, in the same alphabetical position. A new namespace also needs its `index.ts` import and spread in all five locales (the parity test fails until it is there) and its files added to `studio/scripts/shared-source.json`.
3. In the component: `const translate = useTranslate();` then `translate('style.size.width.label')`. Pass values as params: `translate('git.branch.delete', { branch })`.
4. Never concatenate a translated fragment with a value or another fragment. One whole sentence per key.
5. Plurals: a message may be `{ one: '{count} file', other: '{count} files' }`, called with `{ count }`. Check each language needs its categories.
6. Rich text (a sentence with a `<code>` or a link inside): never translate around the markup by splitting a sentence over several keys. Ask A1 to add one small helper in `src/lib/i18n/` (proposed: `translateRich(key, { file: <code>…</code> })`, which splits the translated string on `{file}` and returns React nodes); until it exists, keep the markup at the start or end of the sentence and use two keys (`...before`, `...after`), and leave a `// review` comment.
7. Translate to es, fr, de, pt-BR yourself, in the register already used (informal "du" in German). Mark doubtful lines `// review`. Keep product terms and placeholders identical.
8. Do not change wording of existing English text while migrating. If a string is wrong, fix it in a separate change.
9. Do not translate: see "Must stay English".
10. aria-labels and tooltips count as UI text. Alt text for user content does not.
11. Verify: `npx prettier --write`, `npx eslint` and `npx tsc` on touched files; `env -u ELECTRON_RUN_AS_NODE npm test -- shared/properties/i18n/catalogParity`; the suites of the folder you touched. Gate once at the end: `npm run check:changed`.
12. Tests that assert English text keep passing because English is the default; tests that read `.tsx` source for a literal string (`/label: 'Settings…'/`-style) must be updated to the key.
13. Skeletons and loading: render instantly. If something must load, use a skeleton, never plain text (`ui.loading` is only the visually hidden status).

### Key naming

`<namespace>.<area>.<thing>.<role>`, lowerCamel segments, at most 5 segments: `style.size.width.label`, `git.branch.delete.confirm`.
Roles: `label`, `title`, `aria`, `placeholder`, `hint`, `empty`, `error`, `confirm`, `cancel`. One key per distinct meaning (not per call site); the same word with a different meaning gets a different key.

## Proposed policy check (for the maintainer to approve; nothing here is implemented)

`scripts/` and the ESLint config are gate files, so this is a proposal only.

**Rule `stacki/no-raw-ui-text`** (local ESLint plugin, `scripts/eslintPlugin/`):

- Applies only to **migrated folders**, listed in one allow-list file, `scripts/policy/i18nMigrated.json`: `{ "folders": ["src/app/settings", "src/features/ai", ...], "allow": [{ "file": "...", "line": ..., "text": "...", "why": "..." }] }`. A folder is added to the list in the same change that finishes migrating it. Not-yet-migrated folders produce no errors, so the rule can land before phase 2 ends.
- Reports, in `.tsx` files of those folders:
  1. `JSXText` containing a letter, outside `<code>`, `<kbd>`, `<pre>`, and `CodeInline`/`CodeBlock` children;
  2. a string literal (or template literal) as the value of a text-bearing JSX attribute: `title`, `placeholder`, `aria-label`, `aria-description`, `alt` (not on user-content images), `label`, `hint`, `tooltip`, `description`, `text`, `message`, plus any attribute whose name ends in `Label`, `Title`, `Placeholder`, `Hint`, `Tooltip`;
  3. string literals inside `{...}` as JSX children (`{cond ? 'On' : 'Off'}`);
  4. in `.ts`/`.tsx`: object properties named `label`, `title`, `description`, `placeholder`, `hint`, `tooltip`, `confirmLabel` whose value is a string with a letter and a space or a leading capital, and string arguments to `showToast`/`setError`/`setStatus`.
- Ignored automatically: strings with no letters, single lowercase identifiers (`'flex-start'`, class names), paths, URLs, ALL_CAPS, anything under `test/`, and values in `as const` tables whose key is `value`/`id`/`kind`.
- Exceptions go in the allow-list with a `why` (for example a CSS value shown verbatim); inline `eslint-disable` is rejected, matching the other local rules.
- Cost: one AST pass per file in the existing ESLint run. The scan in this inventory is the prototype: it found the patterns above with few false positives in JSX attributes and more in option arrays, which is why rule 4 is limited to a named property list.
- Also proposed: a test (not a lint) that every `MessageKey` used in `translate('...')` literal calls exists in `en/` (the compiler already enforces it for typed calls; this catches `t` aliases) and that a migrated folder has no key outside its own namespace except `ui.*`.

## Re-running the inventory

The scanner is a throwaway script (TypeScript compiler API over the trees above, no dependencies). Re-create it from the classes above or ask for it; it is intentionally not committed because policy scripts are gate files.
