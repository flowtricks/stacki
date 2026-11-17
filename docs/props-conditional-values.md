# Conditional prop values

A prop is rarely the same in every variant. Button's `label` exists for
`play`, `close` and `arrow` only, says something different in each, and
defaults to "Play" or "Pause" depending on `pressed`. The Properties panel
shows and edits all of that with controls a designer already knows, and
writes it as the TypeScript a developer would have written.

This page is the design: the model, the write rules, the UI and the limits.
`docs/props-variant-rules.md` covers the per-option states (Show,
Required, Hide; written `optional`, `required`, `forbidden`) these build on, and `docs/props-complex-shapes.md` the
real components the design is held to.

## One concept: a field set by conditions

Three fields of a prop's settings can depend on other props, and all three
work the same way, as Default value always has:

| Field | Plain | Set by conditions | Code it writes |
|---|---|---|---|
| Visibility | Show or Required (icon choices) | states per condition: Show, Hide, Required | one discriminated union per controller: `label?: string`, `label: string`, `label?: never` in each member |
| Tooltip | its words | words per option of the prop's controller | each member's doc comment |
| Default value | its control for the kind | words per condition on any choice or switch | the destructure default, or the lookup table the component already reads |

Each field's title row works as a prop field's label row does
(`src/features/componentProperties/PropertyFieldHead.tsx`):

- **The +.** Hovering the field shows the purple dot on its top-left
  corner; hovered, it grows into the +. A click opens the shared data picker
  (`FieldDataPicker`, `rows: 'lead'`), whose one row here is **Create
  conditional**: a setting reads no data, so there is no search or tree. It
  is offered only where a condition can be said (Visibility with a choice or
  switch to decide it; a Default value of words or options; a Tooltip on a
  prop a controller rules).
- **The blue label.** Once the field is set, its title is the blue reset
  label (`ResetLabel`), whose menu's Reset clears it: Visibility's
  conditions (no union rules the prop), a Tooltip's per-option words (every
  option none), any Default value given (none). A table default is the
  component's own code, so its title never clears it.
- **The `{}`.** Every state of each field has it beside the title. Default
  value's switches between its control (or pill) and its code, editable.
  Visibility's and Tooltip's show the TypeScript they write, highlighted and
  read-only (`visibilityCode`, `tooltipCode` in
  `src/features/props/visibility.ts`): the prop's declaration, or each ruling
  union's members with the prop as that member declares it and its doc
  comment. A table default's shows the table read-only.

Set, the field is the purple Conditional pill with its values on one line,
opening the Value conditions editor the Style panel's attribute fields use
(`src/features/props/ConditionalValue.tsx`): groups of conditions on other
props, tried in order, `or` between groups, an Else. For Visibility each
group's value and the Else are the same icon choices as the plain field.

### Visibility's icon choices

Show (Central `eye`), Hide (`eyeOff`) and Required (`asterisk`, Figma
variants 7289:63203 and 7289:63225, the mark the prop list already gives a
required prop) sit side by side in the segmented control the Style panel
uses (`src/ui/SegmentedControl.tsx`, drawn compact by
`src/features/props/valueChoices.css`): square 26px buttons packed to the
start of the row on the input fill, as tall as a Dropdown, each naming
itself in the delayed tooltip. The chosen one has the neutral selected look
(a lighter fill, the icon at full strength), never the accent. Hide on a
plain prop opens the editor on a Hide group: hiding a prop everywhere says
nothing, so Hide is always said under a condition; with no prop to hide by,
one line says so and nothing is written.

## The UI

- **Visibility** replaces "Controlled by". Its summary says it in words:
  "Show when Variant is none of Main, Link; Hide otherwise". A new
  conditional Visibility starts the same way round: its first group Show,
  its Else Hide.
  Choosing a prop in a condition is what makes it a controller; nothing is
  promoted by hand. A union the writer cannot keep in step is the pill,
  disabled, with its one word (Runtime, Complex, Nested, Shared).
- **Tooltip** reads as the pill when the options document the prop
  differently (Button's `label`); typing in the plain field writes every
  option's comment.
- **Default value**: Button's `label ?? named[variant]` reads as "If Variant
  = Play and Pressed is true ↳ Pause …", edited in place in the table.
  A default made by code the editor cannot show (`label ?? KINDS[variant].label`)
  is its code, highlighted and read-only, under the one word Computed.
- **The controller** keeps its Options list and Default dropdown; its Kind
  is locked (its options are the union's members).
- **The pop-up** never runs past the window: it is placed with a max-height,
  its head (title, `{}`, unlink) fixed and its groups the scroll region, with
  a stable gutter; a new group is scrolled into view.

## Visibility as TypeScript

TypeScript says a prop's Visibility with discriminated unions: each union a
controller rules it by gives every option a state, and the prop's state is
the strictest any union gives (Hide over Required over Show). So:

- Reading: one controller that only shows or hides the prop over its own
  closed set of options reads **Show first**, Hide the Else, its Show group
  naming the shorter list (`is any of` the shown options, or `is none of`
  the hidden ones; a switch is `is true` or `is false`). That model means
  the same as the rule for every option and writes back as the same rule, so
  opening and closing it writes nothing, byte for byte; an edit writes the
  rule the edited model says. Anything else (Required, several controllers,
  a rule naming options the controller does not list) reads as written: one
  group per controller and state, Hide first, then Required, each testing
  the options that give it; Show is the Else.
- A test kept as code (`index >= PAGE_SIZE`) names no prop: refused, like
  any condition TypeScript cannot say.
- Writing (`setVisibility`, one write and one undo): each group must be one
  condition on one choice or switch, its value a state. Each controller's
  rule for an option is the first group on it that holds there, else the
  Else; and for every combination of options the conditions must mean what
  the strictest of those rules means. Otherwise the edit is refused with
  one line ("TypeScript cannot say this combination…"), never written
  another way. Controllers no group names stop ruling the prop; new ones
  join; every option's state is then set.

## The model

`shared/properties/variantRules.ts`:

- `VariantRule.description`: the prop's tooltip in that option.
- `VariantDefault`: `{ kind: 'table', prop, controller, key, table, entries }`
  for `prop ?? table[key]` where `key` is the local of the prop `controller`
  and `table` a `const` object literal of the frontmatter with plain keys and
  values; `{ kind: 'computed', prop, code }` for any other `prop ?? code`.
- Edits: `setVisibility` (a prop's whole Visibility), `setRuleDescriptions`
  (each option's tooltip), `setRuleType` and `setRuleDescription` (a prop's
  declaration in the named options), `setDefaultTable` (the whole table as it
  should be).

The conditions themselves are the Value conditions model
(`src/editor/conditionalValue.ts`), read and written in the renderer by
`src/features/props/conditionalDefault.ts`:

- A destructure default that is a condition chain is the model itself.
- A table becomes groups that each start with `key = <option>`, the entry's
  own conditions after it; an entry's plain value is that option's last
  group. Writing splits the model back into one entry per option.

## Write rules

1. **Smallest change.** A rule flips a `?` or a type; a type or tooltip edit
   touches only that declaration; a table edit touches only the entries whose
   conditions changed. An entry whose conditions are unchanged keeps its
   code byte for byte, even when the editor would spell it differently.
2. **Each shape is written in its own shape.** A default the author keeps in a
   table is written into the table; a destructure default stays in the
   destructure. A new conditional default goes into the destructure, as a
   condition chain; if it reads a prop destructured after it, its own entry
   moves to just after that prop (a default cannot read a local that does
   not exist yet).
3. **A table edit must be one group per option.** Every group must start with
   `<key> = <one option>` and the Else must give no value (a key the table
   lacks gives none). Anything else is refused with one line saying so,
   never written another way.
4. **A member of several options** (`variant: "month" | "day" | "state"`) is
   shown as one option each. The first edit to that group gives each of those
   options its own member (copies, the first keeping the `?`), in the same
   write: one option's rule cannot be said while it shares a member. An edit
   that changes nothing leaves the shared member as written.
5. **Instances.** Forbidding a prop that an instance passes with that option
   (or with no option, where the fallback forbids it) is refused, naming the
   file. Moving a prop to another controller keeps the state of every option
   both controllers name.
6. **Read-only, never hidden.** Code the model cannot hold is never rewritten:
   a table with a written type (`Record<Variant, string>`, the author's
   contract), an entry that is a call or an object, an `any` group of several
   conditions, a default read further (`KINDS[variant].label`). It is shown as
   its code under Computed; every other part of the prop stays editable.

Every edit is one `component:editProperties` batch: one write, one undo.

## Limits

- Conditions give words: a number or switch prop's default is not set by
  conditions (its `{}` code still holds any expression).
- The runtime type (`Astro.props as AllProps`) is not narrowed when one
  option's type changes; it already accepts what any option does.
- A table is found where the prop is read with `??` directly
  (`label ?? named[variant]`); a default applied another way (`if` blocks,
  `switch`) is not seen.
- A member keyed by an alias of several options (`variant?: VideoRatio`) is
  not split; that union keeps the read-only conditions list.
- The Value conditions editor holds 16 groups of 16 conditions; a bigger
  table stays read-only.

## One group layout everywhere

Every conditions pop-up draws a group the same way, top to bottom, through
one component (`ConditionGroupBody` in `src/features/props/ConditionalValue.tsx`):

1. **If [all] conditions in this group are true** (the grip, the all/any
   picker, the group's remove),
2. the condition rows,
3. **+ New condition**,
4. a divider, then **↳ Value**: what the group gives.

Value conditions on an attribute (Heading `style`, `aria-label`), a Default
value, a Tooltip and a Visibility all use it, and so does the Class list: a
class given only when its conditions hold is a group whose value is the
class, so its conditions come first and the class after. A class given always
has no conditions; its head says **Always**, and its + New condition makes it
conditional. Removing a class's last condition gives it always again (in a
Value conditions group the last condition takes the group with it, as a group
with no condition would always hold).

The Class list once drew its rows value-first ("↳ Value", then "Only when
[all] conditions are true"); that order dated from the list's first version
(b39f372b), not from a later change. It now follows the order above.

## Attribute values: the rich reading

An attribute's value is code an author wrote, so the Attributes section reads
it richly (`readConditionalExpression(code, { shapes: 'rich' })`,
`src/editor/conditionalValue.ts`): any ternary chain is the Conditional pill,
and the parts the rows and value fields cannot draw are kept as **locked
code**, byte for byte, instead of turning the whole attribute back into code.

| Written | Read as |
|---|---|
| `cond ? undefined : X`, `null` | a group whose value leaves the attribute out |
| `a ?? b`, `a \|\| b` | a **fallback**: its values in order, the first that is set wins; shown as the values with `??` between them |
| `named[variant]` | a **lookup**: the entry of a table a prop picks, one bound-value chip |
| `0`, `-1`, `false`, `slug(label)`, `` `cc-${a ?? "b"}` `` | **computed**: locked code in the value, highlighted |
| `index >= PAGE_SIZE`, `selected?.id === id` | a **code condition**: a locked row, removable, the other rows editable |
| `a && b \|\| c` | an any group whose first condition is the code `a && b` |
| `(a \|\| b) && c` | an all group whose first condition is the code `a \|\| b` |
| `a ? (b ? x : y) : z` | flattened: `a && b ? x : a ? y : z`, the same meaning |
| `(…)` around any part | read through |

Lumos Button's `aria-label={isWritten ? undefined : (label ?? named[variant])}`
is one group (If Is Written is set ↳ left out) and an Else that is the
fallback `label ?? named[variant]`.

Write rules for the rich reading:

- **Opened and closed unchanged writes nothing.** An edit writes the whole
  expression again; every part it did not touch comes back as it was: locked
  code verbatim, and parentheses where JavaScript needs them or Prettier
  writes them (`(label ?? named[variant])` in a branch, `(a && b) || c`), so
  Prettier changes nothing. Over the corpus below, all 219 drawn attributes
  write back token for token.
- A flattened nested ternary is written flattened once an edit is made: the
  same meaning, a different spelling.
- **Computed.** Code that chooses between values (a ternary, `&&`, `||` or
  `??` at its top level, or in a template's holes: `isConditionalShaped`)
  but that the reader cannot delimit (a regular expression, an arrow
  function, a condition inside a template, a test with no value to give such
  as `open={a && b}`) is the grey **Computed** pill, read-only, with the code
  highlighted; its `{}` opens the code editor. Code that does not choose
  (`slug(label)`, `item.image?.url`) keeps its code field.
- The plain reading, used by Default value, Visibility, Tooltip and the
  inline style branches, is unchanged: it refuses every rich part, because
  those writers cannot write them back.

### Coverage

Every `{…}` attribute in the templates of the corpus
(`docs/props-complex-shapes.md`: Lumos, webflow-shop, the Webflow.com build,
pigeon): 2,498 expression attributes, 231 of them with `?`, `&&`, `||` or `??`.

| | Before | After |
|---|---|---|
| Conditional pill or Class list, editable | 142 (61.5%) | 219 (94.8%) |
| Computed pill | 0 | 6 (2.6%) |
| Raw code as the main control | 89 (38.5%) | 0 of the choosing ones |

The 6 left as code do not choose between values (the audit's text match
counted `?.`, a `?` in a URL and an `&&` inside an arrow function).

## The values field

A condition's values field (`MultiSelect`, `src/ui/MultiSelect.tsx`) holds
the chosen values as chips, each with its own ×; there is no clear-all. Its
chevron sits in room every line keeps at its end, pinned to the last line, so
chips wrap before they reach it and the field never grows a line holding only
the chevron.

## The value first

A conditional is shown the way people say it, the value first. One group
that leaves the value out before an Else that gives one, as Lumos Button
writes `aria-label={isWritten ? undefined : (label ?? named[variant])}`, is
shown flipped (`presentedModel`, `src/features/props/conditionalModel.ts`):
**If Is Written is false ↳ `label ?? named[variant]`; Else left out**.

- The negation must be exact: is set ↔ is empty, is true ↔ is false, is any
  ↔ is not any, equals ↔ not equals; several conditions flip all ↔ any (not
  all of them is any of their negations). A code condition, whose negation
  the rows do not draw, is never flipped; neither is a model of two or more
  groups, nor one whose Else leaves the value out too.
- Showing it changes no code: closed unchanged, the editor writes nothing
  (`draftUnchanged`). Only an edit writes, and it writes the flipped form
  (`!isWritten ? (label ?? named[variant]) : undefined`).
- A new conditional starts the same way round: its first group gives what the
  field held, and its Else leaves the value out.

## Computed in code

In the template a condition can test what the frontmatter computes from props
(`const isWritten = variant === "main" || variant === "link";`), not only the
props. Such a value is never drawn as a prop: the subject menu lists it after
the props under **Computed in code**, with the Central `code` icon, and its
tooltip says what it is computed from, in words when they say it exactly
("Is Written is computed in code: Variant is any of Main, Link") and as the
code. A value is listed when its one-line `const` is a test of props alone; a
ternary, an object or a call is not one. Default value, Visibility and
Tooltip conditions never list them: a default or a type cannot read the
frontmatter.

When the definition is provably one condition on a prop (a comparison of a
prop with literals, or one prop's `===` joined by `||`, or `!==` joined by
`&&`), a quiet row under the condition suggests it, on the secondary fill
with the branch icon: **Same as: Variant is none of Main, Link** (for Is
Written is false, the negation), and a compact **Switch** at its end. Its
tooltip says why it is offered ("Is Written is computed in code: Variant is
any of Main, Link"); Switch's says what it does ("Replace this condition with
Variant is none of Main, Link (same result, editable with dropdowns)").
Nothing changes until Switch is pressed; the editor writes once, as it
closes, so it is one undo step. The subject's own trigger has the
definition as its tooltip too.
