---
title: The canvas
description: Selecting on the page, breakpoints, drilling into components, and preview mode.
group: interface
order: 2
keywords:
  ["preview", "breakpoints", "responsive", "device", "select", "hot reload"]
---

The canvas shows the page as the dev server renders it. It is the real site, not
an approximation: your CSS, your scripts, your fonts.

## Selecting

- **Click** anything to select it. The Navigator opens and scrolls to the node.
- **Double-click** a component to open it: the canvas dims everything outside
  that component and you edit its own file. <kbd>Esc</kbd> backs out one level.
- Clicking chrome the layout renders itself (a header or footer outside the
  page's `<slot>`) selects the layout, because that markup belongs to it.

The breadcrumb above the canvas shows the path to the selection; clicking a
crumb selects that ancestor.

## Breakpoints

| Button  | Key          | Width                         |
| ------- | ------------ | ----------------------------- |
| Desktop | <kbd>1</kbd> | Fills the canvas              |
| Tablet  | <kbd>2</kbd> | 768px                         |
| Phone   | <kbd>3</kbd> | 375px                         |
| Canvas  | <kbd>4</kbd> | Every breakpoint side by side |

Drag the frame's side or bottom handle to set any width by hand. The highlighted
button is the breakpoint the page is _actually_ laying out in. Squeeze the
window with Tablet selected and the highlight moves to Phone, because that is
what the page is getting.

The canvas and the style panel's breakpoint dropdown move together: picking a
query there sets the canvas to a width inside it, and switching the canvas back
to Desktop puts the panel back on `Base`. See
[breakpoints](/docs/breakpoints).

## Edits patch, they do not reload

Astro cannot hot-swap a server-rendered component, so an edit would normally
mean reloading the document: restarting animations, rewinding video, dropping
scroll position and closing anything the page had open.

Stacki catches that reload and turns it into a patch: the server's previous
rendering is diffed against the new one and only the difference is applied. Work
the page's own scripts have done appears in neither rendering, so it survives
untouched. Anything that cannot be lined up falls back to a reload.

## Preview mode

The preview button in the title bar steps into the running site: links work,
scripts run, and no editor chrome is drawn over it. <kbd>Esc</kbd> exits, and
the editor follows you to whichever page you navigated to.

For a page with a dynamic route, the canvas renders one entry, and the picker in
the title bar chooses which. You are always editing the template; the entry only
changes the data it is rendered against.
