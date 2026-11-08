---
title: Keyboard shortcuts
description: Every shortcut in Stacki, grouped by what it acts on, including the three that are easy to get wrong.
group: reference
order: 1
keywords:
  [
    "keys",
    "hotkeys",
    "shortcuts",
    "cheatsheet",
    "command",
    "option",
    "command palette",
    "search",
  ]
---

<span data-keys-literal>Shortcuts are written for macOS. On Windows and Linux,
<kbd>⌘</kbd> is <kbd>Ctrl</kbd>, <kbd>⌥</kbd> is <kbd>Alt</kbd> and
<kbd>⇧</kbd> is <kbd>Shift</kbd>. The tables below say so themselves when
you read them on a Windows machine.</span>

Single-letter shortcuts are ignored while you are typing in a field, so a prop
value can still contain the letter `s` or the digit `2`.

> There is no command palette, no project-wide search, and no shortcut
> reference inside the app. Every search box in Stacki is scoped to one panel,
> and the only place a key is discoverable is the tooltip on a rail button. This
> page is the list.

## Panels

The left rail holds ten panels, one icon each. Pressing the key of the panel
that is already open collapses it, which gives the canvas the whole window.

| Shortcut                 | Panel           | Notes                                                       |
| ------------------------ | --------------- | ----------------------------------------------------------- |
| <kbd>P</kbd>             | Pages           |                                                             |
| <kbd>Z</kbd>             | Navigator       |                                                             |
| <kbd>K</kbd>             | Properties      | Bound only while a component is open                        |
| <kbd>⇧</kbd><kbd>A</kbd> | Components      |                                                             |
| <kbd>J</kbd>             | Assets          | Bare <kbd>J</kbd>; <kbd>⌘</kbd><kbd>J</kbd> is the terminal |
| <kbd>⌥</kbd><kbd>C</kbd> | CMS             |                                                             |
| <kbd>⌥</kbd><kbd>V</kbd> | Variables       |                                                             |
| <kbd>G</kbd>             | Style selectors |                                                             |
| <kbd>C</kbd>             | Code            |                                                             |
| <kbd>⌥</kbd><kbd>H</kbd> | Git             |                                                             |

The rail's keys are matched on the physical key rather than the character, which
is why the <kbd>⌥</kbd> pairs work at all: Option rewrites <kbd>⌥</kbd><kbd>C</kbd>
to `ç` and <kbd>⌥</kbd><kbd>H</kbd> to `˙` before a page would ever see a letter.
Holding <kbd>⌘</kbd> or <kbd>Ctrl</kbd> makes the rail ignore the key entirely,
so none of these collides with the shortcuts below.

The right panel has two:

| Shortcut     | Does         |
| ------------ | ------------ |
| <kbd>S</kbd> | Style tab    |
| <kbd>D</kbd> | Settings tab |

Both are bare keys, so they only fire outside a field — which is also why
<kbd>D</kbd> never collides with <kbd>⌘</kbd><kbd>D</kbd>.

## Editing

| Shortcut                                                                       | Does                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| <kbd>⌘</kbd><kbd>F</kbd>, <kbd>⌘</kbd><kbd>E</kbd> or <kbd>⌘</kbd><kbd>K</kbd> | Open the insert palette                                               |
| <kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd>                                           | Make a component out of the selection, naming dialog up               |
| <kbd>⌘</kbd><kbd>Enter</kbd>                                                   | Style tab, caret in the selector field                                |
| <kbd>Enter</kbd>                                                               | Open the selection's code window (frontmatter, `<style>`, `<script>`) |
| <kbd>⌘</kbd><kbd>C</kbd>                                                       | Copy the selected node                                                |
| <kbd>⌘</kbd><kbd>V</kbd>                                                       | Paste it                                                              |
| <kbd>⌘</kbd><kbd>D</kbd>                                                       | Duplicate it                                                          |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd>                                       | Remove it                                                             |
| <kbd>⌘</kbd><kbd>Z</kbd>                                                       | Undo                                                                  |
| <kbd>⇧</kbd><kbd>⌘</kbd><kbd>Z</kbd> or <kbd>⌘</kbd><kbd>Y</kbd>               | Redo                                                                  |
| <kbd>⇧</kbd><kbd>⌘</kbd><kbd>C</kbd>                                           | Copy Selection — the trail to it, as `file:line` pointers             |
| <kbd>⌘</kbd><kbd>J</kbd> or <kbd>Ctrl</kbd><kbd>`</kbd>                        | Toggle the terminal                                                   |
| <kbd>⌥</kbd><kbd>P</kbd>                                                       | Step into the interactive preview, back out of it, or back to now     |

> <kbd>⌘</kbd><kbd>F</kbd> is not a search. It opens the insert palette, and so
> do <kbd>⌘</kbd><kbd>E</kbd> and <kbd>⌘</kbd><kbd>K</kbd> — three keys for one
> thing, because the palette answers whichever a person's other tools taught
> them. Inside the code editor all three are released so CodeMirror keeps its
> own find.

A rich text field claims <kbd>⌘</kbd><kbd>K</kbd> and <kbd>⌘</kbd><kbd>E</kbd>
first, for a link and for code. <kbd>⌘</kbd><kbd>C</kbd> and
<kbd>⌘</kbd><kbd>V</kbd> fall back to normal text behaviour when a field has
focus or text is selected, and paste is left alone entirely while the clip-path
editor is open, because that tool reads the clipboard itself.

<kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd> and <kbd>⌘</kbd><kbd>Enter</kbd> are
deliberately handled before the "am I typing" check, so they act on the selected
node wherever focus happens to be.

Undo and redo are global: CSS edits, CMS edits and asset changes are on the same
stack as page edits, and they work from anywhere in the app, including without a
page open. They do stand aside for a field that already undid its own typing —
a value half-typed in a box is not a step on the page's stack.

<kbd>⌥</kbd><kbd>P</kbd> is the toolbar's preview button, which names whichever
of the three it will do: `Preview (⌥P)`, `Exit preview (⌥P)`, or
`Back to now (⌥P)` while you are looking at an older version. Returning from an
older version wins over the toggle. Entering needs a dev server, so without one
the key does nothing.

## Canvas

| Shortcut       | Does                                                           |
| -------------- | -------------------------------------------------------------- |
| <kbd>1</kbd>   | Desktop                                                        |
| <kbd>2</kbd>   | Tablet, 768px                                                  |
| <kbd>3</kbd>   | Phone, 375px                                                   |
| <kbd>4</kbd>   | Canvas — all breakpoints at once                               |
| <kbd>Esc</kbd> | Leave the preview, or an older version you were looking at     |
| <kbd>Esc</kbd> | Otherwise, step out of a component you drilled into, one level |

<kbd>Esc</kbd> lets fields, menus, dialogs and the code window answer it first.

## Navigator

| Shortcut                    | Does                    |
| --------------------------- | ----------------------- |
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next sibling |
| <kbd>↑</kbd>                | Parent                  |
| <kbd>↓</kbd>                | First child             |

`::before` and `::after` are rows in the tree, so they are part of this: a
`::before` is the first child's left-hand sibling, <kbd>↓</kbd> enters one, and
<kbd>↑</kbd> from one goes to the element that draws it. Any modifier held
cancels the move.

## Fields

| Shortcut                                      | Does                              |
| --------------------------------------------- | --------------------------------- |
| <kbd>↑</kbd> / <kbd>↓</kbd> in a number field | Step by 1                         |
| <kbd>⇧</kbd> + step                           | Step by 10                        |
| <kbd>⌥</kbd> + step                           | Step by 0.1                       |
| <kbd>⌥</kbd>-click a spacing value            | Remove it                         |
| <kbd>⇧</kbd>-drag a spacing side              | Change all four sides             |
| <kbd>⌥</kbd>-drag a spacing side              | Change that side and its opposite |
| <kbd>Enter</kbd>                              | Commit and blur                   |
| <kbd>Esc</kbd>                                | Cancel and put the old value back |

In the style panel, <kbd>=</kbd> in any value field opens the large value
editor — `=` is not something a CSS value starts with — and
<kbd>⇧</kbd>-clicking a section heading collapses or expands all of the
sections at once.

The selector box is the one field where blur is not a commit: text left
half-typed there is abandoned, and only <kbd>Enter</kbd> or a suggestion adds
the selector.

## Application menu

On macOS the native menu takes these keys before the page sees them, so they are
routed back into the editor over IPC — which is why they act on the selected
node when no field has focus, and on the text when one does.

| Shortcut                                                        | Menu item              |
| --------------------------------------------------------------- | ---------------------- |
| <kbd>⌘</kbd><kbd>,</kbd>                                        | File → Settings…       |
| <kbd>⌘</kbd><kbd>O</kbd>                                        | File → Open Project…   |
| <kbd>⇧</kbd><kbd>⌘</kbd><kbd>W</kbd>                            | File → Close Project   |
| <kbd>⌘</kbd><kbd>Z</kbd> / <kbd>⇧</kbd><kbd>⌘</kbd><kbd>Z</kbd> | Edit → Undo / Redo     |
| <kbd>⌘</kbd><kbd>C</kbd> / <kbd>⌘</kbd><kbd>V</kbd>             | Edit → Copy / Paste    |
| <kbd>⇧</kbd><kbd>⌘</kbd><kbd>C</kbd>                            | Edit → Copy Selection  |
| <kbd>⌘</kbd><kbd>E</kbd>                                        | Edit → Insert Element… |

`Check for Updates…` also sits in the File menu, with no key.
<kbd>⇧</kbd><kbd>⌘</kbd><kbd>C</kbd> saves any pending edit before it reads the
file, because typing is written on a debounce and the line numbers would
otherwise be one edit old. The menus are File, Edit, View and Window. There is
no Help menu, which is the other half of why there is no shortcut reference in
the app.
