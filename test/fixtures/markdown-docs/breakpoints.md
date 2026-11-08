---
title: Breakpoints
description: The style panel lists the queries your project already writes, and picking one moves the canvas into it.
group: styling
order: 3
keywords:
  [
    "media query",
    "container query",
    "supports",
    "responsive",
    "tablet",
    "mobile",
    "min-width",
    "max-width",
    "style context",
  ]
---

Stacki has no breakpoint scale of its own. The dropdown above the style panel's
sections — its label is `Style context` — lists the at-rules your project has
already written, and whichever one is selected is the query your next edit lands
in. `Base` is always first, and means the rule itself with no query around it.

Three at-rules are collected: `@media`, `@container` and `@supports`. The reason
is written into the source, and it is the whole model in one line:

> A query is listed because it is written somewhere, never because the canvas is
> that wide.

## Labels are your query text

A row is labelled with the at-rule exactly as it is spelled in the file,
including the `@`. A project that writes `@media (width >= 64rem)` sees
`@media (width >= 64rem)`. A query nested inside another joins with `›`, as in
`@container card › @media (width < 40em)`, and names the rule it sits inside on
the line above.

The same query written in two stylesheets is two rows, each one saying which
file it lives in — in the same words the **Add custom styles in** control uses
for that file.

A row also carries:

| Marking  | Means                                                                       |
| -------- | --------------------------------------------------------------------------- |
| A dot    | The selected element already has styles in this query                       |
| A pencil | `Edit <query>` — the query is written in the file the panel is writing into |

Renaming through the pencil rewrites every block in that file that spells the
same query, and tells you how many before you commit. A breakpoint is written
once per block but meant once per file, and changing one spelling by hand splits
it in two without saying so.

## Which rows appear

A query is listed when the selected element has styles in it, **or** when it is
already written in the file the panel writes into — the second one deliberately,
because the dropdown is how you get _into_ an empty query to write the first
rule there. The source calls hiding it until something is in it "a door that
only opens from the far side".

So a project with no `@media` at all shows two rows: `Base` and `Add query`.

## Picking a query moves the canvas

Choosing `@media (width < 50rem)` is choosing to write styles that apply below
50rem, and a wider canvas would show none of them — every edit would look like
it did nothing. So the canvas moves to a width just inside the query:

| Condition                    | Canvas width                       |
| ---------------------------- | ---------------------------------- |
| `width < X`, `X > width`     | The largest whole pixel below X    |
| `width <= X`, `max-width: X` | X, rounded down                    |
| `width > X`, `X < width`     | The smallest whole pixel above X   |
| `width >= X`, `min-width: X` | X, rounded up                      |
| Both bounds                  | The upper bound, by the rule above |

Only `px` and `rem` are read, `rem` against the canvas page's root font size.
Anything else leaves the canvas exactly where it is: `em`, `vw`, height,
orientation, `hover`, `or`, `not`, a comma-separated list, `@container`,
`@supports`, and any width that works out below 280px or above 7680px. A guess
there would move the canvas somewhere the query may not hold.

It also runs the other way. Switching the canvas back to Desktop puts a
`@media` width context back on `Base`, because the next edit would otherwise
land in a query the desktop canvas does not show. A `@container` context follows
its container rather than the window and a `@supports` context has nothing to do
with width, so neither is moved.

Switching context also moves the picked selector, if it has to: the panel keeps
your pick when it has styles in the new query and otherwise jumps to the
strongest one that does.

## Adding a query

`Add query` is the last row of the dropdown. It opens a field with
`@media (width < 50em)` as its placeholder, offering every query already in the
project followed by common ones — `prefers-color-scheme`,
`prefers-reduced-motion`, `pointer`, `hover`, orientation, aspect-ratio,
`@container` and `@supports` among them. A bare condition is taken as `@media`,
so `(width < 40em)` and `width < 40em` both work.

Two choices sit above the field:

- **Wrap** — `New block — @query { selector { … } }`
- **Nest** — `Inside the selector — selector { @query { … } }`

Nesting needs a selector picked; without one the form says
`Pick a selector to nest inside it.` and only Wrap is available. Either way the
empty block is written to the file straight away, so the query survives before
the first property goes into it.

## The six labels that are not yours

One piece of a fixed Webflow-style scale is still live, and it is worth knowing
about so that nobody "corrects" it back the other way. Six exact `@media`
conditions are relabelled when a project happens to write them:

| Query in your stylesheet | Label shown     |
| ------------------------ | --------------- |
| `(min-width: 1920px)`    | `Desktop ≥1920` |
| `(min-width: 1440px)`    | `Desktop ≥1440` |
| `(min-width: 1280px)`    | `Desktop ≥1280` |
| `(max-width: 991px)`     | `Tablet`        |
| `(max-width: 767px)`     | `Mobile (L)`    |
| `(max-width: 479px)`     | `Mobile`        |

The match ignores whitespace and case, so `(max-width:767px)` is relabelled too.
A project using `max-width: 767px` genuinely does see a row reading
`Mobile (L)`.

That is all it is: six widths given friendlier names. The ladder is never listed
for its own sake, nothing is created from it, and a query one pixel either side
of those numbers is shown as you wrote it. If none of the six is in your
stylesheets, you will never see any of these words.

## The cascade between queries

A query view shows the base styles it builds on, not only its own overrides —
and it marks them as inherited rather than as set here, in the same orange as a
value coming from another selector. Changing one writes an override into the
query you are in and leaves the base rule alone. A query nested inside another
inherits from it the same way; a sibling query does not apply at all. See
[selectors](/docs/classes-and-states) for how to read those marks.
