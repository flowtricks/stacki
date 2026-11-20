# The Stacki CLI

`stacki` lets people, scripts, CI and AI agents change everything that lives in a project's `.stacki/` folder
without breaking the rules the app enforces. `stacki mcp` serves the same commands to AI agents over the Model
Context Protocol. This page is the design, the safety rules, the command reference and how to extend it.

## Setting up Studio's sign-in (`npm create stacki`)

`npm create stacki@latest` installs Studio and asks "How should people sign in to Studio?": GitHub (default), Cloudflare
Access, Google, SSO (OpenID Connect) or Passkeys. For scripts and CI, `--auth github|access|google|oidc|passkey` chooses
without asking, with non-secret value flags: `--auth-client-id`, `--auth-issuer`, `--auth-name`, `--auth-allowed-domains`,
`--auth-allowed-emails`, `--auth-team-domain`, `--auth-aud`, `--auth-custom-domain` and `--auth-admin` (the first admin's
email, or a handle for passkeys). `--yes` without `--auth` keeps GitHub. Invalid or missing values fail before any file is
changed. The command never accepts a client secret: it prints the `wrangler secret put` command instead. See
`studio/docs/cloudflare.md`, "Choosing a sign-in type".

## Where it lives and why

| Piece | Path |
|---|---|
| Key reference of every `.stacki` file (what is settable) | `shared/properties/cli/files/*File.ts`, assembled in `shared/properties/cli/stackiFiles.ts` |
| Pure rules: schema DSL, config path, key-level edit, command table, arguments, output envelope, role features | `shared/properties/cli/*.ts` |
| Headless runner: project IO, plan, atomic apply, lock, undo, handlers, MCP, app extensions | `electron/project/cli/*.ts`; the component commands and the executable entry in `electron/handlers/` (`cliComponentCommands.ts`, `stackiCli.ts`), because they use the component planner and the layers let `handlers` reach `project`, not the reverse |
| Executable | `node dist/electron/handlers/stackiCli.js` (`npm run stacki -- <command>`), or the bundle `npm run build:cli` -> `dist/cli/stacki.cjs` (the `stacki` bin in `package.json`) |

**Placement decision: a new `stacki` bin, not a command of `astro-studio`.** The CLI writes through the main process's
document actors (`electron/documents`, `electron/project/projectMetadata.ts`), which Studio's vendored source does not ship, so
extending `astro-studio` would mean moving them into the Studio package: a release-pipeline change of its own. The bundle is built with
esbuild from the same sources (`scripts/build/bundleStackiCli.ts`), the way the repository bundles its other CLIs. `astro-studio
check-project` keeps working; `stacki doctor` runs the same parsers (`validateMetadata`) plus the key reference. Nothing here is published: `stacki`
runs from a checkout (`npm run build:cli`, then `node dist/cli/stacki.cjs` or `npm link`).

**Rules live in one place.** A command never re-implements a rule: breakpoints use `withBreakpointAdded`/`checkedConfig`, folders use
`addFolder`, role component rules use `setComponentState`, roles use `parseProjectRoles`/`serializeProjectRoles`, every file is finally judged
by the app's own parser (`validateMetadata`). The app and the CLI cannot disagree about what a file may hold.

## Safety rules

- **Dry run by default.** Every write prints a plan (files, what changes, refusals) as JSON (`--json`) or text. `--apply` writes. Commands that delete
  also need `--yes`; without it they refuse with `confirmation-required`.
- **All files or none.** A plan is staged in full first (every file read, edited, serialised the way the app does, and checked by the app's parser).
  Any refusal stops the whole command before the first byte is written. Apply then re-checks every file still holds the text the plan read
  (`conflict` otherwise), writes each file, and on the first failure puts back every file already written.
- **Closed-world keys.** The app's parsers ignore keys they do not know, so a typo would be dead data. The CLI refuses a key that is not in the key
  reference (`unknown-key`) before the parser sees it.
- **Never invalid.** A file the app's parser would refuse is never written; an existing file the parser refuses is never overwritten.
- **No secrets, no network.** The CLI reads and writes only the listed `.stacki` settings files. Secret-bearing and generated paths are
  "not settable" (below) and are never read, printed or written. No command uses the network.
- **Undo.** Each apply writes one journal entry (`.stacki/io/cli-journal/<id>.json`, last 16 kept); `stacki undo <id> --apply` puts the files back when
  they still hold what the apply wrote. Desktop's undo stack is in memory inside the app window and cannot be fed from another process; git remains
  the app's durable history. The journal is the CLI's own undo.

## Running app

There is no project-open lock or port file in Stacki, so none is invented. What protects the project is:

1. Writes go through the same **document actors** as the app (`writeProjectMetadata`). They take the per-file advisory lock the app takes (a lock file in
   `.stacki/io/`, with stale-owner recovery), witness the exact bytes they replace, and rename atomically. A CLI write while the app holds a file's lock
   is refused (`locked`, exit 3); a file the app changed after the CLI planned is a `conflict` (exit 3). Either way nothing is written.
2. **One CLI writer at a time:** `.stacki/io/cli-project.lock` (created exclusively, owner pid and time, abandoned after ten minutes or a dead owner).
   `--wait <seconds>` retries up to 120 seconds.
3. The app picks the new files up through its project file watcher and its metadata reconcile on window return; the temporary and lock files are in
   `.stacki/io/`, which the watcher ignores and git excludes. (Not verified against a live Desktop window in this change.)

## Output contract

`--json` prints one line: the envelope, `schemaVersion: 1`.

```json
{ "schemaVersion": 1, "ok": true, "command": "guides set", "mode": "plan", "applied": false, "project": "/abs", "role": "admin",
  "files": [ { "file": ".stacki/guide.json", "action": "create", "afterDigest": "…", "changes": [ { "path": "settings", "after": { } } ] } ],
  "notes": [], "summary": "Set the column guide." }
{ "schemaVersion": 1, "ok": false, "command": "config set", "error": { "code": "unknown-key", "message": "…" } }
```

`files[].action` is `create`, `modify`, `delete` or `move` (a move also names `from`). `mode` is `read`, `plan` or `apply`; `applied` is true only when files were written; an apply adds `undoId`; a read adds `result`. Golden tests pin the
shape and the codes (`test/shared/properties/cli/stackiCommands.test.ts`); a change bumps `schemaVersion`.

| Exit | Codes |
|---|---|
| 0 | ok |
| 1 | `unknown-key` `invalid-value` `invalid-file` `missing` `exists` `required` `refused` `confirmation-required` `apply-required` `planner-unavailable` `unsupported-file` `app-untrusted` (nothing written) |
| 2 | `usage` `not-a-project` `unknown-file` `bad-path` |
| 3 | `locked` `conflict` (retry) |
| 4 | `write-failed` `internal` (everything written was put back) |
| 5 | `role-denied` |

Options on every command: `--project <dir>` (default: nearest ancestor with `.stacki` or an Astro config), `--json`, `--apply`, `--yes`, `--wait <s>`,
`--as-role <role>`, `--login <github-login>` (or `STACKI_LOGIN`). They may come before the command (`stacki --json doctor`) or after it
(`stacki doctor --json`). After the command, a command's own argument wins a shared spelling: `roles members add` has a `role` argument, so there
`--role` is that argument and `--as-role` chooses the role to act as.

Help: `stacki --help` lists the commands the chosen role may run (`stacki --help --as-role viewer`); `stacki <command> --help` (or
`stacki help <command>`) prints that command's usage line, every argument, whether it writes, its feature and its MCP tool; `stacki <group> --help`
(`stacki roles --help`) lists a group. Help always exits 0.

`stacki doctor` exits 1 (`invalid-file`) when any settings file is refused, with the findings in `result` of the failure envelope, so CI can gate on
it; warnings alone exit 0. `stacki list components` lists every component at any depth (no count or depth cap; symbolic links are not followed).

## Commands and role features

Every command has a feature key and a role feature. `Feature` is an ordinary role feature (Settings > Roles > Command line); defaults: `cli:read` is
held by every role (read commands change nothing); every write feature is **admin only** until the owner grants it, because a write changes
files other people rely on and a newly installed command should never be runnable by accident. `cli:roles` is never grantable (like
`settings:roles`): roles edits, app trust and enabling apps' commands are admin only.

| Command | Access | Feature | Feature key | MCP tool |
|---|---|---|---|---|
| `stacki schema [file]` | read | `cli:read` | `cli.schema` | `stacki_schema` |
| `stacki list <what>` | read | `cli:read` | `cli.list` | `stacki_list` |
| `stacki doctor` | read | `cli:read` | `cli.doctor` | `stacki_doctor` |
| `stacki config get <file> [path]` | read | `cli:read` | `cli.config.get` | `stacki_config_get` |
| `stacki config set <file> <path> <value>` | write | `cli:config` | `cli.config.set` | `stacki_config_set` |
| `stacki config unset <file> <path>` | write | `cli:config` | `cli.config.unset` | `stacki_config_unset` |
| `stacki config add <file> <path> <value> [--position n]` | write | `cli:config` | `cli.config.add` | `stacki_config_add` |
| `stacki config remove <file> <path> [value]` | write, deletes | `cli:config` | `cli.config.remove` | `stacki_config_remove` |
| `stacki guides set [--visible --numbers --color --opacity --columns --margin --gutter --width-max]` | write | `cli:guides` | `cli.guides.set` | `stacki_guides_set` |
| `stacki guides clear <margin\|gutter\|widthMax\|all>` | write, deletes | `cli:guides` | `cli.guides.clear` | `stacki_guides_clear` |
| `stacki breakpoints set <id> [--value --unit --name]` | write | `cli:breakpoints` | `cli.breakpoints.set` | `stacki_breakpoints_set` |
| `stacki breakpoints add <name> --value --unit` | write | `cli:breakpoints` | `cli.breakpoints.add` | `stacki_breakpoints_add` |
| `stacki breakpoints remove <id>` | write, deletes | `cli:breakpoints` | `cli.breakpoints.remove` | `stacki_breakpoints_remove` |
| `stacki breakpoints sync <id> --value <n> [--unit rem\|px] [--from <length>] [--places checked\|all]` | write | `cli:breakpoints` | `cli.breakpoints.sync` | `stacki_breakpoints_sync` |
| `stacki roles add <name>`, `roles remove <role>`, `roles members add\|remove <role> <login>`, `roles access grant\|revoke <role> <feature>`, `roles components hide\|show <role> <path>` (or `--path <path>`) | write | `cli:roles` | `cli.roles.*` | `stacki_roles_*` |
| `stacki folders add\|remove <kind> <folder>`, `folders reset <kind>` | write | `cli:folders` | `cli.folders.*` | `stacki_folders_*` |
| `stacki apps commands` | read | `cli:read` | `cli.apps.commands` | `stacki_apps_commands` |
| `stacki apps settings set <app> <setting> <value>` | write | `cli:apps` | `cli.apps.settings.set` | `stacki_apps_settings_set` |
| `stacki apps enable <app> [--network]`, `apps disable <app>` | write | `cli:roles` | `cli.apps.enable`, `.disable` | `stacki_apps_enable`, `_disable` |
| `stacki apps add <folder\|.zip>` | write | `cli:apps` | `cli.apps.add` | `stacki_apps_add` |
| `stacki apps remove <app>` | write, deletes | `cli:apps` | `cli.apps.remove` | `stacki_apps_remove` |
| `stacki components rename <path> <Name>`, `components move <path> <folder>` | write | `cli:components` | `cli.components.rename`, `.move` | `stacki_components_rename`, `_move` |
| `stacki components duplicate <path>` | write | `cli:components` | `cli.components.duplicate` | `stacki_components_duplicate` |
| `stacki components delete <path>` | write, deletes | `cli:components` | `cli.components.delete` | `stacki_components_delete` |
| `stacki undo <id>` | write | `cli:config` | `cli.undo` | `stacki_undo` |

Config on `roles` needs `cli:roles`, on the apps files `cli:apps`, on `cli.json` `cli:roles`, whatever the command's own feature: no route around the
high-privilege features. A file also needs the app feature its UI asks (`stacki schema` shows `requires`), so a role with `cli:config` still cannot change
a file its role cannot change in the app.

### Breakpoints: moving a boundary and its media queries

`stacki breakpoints sync <id> --value <n>` does what Settings > Breakpoints does after a number is saved: the breakpoint takes the new boundary in
`.stacki/breakpoints.json`, and every media query in the project's stylesheets and the `<style>` blocks of its pages and components that still holds
the old boundary moves with it. It reuses the app's code unchanged: `scanBreakpointSync` finds the places, the dialog's `initialChecked` and
`applyRequest` choose them, `planBreakpointSyncTexts` (the same function `applyBreakpointSync` writes through) produces each new text, checked against
the scan's digest, read back and CSS-parsed, and `syncRecordAfter` remembers the places left alone in `.stacki/breakpoint-sync.json`.

- `--value <n>` (required) is the new boundary; `--unit rem|px` defaults to the breakpoint's current unit. The new value must keep the breakpoint's
  order and the canvas bounds, as in Settings. Desktop is not a media query boundary: use `breakpoints set desktop`.
- `--from <length>` (such as `64rem`) names the boundary the queries still hold when `.stacki/breakpoints.json` already has the new one (after
  `breakpoints set` or a change in Settings); the default is the saved boundary.
- `--places checked` (default) changes the places the Settings dialog checks first: exact matches not remembered as "Not synced". `--places all`
  changes every place found (inclusive and exclusive forms too).
- In a Lumos project (rem), the queries are written in rem, whatever unit they had.
- A dry run prints the files and, in `result.places`, every place found with its line, the query before and after, and whether it is synced. `--apply`
  writes the stylesheets and both settings files all or none; `stacki undo <id> --apply` puts them back. Running the same sync again succeeds and
  changes nothing (exit 0).

### Components and apps: the plan model's effects

A plan can hold two kinds of change: settings text (`Edit`s, written with the app's serializers) and **effects** (`electron/project/cli/cliEffects.ts`): a component rename or
move, creating or deleting component files, creating or deleting an installed app's folder. An effect is data (a kind and a JSON record), so the undo journal can hold it and
`stacki undo` can run its opposite after the process is gone. Effects run first, each all or nothing, then the settings files; a failure anywhere runs the opposite of
every effect already applied and puts back every file already written.

- **`components rename|move`** reuse the Components panel's planner and writer unchanged: `planComponentRenameWork` finds every reference (relative imports recalculated, aliases and quote
  styles kept, local bindings and tags renamed, `components.json` recipe keys and nested references, `roles.json` rules), `applyComponentRename` writes it all as witnessed leased
  writes through the document actors with the file moved last (a case-only rename goes through a temporary name) and every text put back on failure. The plan output carries the
  file list, "N files will be updated", and the references that are **reported, not changed** (a text file that still names the old path, a namespace tag, a file that would not parse).
- **Names are normalized like the Rename dialog** (`shared/properties/componentNaming.ts`, one function for the dialog, the CLI and the MCP tool). A typed name may use spaces and any case:

  | Typed | Pascal-case project | Dashed project (most component files are `kebab-case`) |
  |---|---|---|
  | `Accordion Cards` | `AccordionCards.astro` | `accordion-cards.astro` |
  | `hero banner` | `HeroBanner.astro` | `hero-banner.astro` |
  | `tile` | `Tile.astro` | `tile.astro` |

  Imports and tags always use the PascalCase identifier (`import AccordionCards from '../components/accordion-cards.astro'`, `<AccordionCards />`). The plan carries a note
  `normalized from "Accordion Cards" to AccordionCards` when the name changed. A character that cannot be kept (`Card 🙂`, `til/e`) is refused with that character named; a name that
  is empty after normalizing, starts with a digit or is reserved (`Fragment`, `Astro`) is refused; nothing is written either way. The MCP tool `stacki_components_rename` says so in its description,
  and `name` may be passed with or without `.astro`.
- **`components duplicate`** uses `planDuplicateTarget` and `writeCopy`: the first free name (`FooCopy`, `FooCopy2`, ... or `foo-copy`, `foo-copy-2` for dashed names).
- **`components delete`** uses `planRemoveTarget`: refused with "Used in N places" while any other file uses the component, otherwise the files and the `.stacki` text that names
  them go (`components.json` recipe and nested references, `roles.json` rules). Needs `--apply --yes`. **Where deleted files go:** the operating system's Trash is reachable only from the
  Electron app (`shell.trashItem`), so a CLI delete is kept in the CLI undo journal, text for text; `stacki undo <id> --apply` writes every file back and the settings are restored only
  while they still read as the deletion left them. The shared planners were split out of the app's `componentOps.ts` (`planDuplicateTarget`, `planRemoveTarget`, `planMetadataChanges`) so the
  panel and the CLI run the same code.
- **`apps add <folder|.zip>`** reads the source with the app's own bundle readers (the same file-type, size and remote-code checks as an upload) and plans the files under
  `.stacki/apps/<id>/` plus a lock entry (source `local`, the folder digest) in `.stacki/apps/apps.json`. **No network:** a URL, `github:` or `npm:` source is refused with the way to install it
  (the Apps panel: marketplace, GitHub or a file), because a download needs the signed-in account, marketplace approvals and the update policy the panel holds. An app that declares CLI commands stays
  off until `stacki apps enable <id>` is applied by an admin.
- **`apps remove <app>`** removes the folder (journalled byte for byte, so undo restores binary files too), the lock entry, the app's record in `.stacki/cli.json` and its non-secret values in
  `.stacki/apps/settings.json`. The app platform has no dependency between apps (no manifest key names another app), so there is nothing for a removal to refuse on that ground. An app's sealed
  secrets live in its vault outside the project and are not touched.

## Reference: every `.stacki` file

`stacki schema` prints these (also MCP tool `stacki_schema` and resources `stacki://schema/<id>`; current text as `stacki://state/<id>`).
`stacki config <verb> <file> <path>` reaches every key; the paths read like `settings.visible`, `entries[3]`, `components["src/Card.astro"].tag`.

| File | Keys | Domain commands | Needs |
|---|---|---|---|
| `.stacki/guide.json` | version, settings | guides set/clear | `settings:editor` |
| `.stacki/breakpoints.json` | version, desktop, breakpoints | breakpoints set/add/remove/sync | `settings:breakpoints` |
| `.stacki/breakpoint-sync.json` | version, per-breakpoint records | breakpoints remove/sync | `settings:breakpoints` |
| `.stacki/roles.json` | version, defaultRole, roles (id, name, members, access, appPermissions, pinnedApps, componentRules) | roles ... | `settings:roles` |
| `.stacki/components.json` | version, components (props, text, children, nested component refs) | components rename/move/duplicate/delete | `component:edit` |
| `.stacki/component-sources.json` | version, sources | config | `settings:folders` |
| `.stacki/folders.json` | version, folders, cms | folders add/remove/reset | `settings:folders` |
| `.stacki/pages.json` | version, entries | config | `panel:pages` |
| `.stacki/publish.json` | version, defaultTarget, githubAccount, hosting, buildScript, beforePublish, afterPublish, githubWorkflow, publishedSite | config | `publish` |
| `.stacki/styles.json` | version, keep, lockedStylesheets, newStyleTag (`version` 2, `attributes`, `content`; version 1 `isGlobal` is read), newStyleLocations (`page` and `component`, each `use` tag or file, `file`, `tag`) | config | `panel:selectors` |
| `.stacki/variables.json` | version, hiddenFromSuggestions | config | `panel:style` |
| `.stacki/audits.json` | version, ignored, ignoredPages, checks, tokens, placeholders | config | `panel:audits` |
| `.stacki/instructions.json` | version, hidden | config | `instructions:edit` |
| `.stacki/apps/apps.json` | version, apps (the install lock) | apps add/remove | `settings:roles` |
| `.stacki/apps/settings.json` | version, apps (non-secret values) | apps settings set | `panel:apps` |
| `.stacki/cli.json` | version, apps (enabled, trusted, sha256, network) | apps enable/disable | `settings:roles` |
| App-declared files | declared in the app's manifest `cli.files` | the app's commands | `cli:apps` |

**Not settable (never read, printed or written):** `.stacki/preview/` and `.stacki/canvas/` (generated, git-ignored), `.stacki/io/` (write staging, locks and the CLI
journal), `.stacki/studio/` (Studio machine state), `.stacki/studio-app-secrets/`, `.stacki/studio-media/`, `.stacki/studio-cms/` (credentials),
`.stacki/studio-app-storage/` and `.stacki/app-data/` (app runtime data), `.stacki/apps/<id>/` (installed app code: installed and removed only through apps
commands), `.stacki/cms.json` (an untyped map the CMS panel writes with no parser in the app: the CLI will not write data the app cannot validate; it
needs an app-side parser first). Desktop's CMS and media connections, app secrets and tokens live in the app's user-data folder, not in the project.
Written outside `.stacki` and out of scope: `.mcp.json`, `~/.codex/config.toml`, `.env`.

## The coverage rule (the "everything that can be set" guarantee)

`test/shared/properties/cli/stackiSchemaCoverage.test.ts` fails when: a project metadata kind has no registry file; a registry file's empty document is
refused by the app's own parser; a key a parser reads (`value['key']`, `.get('key')`, `for (const key of ['a', 'b'])`, in the parser sources each
registry file names) is neither in the registry nor listed with a reason in `parserKeyExceptions`; the app's source names a `.stacki/...` path that is neither
a registry file nor in `STACKI_UNSETTABLE`; a registry key names a command that is not in the table. So adding a setting to the app without CLI
coverage breaks the build. It is a source scan, not a proof: a parser that builds a key name dynamically, or reads keys through a helper in another
module, is not seen; list that module in `parserSources`.

**For the owner to add to `docs/enforcement.md`** (gate-defining; not edited here), under the rule map's Core patterns:

| Rule | Mechanism |
|---|---|
| Every `.stacki` setting is reachable through the CLI: a key a parser reads, and a `.stacki` path the app writes, is in the key registry (`shared/properties/cli/files/`) or is listed as not settable with a reason | test: `test/shared/properties/cli/stackiSchemaCoverage.test.ts` (source scan of the parsers and of the app's `.stacki` path literals) |
| Every CLI command has a role feature, a unique feature key and a handler, and every command is in the table the MCP tools come from | test: `test/shared/properties/cli/stackiCommands.test.ts`, `test/electron/handlers/cliCommandTable.test.ts`, `test/electron/project/cli/mcpServer.test.ts` |
| Components and apps with rules across files are changed by domain commands that reuse the app's planners | test: `stackiSchemaCoverage.test.ts` (commands named), `test/electron/handlers/cliComponentCommands.test.ts`, `test/electron/project/cli/cliAppsInstall.test.ts` |
| CLI output contract and exit codes do not drift | test: golden values in `stackiCommands.test.ts` |
| Code that writes `.stacki` from the CLI goes through `writeProjectMetadata` / the document actors | review (`electron/project/cli/cliFiles.ts` is the only writer) |

## Roles and identity

Reuse, not a second system: roles live in `.stacki/roles.json`; `can()` decides; the CLI group is listed in Settings > Roles with the same toggles
as other features; apps' own switches use `appPermissions`.

| Tier | Where the role comes from | Strength |
|---|---|---|
| Studio / hosted | The authenticated identity, resolved server-side by Studio's existing role resolution, on every write Studio makes (metadata, roles, apps) | **Enforced.** Studio exposes no CLI endpoint; nothing here weakens it. A hosted CLI route would call `runCommand` with the authenticated role (not built). |
| Local human | `--login <github login>` / `STACKI_LOGIN` maps to roles.json members (an unlisted login gets the default role); no claim means the project owner (admin) | **Cooperative.** Anyone who can run the CLI as the owner, or edit `roles.json`, can pick another role. |
| `--as-role <role>` in a shell | Acts as that role for the command, to test or restrict a script | Cooperative, same reason. |
| AI agent over MCP | `stacki mcp --role <role>` (or `--login`): pinned by whoever configures the server; **tool inputs cannot change it** (an unknown `role` input is refused); `tools/list` shows only what the role may run; `tools/call` re-checks. **In a project with `.stacki/roles.json`, a server started without `--role` or `--login` runs no tool** (an empty `tools/list`, every call refused with `usage` and the reason, also printed on stderr at start): it never falls back to admin, so an agent's power is chosen on purpose; `--role admin` acts as admin. Without a roles file everyone is the owner, as in a shell. | Cooperative on a local machine (the agent runs as the owner's user), strong against the model choosing its own role. Writes are still plans until the user approves `apply`. |

A denied command answers `role-denied` with the feature key and the role and **no plan details**; denied commands are absent from `--help` and MCP `tools/list`. The role
is never passed to an app's code handler and never read from a command's own arguments.

## MCP

`stacki mcp [--project <dir>] [--role <role>] [--login <github-login>]` speaks newline-delimited JSON-RPC 2.0 on stdio: `initialize`, `ping`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`, and notifications. Hand-written on purpose (no dependency, AGENTS.md section 17: the surface is small, the SDK
would add a dependency tree to a tool whose point is a small auditable surface); the protocol tests pin it. Tools are the command table
(`stacki_<words>`); write tools take `apply` (default false) and deletes also `yes`; descriptions tell the agent to **plan first, show the user the plan, and apply only
on approval**. Input is read line by line, one message in memory at a time. Tool results are the same envelope (`structuredContent` and text); a
refusal speaks in tool terms (a deletion asks for `apply=true` and `yes=true`, not `--apply --yes`). After an applied call that changes what the role
may run (`apps enable`, `apps disable`, a roles edit) the server sends `notifications/tools/list_changed`, and after one that adds or removes a settings
file `notifications/resources/list_changed`, as its `initialize` capabilities promise.

## Adding a command

1. Add a row in `shared/properties/cli/stackiCommands.ts` (words, summary, access, feature, args). The feature key and MCP tool come from it.
2. Add a handler in `electron/project/cli/cliCommands.ts` (`CORE_HANDLERS`) returning a read result or `Edit`s. Use the app's own planner for the rule; never copy it.
3. If it touches a new file or key, add it to the file's registry in `shared/properties/cli/files/` (and the file to `STACKI_FILES`).
4. Tests: dry run vs apply, a refusal, a role denial. The table, coverage and MCP suites check the rest.

## Extending the CLI from an app

An installed app can add commands to `stacki` and to its MCP server, and its own settings files to `stacki schema` and `stacki config`.
Declare them in a `cli` section of `stacki-app.json`.

### Example manifest

```json
{
  "manifestVersion": 1, "id": "notes", "name": "Notes", "version": "1.0.0", "entry": "index.html",
  "permissions": [{ "id": "reset", "label": "Reset the title", "default": false }],
  "cli": {
    "apiVersion": 1,
    "network": false,
    "files": [{
      "id": "notes.settings", "path": ".stacki/apps/notes/settings.json", "description": "Settings of the notes app.",
      "keys": {
        "title":    { "type": { "kind": "string", "charsMax": 40 }, "description": "The board title.", "default": "Notes" },
        "pageSize": { "type": { "kind": "integer", "min": 1, "max": 100 }, "description": "Notes per page.", "default": 20 }
      }
    }],
    "commands": [
      { "name": "set-title", "description": "Set the title of the notes board.", "writes": true,
        "input": { "type": "object", "properties": { "title": { "type": "string", "description": "The new title.", "maxLength": 40 } }, "required": ["title"] },
        "owns": [{ "file": "notes.settings", "keys": ["title"] }],
        "handler": { "kind": "declarative", "operations": [{ "op": "set", "file": "notes.settings", "path": "title", "value": { "$input": "title" } }] } },
      { "name": "shout", "description": "Upper-case the title.", "writes": true, "permission": "reset",
        "owns": [{ "file": "notes.settings", "keys": ["title"] }],
        "handler": { "kind": "module", "entry": "handler.mjs", "timeoutSeconds": 5 } }
    ]
  }
}
```

A declarative handler is a fixed list of `set|unset|add|remove` operations on keys the command owns; no code runs. `{"$input": name}` takes the value of a declared
input and is checked like `config set`. Commands live in the app's namespace (`stacki notes set-title`, tool `stacki_notes_set-title`); an app cannot define a command that
collides with a core command or another app's namespace (refused at load, naming both). `cli.apiVersion` must be `1`; anything else is refused. A malformed section turns off that
app's commands only (the reason shows in `stacki apps commands`).

### Module handler (`handler.mjs`)

```js
let text = '';
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text.split('\n')[0]);   // { protocol: 1, phase: 'plan', command, input, state: { 'notes.settings': {...} } }
const title = (request.state['notes.settings'].title ?? 'notes').toUpperCase();
console.log(JSON.stringify({ ok: true, summary: 'Shouted the title.', operations: [{ op: 'set', file: 'notes.settings', path: 'title', value: title }] }));
// or { ok: false, message: '...' }; a read-only command may answer { ok: true, summary, result }.
```

The module answers one JSON line and never writes files. The CLI checks each operation against what the command `owns` and the key reference, then applies them atomically
after `--apply`. The module runs once per invocation, always as phase `plan`.

### Turning it on

```
stacki apps commands                      # lists the app's commands, state and any refusal reason
stacki apps enable notes [--network]      # a plan: shows commands, files they may touch, app code, network
stacki apps enable notes --apply          # admin only; records enabled + trusted + the lock digest in .stacki/cli.json
stacki apps disable notes --apply
```

An update changes the lock digest, so the app's commands stay off until `apps enable` is run again. A role needs `cli:apps`, `panel:apps`, `app:<id>` (or `app:*`)
and, if the command declares one, the app permission switched on in Settings > Roles. Commands use the same dry run, JSON envelope, project lock and `stacki undo` as core
commands. MCP tools are `stacki_<appId>_<command>` and follow enable and disable on the next call.

### Security model

Enforced:

- The app must be installed (lock entry and a real folder, no symlinks), enabled, trusted, and its lock digest unchanged since it was trusted.
- Roles are checked through the existing role model, both when listing tools and when calling them; app code never sees the role.
- Operations are limited to owned keys and checked against the key reference before any write; an app can never own `roles`, `cli` or `apps`.
- Handlers never write. Modules run in a child process (`process.execPath`, no shell) with an empty environment (`STACKI_CLI_PROTOCOL` only), `--permission` with read
  access to the app folder only (no project read, so no `.env`; no file write, no spawn, no workers or addons), a wall-clock timeout and bounded output.

Not enforced:

- **The network.** Node's permission model cannot block sockets. `cli.network` is a declaration an admin accepts with `apps enable --network`; a module that declares network
  is refused until then, and a plan note says it runs app code. A module can still reach the network on a platform that does not restrict it.
- CPU and memory (only wall-clock time).
- Changes made by hand to the app folder after it was trusted (the digest is the archive's).
- Roles on a local machine remain a cooperative guardrail.
