# Style panel variables

Every value control in the Style panel can be connected to a CSS variable, the same
way in every section:

- **Hover** a control: the purple dot appears in its top-left corner. Press it to
  open the variable picker (the project's `--*` custom properties, searchable,
  filtered to what the property takes).
- **Dropdowns and segmented bars** also offer **Variable…** first in their list or
  menu; it opens the same picker.
- **Picking** writes `var(--name)` as the property's whole value, through the
  control's own write: instant, one undo step, in the selected breakpoint and
  state. A pick inside a typed expression (a `calc()`, a fallback) goes in at the
  caret and leaves the rest of the text as it was.
- A value holding `var(…)` shows the **purple chip** inside the field, never the raw
  text. The caret sits behind the chip, so Backspace removes it; the chip's tooltip
  shows the variable and what it is declared as; pressing the chip swaps it for
  another variable.
- **Disconnecting**: choose a keyword from the dropdown or menu, or delete the chip
  (an empty field clears the property).

How it is built:

- Typed fields wrap their `<input>` in `VariableConnect` (`src/features/style/VariableConnect.tsx`).
- Keyword controls are wrapped in `KeywordConnect` (`src/features/style/KeywordConnect.tsx`):
  `VariableSelect` for dropdowns, `VariableMenuItem` for segmented menus,
  `KeywordSegments` for two-segment bars with no custom mode. While the value is a
  variable the control shows its custom field, which is itself a `VariableConnect`
  field: that draws the chip, and the wrapper's own dot steps aside.

## Audit

`test/renderer/style/keywordVariablesCoverage.test.js` scans every `.tsx` file under
`src/features/style` and fails when a file with input controls is not listed here
(with the same counts), so a new input cannot ship without this decision.
`test/renderer/style/keywordVariables.test.js` drives the converted keyword controls.

Totals: 53 files, 77 controls: 30 took variables before, 26 converted, 21 exempt (not a CSS value, or one facet of a compound value whose own field takes variables).

| File | Control (property) | Takes variables | Why not |
| --- | --- | --- | --- |
| `AlignControl.tsx` | justify-content, align-items (Align X / Y dropdowns and their custom field) | Yes (converted) |  |
| `AspectRatioField.tsx` | aspect-ratio (preset dropdown) | Yes (converted) |  |
| `AspectRatioField.tsx` | aspect-ratio (Other free field) | Yes (before) |  |
| `AspectRatioField.tsx` | aspect-ratio W / H numbers | No | two halves of one ratio; a variable goes in the Other field |
| `BackgroundKit.tsx` | background-color and background fields | Yes (before) |  |
| `BackgroundLayerEditor.tsx` | layer type, tile, fixed | No | one entry of a comma-separated layer list, and the type is a mode of the editor |
| `BackgroundLayerFields.tsx` | background-size / background-position parts | Yes (converted) |  |
| `BackgroundLayerFields.tsx` | overlay colour | Yes (converted) |  |
| `BackgroundLayerFields.tsx` | image url | Yes (before) |  |
| `BackgroundLayerFields.tsx` | size mode (Custom / Cover / Contain) | No | a mode of the editor; the Width / Height parts take variables |
| `BordersSection.tsx` | border-style bar | Yes (converted) |  |
| `BordersSection.tsx` | border-width, border-color | Yes (before) |  |
| `BoxShadowsRow.tsx` | shadow inset / outset | No | a keyword inside one shadow of a list |
| `codeChips/CodeChips.tsx` | a code chip’s gradient type and keyword buttons | No | they edit code, where a variable is its own chip (the variable picker) |
| `CustomValueEditor.tsx` | the large value editor, any property | Yes (before) |  |
| `DecorationPopover.tsx` | text-decoration-skip-ink | Yes (converted) |  |
| `DecorationPopover.tsx` | text-decoration line / style facets | No | facets of the text-decoration shorthand, written together |
| `DecorationPopover.tsx` | text-decoration-thickness, color | Yes (before) |  |
| `DirectionControl.tsx` | flex-direction bar | Yes (converted) |  |
| `DisplayControl.tsx` | display bar | Yes (converted) |  |
| `EasingEditor.tsx` | transition-timing-function | Yes (before) |  |
| `EffectsKit.tsx` | mix-blend-mode, cursor (preset dropdowns) | Yes (converted) |  |
| `EffectsKit.tsx` | effect free fields | Yes (before) |  |
| `FilterFields.tsx` | filter function type | No | the name of a function inside a filter list, not a value |
| `FlexChildSection.tsx` | flex sizing bar | Yes (converted) |  |
| `FlexChildSection.tsx` | flex-grow, flex-shrink, flex-basis, grid lines | Yes (before) |  |
| `GapControl.tsx` | gap, row-gap, column-gap | Yes (before) |  |
| `GradientCode.tsx` | gradient code | Yes (before) |  |
| `GradientEditor.tsx` | gradient stop colour | Yes (converted) |  |
| `GradientEditor.tsx` | repeating checkbox | No | a switch between two functions, not a value |
| `GridAreas.tsx` | grid area names and cell numbers | No | identifiers and cell indexes; var() is not valid there |
| `GridAxisMode.tsx` | track mode (count / expression) | No | a mode of the editor; the expression takes variables |
| `GridControls.tsx` | justify-items, align-items (grid align X / Y) | Yes (converted) |  |
| `GridFlowControls.tsx` | grid-auto-flow bar | Yes (converted) |  |
| `GridFlowControls.tsx` | justify-content, align-content bars | Yes (converted) |  |
| `GridFlowControls.tsx` | track count | No | a count of equal tracks; any other value is the expression field |
| `GridTrackExpression.tsx` | grid-template-columns / rows | Yes (before) |  |
| `KeywordConnect.tsx` | the connection itself (VariableSelect, KeywordSegments) | Yes (before) |  |
| `LiveTextInput.tsx` | typography text fields | Yes (before) |  |
| `ObjectFitFields.tsx` | object-fit dropdown | Yes (converted) |  |
| `ObjectFitFields.tsx` | object-fit free field, object-position | Yes (before) |  |
| `OpacityRow.tsx` | opacity | Yes (before) |  |
| `PositionSection.tsx` | position dropdown | Yes (converted) |  |
| `PositionSection.tsx` | top / right / bottom / left, z-index | Yes (before) |  |
| `PositionSection.tsx` | inset presets | No | shortcuts that write four lengths at once |
| `PositionSegments.tsx` | float, clear bars | Yes (converted) |  |
| `SegmentedField.tsx` | pointer-events, outline-style bars | Yes (converted) |  |
| `ShadowFields.tsx` | shadow lengths and colour | Yes (before) |  |
| `SizeKit.tsx` | width, height, min / max | Yes (before) |  |
| `SizeSegmentBar.tsx` | overflow, box-sizing bars | Yes (converted) |  |
| `SpacingEditor.tsx` | margin, padding | Yes (before) |  |
| `TextWrapRows.tsx` | white-space, word-break, overflow-wrap dropdowns | Yes (converted) |  |
| `TextWrapRows.tsx` | text-overflow bar | Yes (converted) |  |
| `TokenField.tsx` | the chip editor itself | Yes (before) |  |
| `TrackEditor.tsx` | track sizes | Yes (before) |  |
| `TrackEditor.tsx` | track sizing mode, auto-fit checkbox | No | modes of the track editor |
| `TransformSettings.tsx` | backface-visibility bar | Yes (converted) |  |
| `TransformSettings.tsx` | transform-origin, perspective | Yes (before) |  |
| `TransformsRow.tsx` | transform values | Yes (before) |  |
| `TransformsRow.tsx` | transform type | No | the name of a function inside a transform list |
| `TransitionsRow.tsx` | transition property | No | one entry of a transition list, a property name |
| `TransitionsRow.tsx` | transition duration, timing | Yes (before) |  |
| `TypographyColumns.tsx` | column-span bar | Yes (converted) |  |
| `TypographyColumns.tsx` | column-rule-style bar | Yes (converted) |  |
| `TypographyColumns.tsx` | columns, column-gap, rule width / colour | Yes (before) |  |
| `TypographyKit.tsx` | text-align, text-decoration, text-transform, font-style, direction, align-self, justify-self, order bars | Yes (converted) |  |
| `VariableConnect.tsx` | the connect wrapper itself | Yes (before) |  |
| `VariablePicker.tsx` | picker search | No | searches the list; not a value |
| `clipPath/ClipPathView.tsx` | clip-path variable field | Yes (before) |  |
| `clipPath/ClipPathView.tsx` | shape fit mode | No | a mode of the shape editor |
| `components/ColorPicker.tsx` | hex text inside the colour picker | No | the picker of a field that takes variables |
| `components/LiveInput.tsx` | the shared value field | Yes (before) |  |
| `components/SelectViews.tsx` | dropdown search | No | searches the list; not a value |
| `embed/AddProperty.tsx` | Other properties rows | Yes (before) |  |
| `embed/QueryForms.tsx` | media / container query forms | No | query conditions, not property values |
| `embed/ResolvedRows.tsx` | vertical-align dropdown | Yes (converted) |  |
| `embed/SelectorPicker.tsx` | selector picker | No | selectors, not property values |
| `embed/StyleCard.tsx` | state and breakpoint menus | No | which rule is edited, not a value |
