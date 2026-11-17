# Conditional prop values

A prop is rarely the same in every variant. Button's `label` exists for
`play`, `close` and `arrow` only, says something different in each, and
defaults to "Play" or "Pause" depending on `pressed`. The Properties panel
shows and edits all of that with controls a designer already knows, and
writes it as the TypeScript a developer would have written.

This page is the design: the model, the write rules, the UI and the limits.
`docs/props-variant-rules.md` covers the per-option states (Allowed,
Required, Not allowed) these build on, and `docs/props-complex-shapes.md` the
real components the design is held to.

## One concept: a field set by conditions

Three fields of a prop's settings can depend on other props, and all three
work the same way, as Default value always has:

| Field | Plain | Set by conditions | Code it writes |
|---|---|---|---|
| Visibility | Allowed or Required (a Dropdown) | states per condition: Allowed, Required, Not allowed | one discriminated union per controller: `label?: string`, `label: string`, `label?: never` in each member |
| Tooltip | its words | words per option of the prop's controller | each member's doc comment |
| Default value | its control for the kind | words per condition on any choice or switch | the destructure default, or the lookup table the component already reads |

A branch beside the field's title makes it conditional; set, the field is
the purple Conditional pill with its values on one line, opening the Value
conditions editor the Style panel's attribute fields use
(`src/features/props/ConditionalValue.tsx`): groups of conditions on other
props, tried in order, `or` between groups, an Else. For Visibility each
group's value is a state picker instead of words.

## The UI

- **Visibility** replaces "Controlled by". Its summary says it in words:
  "Not allowed when Variant is any of Main, Link; Allowed otherwise".
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
the strictest any union gives (Not allowed over Required over Allowed). So:

- Reading: one group per controller and state, Not allowed first, then
  Required, each testing the options that give it; Allowed is the Else.
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
