# Variant rules

A component often allows a prop only for some of its variants: a Button's
`label` exists for `play`, `close` and `arrow`, never for `main`. In TypeScript
that is a discriminated union, and designers should not have to write one. The
Properties panel reads the union, draws it as controls, and writes each change
back as the smallest edit to the TypeScript that says it.

| Piece | File |
|---|---|
| Model and boundary parsers (the renderer–main contract) | `shared/properties/variantRules.ts` |
| Reader: frontmatter to model, with the syntax the writer edits | `electron/properties/variantRuleModel.ts` |
| Writer: one edit to minimal text edits | `electron/properties/variantRuleEdits.ts` |
| Plan: the instances a rename or removal touches | `electron/properties/variantRulePlan.ts` |
| Panel controls | `src/features/componentProperties/PropertyVariants.tsx` |

## In the panel

Every control lives in a prop's own Property settings; nothing is text. A
prop's rules are its **Visibility**, set by conditions like Default value
(docs/props-conditional-values.md): the purple Conditional pill, opening the
Value conditions editor with states as values. The controller (`variant`,
`element`) keeps the panel's Options list and Default dropdown, which write
the union's option edits (`addOption`, `renameOption`, `removeOption`,
`moveOption`, `setFallback`); its Kind is locked. The prop list marks a
conditional prop with a dimmed branch (Central `branch`, 14759:28219).

## The model

```ts
type Props = { render?: boolean } & Tag & Kind;
type Kind =
  | { variant?: "main"; emphasis?: Emphasis; label?: never }
  | { variant: "play"; emphasis?: Emphasis; label?: string };
```

- **Group**: one union `Props` intersects, directly or through local,
  non-exported, non-generic aliases (`Tag`, `Kind`). An `interface Props`
  has no group, but its props of options are candidates: the first
  `attachProp` writes it as `type Props =` (body unchanged).
- **Controller**: the first prop every member declares as literals of one
  kind, different ones in each: strings (`variant`, `element`) or
  `true` / `false`. A member may name several string options
  (`variant: "month" | "day"`): it is read once per option, and split into
  one member per option before an edit to its group. A boolean controller's two options are fixed: they are
  never added, renamed or removed. A union with no such
  prop is not a group; its props keep the read-only conditions
  (`propertyContracts.ts`).
- **Option**: one member, named by its controller literal. The member whose
  controller is optional (`variant?: "main"`) is the **fallback**, shown as
  Default: it applies when the controller is not passed.
- **Candidate**: a prop that could become a controller (string options or a
  boolean, shared or ruled by another group, not a controller) is offered as
  one (`editing: { kind: 'candidate' }`, no rules); `attachProp` to it creates
  the group.
- **AND**: one prop may be ruled by several groups (`disabled` by `element`
  and `variant`). `Props` intersects the unions, so each must allow it. They
  stay separate unions; nothing is flattened.
- **Props**: every prop a member names, the controller excluded, in the order
  first written.
- **Rule**: a prop under an option is `optional` (Show), `required`
  (Required) or `forbidden` (Hide). `forbidden` is `prop?: never` (or
  `prop?: undefined`), or a prop the member does not name that no type
  beside the union declares either (`listed: false`); TypeScript refuses
  all three.
- **Inherited**: absence alone never forbids. A prop declared outside the
  union, in a type `Props` intersects with it (`type Props = Base & (A | B | C)`,
  Lumos's Card: `theme` in `Base`, `theme?: never` only in stacked), is
  every member's unless the member says `never`: a member that does not
  name it reads as the shared declaration says (`listed: false`, its type
  and tooltip). Both hold, so a shared `never` or a shared requirement wins
  over the member's own declaration. The instance panel's union tables
  (`electron/parse/propModel/propDeclarations.ts`) read it the same way.
  Writing: Hide appends the member's own `prop?: never`; Show everywhere
  removes the members' declarations and keeps the shared one (never a
  second); a tooltip or type for options that inherit it is written once,
  on the shared declaration; making a shared requirement optional for one
  option is refused. `test/electron/properties/variantVisibilityCorpus.test.ts`
  holds both readers to the TypeScript checker over the corpus
  (docs/props-complex-shapes.md).

Members may intersect attribute types the file does not declare
(`HTMLAttributes<"a"> & {…}`, `Omit<HTMLAttributes<"a">, "type"> & {…}`):
they pass through untouched.

## What stays read-only

A group the writer could not edit faithfully is still drawn, with one word:

| Reason | Shape |
|---|---|
| Shared | The union or `Props` is exported: other files read it |
| Nested | A member holds another union |
| Complex | A member is not one object type beside attribute types: a local alias, a method, a quoted key, a mapped type, two object types; or two groups share a controller |
| Runtime | Several `Astro.props as …` types, a runtime type that is a union, or several destructures of `Astro.props` |

## Edits

Every edit is `{ kind: 'variantRules', edit }` on `component:editProperties`
(docs/contracts.md): one batch, one undo. Main re-reads the source, refuses a
read-only or unknown group, plans text edits, checks the frontmatter still
parses, and asserts that the result reads back as asked.

| Edit | Writes |
|---|---|
| `setRule` | Show / Required: adds or removes the member's `?`; from Hide, the type comes back from the first option that allows the prop (else the runtime type). Hide: `prop?: never`. An unnamed prop is appended in the member's own style (line, indent, `;` or `,`) |
| `addOption` | A copy of the last member after it, with the new literal and no `?`; the runtime controller union gains the option |
| `renameOption` | The member's literal, the runtime union, the destructure default, `local === "x"` / `case "x":` comparisons in the frontmatter and template, and every instance that passes it (`<Button variant="x">`) |
| `removeOption` | The member and one separator; the runtime union |
| `moveOption` | Member texts swap slots; separators stay; the runtime union follows |
| `setFallback` | The `?` moves to the option; the destructure default follows |
| `addProp` | `prop?: type` in every member, in the runtime type, and a local before `...rest` |
| `removeProp` | The prop's declaration in every member (comments with it), in the runtime type, and its local |
| `attachProp` | A prop the shared object type declares (`{ render?: boolean } & Tag & Kind`) leaves it, comment included, and every member declares it: as it was where picked, `never` elsewhere. A prop another group rules keeps those declarations, and this group's members declare it too (both hold). For a candidate controller (no group yet), the controller and the prop both leave the shared object type and `Props` is intersected with `(\| { size?: "s"; icon?: never } \| { size: "l"; icon?: string })`; the destructure's default (else the first option) is the fallback when the controller was optional |
| `switchController` | `detachProp` from one controller, then `attachProp` to the other, as one write and one undo: an option both controllers name keeps its state (Required stays Required); with none in common the prop is allowed for every option |
| `setRuleType` / `setRuleDescription` | The prop's declaration type, or its doc comment, in the named options only |
| `setDefaultTable` | The lookup table a default is read from (docs/props-conditional-values.md) |
| `detachProp` | The prop leaves every member and is declared once in the first shared object type (one is intersected onto `Props` when there is none): the first allowing option's type and comment, Required only if every option required it |

The runtime type (`Astro.props as AllProps`) is kept in step only where it
lists exactly the options, as string literals; one written another way
(`Kind["variant"]`, `string`) follows by itself and is not touched.

## Refusals

- Removing the fallback, or leaving fewer than two options.
- Renaming or removing an option the code uses in a way the writer cannot
  follow: an object key or a property name spelled as it (`named.play`,
  `{ play, close }`). Removing also refuses comparisons, which would test an
  option that no longer exists.
- Removing an option or a prop an instance still passes, naming the file.
- Forbidding a prop (Hide, attaching for some options, switching) that
  an instance passes with an option that now forbids it, naming the file.
- Removing a prop the code still reads.
- Adding a prop whose name is declared or in scope; a type that does not parse.

## Limitations

- Numeric controllers are not groups; boolean ones keep their two options.
- A member keyed by an alias of several options (`variant?: VideoRatio`) is
  not read as a group; its props keep the read-only conditions.
- Template mentions are found textually (`<style>` and `<script>` blanked);
  an option built at runtime (`variant + "-x"`) cannot be seen.
- Forbidding a prop judges instances that pass the controller as a literal
  (or not at all); one that passes it as code is not judged.

Per-option types, tooltips and defaults, and a member of several options,
are in docs/props-conditional-values.md.
