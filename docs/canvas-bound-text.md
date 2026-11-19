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
| 1.4.8 | Data a call hands back: a YAML file a module parses (`export const home = parse(raw) as HomeData` over `import raw from "./home.yaml?raw"`), `Object.freeze(...)`, and project functions followed into their returns with their parameters bound to the arguments (`section({ heading: "…" })`). Before, every one of these was refused as "comes from a function call". |

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
| A YAML file a module parses: `parse(raw)` / `YAML.parse(raw)` / `Y.parse(raw)` (package `yaml`) or `load(raw)` (`js-yaml`), one argument, where `raw` is `import raw from "./x.yaml?raw"`; or `import data from "./x.yaml"` | That YAML file, one scalar (`boundTextYaml.ts`) |
| `Object.freeze(x)`, `Object.seal(x)`, `Object.preventExtensions(x)`, `structuredClone(x)` | Whatever `x` leads to |
| A call to a function the project writes (declaration, `const f = (…) => …`, `function` expression; imported or re-exported too) | The literal its return leads to, each parameter standing for the call's argument (`o`, or `{ heading, body: text }` destructured) |

### Shapes, before and after 1.4.8

| Shape | Before | Now |
|---|---|---|
| `const x = { heading: "…" }` (`as const`, `satisfies`, parentheses) | edited | edited |
| `{ ...base, heading: "…" }` (key written after the spread) | edited | edited |
| `export const home = parse(raw) as HomeData` over a `.yaml?raw` import (the reported case) | refused: call | edited in the YAML file |
| `import data from "./x.yaml"` | refused: unsupported | edited in the YAML file |
| `section({ heading: "…" })`, `section` returns its argument or `{ ...o }` | refused: call | edited |
| `copy("…")`, `copy = (text) => text` | refused: call | edited |
| `section(group({ ...base, title: "…" }))`, `Object.freeze({…})` | refused: call | edited |
| `const { a } = await getPage("home")` (guards decided by literal arguments) | edited | edited |
| A function from a package (`defineContent({…})`), a global (`make()`) | refused: call | refused: call, naming the function and line |
| A method (`words.join(" ")`), a tagged template (`` html`…` ``), `await fetch(…)` | refused: call | refused: call, naming it and the line |
| `parse(raw, options)` (a second argument may change the reading) | refused: call | refused: call |
| `t("key")` where `t` reads `messages[key]` | refused: call | refused: computed, at the line of `messages[key]` |
| A function that joins its argument (`text + "!"`) | refused: call | refused: concatenation, in the function's file and line |
| An argument that is a `let` | refused: call | refused: mutable |
| A YAML block scalar (`|`, `>`) or a scalar folded over lines | — | refused: multiline |
| A YAML alias (`*base`), a tag (`!!str`), a merge key (`<<`) | — | refused: computed |

### Writing a YAML scalar

Only the scalar's bytes change; comments on the line, indentation and every other key stay. The scalar keeps
its style when that style can spell the words: plain stays plain, `'…'` stays single quoted (a `'` doubled),
`"…"` stays double quoted (JSON escapes, which are YAML's). A plain scalar that cannot spell the words (a
`: `, a ` #`, a leading indicator such as `-` or `#`, a word YAML reads as another type such as `true` or
`12`, a newline) and a single-quoted one that cannot (a newline, a control character) become double quoted,
the one YAML style with escapes: the same rule the CMS YAML writer follows (`electron/content/formats/yaml.ts`).
A typed newline is therefore written as `\n` inside double quotes, never as a second line. Every encoding is
read back with the `yaml` package before it is written (an assertion).

In JavaScript a newline is written `\n` in `'…'` and `"…"` (both styles have the escape) and as a real line
break in a backtick template, where `${` is written `\${`.

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
| `call` | a function the project does not write (`make("x")`, a package's), a method, a tagged template; the toast names it and its line |
| `multiline` | a YAML block scalar or a scalar folded over several lines |
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

## Text a component renders from a prop

`canvasPropText.ts` offers the words a component prints from a prop (`{heading}`, or `set:html={heading}`) as
text to edit on the canvas, written to the prop on the instance the person double clicked, or added to it when
the instance showed the component's default. `canvasPropSites.ts` finds where a component shows each prop.

| Where the component puts the prop | Edited |
|---|---|
| `<p>{text}</p>`, `<Button>{label}</Button>` | Yes, as one text |
| `<p set:html={text} />` | Yes, one target per text run, with the format bar |
| `<Heading tag={headingTag}><Fragment set:html={heading} /></Heading>` (Lumos Card) | Yes: the component draws the element, so the frame finds the words by position inside it |
| `<Tag set:html={heading} />` where `Tag` is a variable of the component (a dynamic tag) | Yes, same way |
| `<Heading set:html={heading} />` where `Heading` is imported | No: an imported component takes `set:html` as its own prop |
| `<Fragment slot="aside" set:html={heading} />`, or words of the caller beside the fragment | No: the position the frame counts text by would not hold |
| An instance inside a loop or an expression | No: one attribute would stand for every copy |
| `heading={title}` on the instance | The source the binding leads to (escaped, when the component prints it as HTML) |
| A binding that leads to no one string (`a + b`, `cond ? x : y`, a call, data holding markup) | Refused by name, with the file to edit, like any other bound text; never written |

Pointing at these words outlines and names them at once, with nothing selected (`frameTextMarks.ts`,
`hoverBeforeSelect`); a click still selects the component. Words from a refused binding show a muted outline.
The first 4,000 instances of a page are read, in tree order, and the edits kept are bounded by the catalog.

Repeated instances each get their own target (keyed by instance), so typing in one writes that instance only.
Tests: `test/renderer/preview/canvasPropTextComponents.test.js` (the finder on Card-shaped components) and
`test/electron/preload/componentPropTextCanvas.test.js` (a real window: double click, type, the page file
changes only in the prop literal, one Undo restores every byte).

## The cue

| Moment | Shown | Where |
|---|---|---|
| Pointer on the element, or the element selected | Nothing: not even for one frame | — |
| Typing in it (from the double click that opens the editor) | "Editing source" + `src/lib/homepage/content.ts › aiCallout1.body` (path highlighted, start-truncated), plus "Used in N places" when N is more than 1 | `CanvasTextSourceCue`, under the element's bottom edge and left-aligned with it (`canvasSourceCue`, from `avb:text-active`'s `rect`; `sourceCuePlace`) |
| Saved | toast "Updated {path} in {file}" with **Undo** | `reportActionToast` |
| Not editable | the refusal sentence above, its file followed by the line (`src/lib/content.ts:3`) when the trace knows it | toast, from `avb:text-refused` with `reason: 'source-blocked'` and the blocked text's `key` |

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
| Walking a YAML file to one scalar, and its encoding | `src/editor/boundTextYaml.ts` |
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
`test/renderer/preview/boundTextCalls.test.js` (the reported YAML shape end to end through the planner, the
accepted-shape table byte for byte, every awkward typed text through every YAML and JavaScript quote, the
refused-shape table with pinned reasons, lines and sentences, undo) and
`test/renderer/preview/canvasSourceCue.test.js` (the chip; its place below the element and the flip above
the element; the Settings panel draws nothing) and `test/renderer/preview/canvasSourceCueFrames.test.js` (a
per-frame recording of the real canvas text hook: no frame draws the chip while the pointer moves over bound
text; the chip appears with the message that opens the editor) and
`test/renderer/preview/canvasEditingTagChromium.test.js` (in Chromium, with the real overlays and styles: no
frame while typing shows the name tag, no frame shows the tag and the chip together, the tag is back in the
first frame after; for an element, a component instance's text and a text mark).
