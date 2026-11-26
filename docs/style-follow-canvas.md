# Follow canvas size: the breakpoint dropdown and the canvas

The Style panel's breakpoint dropdown has a link on its trigger, **Follow canvas size**. While it is
on, the edit target is the query that holds at the canvas width, and resizing the canvas moves the
target. While it is off, the target is held where the person put it, whatever the canvas does.

The rules live in one pure function, `followTransition` in
`src/features/style/embed/followTransition.ts`; `useEditorContexts.ts` applies its answer, and
`test/renderer/style/followTransition.test.js` pins every cell of the table below.

## The table

"Toggle" is a click on the link and the `0` key: one action. "Row at the canvas" is the row that holds
at the canvas width now. "Device row" is Base or a query named for a project breakpoint (Laptop,
Tablet, Phone). "No width" is any other row: `prefers-reduced-motion`, a hand-typed width.

| Follow | Target | Action | Follow after | Target after | Canvas |
|---|---|---|---|---|---|
| on | a query | toggle | off | Base | stays |
| on | Base | toggle | off | Base | stays |
| off | any | toggle | on | the row at the canvas | stays |
| on | any | pick the row at the canvas | on | that row | stays |
| on | any | pick a device row | on | that row | moves to the row's width |
| on | any | pick a no-width row | off | that row | stays |
| off | any | pick the row at the canvas | on | that row | stays |
| off | any | pick any other row | off | that row | stays |

Why the toggle goes to Base: turning following off is how the person says "edit every size from
here". The canvas keeps its width and device (a page at 767 px stays at 767 px), and the edits land
in Base. Turning it back on targets the canvas's own query again, in the same frame.

Why a pick keeps following: picking a row while following asks to see and edit that breakpoint, so
the target and the canvas move together. Only a row with no canvas width to go to holds instead.

## The Desktop device and the pane

The ordinary editing canvas is the pane's own width at 100%, and it **reflows**: shrinking the window
or widening a panel lays the page out as a browser window that size would, the toolbar presses the
device that width belongs to (`activeDeviceFor`) and following moves the style target with it. This
is what a project opens on, a page switch, a reload, component canvas, and any view code restores.
A resize or a layout change never scales the page.

Only a **pick** of Desktop can do otherwise (`DesktopPick` in `usePreviewSizing.ts`): its button, its
device key, Fit, the style panel's Base, and an app's `canvas.setDevice`. What the pick finds decides:

| The pane | The pick |
|---|---|
| has the desktop range (from one pixel past the widest `down` canvas, up to the first `up` one) | nothing to hold: the ordinary canvas |
| is narrower | `narrow`: the project's Desktop width, framed and scaled to fit, as typing it would |
| reaches an `up` breakpoint | `wide`: the page stops one pixel short of it, centred and unscaled |

A `narrow` or `wide` pick is one look. The next resize of the canvas pane, either way and whether or not it is now
wide enough, ends it and the ordinary canvas is back: the app window, and a side panel dragged, opened or closed, since
each resizes the pane. Not counted: a difference of up to `DESKTOP_PICK_JITTER_PX` from the size the pick is held at, and
whatever moves the pane in the `DESKTOP_PICK_SETTLE_MS` after the pick (the layout the pick itself causes). Choosing
Desktop again looks again. Another device, another page and a reload end it too. It is not saved across restarts. A
typed width is not a pick: it stays, and is scaled to fit as the pane changes. The preview mode reads the pick and draws
it in its own stage; only the canvas, which listens for the device keys, changes it. In the range, where the scrollbar's
gutters would push the page below it, they give way first.
## Where a picked row puts the canvas

`rowPlacement` answers, and it only keeps a width at which following picks that very row, so the
target never snaps to another row once the canvas reports its new width:

- a query named for a project breakpoint: that breakpoint's device width, the toolbar button's
  (Tablet: 767 px). A mobile-first `width >= 30rem` row is named for the `< 30rem` Phone but holds
  only from 480 px, so it goes to its own boundary width (480 px, which the toolbar shows as Tablet);
- Base: where Base is the layer in effect (`model/baseWidth.ts`), or the Desktop device when following
  would not land on Base there (a desktop-first component);
- anything else: nowhere.

Until the canvas reports the new width, following waits (`followRetargetKey`'s `pickPending`),
so the trigger goes straight from the old row to the picked one.

## One frame per action

The mode and the target change in one commit. The `0` key arrives outside a React event, so
`toggleFollowMode` applies the panel's handler inside `flushSync`; otherwise the mode's store update
and the target's state update render in two commits and one frame shows the old query beside a
link already off. `test/renderer/style/followCanvasPick.test.js` records the trigger frame by frame
across each action.

## Inline styles is always Base

A style attribute applies at every width, so the panel never shows a query while the "Inline styles"
chip is the target (`useStyleContexts`). Clicking the chip picks Base as the dropdown does. While it
stays picked, following waits: a resized canvas, the link and the `0` key leave the target on Base.
Reselecting an element on its attribute, and Design mode's inline default, move the target only, never
the canvas. Picking or adding a query leaves the chip first, so the edit goes into a rule.
`test/renderer/style/inlineStyleBase.test.js` holds this.
