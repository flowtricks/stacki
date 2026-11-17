# Editing data-bound text on the canvas

Text a page prints from data (`<p>{aiCallout1.body}</p>`) is edited on the canvas by double-clicking it.
The words are written back to the string literal they come from, in whichever file holds it, and the
canvas says so while it happens. This page is the contract; losing any line of it is a regression.

## History (why this page exists)

| Version | What worked |
|---|---|
| 0.1.93 (`fc7b3e10`) | Only a bare name bound to a top-level `const x = "text"` in the page's frontmatter, or a string literal inside the braces. |
| later 0.1.x | Text a component prop sets to a **literal** (`heading="Words"`); CMS entries read by `getEntry` with literal collection and id. |
| this feature | Member paths (`aiCallout1.body`), imported project modules, JSON files, props bound to a path, loop items. |

A path with a dot in it was never edited on the canvas before. It was not a regression of a working feature,
it was the case the first release never covered (`canvasTextBinding.ts` reads a bare identifier only).

## Behaviour

| Source of the words | Edited where |
|---|---|
| A top-level `const` object or array literal in the page's frontmatter (`const card = { body: "…" }`) | The page itself, one history step |
| `import { aiCallout1 } from '@lib/homepage/content'` (named, aliased, default, `export { a as b }`, `export { a } from`, `as const`, `satisfies`) | That module, one history step |
| A `.json` file imported as data | That JSON file |
| A prop the page binds (`<Card body={aiCallout1.body} />`) printed by the component as `{body}` | The source the binding leads to |
| `{card.title}` over `cards.map(...)` where `cards` is a literal list (nested loops too) | The item's own literal; one canvas target per item |
| A content-collection entry read by `getEntry` | The entry (unchanged, `canvasTextContent.ts`) |

The literal keeps the quote style it was written in (`"`, `'`, a backtick template without holes, or JSON's
double quote), escaped as that style needs. Every byte but the literal is unchanged, and Undo writes the old
bytes back. A file that no longer holds the literal that was traced is never overwritten: the edit is
refused ("The data changed on disk while editing").

### Refused, with the file to edit instead

The tracing never runs project code. A value that is not one plain string is not editable in place; the
double click names why and where (`preview.text.source.blocked.<reason>`), nothing is written.

| Reason | Shape |
|---|---|
| `concatenation` | `"a" + b` |
| `call` | `make("x")`, `await load()` |
| `template` | a template literal with `${}` holes |
| `mutable` | `let` / `var` |
| `computed` | a spread may supply it, any other expression |
| `prop` | a prop the file receives and nothing binds it |
| `ambiguous` | the name or key is written more than once |
| `not-text` | the path ends at an object or a list |

Silent, as before: a name the file does not write out (`post` in a CMS collection loop), a package, a file
that is not a project script or JSON (`runtime`, `missing`, `unsupported` are never listed as blocked).
Loop items whose words another item of the same loop repeats get no target, because the canvas finds text by
its words and could not tell which of the two was meant.

## The cue

| Moment | Shown | Where |
|---|---|---|
| Pointer on the element, or the element selected | Nothing: not even for one frame | — |
| Typing in it (from the double click that opens the editor) | "Editing source" + `src/lib/homepage/content.ts › aiCallout1.body` (path highlighted, start-truncated), plus "Used in N places" when N is more than 1 | `CanvasTextSourceCue`, under the element's bottom edge and left-aligned with it (`canvasSourceCue`, from `avb:text-active`'s `rect`; `sourceCuePlace`) |
| Saved | toast "Updated {path} in {file}" with **Undo** | `reportActionToast` |
| Not editable | the refusal sentence above | toast, from `avb:text-refused` with `reason: 'source-blocked'` and the blocked text's `key` |

While typing, the selection keeps its outline but its name tag above goes: an element's tag, a component
instance's parent tag, and a text mark's tag alike (`styles.css`, keyed on the `#stacki-canvas-text-editor`
marker that `canvasTextOverlay.ts` adds on `avb:text-active` and removes on `avb:text-inactive`). The tag is
back in the first frame after editing ends. Shared words (CMS, variable) keep the tag as their warning
("Shared CMS content · changes other uses too"), with the name left out.

The chip goes directly above the element only when there is no room below it in the window (there is no
name tag to clear while typing). With room for neither it is pinned to the window's bottom.

A hover hint ("Double-click to edit · updates …") was dropped: it was set on `avb:hover-node` and cleared by
the next frame message of any other kind, so it showed as a one-frame flash on every hover. The cue now
belongs to editing alone.

"Used in N places" counts the places on the page that resolve to the same literal. Other pages that import
the same module are not counted; their dev-server renders update when the write lands.

## Where it lives

| Piece | File |
|---|---|
| Tracing a path to its literal, escaping, rewriting (pure) | `src/editor/boundText.ts` |
| Targets per text and loop item, blocked list, write and toast | `src/app/model/canvasBoundText.ts` |
| Props bound to a path | `src/app/model/canvasPropText.ts` (`bound`) |
| Host: read modules, write them as one history step | `src/app/shell/desktopCanvasText.ts` (Studio: page frontmatter only) |
| Catalog `blocked`, refusal `key`, `avb:text-active.rect` | `shared/properties/canvasText.ts`, `canvasTextOverlay.ts` |
| Frame: refuses a double click on blocked text; posts the editing box | `electron/preload/frameText.ts`, `frameTextSession.ts` |
| Rebuild after a write beside the page | `src/features/preview/canvasTextRefresh.ts` |

## Tests

`test/renderer/preview/boundText.test.js` (tracing for each source kind, escaping and round trips, byte-exact
rewrites and undo, refusals, multiple use, loops, contracts, a JSDOM double click that opens the editor and a
save that writes the source and not the markup, the refusal of blocked text) and
`test/renderer/preview/canvasSourceCue.test.js` (the chip; its place below the element and the flip above
the element; the Settings panel draws nothing) and `test/renderer/preview/canvasSourceCueFrames.test.js` (a
per-frame recording of the real canvas text hook: no frame draws the chip while the pointer moves over bound
text; the chip appears with the message that opens the editor) and
`test/renderer/preview/canvasEditingTagChromium.test.js` (in Chromium, with the real overlays and styles: no
frame while typing shows the name tag, no frame shows the tag and the chip together, the tag is back in the
first frame after; for an element, a component instance's text and a text mark).
