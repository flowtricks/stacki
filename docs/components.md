# Creating components

How "Create component" (Components panel, ⌘⇧A) decides where a new component goes and what it writes. Renaming and moving
an existing component is a separate flow (`componentRenamePlan.ts`); both share the name and folder rules in
`shared/properties/componentNaming.ts`.

## The folder

- The dialog has a **Folder** field under **Name**: the custom `Dropdown`, never a native select.
- It opens on the **components root** (`<root> (root)`, the first folder in `.stacki/folders.json`, `src/components` by
  default) every time. The last choice is not remembered, so a component lands where it always has unless someone picks.
- The list holds the root, every folder below it that holds a component (nested ones as paths: `Form`, `Global/Layout`) and
  the folders between, and a last **New folder…** row that opens a field for a typed path. Folders come from the project
  scan, so the list is instant; an empty folder on disk is reached by typing it.
- The hint under the name follows live: `<div> becomes <Div />, saved as src/components/Global/Layout/Div.astro`.

### Typed folders

`parseTypedFolderPath` normalizes each level in the folders' own style (PascalCase or dashed, `detectFolderStyle`), turns
backslashes into slashes and drops a trailing slash. It refuses, with the reason shown under the field and Create disabled:

| Typed | Reason |
|---|---|
| `..`, `a/../b`, `./a` | climbs out of the components folder |
| `/a`, `C:\a`, `~/a` | starts at the disk |
| `a//b`, `a/ /b` | an empty level |
| `a*b`, `a:b` | a character no name can hold (named) |

A level that differs from an existing folder only in case takes the existing spelling (`global/layout` is `Global/Layout`),
in the dialog from the scan and again in main from the disk: on a Mac they are one folder, and two spellings would split a
group in the Components panel.

## Names

- A name is **taken only in the chosen folder**, compared without case: the dialog checks the scan, main checks the folder on
  disk before it writes.
- The same name in **another folder is allowed with a warning**: tags and imports are written by name, so a page that
  imports both must alias one.

## What main writes

- `component:create` takes `folder` (below the root, `''` for the root). The boundary parser (`parseComponentSubfolder`)
  and `componentFile` both refuse a folder that climbs out, starts at the disk, has an empty level or an illegal character.
- `componentFile` reports the folders that do not exist yet (outermost first); the handler makes them, writes the file and
  returns them with the checksum.
- Imports that travel into the new file are re-aimed from its own folder. The page or layout that receives the instance
  imports it through `componentImportPaths`: the project's alias when one verifiably reaches the file, else a path relative
  to the receiving file (`../components/Form/Div.astro` from `src/pages/index.astro`, `../../components/…` one level deeper).

## Undo and redo

One undo step covers the page edit and the file (`componentCreation.ts`). Undo deletes the file while it holds the bytes it
was written with, then removes the folders the creation made, deepest first, while they are empty; a folder that holds
something put there since stays, with every folder above it. Main removes only folders inside a component folder that hold
the component, never a component folder itself. Redo writes the file again and records the folders it made this time.

## Where else components are made

- **Duplicate** (Components panel "…") copies next to the original, so it keeps its folder.
- **Rename / move** already takes nested folders; its **New folder…** field uses the same typed-folder rules.
- **Paste** and the **CLI / MCP** do not create component files. **Studio** shares the dialog but does not offer creation.
- The Components panel groups by the scan's folder, so a new component appears in its folder's group after the rescan that
  follows creation.

## Deleting a component

Delete in the Components panel's "…" menu is one step over the whole site, planned before anything is written
(`electron/handlers/componentRemovalPlan.ts`, applied by `componentOps.ts`), and one Undo puts every byte back.

- **The confirmation** (`src/app/shell/componentRemovalDialog.tsx`, the window's own dialog) says what will happen: the file
  moves to the Trash; N instances leave M files (listed with counts); N imports are removed; the `.stacki` settings that name it
  are cleaned. With nothing using it, it still asks, in one line.
- **Instances** go with everything inside them, the comment that labels them and the whitespace before them: the span Delete on
  the canvas takes. **Imports** go wherever they bind the component: default and aliased imports, `{ default as Div }`,
  side-effect imports, extension-less and `@/` specifiers, and `{ Div }` through one barrel (whose own `export … from` line goes
  too); in `import { Div, Card } from` only `Div` goes. **Settings**: its recipe and every nested `component` reference in
  `.stacki/components.json`, and its rules in `.stacki/roles.json`.
- **Refused, nothing written**, with every place listed by file and line: `import()` or `require()` of it, an
  `import.meta.glob` / `Astro.glob` that matches it, a re-export chain (a barrel of a barrel, `export … from` in an .astro file),
  a use as a value (`{Div}`, `{ Div }` in code, `<Div.Item>`, `UI.Div`), an instance inside a `{…}` expression, an instance in
  Markdown or MDX, a Markdown `layout:` naming it, and a file that names it but does not parse. Show instances stays available.
- **Order**: every edited page is written first (leased together; a failure puts back what was written), then the settings,
  then the file goes to the Trash. Undo writes the file back first, then the pages, then the settings. Each edited page must
  still parse after the edit, or the whole plan is refused.
- **The dev server**: the canvas patches pages instead of reloading them, so the browser keeps the deleted component's
  stylesheet modules (`Div.astro?astro&type=style&index=0`). When the file goes, Vite sends their update, the browser asks for
  them again and Astro answers "No cached compile metadata found", shown as its error overlay. The preview plugin
  (`electron/preview/markerConfig.ts`) must leave those modules out of a deleted file's update: a style count of 0 for a file
  that is gone.
- Duplicate's Undo deletes the copy with `uses: 'refuse'`: a copy something now uses is kept. The CLI's `components delete`
  refuses a used component the same way.

## How a component's text is edited

"Set component defaults" ends its Settings group with two switches, both off by default. Each writes
`.stacki/components.json` at once, as a key on the component's own recipe that exists only while on (`"lineBreaks": true`,
`"richText": true`); turning one off removes the key, and an owner left empty goes with it, so the file returns byte for
byte. Older Stacki versions read recipes key by key and skip these keys, so they keep reading the file; a defaults save
made in an older version rewrites the file from what it parsed and drops them. Renames and moves carry them
(`relinkDefaults`); the CLI's `components` schema describes them, so `stacki config set` can turn them on.

| Setting | Offered for | Canvas | Properties panel |
|---|---|---|---|
| Allow line breaks | Every component | Enter and Shift Enter type a line break, saved as `<br />`; ⌘/Ctrl Enter finishes, Escape cancels, a click away saves | The Content field, which already wrote `<br>` for Enter, is unchanged |
| Allow rich text editing | A component with a default slot that is not a line of words (`<slot />` not inside `<p>`, a heading, a link…), or a `set:html` (`richTextAllowed`) | Enter in a paragraph, heading, quote, list item or code block types a break that is saved as a new block, inline formatting split with it; a heading goes on as a paragraph, a list item as another item | Content becomes **Edit rich text**, which opens the rich text editor in a dialog; `+` beside an empty block chooses Heading 1–6, Paragraph, Quote, Image, Link, Video, lists, divider or code block |

With both on, rich text's Enter wins in a block. A stored rich text setting on a component that no longer qualifies is
ignored and kept, and `check-project` names it. The rich text editor opens only content it can give back unchanged in
meaning (`richTextView`, `src/features/props/richTextContent.ts`): native rich text tags with plain attributes. A
component, an expression, a comment, a directive or an unknown tag or attribute shows the content as highlighted code
instead, the `{}` beside the label locked on code with a tooltip saying why. Code is written as one patch of the bytes
between the instance's tags, when the code view loses focus, and refused when those bytes changed meanwhile.

Not yet: Studio and the demo draw the same panel components but pass neither setting, so they edit as before; the `+`
menu lives in the dialog, not on the canvas; a set:html component qualifies for the setting but its prop is still edited
by its own field.
