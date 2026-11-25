# Scroll gutter

Every scroll container keeps room for its scrollbar whether or not the bar shows, so
content never moves sideways when a bar appears or disappears.

## Why

The app draws a classic 8px scrollbar (`::-webkit-scrollbar` in `src/app/styles.css`), and
a classic bar takes layout space. A list that grew past its height narrowed its content by
the bar's width, every line re-wrapped, and the panel jumped. The Properties panel showed it
(Button, type, Property settings: opening a conditional option made the list scroll).
`scrollbar-gutter: stable` reserves the bar's space up front.

## The rule

An element whose `overflow`, `overflow-x` or `overflow-y` is `auto`, `scroll` or `overlay`
declares `scrollbar-gutter: stable` in the same rule. Add it beside the overflow line:

```css
.thing-list {
  overflow-y: auto;
  scrollbar-gutter: stable;
}
```

In a TypeScript style object it is `scrollbarGutter: 'stable'`. `both-edges` is for a box
whose content must stay centred between two bars; nothing needs it today.

## Mechanism, and why not one global rule

| Option | Verdict |
|---|---|
| `* { scrollbar-gutter: stable }` | Rejected. Chromium also reserves the gutter on `overflow: hidden` elements, so every clipped box lost 8px (measured: a 200px hidden box with a 200px child gave 192px). |
| A CSS selector for "overflow is auto" | Does not exist; CSS cannot select on a computed value. |
| JavaScript that tags scrollers | Rejected. Runs after layout, so the first frame shifts, and it hides the rule from the stylesheet. |
| **One declaration per rule, held by a test** | Chosen. Explicit, zero runtime, and `test/renderer/ui/scrollGutter.test.ts` fails the next rule that forgets. |

Two scroll containers are made by the browser or CodeMirror, not by a rule of ours, so one
shared rule in `src/ui/controls.css` covers them (every surface loads it through
`src/app/styles.css`, including Studio, the demo and the apps UI kit):

```css
textarea,
.cm-scroller {
  scrollbar-gutter: stable;
}
```

`AutoTextarea` also sets `scrollbarGutter: 'stable'` itself, because it flips
`overflow-y` between `hidden` and `auto` from code as the text crosses its height bound.

## Exempt by construction

The scanner does not ask for a gutter when:

- The block scrolls only horizontally and its vertical axis is `hidden` or `clip`. The
  gutter is the vertical bar's room, so a horizontal bar cannot change the width.
  (`overflow-x: auto` alone does not qualify: the vertical axis then computes to `auto`.)
- The block declares `scrollbar-width: none`. The element scrolls but no bar is ever drawn.

Anything else needs an entry in `test/helpers/scrollGutterAllowlist.json` (file, selector,
reason). It is empty today. An entry that stops matching fails the test.

## Inventory

Counted by `test/helpers/scrollGutter.ts` over `src`, `shared`, `studio/src` and
`studio/demo` (there is no top-level `demo/` and no site CSS outside these roots):

**124 scroll-container blocks.** 118 carry a stable gutter, 6 are exempt by construction (4 horizontal-only and 3 with the bar hidden, one of them both).

| Kind | Count |
|---|---|
| CSS rules scrolling vertically only | 69 |
| CSS rules scrolling both axes | 44 |
| CSS rules with `overflow-x: auto` only (vertical computes to auto) | 5 |
| CSS rules scrolling horizontally with the vertical axis hidden (exempt) | 4 |
| Inline style objects (`Menu.tsx`, `MoreMenu.tsx`) | 2 |
| Browser-made: `textarea` and CodeMirror `.cm-scroller` | one shared rule in `controls.css` |

(The first four rows are the 122 CSS rules; four of them target a `.cm-scroller`.)

By file:

| File | Blocks |
|---|---|
| `src/features/style/embedEditor.css` | 14 |
| `src/features/ai/transcript/transcript.css` | 5 |
| `src/features/cms/remoteCms.css` | 4 |
| `studio/src/app/studio.css` | 4 |
| `src/app/settings/settings.css` | 3 |
| `src/features/audits/audits.css` | 3 |
| `src/features/componentProperties/componentProperties.css` | 3 |
| `src/features/notifications/toasts.css` | 3 |
| `src/features/pages/pageTemplate.css` | 3 |
| `src/features/props/loopSettings.css` | 3 |
| `src/app/settings/roles.css` | 2 |
| `src/features/apps/apps.css` | 2 |
| `src/features/cmsConnections/cmsConnections.css` | 2 |
| `src/features/style/clipPath/ClipPath.css` | 2 |
| `src/features/style/utilities.css` | 2 |
| `src/ui/dropdown.css` | 2 |
| `src/ui/richText.css` | 2 |
| `studio/src/features/ai/chat.css` | 2 |
| `src/app/recovery/recovery.css` | 1 |
| `src/app/settings/breakpointsSettings.css` | 1 |
| `src/app/settings/breakpointSyncDialog.css` | 1 |
| `src/app/settings/styleTagSettings.css` | 1 |
| `src/features/ai/aiShell.css` | 1 |
| `src/features/ai/composer/composer.css` | 1 |
| `src/features/ai/sessions/sessions.css` | 1 |
| `src/features/ai/transcript/chrome.css` | 1 |
| `src/features/ai/transcript/diff.css` | 1 |
| `src/features/apps/appDetails.css` | 1 |
| `src/features/apps/appSettings.css` | 1 |
| `src/features/apps/publish.css` | 1 |
| `src/features/palette/renameComponent.css` | 1 |
| `src/features/preview/toolbarOverflow.css` | 1 |
| `src/features/projectSettings/mcp.css` | 1 |
| `src/features/projectSettings/projectSettings.css` | 1 |
| `src/features/props/conditionalValue.css` | 1 |
| `src/features/publishing/publishing.css` | 1 |
| `src/features/studioSetup/studioSetup.css` | 1 |
| `src/features/style/components/PanelSheet.css` | 1 |
| `src/ui/chipEditor/chipEditor.css` | 1 |
| `src/ui/logBlock.css` | 1 |
| `src/ui/Menu.tsx` | 1 |
| `src/ui/MoreMenu.tsx` | 1 |
| `studio/src/features/roles/roles.css` | 1 |

## Verifying in the real engine

Chromium 156 (the Browser pane), a static page with the app's own 8px `::-webkit-scrollbar`
rules; a child's width was read with the content short, then tall.

| Container | Short | Tall | Shift |
|---|---|---|---|
| `overflow: auto` | 200 | 192 | **8** |
| `overflow: auto; scrollbar-gutter: stable` | 192 | 192 | 0 |
| `overflow: auto; scrollbar-gutter: stable both-edges` | 184 | 184 | 0 (8px each side) |
| `overflow: hidden; scrollbar-gutter: stable` | 192 | 192 | 0, but 8px narrower: why there is no global rule |
| `overflow: visible; scrollbar-gutter: stable` | 200 | 200 | 0 |
| `overflow-x: auto; overflow-y: hidden; scrollbar-gutter: stable` | 192 | 192 | 0, 8px wasted: why horizontal-only is exempt |

The Properties scenario used the real `src/app/styles.css` and a `.dp-property-settings`
list with 4 rows, then 20: 312 to 312 with the gutter, 320 to 312 (the 8px jump) with
`scrollbar-gutter: auto`. A `textarea` and a `.cm-scroller` picked the gutter up from
`controls.css` and did not move when their content grew.

To repeat it, serve a folder with a page that links the real stylesheet, size a scroller,
change its child's height and compare `getBoundingClientRect().width`. Do not point it at a
project and do not use the dev server's port.

## Not covered

- macOS overlay scrollbars reserve nothing under `scrollbar-gutter: stable`. The app's
  `::-webkit-scrollbar` rule forces classic bars, so it is in effect everywhere the app
  styles them. The `recent-rail` sets its own bar height and is horizontal-only.
- The window's own viewport (`html`) and `<iframe>` documents (the canvas, apps) are
  separate scroll containers outside this scan.
- A scroll container made by a third-party stylesheet inside a user's site (the canvas) is
  the user's page, not the app.
