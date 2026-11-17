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

## One concept, three questions

For any prop, per option of a controller (`variant`, `element`, a switch):

| Question | Where it is answered | Code it writes |
|---|---|---|
| May it be passed? | Controlled by: Allowed / Required / Not allowed per option | `label?: string`, `label: string`, `label?: never` in that member |
| What is it there? | The option's own Kind and Tooltip (open the option's row) | That member's declaration type and doc comment |
| What is it when not passed? | Default value, set by conditions | The destructure default, or the lookup table the component already reads |

The common case stays the simple one: a prop with no rules has Required and
a plain Default value; Controlled by appears only once a controller is
picked; an option's Kind and Tooltip only when its row is opened; conditions
only when the Default value's branch is pressed.

## The UI

Everything is a control; nothing asks for TypeScript.

- **Controlled by** (unchanged): one row per option, its name on the left and
  three icon buttons on the right. An option that allows the prop shows a
  chevron before its name; pressing the name opens the option's own **Kind**
  (the same Kind picker, Options list and `{}` switch every prop has) and
  **Tooltip**, on a well one step darker than the panel. An option whose kind
  differs from the prop's shows that kind's icon in its row, so a
  per-option type is visible without opening anything.
- **Tooltip**: when the options document the prop differently, the prop's
  Tooltip reads **Varies**. Typing there writes the same words to every
  option that allows it; each option's own words are in its row.
- **Default value**: the same purple **Conditional** chip, summary and
  **Value conditions** editor the Style panel's attribute fields use
  (`src/features/props/ConditionalValue.tsx`): groups of conditions on other
  props ("If all are true: Variant = Play, Pressed is true ↳ Pause"), tried in
  order, an Else. A designer who made a Heading's class conditional already
  knows it. A text or options prop with a plain default has a branch button
  beside the `{}`: **Set by conditions** opens the editor with the current
  default as the Else.
- **Computed**: a default made by code the editor cannot show
  (`label ?? KINDS[variant].label`) is its code, highlighted and read-only,
  under the one word Computed.
- **The controller** keeps its Options list and Default dropdown. Its Kind is
  locked: its options are the union's members, so a kind change would
  rewrite all of them.

## The model

`shared/properties/variantRules.ts`:

- `VariantRule.description`: the prop's tooltip in that option.
- `VariantDefault`: `{ kind: 'table', prop, controller, key, table, entries }`
  for `prop ?? table[key]` where `key` is the local of the prop `controller`
  and `table` a `const` object literal of the frontmatter with plain keys and
  values; `{ kind: 'computed', prop, code }` for any other `prop ?? code`.
- Edits: `setRuleType` and `setRuleDescription` (a prop's declaration in the
  named options), `setDefaultTable` (the whole table as it should be).

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
