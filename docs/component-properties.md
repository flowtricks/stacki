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
Unused props can be deleted;
props still referenced by a component or consumer must be disconnected first.
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

## Runtime dependencies

`typescript` and `@astrojs/compiler` move from development dependencies to runtime
dependencies; their existing versions are unchanged. TypeScript parses authored
types and expressions, and Astro identifies markup attributes and code regions.
The platform has no TypeScript or Astro parser, and text replacement cannot
distinguish actual prop references from comments, text, or unrelated attributes.
This adds the existing compiler packages (including Astro's WASM) to the packaged
application, with no additional service or network dependency. Both run in the
main process; they are not bundled into the renderer.
