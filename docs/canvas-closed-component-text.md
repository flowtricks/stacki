# Text inside closed components on the canvas

## Who owns an outline decides its colour

One rule (`shared/properties/outlineOwnership.ts`): content is **page-owned (blue, `element`)** only when the page wrote it: a
node of the open file's own tree, or an element rendered from children the page passed into a slot of the enclosing instance.
**Everything else inside a component instance is the component's own (green, `component`)**: its root, its own markup, a wrapper
it draws around the slot (a Button's `<span class="label">`), text it renders from a prop, any element carrying a component
file's path (`File.astro|0.1`). A closed component has no way to produce a blue outline for what it renders itself.

- Every producer (node hover and selection, hovered and picked words, pseudo-elements, editing) asks `outlineKind`; none picks a
  colour class. `OutlineSubject` has no colour field, and `outlineKind` asserts that nothing inside a component with no slot
  ancestor leaves green.
- **Slot words are the page's only when the page's own text nodes are in the DOM.** The preview records the run of text nodes each
  page text renders (`runsOf`); words with such a run, held by a component's element, are drawn as a run of their own
  (`drawnAsRun` in `electron/preload/frameTextMarks.ts`), reported with `owner: 'slot'` and outlined **blue**, while the element
  around them (a Heading's root) stays **green**, drawn by the instance's own outline.
- **Words a component prints itself are the component's, even when they came through the slot.** A Button renders its slot to a
  string and prints it with `set:html` into its own `button_main_text` span beside an arrow svg: no run exists, every element is
  the component's, so the hover, pick and edit outline (and its tag) are **green**, like a prop's text or hardcoded text. Their
  owner is read off the element's paths (`ownershipOf`: a `|` path is a component file's own). A mark with no owner is the
  component's. A page's own `<span>` or `<em>` inside a slot carries only page paths, so it is `slot` (blue).
- A Heading that renders the page's text nodes is outlined twice, as any such slot text is: the Heading green, the words blue.
  A page's own `<span>` inside a Button's slot is a node of the page's tree, blue like any plain element, with the Button green.
- Deep outline mode (`avb:outline-mode` `deep`) names a node as the editor would draw it with the component open, so it keeps the
  open view's colours; that is a view of the component's file, not of the closed component's markup.
- A `::before` or `::after` inside a component is outlined green and only when it renders text and takes pointer events
  (`pseudoOffered`); on a plain element it is blue as always.

## Hover: what the pointer actually reaches, and no outline for a component's own words

- **The browser's hit test is the authority.** The frame asks `elementFromPoint` / `elementsFromPoint`, which already know z-index,
  stacking contexts, `pointer-events` (and inherited values), `visibility`, clipping, transforms and iframes. The topmost element
  maps to the nearest source node by walking up; **nothing is looked for beneath it**. An element covered by a sibling painted above
  it is never hovered, picked or edited through the cover, and an element no file wrote (a script's layer, an untagged card)
  answers through its nearest tagged ancestor. `opacity: 0` stays hittable, as in a browser. Words are hovered or picked only when
  the top hit is their element or inside it, or lies inside their own instance (a stretched link over a card's words)
  (`reachable` in `frameTextMarks.ts`; `pointTarget` in `frameTargets.ts`; corpus case `covered-by-higher-z-sibling`).
- **A component's own direct text draws no outline of its own on hover.** Prop text, slot text its root or its wrapper (`.text`,
  `.heading`, `.button_main_text`) prints: the pointer on it is the **instance's** hover (green outline, component tag), and the
  frame reports no text hover (`avb:text-marks` carries `hover` only for refused prop text, which says why a double click does
  nothing). A click still picks the words and a double click still edits them. Only a **separate child tag** the page wrote into the
  slot (`strong`, `em`, `span`, `a`, `br`) has an outline of its own, and it is blue (page-owned) with its own tag.
- **Bare text among tagged siblings is no hover target.** In `Our wild<br><strong>work</strong>` the plain words have no tag: a
  hover on them is their owner's (`textOwner` in `nodeAt`, `reportHover` in `frameTargets.ts`; corpus case
  `plain-text-among-tagged-children`), while a click on them still selects the text node as before.
- **One tag per outline.** A text mark never draws its own tag over a node outline's at the same corner (`outlineBoxes` in
  `PreviewOverlays.tsx`; `hoverTagsOnce.test.js`), so a hovered text reads the same as the same text clicked.
- Inside the component's own file (the editor has opened it), its inner elements are ordinary nodes and hover as usual.

Tests: `test/renderer/preview/outlineOwnership.test.js` (rule, frame owners for a Button label span, a Heading, a page-authored
element in a slot, a Button nested in a Card's slot and in a loop; hover, pick and edit outlines), `pseudoOutlineComponent.test.js`,
and the real-window `test/electron/preload/slotTextHoverCanvas.test.js`.

One state machine, `src/features/preview/textOwnerState.ts`, draws every closed component (the **owner**: the outermost
component instance of the page that renders the words) around the words it renders (the **text**: a prop's words, children
the page writes inside the instance, or a fragment of HTML). The frame reports the hovered and the picked words with the
page path of their owner (`scope`); the overlay (`PreviewOverlays.tsx`) asks `ownerClasses` and draws nothing of its own.

| State | When | Text | Owner | Classes / tokens |
|---|---|---|---|---|
| `none` | none of the instance's words hovered or picked | none | its ordinary outline | — |
| `field` | pointer on the words, none of the owner's words picked | hover outline + tag | faint thick outline, **no name tag**, no fill | `text-owner` |
| `selected` | the owner is the selection, pointer on its words, none picked | text hover | its selected outline and **its tag, unchanged**; no fill, no second outline | none (plain `sel`) |
| `resting` | some of the owner's words picked, whatever the pointer is on (the same words, another text of the owner) | solid green outline + tag | faint thick outline **and a light name tag** | `text-owner owner-tag` |
| `body-hover` | words picked, pointer on the owner's own body | solid green outline + tag | solid green outline (1px, opaque); the **same light name tag as `resting`** | `parent tinted` (`--green`, 1px; the tag is the selected parent's, `#7ddc94`) |

The owner that is the selection keeps its selected outline in every state, and a selected ancestor (a layout) is never tinted
or marked for words that are not its own. The faintness is in the outline colour (`color-mix` of `--green`, 22%), never in the
element's opacity, so the tag stays solid (`#7ddc94` with dark words, the colour of the existing parent tag).

Every cell, by selection and pointer:

| Selection | Pointer | Text | Owner |
|---|---|---|---|
| nothing / a layout / another element | on text | text hover | `field` |
| the owner | on text | text hover (unfilled tag) | `selected`: selected outline and solid tag stay, no fill |
| text A | on text A | A's selection | `resting` (tag) |
| text A | on text B of the same owner | A selected, B hover | `resting` (tag stays) |
| text A | on the owner's body | A selected | `body-hover` (solid outline, same tag) |
| text A | elsewhere | A selected | `resting` |

Tags follow the one convention of the canvas: a **hover** tag is unfilled (the icon and label in green, `.node-outline.hover .node-outline-tag`, nothing behind it); a **selected** tag is the solid green fill (`.node-outline.component .node-outline-tag`); the owner's resting tag while its text is selected is the light-green fill (`#7ddc94`, dark words). Nothing is grey or translucent, and no text state has a tag rule of its own beyond the owner's.

**Editing** the words (a double click into them) is `resting` for the whole session: the owner keeps the faint thick outline and
the light name tag with the pointer anywhere (`body:has(#stacki-canvas-text-editor) .node-outline.sel.text-owner.owner-tag`). The
words being typed in count as picked even if the app's selection of the owner has not arrived yet. Ordinary text (not inside a
component) keeps its own behaviour: its tag goes while it is typed in.

The caret lands at the character under the double click, a collapsed caret, never a word selection. When the browser's hit test
names another element (a stretched link over the card), it is found from where the characters are drawn
(`caretByGeometry` in `frameTextSelection.ts`); past the end of a line it goes to the end of that line.

Clicks: one click on hovered words selects the owner and picks the words in the same step (the frame keeps the pick until the
app's selection arrives); a double click enters editing as before. Components that are only their words (a `Heading` or
`Paragraph` written in the page) keep the component's own (green) hover, and their slot words are outlined as a blue run beside it
(see "Who owns an outline decides its colour").

A component whose root **frames** the words is not only its words: a Button's `<a class="button"><slot /></a>` with padding
or a border on any side around `<Button>Start your free flight</Button>`. Its slot words are hovered, marked and picked like
any other words, and their outline is the words' own box (the range of their text), never the button's; the pointer on the
padding is the component's own hover. Words the page wrote are drawn as that run, framed or not (`drawnAsRun` in
`electron/preload/frameTextMarks.ts`; `test/renderer/preview/slotTextFramedRoot.test.js` and the real-window
`test/electron/preload/slotTextHoverCanvas.test.js`).

**Only what this instance decides is offered.** One rule, `isEditableThroughProps` in
`shared/properties/closedComponentReach.ts`, decides for the hover, the text editor and the image popup alike: words or a picture
inside a closed component are hovered, labelled, typed in or opened only when a prop or the slot of this instance reaches them.
Words the component writes itself (hardcoded, or computed from its own code, so no catalog target covers them) get no text
outline, no label and no double click: the pointer on them is the component's own hover. A double click on a picture the
component writes, computes or cannot be read for opens nothing, not even an explanation (`imageDecision` in
`canvasImageTrace.ts`); a picture a prop decides opens the popup on that prop. The decision is made from the catalog and the
trace the canvas already holds: before the catalog arrives nothing is offered, so nothing shows and then disappears.

Prop text a binding keeps from being written (`body={entry.body}` printed as HTML) is reached by a prop, so it hovers exactly
like editable words: the same green outline and solid green tag. Nothing on the canvas is grey or translucent. The reason is
given when the person tries to edit it (the named refusal chip), not by a different look.

Tests: `test/renderer/preview/closedComponentTextTable.test.js` drives every text-bearing element of the real example page
(real component sources and captured preview markup, `test/fixtures/lumos-card/`) through every state and fails on any
deviation; `textHoverParentOutline.test.js` pins the cells for one Card.
