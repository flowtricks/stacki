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

Every control lives in a prop's own Property settings; nothing is text.

- **A ruled prop** (`label`, `href`, `disabled`): in place of Required,
  "Controlled by" names the controller (a Dropdown when two groups rule it),
  then one Allowed / Required / Not allowed switch per option (`setRule`).
- **The controller** (`variant`, `element`): the panel's own Options list and
  Default value dropdown, with no Required checkbox and no `{}` code switch.
  Adding, renaming (on commit), removing or dragging an option in the list is
  `addOption`, `renameOption`, `removeOption` or `moveOption`; picking another
  default is `setFallback`. A refusal shows on the form's error line.
- **A prop every option shares** (`render`): "Only for" with the controller
  and its options; a pick is `attachProp` for that option, after which the
  prop is ruled and the switches take over.

`addProp` and `removeProp` stay in the writer, but no control sends them:
a new prop is created in the prop list and given rules with "Only for".

## The model

```ts
type Props = { render?: boolean } & Tag & Kind;
type Kind =
  | { variant?: "main"; emphasis?: Emphasis; label?: never }
  | { variant: "play"; emphasis?: Emphasis; label?: string };
```

- **Group**: one union `Props` intersects, directly or through local,
  non-exported, non-generic aliases (`Tag`, `Kind`).
- **Controller**: the first prop every member declares as a single string
  literal, a different one in each (`variant`, `element`). A union with no such
  prop is not a group; its props keep the read-only conditions
  (`propertyContracts.ts`).
- **Option**: one member, named by its controller literal. The member whose
  controller is optional (`variant?: "main"`) is the **fallback**, shown as
  Default: it applies when the controller is not passed.
- **Props**: every prop a member names, the controller excluded, in the order
  first written.
- **Rule**: a prop under an option is `optional` (Allowed), `required`
  (Required) or `forbidden` (Not allowed). `forbidden` is either `prop?: never`
  or not named at all (`listed: false`); TypeScript refuses both.

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
| `setRule` | Allowed / Required: adds or removes the member's `?`; from Not allowed, the type comes back from the first option that allows the prop (else the runtime type). Not allowed: `prop?: never`. An unnamed prop is appended in the member's own style (line, indent, `;` or `,`) |
| `addOption` | A copy of the last member after it, with the new literal and no `?`; the runtime controller union gains the option |
| `renameOption` | The member's literal, the runtime union, the destructure default, `local === "x"` / `case "x":` comparisons in the frontmatter and template, and every instance that passes it (`<Button variant="x">`) |
| `removeOption` | The member and one separator; the runtime union |
| `moveOption` | Member texts swap slots; separators stay; the runtime union follows |
| `setFallback` | The `?` moves to the option; the destructure default follows |
| `addProp` | `prop?: type` in every member, in the runtime type, and a local before `...rest` |
| `removeProp` | The prop's declaration in every member (comments with it), in the runtime type, and its local |
| `attachProp` | A prop the shared object type declares (`{ render?: boolean } & Tag & Kind`) leaves it, comment included, and every member declares it: as it was where picked, `never` elsewhere |

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
- Removing a prop the code still reads.
- Adding a prop whose name is declared or in scope; a type that does not parse.

## Limitations

- Option values are string literals only; numeric or boolean controllers are
  not groups.
- A prop's type is one per prop: an option that allows it again takes the
  first allowing option's type. Per-variant types that differ are kept as
  written, but not edited apart.
- Template mentions are found textually (`<style>` and `<script>` blanked);
  an option built at runtime (`variant + "-x"`) cannot be seen.
- Moving a prop between groups, or back out of a group into the shared object
  type, is not an edit; it is a source change. `attachProp` does not check
  instances that pass the prop under an option that now forbids it.
- The controller's Kind dropdown still saves a type change through the
  ordinary save, which would rewrite the union's members; leave its Kind alone.
