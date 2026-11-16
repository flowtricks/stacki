# Spacing bands on the canvas

Hovering a side of the Spacing box in the Style panel draws that side on the canvas. Hover is a view:
it writes nothing.

| Piece | Where |
|---|---|
| Hover report (`SpacingHover`: kind, sides, labels) | `src/features/style/SpacingFill.tsx` `useSideHover` |
| Measured computed margin and padding, and what each vertical margin collapses with | `electron/preload/frameMeasure.ts` `spacingForPath`, `marginCollapses` |
| Strips, collapse marker, clipping to the frame | `src/features/preview/spacingBands.ts` |
| Drawing | `src/features/preview/PreviewOverlays.tsx` `SpacingOverlays` |

## Rules

- **Used geometry.** Strips come from the element's laid-out box plus its computed margin, so a
  `var()` token, a `:where()` rule or a `* + *` rule shows what the page uses.
- **Drawn in the overlay layer**, above the page in frame coordinates, so no page `overflow: hidden`
  cuts it. The layer clips at the frame edge; a band is cut to the frame (`clipBand`) so its label
  stays on the part that can be seen. A band wholly outside the frame is not drawn.
- **Collapsed margins.** Adjoining vertical margins of in-flow blocks collapse into the larger. When
  the hovered margin is the smaller, it adds no space and a strip would be false: a 2px marker line
  is drawn at the box edge with the label "Margin collapses with the previous / next element / the
  parent's margin" (`preview.spacing.collapsed*`). The larger margin keeps its whole strip. Flex and
  grid items, floats and positioned boxes never collapse.
- Sides are physical (`margin-top` is the top edge in any direction or writing mode).

## Tests

`test/renderer/preview/spacingBandSides.test.js` (geometry, overlays),
`test/electron/preload/marginCollapse.test.js` (frame, jsdom),
`test/electron/preload/spacingBandsLayout.test.js` (real Chromium layout).
