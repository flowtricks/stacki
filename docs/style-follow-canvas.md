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

The Desktop device fills the pane, at scale 1, when the pane has room for the project's Desktop width
(Settings, 90rem unless set) and the filled width still reads as Desktop. Otherwise it draws that
width, exactly as the same number typed into the width box: framed and scaled to fit
(`previewFrameWidth` in `usePreviewSizing.ts`, the one rule for the toolbar button, the device key,
Fit, the style panel's Base, apps' `canvas.setDevice` and the preview mode, in Desktop and Studio).
Two panes get the fixed width:

- a narrower one, which filled would lay the page out as a laptop or phone under the Desktop button;
- one that reaches an `up` breakpoint, which filled would lay the page out in that wider layout.

Resizing the window moves between the two. The canvas reports the width it draws, so the toolbar
(`activeDeviceFor`) presses Desktop and following lands where that width does: Base in a
desktop-first component. An unmeasured pane fills until its first measure.

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
