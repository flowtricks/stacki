# Prop controls: a game plan for every prop Astro can express

Status: plan, not built. Nothing here changes source code yet.

The goal, in the user's words: Stacki must give a no-code designer a visual control for any prop an
AI agent can write in an Astro component, using only what Astro and TypeScript express natively. No
Stacki markup. Stacki may add *smart types* that switch on by themselves when code is written a
certain way, as the existing Filter, Sort and Selected items do.

This document covers what exists today, one prop model that every panel shares, a taxonomy of prop
shapes with the control for each, the smart-type recognizers, the JSDoc policy, the type picker
redesign, the instance-side UX, edge cases from AI-written code, a phased build order and the open
decisions.

Sources: the repository as of `3515d09a` (plus the uncommitted work in `src/editor/propDeclaration.ts`,
`propDocumentation.ts`, `attributesBinding.ts`, `htmlAttributes.ts` and
`src/features/props/newPropModel.ts`), and `astro@7.1.4`'s `types.d.ts`, read from an installed copy in
`~/Documents/Projects/stacki-marketing-site`. Claims about Astro that I took from memory and did not check
against installed source are marked **(unverified)**.

---

## 0. Principles (the rules every section below follows)

1. **The code is the schema.** A prop's control comes from its declared type, its default, its name
   and how the template uses it, in that order of trust. Stacki writes no sidecar schema and no
   Stacki-only attributes. (`.stacki/components.json` holds insertion recipes only. It never says
   what a prop *is*.)
2. **Zero JSDoc must still work.** With no comments at all, a component gets correct, usable
   controls. JSDoc tags only *refine* a control (bounds, labels, a tooltip). They are standard
   comments that TypeScript, Astro's language server and every editor show on hover, so they are not
   "extra markup" in the user's sense, but nothing may *depend* on them (§5.1).
3. **Detection is a pure function of source text.** Same text, same control. No hidden state, so the
   result can be tested and stays the same across Desktop and Studio.
4. **When in doubt, show less and stay honest.** A control that can't represent a value shows the
   value as code with an "Edit in code" affordance. It never silently drops or rewrites what it
   doesn't understand. (`ListField`/`ObjectField` already work this way; keep that.)
5. **Designer vocabulary in the primary UI, TypeScript one click away.** The words are Text, Number,
   Switch, Choice, List, Group, Link, Image, Color, Date, Rich text, Attributes and Collection item.
   The raw type expression is in an "Advanced" disclosure, never the headline.
6. **Round-trip exactly.** Every control writes the most idiomatic Astro/TS for its kind and reads
   back what it wrote, plus the common ways an AI writes the same thing.

---

## 1. What Stacki has today

### 1.1 Three readers of one thing

Today **three independent readers** each work out "what are this component's props". This is the
biggest structural risk for this work:

| Reader | Where | Technique | Feeds |
|---|---|---|---|
| Prop schema | `electron/parse/astroPropSchema.ts`, `astroPropFields.ts`, `astroPropTypes.ts` | Regex/brace scanning of `interface Props` / `type Props`, alias expansion, JSDoc prose (`statedDefault`, `numberRules` with `@min @max @step @int`), and `importedTypes` (`electron/properties/propDefaults.ts`) pastes imported declarations into a prelude | `PropField` (`shared/properties/propSchema.ts`): the instance Settings panel (`src/features/props/PropField.tsx`) and Studio (`studio/vendor/stacki/...`, `studio/src/features/settings/Property.tsx`) |
| Component properties | `electron/properties/propertyDefinitions.ts`, `propertyContracts.ts`, `propertyTypes.ts`, `propertySyntax.ts` | TypeScript compiler AST (`ts.createSourceFile`), so it handles contracts, unions, HTMLAttributes inheritance and local alias resolution | `ComponentProperty` (`shared/properties/propertyEditing.ts`): the Properties panel (`src/features/componentProperties/`) |
| Loop/bind-dot props | `src/editor/loopProps.ts`, `propDeclaration.ts`, `propDocumentation.ts`, `optionsBinding.ts`, `listProps.ts` | Lezer TS parser in the renderer | Binding picker "New … property", Filter/Sort/Selected-items props |

They already disagree. The schema reader turns `@step`/`@int` into a step, but the new form writes
`@decimals` (`propDocumentation.ts`), which the schema reader ignores. So a Number prop made in the new
form gets no whole-number behaviour on the instance. Every new kind added three times multiplies
drift like this. **Phase 1 unifies them (§8).**

### 1.2 Control kinds the instance panel already draws

`src/features/props/PropField.tsx` dispatches, in order:

| Condition | Control | File |
|---|---|---|
| `type === 'style'` | Style editor | `StyleEditor.tsx` |
| `type === 'attrs'` (HTMLAttributes / Record / astroHTML.*) | Attribute rows | `propAttributes.tsx` |
| name ends `class`/`classes` | Class chips | `ClassInput.tsx` |
| name `slot` + slot options | Slot dropdown | `PropControls.tsx` `SlotControl` |
| `enum` (literal union, incl. numeric) | Dropdown, or SegSwitch for 2 options | `EnumControl` |
| `boolean` | True/False SegSwitch | `BooleanControl` |
| `number` | Stepper with bounds | `NumberControl` |
| name ends `href` | Link field | `LinkField.tsx` |
| media name (`MEDIA_WORDS`) or asset-looking value | Asset picker | `ui/AssetField` |
| expression bound to an imported asset | Imported asset | `ImportedAssetControl` |
| `code` + object literal value | Object form | `ObjectField.tsx` |
| `code` + array literal value | List rows | `ListField.tsx` (items can be objects) |
| expression | Expression field | `ExprValueField` |
| otherwise | Text (textarea when long), auto-HTML, auto-date | `TextControl` |

Plus list-setting props (`ListPropField.tsx`) drawn with the loop's own Filters/Sort/Selected editors.

### 1.3 How the existing smart types are detected (the model to copy)

The Filter/Sort/Selected-items types are **usage-based**, not type-based. That makes them safe:

1. `src/editor/optionsQuery.ts` `readOptionsQuery` recognizes a declaration whose initializer is an
   options call: `queryItems(collections["x"], { "filter": …, "sort": …, "limit": … }, …)`, whose
   first argument traces back to a `getCollection("x")`.
2. For each setting, `SettingHome` says where the value lives: `inline`, `prop` (the entry's value is
   a local that the `Astro.props` destructure binds, `"filter": propFilters`), or `none`.
3. `src/editor/listProps.ts` `listPropsOf` maps prop key to `{ setting, source, defaultCode }`. The
   *place the prop is used* decides its kind, and the collection it reads decides which fields the
   editor offers.
4. `optionsBinding.ts` `connectableProps` is the weaker, **shape-based** signal. A prop whose default
   is an object with `fields`/`filterFor` "could hold" a filter. That is only used to offer a
   connection, never to redraw a prop.
5. The type written is `SETTING_PROP_TYPES` (plain structural TS), so the code stays honest TS with
   no brand or marker.

The lesson for every new smart type: **strong signal = how the value is consumed; medium = its
declared type; weak = its name or default shape.** Strong signals change the control by themselves.
Weak signals only suggest.

### 1.4 In progress (another agent, now)

"New ‹Type› property" from the bind dot. `NewPropKind = 'string' | 'number' | 'boolean' | 'option' | 'attributes'`.
It writes `interface Props` members with JSDoc tooltips and tags (`@min @max @decimals @onLabel
@offLabel`, `@attributes` on the interface), `...rest` plus `extends HTMLAttributes<"tag">`, and
attribute defaults written *before* the spread (`attributesBinding.ts`). This plan treats that
vocabulary as settled and builds on it (§5).

---

## 2. One prop model for every panel

### 2.1 The contract

Add `shared/properties/propModel.ts`, the one cross-process description of a prop. It replaces the
overlapping parts of `PropField` and `ComponentProperty`, and both become projections of it while
callers migrate. It is a discriminated union per AGENTS.md §1: data exists only on the kinds that
have it.

```ts
// shared/properties/propModel.ts (sketch)
export type PropControl =
  | { readonly kind: 'text'; readonly lines: 'single' | 'multi'; readonly lengthMax: number | undefined; readonly placeholder: string | undefined }
  | { readonly kind: 'number'; readonly min: number | undefined; readonly max: number | undefined; readonly decimals: number | undefined; readonly bigint: boolean }
  | { readonly kind: 'switch'; readonly onLabel: string; readonly offLabel: string }
  | { readonly kind: 'choice'; readonly options: readonly ChoiceOption[]; readonly display: 'auto' | 'dropdown' | 'segmented' }
  | { readonly kind: 'link' }
  | { readonly kind: 'image'; readonly accepts: 'asset' | 'url' | 'either' }
  | { readonly kind: 'media'; readonly media: 'video' | 'audio' | 'file' }
  | { readonly kind: 'color' }
  | { readonly kind: 'date'; readonly form: 'Date' | 'isoString' }
  | { readonly kind: 'richText' }
  | { readonly kind: 'tag'; readonly tags: readonly string[] }           // `as` / polymorphic
  | { readonly kind: 'icon'; readonly names: readonly string[] }
  | { readonly kind: 'className' }
  | { readonly kind: 'list'; readonly item: PropControl; readonly itemsMax: number | undefined }
  | { readonly kind: 'group'; readonly fields: readonly PropModel[] }
  | { readonly kind: 'variants'; readonly discriminant: string; readonly variants: readonly PropVariant[] }
  | { readonly kind: 'map'; readonly value: PropControl }                  // Record<string, V>
  | { readonly kind: 'attributes'; readonly tag: string | undefined }
  | { readonly kind: 'entry'; readonly collection: string; readonly many: boolean }
  | { readonly kind: 'listSetting'; readonly setting: LoopSetting }       // Filter / Sort / Selected items / Show / Skip
  | { readonly kind: 'callback'; readonly signature: string }             // read-only
  | { readonly kind: 'code'; readonly reason: CodeReason };                // honest fallback

export interface PropModel {
  readonly name: string;
  readonly typeText: string;            // authored type expression, always kept
  readonly control: PropControl;
  readonly presence: 'required' | 'optional';
  readonly nullable: boolean;           // `| null` (or `| undefined` on a required member)
  readonly fallback: PropFallback;      // see §2.2
  readonly tooltip: string;             // JSDoc description, tags stripped
  readonly group: string | undefined;   // @group, see §5
  readonly deprecated: string | undefined;
  readonly recognition: Recognition;    // why this control: see §4
  readonly editing: PropertyEditing;    // existing editable / override / restricted
  readonly usage: PropUsage;            // read / unread / spread / forwarded (see §6.5)
}
export type PropFallback =
  | { readonly kind: 'none' }
  | { readonly kind: 'literal'; readonly code: string }      // `"Click me"`, `3`, `[...]` literal
  | { readonly kind: 'expression'; readonly code: string }   // `heroImage`, `new Date()`, `SIZES[0]`
  | { readonly kind: 'conditional'; readonly hint: string }; // existing statedDefault rules
export type Recognition =
  | { readonly source: 'type' }
  | { readonly source: 'usage'; readonly evidence: string }   // "rendered with set:html on line 14"
  | { readonly source: 'name'; readonly evidence: string }    // weak: suggestion only
  | { readonly source: 'tag'; readonly tag: string }          // explicit JSDoc override
  | { readonly source: 'fallback' };
```

It needs a boundary parser (`parsePropModel`) with limits and one parse-test per kind, per
AGENTS.md "Testing expectations". New bounds such as list nesting depth and variants per union go in
`shared/core/limits.ts`, which **needs human approval**, so ask for it at the start of Phase 1.

### 2.2 One producer, in the main process

Build the model in `electron/properties/` with the TypeScript compiler (already a runtime
dependency), in three tiers:

1. **Syntactic tier (default, fast).** `ts.createSourceFile` over the frontmatter plus followed
   imports (generalize `importedTypes` to the TS AST and resolve `import type` / `export type … from` /
   `export *` with the existing `resolveImportPath` and alias support). It covers every pattern in §3
   except the checker-only ones.
2. **Template usage tier.** Walk the parsed template (`shared/page/pageNode.ts` tree, already
   produced) for usage signals (§4): `set:html={x}`, `href={x}`, `src={x}`, `style={…x…}`, `<Tag>` from
   `const Tag = as`, `class:list`, `{x && …}`, `Array.from({ length: x })`, `{...rest}`,
   `x.map(...)`, `x.toLocale…`.
3. **Checker tier (on demand, later phase).** For `ComponentProps<typeof X>`, generics, `Omit`/`Pick`
   over imported types, `HTMLAttributes<…>`, `Polymorphic<…>`, `CollectionEntry<'blog'>` and the
   `z.infer<typeof schema>` style. Use `@astrojs/compiler`'s `convertToTSX` (verified: exported by
   `@astrojs/compiler@4.0.0`, already a dependency) to turn `.astro` into TSX, then a bounded
   `ts.createProgram` with the project's `tsconfig.json`, its `node_modules/astro` types and
   `.astro/types.d.ts` (content collections). Ask the checker for the apparent type of `Props`,
   and serialize only the members to `PropModel`. Cache per file revision. Cap files, nodes and time
   with limits, and fall back to the syntactic tier on timeout. This is the same route Astro's
   language server takes **(unverified: that it uses convertToTSX internally; it did as of Astro 4)**.

The renderer's `loopProps.ts`/`propDeclaration.ts` stay as the **writers** of frontmatter edits
(they keep formatting), but they read kinds from the model instead of guessing.

### 2.3 Consumers

- Properties panel (`src/features/componentProperties/`): the list of props, the settings form, the type picker.
- Instance Settings panel (`src/features/props/PropField.tsx`): dispatch on `control.kind` instead of
  the cascade of name and type checks in §1.2.
- Binding picker (`newPropModel.ts` `propFits`): fit by `control.kind`.
- Studio: `studio/vendor/stacki/` vendors `shared/properties/propSchema.ts`. The new model must be
  added to the vendor list, and `studio/src/features/settings/Property.tsx` moved onto it, or Studio
  drifts.

---

## 3. Taxonomy: every prop shape, how it is detected, and what the designer sees

Legend. **Detect** = exact syntactic pattern (after alias/import resolution). **Name/icon** =
designer-facing. **Instance** = control on a component instance. **Settings** = form fields in the
Properties panel when creating or editing the prop. **Default** = what Stacki writes. **Validate** =
what the instance control enforces.

### 3.1 Summary table

| # | Code pattern | Designer name (icon) | Instance control | Settings form | Default written as |
|---|---|---|---|---|---|
| 1 | `string` | Text (`TextIcon`) | input; textarea if `multi` | Name, Tooltip, Default, Single/Multi-line, Max length, Placeholder, Required | `label = "Click me"` |
| 2 | `number` | Number (`FieldNumberIcon`) | stepper | Min, Max, Decimals, Default | `count = 3` |
| 3 | `boolean` | Switch (`FieldSwitchIcon`) | SegSwitch with on/off labels | On label, Off label, Default | `open = false` |
| 4 | `"a" \| "b" \| "c"`, `1 \| 2 \| 3`, `(typeof X)[number]`, `keyof typeof X` | Choice (`ComponentPropertiesIcon`) | SegSwitch ≤ 3 short options, else dropdown (searchable > 12) | Options rows (reorder/rename), Default | `variant = "primary"` |
| 5 | string + href usage/name, `URL`, `` `/${string}` `` | Link (`LinkIcon`) | `LinkField` (page/URL/anchor/email/phone) | Default, Required | `href = "/"` |
| 6 | `ImageMetadata`, `ImageMetadata \| string`, string + `src` usage on `<img>`/`<Image>` | Image (`ImageIcon`) | `AssetField` thumbnail + pick; URL tab | Accepts (Asset/URL/Either), Default | import + `image = heroImage` |
| 7 | string used as CSS color, or `@format color` | Color (`ColorIcon`) | swatch + hex/var() input, project tokens | Default | `color = "#0b5"` |
| 8 | `Date`, string + `toLocale*`/`new Date(x)` usage, `@format date` | Date (`CalendarIcon`) | date picker (`DateField`) | Include time, Default | `new Date("2026-01-01")` or `"2026-01-01"` |
| 9 | string rendered with `set:html` | Rich text (`RichTextIcon`) | rich text editor (`RichContent`) | Default | `body = "<p>…</p>"` |
| 10 | `as` with a tag union / `HTMLTag` / `Polymorphic` | Tag (`TagIcon`) | tag dropdown (h1–h6, p, div …) | Allowed tags, Default | `as: Tag = "h2"` |
| 11 | `T[]`, `Array<T>`, `readonly T[]` | List of ‹T› (`ElementListDefaultIcon`) | repeater rows: add/remove/reorder, item form | Item type (nested form), Min/Max items | `items = []` or literal |
| 12 | `{ a: string; b: number }`, a local interface | Group of fields (`BracesIcon`) | grouped sub-fields, collapsible | Field list (nested property editor) | `{ … }` literal |
| 13 | union of object types with a literal discriminant | Variants (`VariantsIcon`) | variant picker swaps the field set | Variant list, each a group | `{ type: "video", src: "" }` |
| 14 | `Record<string, V>`, `{ [key: string]: V }` | Key–value list | key/value rows | Value type | `{}` |
| 15 | `...rest` + `extends HTMLAttributes<'div'>` | Attributes (`AttributesIcon`) | attribute rows (exists) | Tag, defaults (before the spread) | attrs before `{...rest}` |
| 16 | `CollectionEntry<'blog'>` / `[]` | Collection item / items (`CollectionIcon`) | item picker from collection / multi-pick | Collection (from type) | none (required) |
| 17 | prop used as a loop option (`"filter": x`) | Filter / Sort / Selected items / Show / Skip | loop editors (exists) | (exists) | (exists) |
| 18 | `Astro.slots` / `<slot name>` | Slot content (`ElementSlotIcon`) | not a prop: drop zone + "Has content" | Slot name, Fallback content | `<slot name="x">fallback</slot>` |
| 19 | `(…) => …`, `Function` | Action (code) | read-only "Set in code" row | read-only | — |
| 20 | `string` + used in `class`/`class:list` | Class (`ClassIcon`) | class chips (exists) | Default | `class: className` |
| 21 | literal union matching an icon set import | Icon (`IconIcon`) | icon grid picker | Default | `icon = "arrow-right"` |
| 22 | `` `${number}px` ``, `` `${number}rem` `` etc. | Size (`RulerIcon`) | number + fixed unit | Default | `gap = "16px"` |
| 23 | `bigint` | Number (whole, large) | stepper writing `10n` | Min/Max | `10n` |
| 24 | `[string, number]` tuple | Fixed list | N labelled fields in a row | Per-slot type | `["a", 1]` |
| 25 | `unknown`, `any`, `object`, generic `T`, `Promise<…>`, `symbol`, `never` | Code | expression field + "Edit in code" | Advanced type only | as written |

Icons named here that don't exist yet in `src/ui/Icons` must be added. Reuse existing ones wherever a
match exists.

### 3.2 Per-kind detail

Each subsection gives the Astro pattern, detection, the instance UI and the round-trip.

#### 3.2.1 Text

```astro
---
interface Props {
  /** Shown on the button. */
  label?: string;
  /** Short summary under the title. @multiline @maxLength 160 */
  summary?: string;
}
const { label = "Click me", summary } = Astro.props;
---
```

- Detect: member type is `string`, `String`, or a single string literal with no other members of
  the union. `string & {}` (the "autocomplete with free text" idiom) counts as text with suggestions.
  See §3.3.4.
- Multi-line: on with `@multiline`. Otherwise **inferred**: the template renders it as the only child of
  `<p>`, `<blockquote>`, `<figcaption>` or `<dd>`, the name matches `description|summary|body|bio|excerpt|caption|text|content`
  (today's `TextControl` heuristic), or the default contains `\n`. Inferred multi-line is a display
  choice only and writes nothing.
- Instance: single-line input, or `AutoTextarea`. Placeholder = the default (§6.3). Inline canvas
  editing stays as is (`canvasText.ts`).
- Settings: Name, Tooltip, Default (text), Lines (Single/Multi), Max length (optional), Required.
- Validate: `@maxLength n`. Show the count, warn past the limit, never truncate.
- Round-trip: `label?: string;` + `label = "Click me"` in the destructure (as `propDeclaration.ts`
  already writes). Quote with `JSON.stringify`.

#### 3.2.2 Number

```astro
interface Props {
  /** Columns on desktop. @min 1 @max 6 @decimals 0 */
  columns?: number;
}
const { columns = 3 } = Astro.props;
```

- Detect: `number`, `Number`. Bounds from `@min/@max/@decimals` (new form), with `@minimum/@maximum`,
  `@step`, `@int`/`@integer` and the existing prose rules (`numberRules`) as readers. **Fix the drift:**
  the schema reader must map `@decimals d` to step `10^-d`. The form writes only `@min @max @decimals`.
- Instance: existing `NumberControl` (stepper, ⇧/⌥ modifiers, clamp on commit). With both bounds and
  a range of 20 or less: also show a slider (Webflow does this). `Array.from({ length: x })` usage
  (§4) sets the min to 0 and decimals to 0 when no tag says otherwise, and the label shows "Count".
- Round-trip: `columns = 3`. Numbers are written in braces on instances (`columns={3}`), as now.

#### 3.2.3 Switch

```astro
interface Props {
  /** Show the author line. @onLabel Show @offLabel Hide */
  showAuthor?: boolean;
}
const { showAuthor = true } = Astro.props;
```

- Detect: `boolean`. Also `true | false` unions, and a lone `true` literal for opt-in flags such as
  `featured?: true`, where the "off" value is *omitted*, not `false`.
- Instance: SegSwitch with `onLabel/offLabel` (default On/Off, not today's True/False). An instance
  that equals the default omits the attribute (current policy). On writes the bare attribute
  `<Card featured />` when the default is false, which is the idiomatic Astro/JSX form and is already
  read as `bare`.
- Usage signal: `{showAuthor && <p>…</p>}` or `{showAuthor ? … : …}` means "Show/hide". Suggest
  labels Show/Hide in the settings form (not written unless the designer saves).

#### 3.2.4 Choice

```astro
---
const SIZES = ["sm", "md", "lg"] as const;
type Size = (typeof SIZES)[number];
interface Props {
  size?: Size;
  tone?: "neutral" | "brand" | "danger";
  cols?: 1 | 2 | 3 | 4;
}
const { size = "md", tone = "neutral", cols = 3 } = Astro.props;
---
```

- Detect (all resolve to the same `choice` control):
  - Literal unions of strings or numbers, optionally `| undefined | null` (existing `normalizeType`).
  - `(typeof X)[number]` where `X` is a `const` array literal `as const` (local or imported).
  - `keyof typeof X` where `X` is a `const` object literal (the "enum object" idiom). Options are the keys.
  - `(typeof X)[keyof typeof X]`: options are the values.
  - A TS `enum` declared by the agent (AGENTS.md bans enums in *Stacki's* code, not in users'
    projects): options are the member *names*, and Stacki writes `Enum.Member` as an expression.
  - Mixed literals (`"auto" | 1 | 2`): Choice with each literal written in its own form.
- Option labels: the literal itself, humanized (`"primary-outline"` shows "Primary outline"). The
  written value is always the literal. Per-option labels via a JSDoc on the const object
  (`/** Small */ sm: "sm"`) when the enum-object idiom is used, which is native.
- Instance: up to 3 options of 12 or fewer characters: segmented. Otherwise a dropdown (searchable
  above 12). Keep the current rule "2 options with a default read as a switch". Hover preview on the
  canvas (exists: `enumPreview`).
- Settings: options as `ListField` rows (exists: `PropertyOptions.tsx`), default picked from them.
  When options come from a `const` array, editing them **edits the array** (one source of truth),
  and the settings form says "Options come from `SIZES` (line 2)".
- Validate: an out-of-schema instance value stays visible and selectable (exists).

#### 3.2.5 Link

```astro
interface Props {
  href: string;
  /** Opens in a new tab. */
  external?: boolean;
}
const { href, external = false } = Astro.props;
---
<a href={href} target={external ? "_blank" : undefined}>…</a>
```

- Detect (strong): the prop, or a local derived only from it, flows into `href` of `<a>`/`<link>`/`<area>`,
  into `action` of `<form>`, or into a child component prop already recognized as Link. Medium: type
  `URL`, `` `/${string}` ``, `` `https://${string}` ``, `@format uri`. Weak: name ends `href|url|link|to`
  (today's `isHrefName`, which already switches on the control, so keep it for continuity).
- `URL` objects: the instance writes `new URL("https://…")`, and reads that back.
- Instance: `LinkField` (pages, anchors on the current page, external URL, mailto, tel). It binds to
  CMS slug fields (`` `/blog/${post.id}` ``) through the existing expression path.

#### 3.2.6 Image (and other media)

```astro
---
import type { ImageMetadata } from "astro";
import { Image } from "astro:assets";
import fallback from "../assets/placeholder.jpg";
interface Props {
  image?: ImageMetadata | string;
  alt: string;
}
const { image = fallback, alt } = Astro.props;
---
<Image src={image} alt={alt} />
```

- Detect (type): `ImageMetadata` (global in Astro projects, or imported from `astro`), `ImageMetadata | string`,
  `GetImageResult`, `Promise<{ default: ImageMetadata }>` (the `import.meta.glob` idiom; see Code
  unless it is a default). Detect (usage, strong): flows into `src` of `<img>`, `<Image>`, `<Picture>`
  (astro:assets), `<source srcset>`, `poster`, or a `background-image: url(${x})` style. Name (weak):
  `MEDIA_WORDS` (exists).
- `accepts`: `ImageMetadata` only means Asset (instance writes `image={heroImage}` and adds
  `import heroImage from "../assets/hero.jpg"`; this flow exists as `ImportedAssetControl` /
  `onPickAsset`). `string` means URL or `/public` path. The union means Either (the asset tab and URL tab
  both enabled).
- Alt text pairing: when a sibling prop named `alt`/`*Alt` exists, draw it directly under the image
  as part of the same card, the way Webflow does.
- Video/audio/file: same detection with `<video>`/`<audio>`/`<a download>`, giving `media` control (exists
  inside `MediaControl`).

#### 3.2.7 Color

```astro
interface Props { accent?: string; }
const { accent = "#2563eb" } = Astro.props;
---
<section style={`--accent: ${accent}`}> … </section>
<!-- or: style={{ color: accent }}  or  <style define:vars={{ accent }}> -->
```

- Detect (strong): the prop reaches a CSS color position: `style` object keys `color|background(-color)?|border(-color)?|fill|stroke|outline-color|accent-color|caret-color|text-decoration-color`;
  a template-literal style string where the interpolation follows one of those properties or
  a custom property `--*color*`/`--accent*`; `define:vars={{ accent }}` where the `<style>` uses
  `var(--accent)` in a color property. Medium: `@format color`; a default matching
  `#hex|rgb(|hsl(|oklch(|var(--`. Weak: name ends `color|colour|bg|background|tint|accent`.
- Instance: a swatch plus text input. The popover lists project color tokens read from CSS custom
  properties (the Style panel already reads project CSS) and writes `var(--brand)` or a literal.
- Round-trip: `string` stays the type. Nothing proprietary.

#### 3.2.8 Date

```astro
interface Props { published: Date; }
const { published } = Astro.props;
---
<time datetime={published.toISOString()}>{published.toLocaleDateString("en-US")}</time>
```

- Detect: `Date` means form `Date`, written `new Date("2026-03-01")`. A `string` that the template
  passes through `new Date(x)`, `Date.parse(x)`, `dayjs(x)`, or that has `@format date|date-time`, means
  form `isoString`, written `"2026-03-01"`. Today `TextControl` switches to `DateField` when the
  *value* looks like a date. Keep that as the weak signal.
- Instance: `DateField` with an "Include time" toggle (`@format date-time` when saved). Binding to a
  CMS `z.date()` field is the common case: the data picker filters to date fields.

#### 3.2.9 Rich text / HTML

```astro
interface Props { body: string; }
const { body } = Astro.props;
---
<div class="prose" set:html={body} />
```

- Detect (strong, safe): the prop or a local derived only from it is the value of `set:html`
  (`<Fragment set:html={x} />` included; `astroComponentApi.ts` already reads this pattern for
  slots). Medium: `@format html`. The default containing tags (today's `containsHTML`) is weak.
- Instance: `RichContent` / `HtmlField` (exist), writing an HTML string. A `set:text` usage means
  plain multi-line Text.

#### 3.2.10 Tag (polymorphic `as`)

```astro
---
import type { HTMLTag, Polymorphic } from "astro/types";
type Props<Tag extends HTMLTag> = Polymorphic<{ as: Tag }> & { size?: "sm" | "lg" };
const { as: Tag = "h2", size = "lg", ...rest } = Astro.props;
---
<Tag class:list={["heading", size]} {...rest}><slot /></Tag>
```

`Polymorphic`, `HTMLTag`, `HTMLAttributes<Tag>` and `ComponentProps<T>` are verified in
`astro@7.1.4/types.d.ts`. `Polymorphic<{ as: Tag }>` makes `as` optional and merges that tag's
attributes.

- Detect (strong): a destructured prop renamed to a capitalized local (`as: Tag`, `tag: Element`)
  that is used as a JSX element name. Options: the literal union if declared
  (`as?: "h1" | "h2" | "h3"`), else for `HTMLTag`/`Polymorphic` a curated list (headings, `p`,
  `span`, `div`, `section`, `article`, `a`, `button`, `li`), with "Other tag…" free text checked
  against `htmlAttributes.ts`'s tag table.
- Instance: Tag dropdown. For `Polymorphic`, the Attributes control (§3.2.15) uses the *chosen* tag's
  attributes, so changing `as` re-validates attribute rows.
- Generic `Props<Tag>` is handled by the checker tier, or syntactically by recognizing the
  `Polymorphic<{ as: … }>` shape. The settings form shows the prop as Tag and puts the generic in
  Advanced as "Edit in code".

#### 3.2.11 List of ‹T› (repeater)

```astro
---
interface Feature { title: string; text?: string; icon?: "check" | "star"; }
interface Props { features?: Feature[]; tags?: string[]; }
const { features = [{ title: "Fast" }, { title: "Small" }], tags = [] } = Astro.props;
---
{features.map((f) => <li>{f.title}</li>)}
```

- Detect: `T[]`, `Array<T>`, `readonly T[]`, `ReadonlyArray<T>`. Item control = recursive model of
  `T` (bounded depth, new limit, suggest 4).
- Instance: repeater. One row per item, titled by the item's first text field (`itemLabel` exists),
  drag to reorder, hover trash, "Add item" at the end (writes the `blankLike` item from the item's
  field defaults), and click a row to open the item form in a popover (exists in `ListField`). For
  `string[]`/`number[]`: inline editable rows (exists). Show "3 items" collapsed when long, with the
  existing six-row scroll.
- Settings: "List of" + item kind picker. For "List of Group" the nested field editor (§3.2.12)
  edits the item interface in place (`Feature` above), including creating a named interface when
  there is none.
- Validate: `@minItems/@maxItems` (ts-json-schema-generator vocabulary, see §5.2). Show
  "Add item" disabled at the max.
- Round-trip: the whole array literal is rewritten (`arrayText` exists). A non-literal value (`[...a,
  b]`, `getItems()`) keeps the code field. Binding the *whole list* to a CMS collection query is
  allowed (picker filters to arrays). Binding *per item* is not offered, because it isn't
  representable in one literal.

#### 3.2.12 Group of fields (nested object)

```astro
interface Props {
  cta?: { label: string; href: string; style?: "solid" | "ghost" };
}
const { cta = { label: "Get started", href: "/start" } } = Astro.props;
```

- Detect: inline type literal, a local or imported `interface`/`type` that is an object shape,
  `Pick<X, …>`/`Omit<X, …>` of one (syntactic for local, checker for imported), intersections of
  object shapes.
- Instance: a collapsible section titled with the prop's name. Each member is a full field with
  its own control, recursively, so `cta.href` is a Link and `cta.style` a Choice. This **replaces
  `ObjectField`'s flat key list** with model-driven fields. Values still round-trip through
  `objectFields`/`objectText`. Optional members that are unset don't appear in the literal.
- Binding: each sub-field has its own bind dot, writing `cta={{ label: post.data.title, href: "/x" }}`
  (an object literal with an expression member). The whole group can also bind to a CMS object
  field of matching shape.
- Settings: nested property editor. The same row UI as top-level props, indented, with "Add
  field".

#### 3.2.13 Variants (discriminated union)

```astro
---
type Media =
  | { type: "image"; image: ImageMetadata; alt: string }
  | { type: "video"; src: string; autoplay?: boolean }
  | { type: "none" };
interface Props { media?: Media; }
const { media = { type: "none" } } = Astro.props;
---
```

and at top level (props themselves are a union, already partly supported by `propRules.ts`):

```ts
type Props =
  | { variant: "link"; href: string }
  | { variant: "button"; onClickLabel?: string };
```

- Detect: a union whose members are all object shapes sharing one property whose type is a distinct
  literal in each member (the discriminant: `type`, `kind`, `variant`, or any shared literal key).
  The existing `PropUnion` branches (`forbids`, `pins`) are the top-level case of the same thing.
- Instance: a segmented/dropdown **variant picker** (options = discriminant literals, humanized),
  then that variant's fields. Switching variants keeps values of same-named, same-kind fields and
  stashes the rest for undo within the session (`propRules.ts` `cascade` already stashes).
- Non-discriminated unions of objects (no shared literal key) get Code with the reason "These shapes
  can't be told apart. Add a shared `type` field to edit them visually." That text is what the
  designer can hand to their agent.

#### 3.2.14 Key–value list (Record / index signature)

```astro
interface Props { labels?: Record<string, string>; }
```

- Detect: `Record<string, V>`, `{ [key: string]: V }`, `Map<string, V>` (Map is Code: writing
  `new Map([...])` is possible but rare, so defer). `Record<"a" | "b", V>` with literal keys is a
  **Group** with fixed fields, not a key–value list.
- Instance: rows of key input plus V control. Today `normalizeType` maps all `Record<…>` to `attrs`.
  Split them: only `HTMLAttributes`/`astroHTML.JSX.*` mean Attributes. `Record<string, string|number|boolean>`
  becomes key–value rows, which look like attribute rows but without the HTML-name advice.

#### 3.2.15 Attributes (rest props)

Settled by the in-progress work: `...rest` in the destructure and `interface Props extends
HTMLAttributes<"div">`, defaults written before `{...rest}` on the element, tooltip in `@attributes`.
Additional cases:

- `HTMLAttributes<"a"> & { … }`, `type Props = HTMLAttributes<"button">`, `astroHTML.JSX.AnchorHTMLAttributes`,
  `ComponentProps<typeof Button>` (attributes of a wrapped component, checker tier), and
  `Omit<HTMLAttributes<"a">, "href">`. The tag is the one in the type. Omitted names are excluded from
  attribute advice (`propertyContracts.ts` `isOmittedAstroAttributes` exists).
- Explicitly declared members that HTMLAttributes also declares (`class`, `id`) show as their own
  fields above the Attributes rows (exists: `inheritedAttributeCanOverride`).
- `class` from rest props: `const { class: className, ...rest } = Astro.props` with `class:list={["card", className]}`
  is the Astro-documented idiom. `className` is a Class control (exists by name). Detect it by the
  rename from `class` too.

#### 3.2.16 Collection item / items

```astro
---
import type { CollectionEntry } from "astro:content";
interface Props { post: CollectionEntry<"blog">; related?: CollectionEntry<"blog">[]; }
const { post, related = [] } = Astro.props;
---
<h2>{post.data.title}</h2>
```

- Detect: `CollectionEntry<"name">` (single) or its array (many). Also `CollectionEntry<"a" | "b">`
  (multi-collection picker). The collection name is the literal. The schema comes from the content
  config Stacki already reads (`shared/properties/collectionSettings.ts`, `collectionReader.ts`).
- Instance: these props are almost always **bound**, not literal. A designer on a page picks
  "Collection item" and either (a) binds to the loop item in scope (`post={post}` inside a
  `posts.map`, which the data picker offers first), or (b) picks one entry, and Stacki writes
  `post={await getEntry("blog", "hello-world")}`. That is valid Astro in page frontmatter **(verify:
  top-level await in an attribute expression. The safer write adds `const post1 = await getEntry(…)` to
  the frontmatter and passes `post={post1}`. Recommend the latter.)** Multi-pick writes
  `related={await getEntries([...])}` the same way, through a frontmatter const.
- Inside the component the props panel shows the entry's fields as a read-only tree for binding
  (`post.data.title`), which `dataScope.ts` partly does already.
- `reference("blog")` fields in content schemas resolve the same way.

#### 3.2.17 List settings (Filter / Sort / Selected items / Show / Skip)

Exists and stays as is (§1.3). The only change: in the new type picker they appear under "Collection
list" (§6), and Show/Skip (`limit`/`offset`, currently plain numbers) get the Number control with
`min 0, decimals 0` implied by the usage.

#### 3.2.18 Slot content (not a prop, shown beside props)

```astro
---
const hasFooter = Astro.slots.has("footer");
---
<article>
  <slot />                                   <!-- default slot -->
  <slot name="media"><img src="/x.png" alt="" /></slot>   <!-- fallback content -->
  {hasFooter && <footer><slot name="footer" /></footer>}
</article>
```

- Detect: exists (`parseSlots`, `slotApiUses` in `astroComponentApi.ts`, `<slot>`, `Astro.slots.has/render`).
- Instance: slots are **children**, edited on the canvas and in the navigator, not in Settings. The
  Settings panel shows a "Slots" section listing each named slot with: filled/empty state, "Use
  fallback" (remove the slotted child), and "Add content" (inserts a `<Fragment slot="media">` or
  an element with `slot="media"`; the slot dropdown exists).
- Render-function slots (`Astro.slots.render("item", [data])` with a function child
  `{(data) => <li>{data}</li>}`) **(unverified for Astro 7; documented through Astro 4)**: show as a
  slot with "Template (receives data)". The canvas edits the markup inside the callback (callback roots
  are already projected, `contracts.md` "Page trees").
- Component properties panel: a "Slots" group listing slots with name and fallback presence. "Add
  slot" inserts `<slot name="x" />` at the selection. That stays native markup.

#### 3.2.19 Callbacks and functions

- Detect: function types, `Function`, method signatures (`onClick(): void`).
- In `.astro` → `.astro` usage a function prop is legal but rare. Most appear on **framework islands**
  (`<Counter client:load onChange={…} />`, but functions can't serialize to hydrated islands, so Astro
  errors or drops them **(unverified exact behaviour per version)**).
- Instance: read-only row "Action, set in code" with the signature in the tooltip and "Edit in
  code" opening the source at the prop. A designer never authors a function.

#### 3.2.20 Code (honest fallback)

`unknown`, `any`, `object`, `{}`, unresolved generics `T`, `Promise<T>`, `symbol`, `never`, `void`,
conditional/mapped types the checker can't flatten, `Map`/`Set`, and class instances. The instance
shows `ExprValueField` (exists) with the data picker. The Properties panel shows the type text read-only
with "Why can't I edit this visually?" giving the reason from `CodeReason`.

### 3.3 Modifiers and type-level wrappers

#### 3.3.1 Optional vs required

| Code | Meaning in Stacki |
|---|---|
| `title: string` and no default | **Required**: instance shows a red "Required" dot until set or bound; insertion recipes must provide it |
| `title?: string` | Optional; unset shows the default as placeholder |
| `title: string` + destructure default | Required by type, defaulted at runtime: still required (existing rule: "a required field and a default are independent") |
| `title: string \| undefined` (required key, may be undefined) | Treat as optional for the designer; keep the type |

The settings form's "Required" switch toggles `?`. It never removes a default.

#### 3.3.2 Nullable

`x?: string | null`: the control gains a "None" state (a small ⌀ button) that writes `x={null}`.
Unset (omitted) and None are different and both shown.

#### 3.3.3 Unions of different primitives

- `string | number`: a Text control whose value is written as a number when it parses as one and
  the author typed no quotes. Better: a small "abc / 123" segmented toggle beside the input. Recommend
  the toggle; it's explicit.
- `string | string[]`: Text, plus "Use a list" toggle switching to List of Text.
- `boolean | "auto"`: Choice with options On / Off / Auto (literals rendered as their own kinds).
- `ImageMetadata | string`: Image with `accepts: either` (§3.2.6).
- Otherwise: Code.

#### 3.3.4 Template literal types

| Pattern | Control |
|---|---|
| `` `${number}px` `` / `` `${number}rem` `` / `` `${number}%` `` | Size: number input with the fixed unit suffix, writing `"16px"` |
| `` `${number}${"px" \| "rem" \| "%"}` `` | Size with a unit dropdown |
| `` `/${string}` ``, `` `https://${string}` `` | Link |
| `` `#${string}` `` | Color (hex), unless used as an anchor href, where usage wins |
| `` `--${string}` `` | Text (a CSS variable name) |
| `` `${"sm" \| "md"}:${"flex" \| "grid"}` `` | Choice (expanded cross product, if ≤ `propOptionsMax`) |
| `string & {}` unioned with literals: `"sm" \| "md" \| (string & {})` | Choice with "Custom…" free text |
| anything else | Text with pattern validation (built from the template), else Code |

#### 3.3.5 Intersections, extends, Omit/Pick, generics, imported types

- `interface Props extends A, B` / `type Props = A & B & { … }`: merge members, local wins. The
  `propertyContracts.ts` reader already does this for local declarations. Imported `A` goes through
  the import follower (syntactic), or the checker for library types.
- `Omit<Base, "x">`, `Pick<Base, "a" | "b">`, `Partial<Base>`, `Required<Base>`, `Readonly<Base>`:
  syntactic for local and imported object types (these utility types are simple to apply to a member
  list), checker for anything deeper.
- Generic props (`Props<T>`): the checker tier with `T` as its constraint (`T extends HTMLTag` gives
  `HTMLTag`). If the constraint is `unknown`, use Code.
- Imported types: follow `import type { X } from "../types"` and `export type { X } from`, through
  path aliases (exists). Show "Defined in `src/types.ts`" in the info tooltip (exists as
  `PropertyDeclarationInfo`). **Edits to an imported type** are restricted (current behaviour); the
  settings form offers "Open `types.ts`". Writing across files is a later decision (§10, D6).
- Re-declared types (two `interface Props` declarations merge in TS): merge them, and show a warning
  in the Properties panel.

#### 3.3.6 Tuples, branded types, `readonly`

- Tuples `[string, number]`: a fixed row of labelled fields (labels from named tuple members
  `[label: string, count: number]`, else "1", "2"). Labelled tuples are native TS.
- Branded types (`string & { __brand: "Slug" }`, `Brand<string, "Slug">`): use the base primitive's
  control. Writing a literal to a branded prop is a *type error* in the user's project, so show it
  as Code with "This value is checked in code (Slug)". Exception: a known brand from astro or zod
  (`z.string().brand()`) is still Code. Recommend: don't author branded values. Show them read-only
  with the binding picker available, because a bound CMS value already carries the brand.
- `readonly` members and `readonly T[]`: no designer-facing difference. Keep the modifier on save
  (exists).

#### 3.3.7 Framework-island props

```astro
<Counter client:visible initial={3} label="Clicks" />
```

React/Vue/Svelte/Solid/Preact component props: Astro passes serializable props to the island, so
functions and class instances fail at hydration. Reading those types means each framework's syntax
(`.tsx` `Props` interfaces are TS; `.svelte` `$props()`, `.vue` `defineProps<…>()`).

- Phase 6 scope: `.tsx/.jsx` components with an exported/first-parameter props type (syntactic: the
  first parameter's type annotation or `FC<P>`/`ComponentProps`), mapped through the same model.
  `.svelte` (`let { a = 1 }: Props = $props()`) and `.vue` (`defineProps<Props>()`) after that.
- Instance: the same controls. A Hydration row ("Loads: on page load / when visible / when idle / never")
  writes `client:load|visible|idle|only` and `client:media`, a native directive.
- Function-typed island props are read-only (§3.2.19), with the note "Can't be passed to an
  interactive island" when the directive is present.

#### 3.3.8 Promise and async data

`Promise<T>` props are legal in Astro (the template can `await` them). Show Code. Smart case: a
`Promise<CollectionEntry<…>[]>` default from `getCollection(...)` shows as "Collection items (loaded)"
read-only, with binding to a collection.

---

## 4. Smart types: recognizers that switch on from how code is written

### 4.1 Rules for all recognizers

- **Three confidence levels:**
  - *Strong (usage):* the prop's value reaches a position that only accepts that kind. The control
    switches automatically, and the label icon shows a small "detected" tooltip with the evidence
    ("Used as `href` on line 12").
  - *Medium (type/format):* a declared type or standard `@format` tag. Switches automatically.
  - *Weak (name/default shape):* switches only where today's behaviour already does (href names,
    media names, class names), for continuity. Otherwise it only *suggests* in the Properties panel
    ("This looks like a color. Use the Color control?"). Accepting writes nothing to code, because the
    control is a display choice. If the designer wants it to stick across machines, Stacki writes the
    native override tag (below).
- **Data flow is local and bounded:** follow the prop through the destructure local, renames,
  `const x = prop`, `const x = prop ?? "…"`, template literals, ternaries with literal branches, and
  one level of child component props (the child's recognized kind propagates up: `<Button href={link} />`
  makes `link` a Link). The same visit budget applies as `treeBudget`.
- **Conflicts:** strong beats medium beats weak. Two strong signals of different kinds (used as both
  `href` and `set:html`) give the declared type's plain control (Text), with both usages listed.
- **Override, natively:** `@format <kind>` in the member's JSDoc (`@format color`, `@format uri`,
  `@format date`, `@format html`, `@format image`). `@format` is the JSON Schema keyword that TS
  schema generators read, so an AI agent writes it unprompted, and it is meaningful outside Stacki.
  `@format text` forces the plain control.
- **Never type-changing:** a recognizer changes the *control*, never the declared type, unless the
  designer explicitly picks a different kind in the settings form.

### 4.2 The recognizer table

| Smart type | Strong signal (usage) | Medium (type/tag) | Weak (name/default) | Why it's safe |
|---|---|---|---|---|
| Filter / Sort / Selected items / Show / Skip (exists) | value of an options-call setting (`"filter": x`) | `SETTING_PROP_TYPES` shape | default shape (`fields`, `itemIds`): connect only | The consuming helper defines the format |
| Link | `href`/`action`/`formaction` attribute, or a child Link prop | `URL`, `` `/${string}` ``, `@format uri` | name ends `href\|url\|link\|to` (switches today) | Any string is a valid href, and LinkField also accepts free text |
| Image | `src` on `img`/`Image`/`Picture`, `srcset`, `poster`, `url(${x})` in `background-image` | `ImageMetadata`, `@format image` | `MEDIA_WORDS` (switches today) | AssetField has a URL tab, so free text is preserved |
| Video / Audio | `src` on `video`/`audio`/`source` inside them | `@format video\|audio` | name `video\|audio` | Same as Image |
| Color | CSS color property in `style` object/string, `define:vars` used in a color property, `--*color*` | `@format color` | default matches a color literal; name ends `color\|bg\|tint\|accent`: suggest only | The control writes the same string type; tokens are just strings |
| Tag picker | renamed to a capitalized local used as an element (`const { as: Tag } …; <Tag>`) | `HTMLTag`, `Polymorphic`, union of tag names | name `as\|tag\|element` + tag-like literals | Options are exactly the declared union or HTML tags |
| Rich text | value of `set:html` | `@format html` | default contains tags (switches today's text field) | `set:html` already expects HTML |
| Attributes (in progress) | `{...rest}` spread on an element | `extends HTMLAttributes<…>` | — | Spread semantics are Astro's |
| Class / variant class | used in `class`, `class:list` (array, object key, or string) | — | name ends `class\|className\|classes` (switches today) | Writes a plain string |
| Choice-as-class | literal union used as `class:list={{ [size]: true }}` / `` `btn-${variant}` `` | literal union | — | Already a Choice; adds a canvas class preview |
| Count | `Array.from({ length: x })`, `[...Array(x)]`, `.slice(0, x)`, loop `limit` | `number` | name `count\|limit\|max\|columns\|rows` | Adds min 0 / whole numbers; doesn't change the type |
| Show/hide switch | `{x && …}`, `{x ? … : null}`, `hidden={!x}` | `boolean` | name starts `show\|has\|is\|hide` | Only suggests labels Show/Hide |
| Slot chooser | prop used as `<slot name={x} />` (rare, dynamic) | literal union | — | Options = the component's slot names |
| Date | `new Date(x)`, `x.toLocale(Date)?String`, `x.toISOString()`, `Intl.DateTimeFormat(...).format(x)`, `<time datetime={x}>` | `Date`, `@format date\|date-time` | value parses as a date (switches today's text field) | Writes the same type the code expects |
| Icon | literal union whose values appear as keys/filenames of an imported icon set: `astro-icon` `<Icon name={x} />`, `import.meta.glob("../icons/*.svg")` keyed by filename, or a local `const icons = { arrow: …, check: … }` indexed with `icons[x]` | union of literals | name `icon` | Options are exactly the set's names; preview renders each |
| Heading level | `` `h${level}` `` used as a tag, `level: 1 \| 2 \| … \| 6` | numeric union 1–6 | name `level` | Becomes Choice "Heading 1 … Heading 6" |
| Size with unit | interpolated into a CSS length position (`gap: ${x}`) | `` `${number}px` `` | — | Writes the same string |
| Collection item | `x.data.*`, `render(x)` from astro:content, `x.id` used in an href | `CollectionEntry<…>` | — | The picker uses the type's collection |
| Entry slug / id | used in `` `/blog/${x}` `` href, `getEntry("blog", x)` | `CollectionEntry<"blog">["id"]` | name `slug\|id` | Becomes "Collection item id" picker writing the id string |
| Target / rel | used as `target=` | `"_blank" \| "_self"` | name `target\|newTab\|external` (boolean) | Choice/Switch labelled "Open in new tab" |
| Alignment / layout choice | literal union of `left\|center\|right`, `start\|end`, `row\|column` | union | — | Segmented control with icons instead of words |
| Embed URL | used as `src` of `iframe` | `@format uri` | name `embed\|youtube\|video` | Link control with "Video URL" placeholder |

### 4.3 What JSDoc is, in the user's sense

JSDoc tags are **ordinary TypeScript comments**. TypeScript keeps them, Astro's editor tooling shows
them on hover, and AI agents write them by default. They don't change runtime output or types, and a
non-Stacki developer reads them as documentation. They are therefore *not* "proprietary markup that
requires Stacki", **as long as two rules hold**:

1. **Nothing depends on them.** Every prop works without them (§0.2).
2. **Prefer existing vocabularies over Stacki inventions** (§5.2), so the tags mean something to
   other tools and to the agent.

Recommendation: adopt this as policy and document it in `docs/component-properties.md`.

---

## 5. What Astro/TS expresses natively, and what needs a comment

### 5.1 Setting by setting

| Setting | Native home | Recommendation |
|---|---|---|
| Kind of value | TS type | Type (always) |
| Required / optional | `?` | Type |
| Nullable | `\| null` | Type |
| Choices | literal union / `as const` array / const object | Type (preferring the array form when options are reused) |
| Default | destructure default `= value` | Destructure. Also read `@default` and "Defaults to …" prose (`statedDefault`, exists) for display when the default lives elsewhere, but **write** only the destructure |
| Tooltip | JSDoc description | JSDoc text (standard) |
| Deprecated | `@deprecated` (standard TSDoc; the editor strikes it through) | Read; show as a strikethrough label + note; offer "Hide deprecated" |
| Example / placeholder | `@example` (standard TSDoc) | Use `@example` for placeholder text. No new tag |
| Min / max (number) | none | `@min`/`@max` (in progress). Also read `@minimum`/`@maximum`/`@exclusiveMinimum`/`@exclusiveMaximum` |
| Decimals | none (`` `${number}` `` doesn't help) | `@decimals` (in progress). Also read `@step`, `@int`, `@integer`, `@multipleOf` |
| On/off labels | none | `@onLabel`/`@offLabel` (in progress; Stacki-specific but harmless). Write only when changed from On/Off |
| Text length | none | read/write `@maxLength`, read `@minLength` |
| Pattern | template literal types partially | `@pattern` (read) |
| Multi-line | none | `@multiline` (Stacki-specific), but **infer first** (§3.2.1) so most props never need it |
| Format / smart-type override | none | `@format` (JSON Schema keyword) |
| Group / section in the panel | none | `@group Layout` (a TypeDoc tag, so not Stacki-only). Fallback: no groups, declaration order |
| Field order | member order | Member order (drag-to-reorder exists) |
| Display label | prop name | Humanize the name (`showAuthor` shows "Show author"). `@title` (JSON Schema) only when the designer types a label that isn't the humanized name |
| Option labels | none | Humanized literals. For const-object enums, the member JSDoc. No per-option tags |
| Hidden from designers | none | `@internal` (TSDoc standard) means hidden in the instance panel, shown dimmed in Properties |
| Min/max items | none | `@minItems`/`@maxItems` (JSON Schema) |
| Image dimensions / aspect | none | Don't add a tag. Read from the `<Image width height>` usage if needed (display only) |

### 5.2 The tag vocabulary, in one place

Read all of these. **Write only the bold ones**, and only when a setting is non-default:

- TSDoc/JSDoc standard: description, **`@deprecated`**, **`@example`**, `@default`, `@see`, **`@internal`**.
- JSON Schema via ts-json-schema-generator / typescript-json-schema **(vocabulary from memory, unverified against
  current versions)**: `@minimum`, `@maximum`, `@exclusiveMinimum`, `@exclusiveMaximum`, `@multipleOf`,
  **`@maxLength`**, `@minLength`, `@pattern`, **`@format`**, **`@minItems`**, **`@maxItems`**, **`@title`**.
- TypeDoc: **`@group`**.
- Stacki (in progress, keep): **`@min`**, **`@max`**, **`@decimals`**, **`@onLabel`**, **`@offLabel`**, **`@attributes`**, plus **`@multiline`**.
- Legacy read-only: `@step`, `@int`, `@integer`.

One parser (`propDocumentation.ts` grown into the main-process reader, mirrored by a renderer copy
only if the renderer must read tags before a round-trip) owns this table, with one test per tag
including malformed values.

---

## 6. The type picker redesign (Properties panel)

### 6.1 Today

`src/features/componentProperties/PropertyType.tsx` titles the field "Type expression" and lists
`string, number, boolean, Options (union), Array, Tuple, Record, object, Function, Date, Promise,
bigint, symbol, null, undefined, unknown, never, void, any, Filter, Sort, Selected items`. These are
TypeScript's words, and half of them (`never`, `void`, `symbol`, `null`) are nothing a designer would pick.

### 6.2 New picker: "Kind"

Status: built in the Properties panel without the unified prop model
(`src/features/componentProperties/propertyKinds.ts`, `PropertyType.tsx`): Text, Number, Switch,
Choice, Link (`@format uri`), Image (`ImageMetadata | string`, or `import("astro").ImageMetadata |
string` when the file does not import it), Color (`@format color`), Date, List (`readonly string[]`),
Group (`{ label: string }`), Key–value list, Attributes (made from an element, so listed but not
writable here), the collection-list settings, and Advanced with the TypeScript types and a "Code
type" disclosure holding the exact expression. Number and Switch settings and the tooltip edit the
JSDoc tags in place (`settingTags.ts`). Not yet: Rich text, Video, Variants, Tag, Class, Collection
item(s), the item-kind picker for List, Group fields, and the instance-count warning.

Rename the field to **Kind**. Use a searchable dropdown with sections and icons. Each choice maps to
a type the form writes:

| Section | Choice | Writes |
|---|---|---|
| Basic | Text | `string` |
| | Rich text | `string` (+ suggests `set:html` binding when connected) |
| | Number | `number` |
| | Switch | `boolean` |
| | Choice | `"Option 1" \| "Option 2"` |
| Media & links | Link | `string` (Link control by usage; `@format uri` if not connected to an href) |
| | Image | `ImageMetadata \| string` (+ `import type { ImageMetadata } from "astro"`) |
| | Video | `string` + `@format video` |
| | Color | `string` + `@format color` (unless usage already says it) |
| | Date | `Date` |
| Structure | List of… | `T[]`. Opens the item kind picker inline: "List of Text / Image / Group …" |
| | Group of fields | `{ … }` (a named interface `CtaProps` when it has 3 or more fields; see D4) |
| | Variants | discriminated union with `type` |
| | Key–value list | `Record<string, string>` |
| Element | Tag | `HTMLTag` subset union |
| | Attributes | `...rest` + `extends HTMLAttributes<"tag">` (in progress) |
| | Class | `string` (connected to `class:list`) |
| Content | Collection item | `CollectionEntry<"…">` with a collection dropdown |
| | Collection items | `CollectionEntry<"…">[]` |
| Collection list | Filter, Sort, Selected items, Show, Skip | `SETTING_PROP_TYPES` (exists) |
| Advanced | Code type… | free type expression input (today's braces mode) |

Behaviour:

- Changing kind rewrites the type and converts the default where possible (Text "3" to Number 3). Otherwise
  it clears the default with an undo toast. It warns when instances pass values that no longer fit
  ("4 instances pass text. They'll show a warning."), using the consumer scan that already backs
  renames (`propertyConsumers.ts`).
- The kind form below the picker changes per kind. These are the settings forms from §3, sharing
  components with the in-progress new-prop form so there is one form per kind, used both for "New
  property" and "Edit property".
- **Advanced disclosure** at the bottom of every form: "Code type", showing the exact TS expression
  (editable, with today's `PropertyType` input), and the tags Stacki will write. This replaces the
  braces toggle as the escape hatch.

### 6.3 Types Stacki can't model

The row in the props list shows the kind icon `CodeIcon` and the label "Code". The settings form
shows:

- The type text, read-only and monospace, with the declaration location (`PropertyDeclarationInfo` exists).
- The reason (`CodeReason`, one sentence a designer can forward to their agent). For example: "This
  is a function. Functions are set in code." or "These shapes can't be told apart. Add a shared
  `type` field to edit them visually."
- Buttons: "Edit in code" (opens the source at the member), "Change kind…" (opens the picker, with a
  warning that the type will be replaced).
- Default and tooltip stay editable (they don't depend on the type).

---

## 7. Instance-side UX (Settings panel)

### 7.1 Layout

```
┌ Settings ───────────────────────────┐
│ Card                    ⟲ Reset all │
│ ── Content ───────────────────────  │   ← @group, else no headers
│ Title  ●              [ Fast sites ]│   ● bind dot (exists)
│ Summary               [ multiline… ]│
│ Image                 [▣ hero.jpg  ]│
│   Alt                 [ A laptop   ]│   ← paired sibling
│ Link                  [ /features ▾]│
│ ── Style ─────────────────────────  │
│ Tone          [Neutral|Brand|Danger]│
│ Accent                [■ #2563eb   ]│
│ Columns               [ 3      ▲▼ ] │
│ ── Features (3) ──────────────── + │   ← List: rows, drag, trash
│   ⋮⋮ Fast                          ▸│
│   ⋮⋮ Small                         ▸│
│ ── CTA ──────────────────────── ▾  │   ← Group, collapsible
│   Label               [ Get started]│
│   Link                [ /start    ▾]│
│ ── Slots ─────────────────────────  │
│   Media   ○ using fallback  [Add]   │
│ ── Attributes ────────────────── + │   (in progress)
└─────────────────────────────────────┘
```

Rules (keeping what exists):

- **Backgrounds, not borders** for sections and rows. Menu checks sit at the right end of a row (user
  preferences already in memory).
- **Default display:** an unset prop shows its default as the *placeholder* (greyed), not as a value
  (exists via `placeholderFor`). Switch and Choice show the default as the selected state, with the
  label in regular weight. Once set, the label turns the "overridden" colour (Webflow's blue dot) and
  a per-field **Reset to default** appears in the label's menu (click or right-click), writing the
  attribute's removal. An expression default (`= SIZES[0]`, `= heroImage`) shows its resolved
  preview where possible (`defaultAsset` exists for images), else its code in the placeholder.
- **Reset all** on the header removes every explicit prop that equals the default and offers to
  clear the rest.
- **Required:** a required prop that is unset (and not bound, not spread) shows a red dot in the
  label and a one-line "Required" note. The navigator badge counts missing required props. A
  required prop with a destructure default shows no warning (runtime is fine), only the type
  obligation in the tooltip.
- **Conditional props** (`propRules.ts` branches): props not applying in the current variant are
  hidden (exists). The variant picker always sits first.
- **Deprecated:** strikethrough label with the `@deprecated` text in the tooltip, sorted last.
  `@internal` is hidden.

### 7.2 Bindings per control kind

The bind dot exists on every bindable field (`propBindings.tsx`, `DataPicker.tsx`). What the picker
offers is filtered by kind. Extend `newPropModel.ts` `propFits` from its five fits to the model's
kinds:

| Control kind | Offers from CMS / loop scope | Offers from parent component props | Bound display |
|---|---|---|---|
| Text, Rich text | string / text / rich-text fields, numbers, dates (formatted) | Text, Number, Choice, Date | chip `post.data.title` with live sample (`instanceProps.ts`) |
| Number | number fields | Number | chip |
| Switch | boolean fields, plus "has value" of any field (`!!post.data.image`) | Switch | chip |
| Choice | string fields whose sampled values are all options; any string with a warning | Choice with a subset of the options | chip; dropdown disabled |
| Link | slug/id via template `` `/blog/${post.id}` `` (offer "Link to this item"), URL fields | Link, Text | chip + page preview (`linkPreview.ts`) |
| Image | `image()` fields, URL strings | Image | thumbnail of the sample |
| Color | string fields | Color, Text | swatch of the sample |
| Date | `z.date()` / `z.coerce.date()` fields, ISO strings | Date | formatted sample |
| List of T | arrays whose items fit T; a collection (`await getCollection(…)`) for List of Collection item | List | "Bound to `posts` (12 items)", rows read-only |
| Group | object fields of matching shape; per-member binds | Group | member chips |
| Collection item | the loop item in scope; `reference()` fields | Collection item | entry title |
| Attributes | parent's rest props only (in progress) | Attributes | `{...rest}` chip |
| Tag, Class, Icon, Size | parent props of the same kind | same | chip |
| Code / Callback | everything (unknown types are offered everywhere, as now) | everything | expression text |

"New ‹Kind› property" from the bind dot (in progress) extends to every kind in §6.2 using the same
per-kind forms. The suggested kind comes from the field it's opened on: an `<img src>` offers Image,
an `<a href>` Link, a `style` color Color.

### 7.3 Validation on instances

- Never block typing. Validate on commit (exists for Number) and show a note under the field. Never
  silently clamp a *bound* value.
- An out-of-range literal written by an agent shows a warning state with "Fix to 6".
- A type mismatch from code (`columns="3"` on a number prop) shows a warning: "This is text; the component
  expects a number. Fix?". The fix rewrites it to `columns={3}`.

### 7.4 Unused props, in the component

The Properties panel row shows a dimmed "Not used" tag when the prop is declared but never read
(not destructured, no `Astro.props.x`, not in a spread forwarded on). The settings form offers
"Remove" (exists for unused props) or "Use it…", which inserts `{x}` at the canvas selection. A prop
destructured but never referenced in the template or frontmatter gets the same tag.

---

## 8. Edge cases from AI-written code

| Case | Example | Handling |
|---|---|---|
| Declared, never destructured | `interface Props { a: string }` and no `Astro.props` read | Listed, tagged "Not used" (§7.4). Instance control still works (the prop is accepted). Adding a default creates the destructure (writer exists) |
| Destructured, undeclared | `const { title = "Hi" } = Astro.props;` and no `Props` | Kind inferred from the default literal (string/number/boolean/array/object) and usage. Row tagged "No type". Editing anything writes `interface Props` with an inferred member (writer creates it when absent, exists). Never rewrite the user's code silently |
| Direct access | `Astro.props.title`, `Astro.props["title"]` | Read as usage. Defaults via `?? "x"` / `\|\| "x"` read as the default for display. Writing a default: the existing generated local alias (`docs/component-properties.md`) |
| Props alias | `const props = Astro.props; props.title` / `const { title } = props` | Follow one alias level (`const p = Astro.props`, `const p: Props = Astro.props`, `Astro.props as Props`). Deeper chains: read-only with a reason |
| Multiple destructures | `const { a } = Astro.props; const { b = 1 } = Astro.props;` | Merge; edits go to the destructure that already holds the key, new keys go to the first |
| Nested destructuring | `const { cta: { label, href } = {…} } = Astro.props` | The prop is a Group whose members come from the pattern when undeclared; the default comes from the pattern default |
| Renames | `const { class: className, as: Tag = "div" } = Astro.props` | Key = prop name, local = renamed (exists in `PropEntry`); the rename to a capitalized local is a Tag signal |
| Rest without HTMLAttributes | `const { a, ...rest } = Astro.props` + `{...rest}` on a `<div>` | Attributes with tag inferred from the spread target (in progress) |
| Rest forwarded to a child | `<Button {...rest} />` | The component's extra props are the child's props: show them as "Passed to Button" in a section on instances (Phase 6, needs the child's model) |
| `export interface Props` / `export type Props` | | Same as non-exported (regex already allows `export`) |
| `Astro.props as Foo`, `satisfies` | `const { a } = Astro.props as CardProps` | `CardProps` is the props type (exists in the schema reader). Port to the TS reader |
| Type-only imports | `import type { CardProps } from "../types"` + `type Props = CardProps` | Follow the import (§3.3.5). Edits restricted to "Open types.ts" until D6 |
| Props from a zod schema | `type Props = z.infer<typeof cardSchema>` | Checker tier. Before that, a syntactic zod reader for `z.object({ … })` covering string/number/boolean/enum/array/object/optional/default (`.default()` is a native default) **(proposal; check AI-written code frequency first)** |
| Re-declared / merged interfaces | two `interface Props` | Merge + warn |
| Overlapping names | prop `class` declared and in HTMLAttributes | Own field above attributes (exists) |
| JS components (no TS) | `.astro` with plain JS frontmatter, no types | Destructure-only inference (above). JSDoc `@typedef {Object} Props` / `@property {string} title` / `/** @type {Props} */` read as types; Astro supports JS components **(JSDoc-typed `Astro.props` unverified with Astro tooling)** |
| Markdown / MDX layouts | layout receives `frontmatter`, `headings`, `url`, `file` | The layout's Settings is the page's frontmatter editor (exists for pages, `pageMetadata.ts`). In the layout's Properties panel, `frontmatter` shows as a Group derived from the content collection schema when the layout is used by a collection, else from the union of keys seen in pages using it (bounded scan) |
| MDX components with props | `<Callout type="warning">` in `.mdx` | The same instance controls; MDX is already parsed (`markdownParser.ts`) |
| Zero types and zero destructure | component reads nothing | No props section; "Add property" only |
| Generated `Props` from `ComponentProps<typeof X>` | wrapper components | Checker tier; until then, follow the import of `X` and reuse its model syntactically |
| Huge unions (all icon names, 2000 options) | `type IconName = …` | Cap at `propOptionsMax` (256); beyond it, Text with suggestions from the first N plus search; say "2,000 options, search to find" |
| Default that references frontmatter | `const { size = defaultSize } = Astro.props` | Expression default; resolved via `resolveIdentifierDefaults` (exists) for display |
| Conditional default | `size = variant === "hero" ? "lg" : "md"` | `conditional` fallback; placeholder shows "md, or lg when variant is hero" (rules exist via `statedDefault`, extend to read the ternary syntactically) |

---

## 9. Phased build order

Each phase ends with `npm run check:changed` and the full gate `env -u ELECTRON_RUN_AS_NODE npm test`.
Phases are ordered by designer value per unit of risk.

### Phase 0: Land the in-progress new-prop feature (other agent)

Scope: what's in flight. Two fixes to fold in:
- The schema reader learns `@decimals` (`electron/parse/astroPropTypes.ts` `numberRulesTags`): step `10^-d`.
- `BooleanControl` shows `@onLabel/@offLabel` instead of True/False.

Tests: `test/` cases where a prop written by `declaredProp` reads back through `parsePropSchema` with
the same bounds and labels (a pair assertion across the two readers, which AGENTS.md §9 asks for).

### Phase 1: One prop model (foundation, no new UI)

Status: built. The model is `shared/properties/propModel.ts`, produced by
`electron/parse/propModel/readPropModel.ts` (in the parse layer rather than
`electron/properties/`, because the component preview server reads props too and may
import only parse); the regex reader is retired, and
`test/electron/properties/propModelParity.test.js` holds the model to its output (with the
stated, deliberate differences). `propNestingDepthMax` and `propVariantsMax` sit in
`PROP_MODEL_LIMITS` beside the parser until D14 is approved for `shared/core/limits.ts`.

Scope:
- `shared/properties/propModel.ts`: types, `parsePropModel`, limits (request approval for new
  `shared/core/limits.ts` entries: `propNestingDepthMax`, `propVariantsMax`).
- `electron/properties/propModel/` (new folder): `readPropModel(source, file, project)`, syntactic
  tier on the TS AST, porting `astroPropSchema.ts` behaviour (aliases, unions/branches, stated
  defaults, number rules, imported types) and `propertyDefinitions.ts` contracts.
- `PropField` and `ComponentProperty` are produced *from* the model (adapters). Delete the regex
  reader once parity tests pass.
- IPC: inventory updates in `shared/ipc/ipcPayloads.ts`, `ipcResults.ts`, `preloadApi.ts` if the
  payload changes (per `docs/contracts.md`).
- Studio vendor: add the model file to the vendor sync.

Tests: a **parity corpus** of every component in `test/` fixtures and representative AI-written
components. The new reader must give the same field types, options, defaults, bounds and unions as
the old one (snapshot per fixture). Plus one parse-test per kind, negative shapes per AGENTS.md, and
fast-check over generated `interface Props` text (round-trip: model → write → read gives the same
model).

### Phase 2: Designer vocabulary and the core kinds (biggest visible win)

Scope:
- Type picker becomes Kind (§6), with per-kind forms shared with the new-prop form:
  `src/features/componentProperties/PropertyType.tsx`, `PropertyEditor.tsx`, `PropertyDefault.tsx`,
  and new `src/features/componentProperties/kinds/*.tsx` (one form per kind).
- Instance dispatch on `control.kind`: `src/features/props/PropField.tsx`, `PropControls.tsx`.
- Kinds: Text (multi-line inference), Number (slider), Switch (labels), Choice (const-array /
  const-object / `keyof typeof` sources, segmented ≤ 3), Link (usage), Image (ImageMetadata / either,
  alt pairing), Code fallback screen with reasons.
- Required dot, reset-to-default, overridden-label state, "Not used" tag.

Tests: model tests per detection pattern in §3.2.1–3.2.6. Renderer tests for each control's
read/write round-trip (`attr` in, `attr` out), including out-of-schema values. Type-level
`expectTypeOf` tests for `PropControl` exhaustiveness. A recorded regression for the "2 options read as
a switch" rule.

### Phase 3: Structure (repeaters, groups, variants)

Scope:
- List of T with model-driven item forms (`ListField.tsx`, `arrayValue.ts`), Group with recursive
  fields (`ObjectField.tsx` replaced), Variants picker (`propRules.ts` generalized from top-level
  to nested), Key–value list (split `Record` out of `attrs` in the reader), Tuples.
- Properties panel nested field editor (edit an item interface in place, create a named interface).
- Per-member bindings inside groups.

Tests: fast-check property tests on `arrayText(arrayItems(x)) === x` for every literal Stacki
writes. Variant switching state machine (stash/restore) as a property test, per AGENTS.md's
state-machine note. Bounds tests at nesting depth max and items max.

### Phase 4: Smart types from usage

Scope: the usage tier (§4) in `electron/properties/propModel/usage.ts` over the page tree: Color,
Rich text, Tag picker, Date, Count, Show/hide labels, Class-from-`class:list`, Icon (astro-icon and
glob/object icon sets), Size with unit, Heading level, child-prop propagation one level deep. `@format`
override. The "detected" tooltip with evidence. Suggestions for weak signals.

Tests: one fixture per recognizer with a positive case, a near-miss negative (`href` in a string
literal, `set:html` on an unrelated local, a color name in a comment), and a conflict case. A pin
test that recognition never changes the declared type text.

### Phase 5: Content-aware kinds

Scope: Collection item / items (`CollectionEntry`), `reference()`, entry id; picker writing a
frontmatter `getEntry` const; Slots section on instances and in the Properties panel; render-function
slots; Markdown/MDX layout `frontmatter` props.

Tests: content-config fixtures with each collection kind; the written `getEntry` const round-trips
and compiles (a build smoke test in the existing regression suite).

### Phase 6: Checker tier and the long tail

Scope: `convertToTSX` + bounded `ts.Program` for `ComponentProps<typeof X>`, generics, imported
`Omit/Pick`, `Polymorphic`, `z.infer`, deep alias chains. Framework islands (`.tsx` first, then
Svelte and Vue), the hydration row, forwarded rest props ("Passed to Button"). Cross-file type edits
if D6 says yes.

Tests: fixtures needing the checker, and a timeout/limit test proving the fallback to the syntactic
tier. A comparison test: where both tiers answer, they agree.

---

## 10. Open decisions (each with a recommendation)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Are JSDoc tags acceptable "native" settings? | (a) yes, freely; (b) yes, refinement only and standard vocabularies first; (c) no tags at all | **(b).** Tags are standard comments that tools already show, but nothing may depend on them, and standard tags (`@deprecated`, `@example`, `@format`, `@maxLength`, `@group`) come before Stacki ones (§4.3, §5.2) |
| D2 | Do weak (name-based) signals switch controls automatically? | auto / suggest only | **Keep today's three auto cases (href, media, class names) for continuity; every new weak signal suggests only.** Strong usage signals switch automatically |
| D3 | When a designer picks a smart kind (Color) on a plain `string` prop, write `@format color`? | always / only when no usage signal / never | **Only when no strong usage signal already gives it**, so code stays clean when the template already proves it |
| D4 | Group of fields: inline type literal or named interface? | inline / named / threshold | **Inline below 3 fields, named interface (`CtaProps`) from 3**, which is how agents write it |
| D5 | Choice options from a const array: edit the array or switch to an inline union? | edit array / inline | **Edit the array** (one source of truth; it may be used in the template for iteration) |
| D6 | Edit types that live in other files (`types.ts`)? | never / with confirmation / freely | **With confirmation** in Phase 6 ("This changes `src/types.ts`, used by 3 components"), using the existing atomic multi-file batch. Until then, restricted with "Open file" |
| D7 | Collection item picking: write `await getEntry` in an attribute, or a frontmatter const? | attribute / const | **Frontmatter const** (`const post1 = await getEntry("blog", "x")`), which is clearer and certainly valid |
| D8 | Rename the Switch on/off defaults from True/False to On/Off on *existing* props without tags? | yes / no | **Yes.** It's display-only and less technical |
| D9 | `string \| number` editing | auto-detect / explicit abc/123 toggle | **Explicit toggle**. Guessing types from typed text has bitten every builder that tried it |
| D10 | Framework island support order | TSX only / TSX+Svelte+Vue together | **TSX/JSX first** (TS syntax we already parse), Svelte 5 `$props()` next, Vue last |
| D11 | Show a Code prop's value editor to designers at all? | yes (expression field) / read-only | **Yes, with the data picker**. Many Code props are just bindings, and hiding them strands the designer |
| D12 | Where do settings forms for "New property" and "Edit property" live? | two forms / one | **One per kind**, shared by the bind-dot form (in progress) and the Properties panel, so they cannot drift |
| D13 | Retire the regex schema reader in Phase 1, or keep it as a fallback? | retire / keep | **Retire after parity tests pass**. Three readers is the root cause of drift (§1.1) |
| D14 | Approve new `shared/core/limits.ts` entries (`propNestingDepthMax` = 4, `propVariantsMax` = 32) | — | Needed before Phase 1 (gate files change only with human approval) |

---

## 11. Quick reference: what a designer sees for common AI-written props

| AI writes | Designer sees |
|---|---|
| `title: string` | Text "Title" (required dot) |
| `description?: string` | Text "Description" (multi-line) |
| `variant?: "primary" \| "secondary" \| "ghost"` | Choice: Primary / Secondary / Ghost (segmented) |
| `size?: (typeof SIZES)[number]` | Choice from `SIZES` |
| `href: string` | Link |
| `image: ImageMetadata` | Image (asset picker) |
| `accent?: string` used in `style={{ color: accent }}` | Color |
| `body: string` used with `set:html` | Rich text |
| `as?: "h1" \| "h2" \| "h3"` with `<Tag>` | Tag |
| `items: { title: string; href: string }[]` | List of Group (Title: Text, Href: Link) |
| `media: { type: "image" … } \| { type: "video" … }` | Variants: Image / Video |
| `post: CollectionEntry<"blog">` | Collection item (Blog) |
| `...rest` + `HTMLAttributes<"a">` | Attributes (anchor) |
| `onToggle?: () => void` | Action (set in code) |
| `data: unknown` | Code (with data picker) |
