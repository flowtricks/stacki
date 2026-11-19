# Text inside closed components on the canvas

One state machine, `src/features/preview/textOwnerState.ts`, draws every closed component (the **owner**: the outermost
component instance of the page that renders the words) around the words it renders (the **text**: a prop's words, children
the page writes inside the instance, or a fragment of HTML). The frame reports the hovered and the picked words with the
page path of their owner (`scope`); the overlay (`PreviewOverlays.tsx`) asks `ownerClasses` and draws nothing of its own.

| State | When | Text | Owner | Classes / tokens |
|---|---|---|---|---|
| `none` | none of the instance's words hovered or picked | none | its ordinary outline | — |
| `field` | pointer on the words, none of the owner's words picked | hover outline + tag | faint thick outline, **no name tag**, no fill | `text-owner` |
| `resting` | some of the owner's words picked, whatever the pointer is on (the same words, another text of the owner) | solid green outline + tag | faint thick outline **and a light name tag** | `text-owner owner-tag` |
| `body-hover` | words picked, pointer on the owner's own body | solid green outline + tag | solid green outline (1px, opaque); the **same light name tag as `resting`** | `parent tinted` (`--green`, 1px; the tag is the selected parent's, `#7ddc94`) |

The owner that is the selection keeps its selected outline in every state, and a selected ancestor (a layout) is never tinted
or marked for words that are not its own. The faintness is in the outline colour (`color-mix` of `--green`, 22%), never in the
element's opacity, so the tag stays solid (`#7ddc94` with dark words, the colour of the existing parent tag).

Every cell, by selection and pointer:

| Selection | Pointer | Text | Owner |
|---|---|---|---|
| nothing / a layout / another element | on text | text hover | `field` |
| the owner | on text | text hover | `field`, selected outline |
| text A | on text A | A's selection | `resting` (tag) |
| text A | on text B of the same owner | A selected, B hover | `resting` (tag stays) |
| text A | on the owner's body | A selected | `body-hover` (solid outline, same tag) |
| text A | elsewhere | A selected | `resting` |

Every tag of these states is an opaque chip: the hovered text's is the solid green one (`.hover.text-mark`), the owner's is `#7ddc94`.

Clicks: one click on hovered words selects the owner and picks the words in the same step (the frame keeps the pick until the
app's selection arrives); a double click enters editing as before. Components that are only their words (a `Heading` or
`Paragraph` written in the page) are their own owner: the component's hover is the hover.

Words a component draws that no target covers (a label computed from a variant table, a footer's links, an option) hover
**muted** (`refused`) so the canvas says nothing edits there instead of staying silent.

Tests: `test/renderer/preview/closedComponentTextTable.test.js` drives every text-bearing element of the real example page
(real component sources and captured preview markup, `test/fixtures/lumos-card/`) through every state and fails on any
deviation; `textHoverParentOutline.test.js` pins the cells for one Card.
