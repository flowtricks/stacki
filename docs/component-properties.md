# Component properties

Properties (K) is available while editing an Astro component or layout. The panel
edits the component's authored `Props` declaration and `Astro.props` defaults.
It does not store a separate schema, so the project's code remains authoritative.

The visual editor supports adding fields, required and readonly modifiers,
descriptions (JSDoc), arbitrary TypeScript type text, default expressions,
drag-to-reorder properties and literal union options, and trash actions.
Property grip handles also support arrow keys for keyboard reordering. Options use
the same `ListField` rows and click-to-edit popover as component list props, including
Add item, drag-and-drop, and hover trash actions. The adapter keeps literal types
and defaults intact even when string and non-string options share a visible label.
Clicking the open option again closes its popover and commits the current edit.
Deleting a prop asks first and removes it across the site (see "Deleting a prop").
A required field and a default
are independent: a runtime fallback does not remove the caller's type obligation.
Locally declared fields stay visually editable when `Props` extends another type,
including Astro's `HTMLAttributes`. Inheritance and unrelated fields are preserved.
Local aliases for primitive and literal union types resolve into visual controls.
Renaming a field or changing its tooltip, default, or required flag retains the
alias. Editing its options writes the new union on that field alone, preserving
other fields that share the alias. Renaming the default option updates its fallback.
Type expression uses the shared searchable dropdown for primitive types, options,
arrays, tuples, records, callbacks, and common built-in types. The braces button
switches to a plain input for custom types such as `typeof theme` or imported
aliases. Switching modes preserves the current type and union options; hovering
a menu choice never changes the prop. Unsupported types open in input mode.
Common fields in composite `Props` contracts stay editable when their declaration
is local and shared by the public and runtime types. An imported or other named
type in the intersection (`type Props = SeoProps & { theme?: … }`) only adds
fields, so the local members beside it stay editable. Variant-dependent fields show
their conditions and explain why source editing is needed. A member whose own type
is imported, a local generic, or computed (mapped, conditional, indexed, `typeof`,
`keyof`) stays read-only with the note "depends on a shared or computed type", as do
ambiguous declarations and computed parts of the contract. Options kept in a
same-file alias (`theme?: Theme`) are edited in the alias; when other declarations
use it too, or it is exported, the form warns that the edit changes all of them.

Members of an imported props type (`SeoProps` from `src/types.ts`, through the
tsconfig `@/` alias) are listed under "From SeoProps · src/types.ts", with a link to
the file, and use the same editors. Their name, type, options, Required and tooltip
are written to the shared file; the form says so first ("Shared: edits SeoProps in
src/types.ts, used by N components … and their instances", which expands to the
list). A default is each component's own destructure, so it is written in the
component edited when that component destructures the prop, and the other users'
defaults are shown. A rename rewrites the type, every user's destructure,
`Astro.props.x` and rest `seo.x` reads, and every instance, listed before it is
applied, as one undo step; a computed read or another use of the rest variable
refuses only the rename. Deleting a shared member is done in its file.

Readonly is not offered: TypeScript's `readonly` has no effect on Astro props, and
an existing modifier is kept as written. A Switch has no On/Off labels; legacy
`@onLabel`/`@offLabel` tags are ignored, kept out of the tooltip, and the tooltip
field offers to remove them once it is edited. Nothing in property settings has a
Save button: an existing prop saves as it changes, and a new one is created when
its name is committed (or as the form closes) and then saves itself. The `{}`
toggle beside Options (or Kind) switches to the code type. Add and reorder operations on composite
contracts still require source editing. Declaration locations appear in an information
tooltip, not as runtime binding chips. Clicking a prop never opens the full source editor.
Renames also update indexed and picked references to local contract types.

Property rows show names and type icons. Type and default choices use the shared
custom dropdown, with matching expression toggles. Long option lists scroll after
six rows, with Add item outside the scrolling region. Property settings close on
outside clicks, including clicks in the canvas, and remain dismissible when read-only.

The panel listens for external changes to the open component and automatically
loads the latest properties. Stacki's own writes are filtered by the project
watcher and update the panel directly from their save results. External changes
received during a save are coalesced into one refresh afterward. New source
replaces an open property draft; unchanged source preserves it. Stale reads and
responses received after the panel closes are ignored.

Renames follow imports to the component file, including project path aliases.
They update explicit instance attributes, shorthand attributes, inline object
spreads, and direct `Astro.props` accesses. Destructured local bindings retain
aliases, preserving lexical scope and avoiding changes to shadowed variables.
Defaults also apply to direct `Astro.props` reads. A generated local alias keeps
those reads from being shadowed by template loop variables. Reads before the
default binding must be moved in source first to preserve execution order.
Unrelated components, CSS, literal text, and comments remain unchanged.
Ambiguous cases (dynamic spreads, computed prop access, forwarded props, and
JavaScript consumers, re-exports, and dynamic imports) return an actionable error
before any file is written.

Each edit compares the loaded source against disk before writing. Multi-file
renames validate every revision, atomically replace each file in a synchronous
batch, and restore written files if an operating error occurs. The renderer flushes pending page
and code saves before making a request, then refreshes the model and schemas.
File, byte, field, and AST limits cap project traversal and refactoring work.

## A class list prop

In a component, the purple dot on an element's Class field, and on a `class:list`
attribute, offers **New Class list property** under New Plain Text property. It makes
the prop an instance passes its own classes through (`<Card class="featured">`), as
Lumos components do: `class?: string` in `interface Props`, read as `class: className`
(`class` is a reserved word, so the destructure binds it by an alias; `propClass` when
`className` is taken). The element's classes move into `class:list` with the prop
last, so an instance's classes come after the element's:

| Before | After |
|---|---|
| `class="card hero"` | `class:list={["card", "hero", className]}` |
| no class | `class:list={[className]}` |
| `class={tone}` | `class:list={[tone, className]}` |
| `class:list={["card", on && "is-on"]}` | `class:list={["card", on && "is-on", className]}` (one entry per line stays so) |

`class:list` takes the place of `class`; every other attribute keeps its place and
bytes. A `class` beside an existing `class:list` stays as it was. The declaration and
the rewrite are one undo step, and the write goes through main's pre-flight like any
edit. Data picked from a `class:list`'s dot joins the list rather than replacing it.

The row is drawn disabled, with the reason, where the rewrite would have to guess
(`src/features/props/classListProp.ts`): a component tag (it reads `class` its own
way), a spread other than the component's own rest props (it could pass a class of
its own; the rest props are safe, since declaring `class` takes it out of them), a
component that already declares `class`, or a value that does not read as one
expression. Instances then edit the prop with the class field's token editor.

## Deleting a prop

The trash button (in the prop's settings, or on its row) never deletes at once.
Main reads the site first (`component:previewPropertyRemoval`, which writes
nothing) and the window's own confirmation (`ConfirmDialog`, never a native one)
says what will happen, one short line each:

- the prop, and that it leaves the component, every variant included;
- when the component's own code reads it, the constant that keeps that code
  working ("Kept as a constant: `direction = "forward"` (read on lines 122, 132)");
- how many instances pass it, and in which files (six listed, then "and N more");
- spreads to check by hand, by file and line;
- that one Undo restores everything.

Confirming sends the ordinary `{ kind: 'remove' }` batch on
`component:editProperties`, planned again from disk
(`electron/properties/propertyRemoval.ts`), so a file changed in between is read
afresh and an outside edit refuses the batch. It removes:

- every declaration of the prop: the `Props` member, each discriminated-union
  branch's member (`direction?: never` included), the runtime type's member;
- its destructure entry and default;
- the value every instance passes, in every file that imports the component:
  `direction="back"`, `direction={value}`, `` direction=`…` ``, `{direction}`, a
  bare `direction`, and the key of an inline spread (`{...{ direction: 'back' }}`;
  the whole spread when that key is all it holds). The space before an attribute
  goes with it; every other byte is copied, not re-printed.

When the component's own code reads the prop's local (`direction === 'back'`,
`data-direction={direction}`), the deletion keeps that code working: a constant
of the same name goes right after the destructure, holding what the prop would
now always be, and the reads are left as written:

```ts
const direction = "forward" as "forward" | "back";
```

- **The value** is the prop's default expression, kept as written (a default
  that reads other props works too: they are bound by then). With no default,
  an optional prop's constant is `undefined` (typed `T | undefined`), as when
  nothing passed it; a required one gets its first option, or `""`, `0`,
  `false` or `[]` by kind. The dialog says which.
- **The `as`** keeps the prop's declared type: a bare `"forward"` would narrow
  it, and `direction === "back"` would stop type-checking.

What no constant can stand in for is never guessed at:

- **A read through the props object** (`Astro.props.direction`,
  `props.direction`, `rest.direction`), **a default that reads the prop
  itself**, **a required prop with no default and no zero value for its type**
  (an object shape), and **a prop only an inherited type declares** (`class`
  from `HTMLAttributes`, which instances still pass). Nothing is deleted: the
  dialog lists each line ("can't be deleted yet") and the batch refuses with the
  same lines (`props.edit.readsInCode`). The scan is syntactic and
  conservative: a shadowing loop variable counts too. Keys, CSS
  (`flex-direction`), markup text and client scripts do not.
- **An instance spreads an object Stacki cannot see into** (`{...props}`). It may
  or may not carry the prop; the deletion goes ahead, leaves that object alone,
  and lists the line under "Check by hand".

Each written file must parse again before the batch is written. The consumer
scan is the rename's (`readPropertyConsumers`): the same refusals for consumers
that use the component in code, re-export it or import it dynamically. A prop
declared by a shared type is deleted in that type's file, as before.

## Runtime dependencies

`typescript` and `@astrojs/compiler` move from development dependencies to runtime
dependencies; their existing versions are unchanged. TypeScript parses authored
types and expressions, and Astro identifies markup attributes and code regions.
The platform has no TypeScript or Astro parser, and text replacement cannot
distinguish actual prop references from comments, text, or unrelated attributes.
This adds the existing compiler packages (including Astro's WASM) to the packaged
application, with no additional service or network dependency. Both run in the
main process; they are not bundled into the renderer.
