# Error-proofing

The product rule: **an edit made in Stacki never leaves a page Astro cannot render.** Stacki is for
designers and clients, who do not read stack traces. When a gesture would break the page, Stacki
repairs it on the spot, offers a one-click fix, or holds the change and says why in plain words.
Typing stays live: the canvas updates as the person types, and nothing they type is ever blocked.

This file is the contract (what each layer guarantees), the audit of every gesture that writes source
(what it can break, what protects it today, what is left), and what to add to `docs/enforcement.md`.

## The three layers

| Layer | Where | When it runs | What it guarantees |
|---|---|---|---|
| Gesture planning | `src/app/state/*`, `src/editor/*` | Before the edit is committed | The gesture carries what it needs (context-aware paste, extraction, pruning on delete, placement gate) |
| Pre-flight | `shared/engine/preflight.ts`; main's gate `electron/documents/documentPreflight.ts`; the paste's own call in `src/app/state/appContextPaste.ts` | Between the planner and the writer, on the candidate bytes | No gesture adds an error to a file; typed code is advised, never blocked |
| Recovery | `src/app/state/appCompileRecovery.ts` | After the dev server renders | A page that fails right after an edit offers "Undo last change" |

### Context-aware paste (`src/editor/pasteDependencies.ts`)

A paste into another file carries the markup's dependency closure, read with the scope reader that
Create component uses (`readStatements` in `src/editor/extractFrontmatter.ts`):

1. **Imports** it uses (components, helpers, assets). The named, default, namespace or type-only form
   travels with the import record (`ImportDecl`), so `import { getCollection } from 'astro:content'`
   stays named. Relative specifiers are re-aimed for the target's folder; a project component is
   imported from where it lives, in the target's alias style. An import the target has (same name,
   same module) is reused; one whose name the target binds otherwise is renamed (`Button2`) in the
   import and in every tag.
2. **Frontmatter** the markup reads, transitively, in source order, when it means the same in the
   target: literals, objects, arrays, plain functions, content-collection reads. Colliding names are
   renamed in the copied code and in the markup.
3. **Props** (`Astro.props`, destructured or read directly) become a `const` each: the destructure's
   default when it is self-contained, else a placeholder (`[]` for a list, `{}` for an object, `''`
   otherwise), named in "What changed". Nothing is left undefined.
4. **`<slot>`** in a page is replaced by its fallback content.
5. **Styles**: the rules whose classes and ids are all on the copy (`::before`, nesting and `@media`
   included) go into a NEW style tag shaped by `newStyleTag` (`is:global`, template). A rule the
   target holds word for word is not written twice; tag-only rules (`h2 {}`) are left behind and
   listed, because written into a page they would restyle every match. `define:vars` travels when a
   carried rule reads one of its variables; `@keyframes` an animation names travel too. No existing
   rule is edited.

What cannot travel (it reads `import.meta`, `process.env`, `Astro.request`, `Astro.locals`, waits on
a request that is not a collection read, runs for its effect, or is changed by other code) is never
copied silently. A custom choice dialog asks, in plain words: paste as a component instance
(recommended when the copy is the component's root), paste the markup with values filled in, or
cancel. The whole paste is one gesture and one undo step; the toast reads "Pasted. Also brought
along: 2 imports, 1 value, 3 style rules" with **Undo** and **What changed**. A paste within the
same file is unchanged.

### Pre-flight (`shared/engine/preflight.ts`)

`preflightVerdict(operation, { before, after }, resolve)` reads both files and keeps **only the
findings the edit adds** (counted per code and subject). A file that was already odd never blocks an
edit elsewhere in it; that is what keeps the false-positive rate at zero on unmodified files.

| Code | Severity | Remedy | Breaks because |
|---|---|---|---|
| `undefined-name` | error | explain | ReferenceError while rendering |
| `missing-component` | error | one-click: add the import | Astro cannot resolve the tag |
| `default-from-module` | error | auto-fix: named import | `astro:content` and friends have no default export (`… .default is not a function`) |
| `duplicate-name` | error | one-click: rename | The frontmatter does not compile |
| `missing-file` | error | explain | Vite cannot resolve the import (checked by main against the disk, Vite's extension order) |
| `named-from-astro` | warning | auto-fix: default import | A component file's component is its default export (helpers exported from a frontmatter are fine and never reported) |
| `props-in-page` | warning | one-click: fill in the value | A page without `getStaticPaths` receives no props |
| `frontmatter-syntax` | warning | explain | Lezer cannot read it; TypeScript may still (so never an error) |

**Policy per operation** is `PREFLIGHT_CHECKS`, typed `Record<OperationTag, …>`: a new planner
operation does not compile until it states its checks and policy, and
`test/shared/engine/preflight.test.ts` reads the operation union in `shared/engine/intent.ts` and fails
on a missing or extra entry.

- `refuse-new-errors` (insert, append, move, wrap, delete, rename tag, rename binding, insert
  frontmatter): a new error rejects the intent with `would-break-page`. Nothing is written, so the
  canvas keeps its last good render and the optimistic change is taken back (`onRefusedGesture`).
- `advise` (attribute and prop values, rewrite of a node, typed code patches, the frontmatter slot,
  reverts, program rewrites): never blocks. Main does not even parse on this path, so a keystroke's
  write pays nothing; a page that then fails to compile gets the recovery notice.

**Real time.** Pre-flight is never on the keystroke's path: typing writes are `advise`. Gestures are
one per click; the gate parses the base (cached by checksum, usually the previous write's candidate)
and the candidate. Measured on this machine (generated pages, 20 runs, both parses uncached, which is
the worst case):

| Page | p50 | p95 |
|---|---|---|
| 6 KB (50 sections) | 6 ms | 29 ms |
| 44 KB (400 sections) | 31 ms | 39 ms |
| 222 KB (2000 sections) | 160 ms | 191 ms |

The checks alone (no parse) on a 400-section page are under 50 ms at p95
(`test/shared/engine/preflight.test.ts`). A gate pass over 50 ms is logged (`preflight slow …`).

**Corpus.** Every unmodified file of `test/corpus/` produces zero errors (in the gate). Swept
read-only over 6578 `.astro` files of real sites (set `STACKI_PREFLIGHT_CORPUS`), the remaining
error findings are vite `define` globals (`ENV_CLIENT`), files that do not parse as Astro, and test
fixtures that are wrong on purpose; none of them blocks an edit, because only added findings count.

### The CLI

`stacki` plans write only `.stacki/*.json` today (`electron/project/cli/cliPlan.ts` `stage`), never an
`.astro` file, so no plan has anything for pre-flight to read. The first command that stages an
`.astro` edit runs `preflightVerdict` in `stage` with the same table, lists findings and remedies in
the plan output, and `--apply` refuses a plan with errors unless `--force-preflight` is given
(follow-up 6).

## Audit: every gesture that writes source

Legend: **Now** is the protection that exists, **Gap** what can still break, **Plan** the fix.

| Gesture | Error classes it can cause | Now | Gap | Plan |
|---|---|---|---|---|
| Paste into another file | undefined name/prop, missing import, default/named mismatch, duplicate name, missing styles, slot in page | Context-aware paste + pre-flight (this change) | Call-site prop values are not read (defaults or placeholders instead) | Follow-up 1 |
| Paste in the same file | invalid nesting, loop variable out of scope | Placement gate, loop bindings stripped with a notice | None known | — |
| Duplicate | second doctype, invalid nesting | Placement gate | None known | — |
| Insert element / component | missing import, invalid nesting, `<Image>` without `src` | Import added with the node, placement gate, placeholder props | Pre-flight now refuses a missing import | — |
| Insert loop / condition | undefined source | `[].map` and `true` starters | Pre-flight refuses a source naming nothing | — |
| Drag / move within a file | loop item read outside its loop, slot attribute meaningless | Placement gate, bindings stripped, `slot` dropped | None known | — |
| Drag between files | as paste | Not a gesture today | — | Reuse `planPaste` when it exists (follow-up 2) |
| Delete | dangling reference to a loop variable or a removed declaration | Unused frontmatter pruned only when provably unused; pre-flight on `remove-node` | Deleting a `<slot name>` other files fill is silent (renders nothing, no error) | Follow-up 7 (warning) |
| Wrap / unwrap | invalid nesting | Placement gate; pre-flight on `wrap-nodes` | None known | — |
| Rename tag | `<Card>` with no import | Pre-flight on `rename-tag` | — | — |
| Swap component | props the new one lacks (warning only at runtime) | Prop schema | Unknown props pass silently | Follow-up 8 |
| Prop / variant / slot content | invalid expression, wrong type | Typed fields, `advise` pre-flight | A typed expression naming nothing renders an error until fixed | Follow-up 3 (inline cue) |
| Attribute / class edits | unquoted value, bad `class:list` | Attribute writer quotes; class:list migration is one rewrite | None known | — |
| Text edits, bound text | `{` in prose read as an expression | Text writer escapes; entity text work | None known | — |
| Loop settings (source, filter, sort, limit) | undefined source, `Source=None` import left behind | Loop editor; separate fix in flight (Source=None import) | — | — |
| Expression field, `{}` toggle | undefined name, syntax error | `advise`, recovery notice | No inline cue at the field yet | Follow-up 3 |
| Frontmatter editor (Code panel) | syntax error, duplicate name, undefined name | `advise`, recovery notice | No squiggle with friendly words yet | Follow-up 3 |
| Style panel (create `<style>`, rules) | — (CSS errors do not stop a render) | newStyleTag template, never rewrites user CSS | — | — |
| Create component from selection | values left behind, props mismatch | `readExtraction` moves or passes every value | — | — |
| Component rename / move | stale imports in other files | `componentRename.ts` plans every file, all or nothing | — | — |
| Component delete | imports of a deleted file | Refusal while in use (existing) | — | Pre-flight `missing-file` covers the next edit of an importer |
| Page create / rename / delete / move | broken links, duplicate routes, dynamic route without `getStaticPaths` | `pageRenameConflicts.ts` (route clash) | Dynamic page created without `getStaticPaths` | Follow-up 5 |
| CMS / collection changes | schema mismatch | Schema checks (`astroSchemaChecks.ts`) | — | — |
| Image / asset ops | import path of a moved asset | Asset handlers rewrite paths | — | — |
| Import management | default vs named | Named form kept on paste (64bce26f); a pasted default import of a named-only module is repaired before the write; pre-flight `default-from-module` refuses it elsewhere | Other gestures refuse rather than repair | Follow-up 4 |
| Frontmatter inserted into an imports-only block | statement printed above the imports (ugly, confusing) | Fixed in this change (`moveOffsets`) | — | — |

## Prioritized follow-ups

1. **Call-site prop values.** When the copy comes from a component opened from an instance, read the
   instance's props on the host page and flatten those, before falling back to defaults.
2. **Drag between files** through `planPaste`, once dragging across files is a gesture.
3. **Inline cue for typed code.** Run `preflightFile` in the renderer on the optimistic model
   (debounced, under 50 ms, no parse: the model is already there) and show "This would cause an error:
   … · Fix it" at the field and as a squiggle in the code panel.
4. **Apply auto-fixes in every gesture.** The paste already repairs a default import of a named-only module; the remedies are typed, so an insert can rewrite a
   default import of `astro:content` to the named form before the write instead of being refused.
5. **Dynamic routes.** Creating `[slug].astro` adds a `getStaticPaths` stub.
6. **CLI pre-flight** in `stage` with `--force-preflight`, when a command writes `.astro` files.
7. **Slot removal warning** when other files fill the slot by name.
8. **Swap component** warns about props the new component does not declare.
9. **Friendly compile messages.** Map the commonest Astro and Vite errors (`X is not defined`, `Cannot
   read properties of undefined`, `… .default is not a function`) to the pre-flight sentences in the
   recovery toast, with "Technical details" and Copy, and confirm SSR TypeErrors from the dev server
   reach `onPreviewFailed` (the recovery hook reads `PreviewHealth.thrown`; not verified end to end).

## For `docs/enforcement.md` (owner approval needed)

| Rule | Check |
|---|---|
| Every planner operation declares its pre-flight checks and policy | `PREFLIGHT_CHECKS: Record<OperationTag, …>` (compile) and `test/shared/engine/preflight.test.ts` (reads the operation union) |
| No gesture adds an error to an `.astro` file | `electron/documents/documentPreflight.ts` in the document actors; `test/electron/documents/documentPreflight.test.ts` |
| Pre-flight has no false positives on unmodified files | Corpus test in `test/shared/engine/preflight.test.ts` |
| A cross-file paste carries its dependencies | `test/renderer/editor/pasteDependencies.test.js` |
