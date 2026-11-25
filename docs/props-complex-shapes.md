# Prop shapes in real components

The Properties panel must show, and where it can edit, every prop shape a
developer writes. This is the corpus it is held to: every component in the
four projects on the author's machine (252 `.astro` files, frontmatter read
only, nothing run): the Lumos starter (`my-site`, identical to
`test/fixtures/lumos`), `webflow-shop` (Lumos plus 17 files), the Webflow.com
build (126) and `pigeon-test` (4).

How the panel shows each shape is in the **Panel** column, and whether a
designer can edit it there in **Edit**. **R/O** means read-only: the shape is
drawn, with one word, and its bytes are never rewritten
(docs/props-conditional-values.md, "Write rules").

Tests that hold the corpus: `test/electron/properties/variantDefaults.test.ts`,
`variantRuleEdits.test.ts`, `variantRuleModel.test.ts`, `variantRulePlan.test.ts`,
`test/renderer/props/conditionalDefault.test.js`,
`test/renderer/componentProperties/propertyVariants.test.js`.

## Repeated patterns

| Where | Prop | Shape | Panel | Edit |
|---|---|---|---|---|
| 49 Lumos files | `render` | `boolean`, default `true` | Switch kind, Default dropdown | Y |
| 62 Lumos, 60 Webflow.com | `class`, `...rest` | `HTMLAttributes<"x">` passthrough, `class: className` rename | Attributes row; the rename is kept | Y (passthrough is never rewritten) |
| 8 Lumos | whole props | discriminated union + `Astro.props as AllProps` | Visibility pills | Y (runtime type kept in step where it lists the options) |
| 7 Lumos, 4 Webflow.com | slots | `slotContent(Astro.slots)`, named slots | not props: not listed | n/a |

## Lumos (my-site; webflow-shop shares these)

| Component | Prop | Shape | Panel | Edit |
|---|---|---|---|---|
| Button | `element` | controller of `Tag` (`"button"` / `"link"`), optional in the fallback | Choice, Options list writes the union, Kind locked | Y |
| Button | `type`, `disabled`, `href` | ruled by `element`, `never` in the other member | Visibility pill on element | Y |
| Button | `variant` | controller of `Kind`, 5 options, default `"main"` | Options list, Default dropdown moves the fallback | Y |
| Button | `emphasis` | alias union `Emphasis`, `never` for `link`, doc in one member | Visibility pill on variant | Y |
| Button | `label` | `string` for play/close/arrow, `never` for main/link, a different doc per member, default `label ?? named[variant]` with `named = { play: pressed ? "Pause" : "Play", close: "Close", arrow: direction === "back" ? "Previous" : "Next" }` | Visibility pill (Hide when Variant is any of Main, Link); Default value pill ("If Variant = Play and Pressed is true ↳ Pause" …); Tooltip pill, one per option | Y: entries of `named` are edited in place |
| Button | `pressed` | `boolean` only for play | Visibility pill on variant | Y |
| Button | `direction` | `"forward" \| "back"` only for arrow | Visibility pill on variant | Y |
| form/Choice | `type`, `name` | controller `type` (checkbox/radio); `name` required only for radio, a different doc per member | Visibility pill: Required when Type = Radio; Tooltip pill | Y |
| form/Choice | `variant`, `checked`, `required`, `label`, `value` | plain unions, booleans, strings | Kinds | Y |
| form/Fieldset | `legend`, `variant`, `legendStyle` | strings and unions with literal defaults | Kinds, Default | Y |
| form/Form | `name`, `action`, messages, `method` | strings with defaults, inherited attribute default | Kinds, Default | Y |
| form/Input | `variant` | alias union of 11 | Choice | Y |
| form/Input | `label`, `placeholder` | default `label ?? kind.label` (`kind = KINDS[variant]`) | Default value shows the code under Computed | R/O: the table holds objects, read a field further |
| form/Range | `value`, `min`, `max`, `step` | numbers with `@min @max @int`, `value ?? Math.round(…)` | Number kind; Computed for `value` | Y; the computed part R/O |
| form/Select | `variant`, `options`, `from`, `to` | union with a member of three options (`"month" \| "day" \| "state"`), `options` required only for list | Visibility pill, one condition per option set | Y: the shared member is split on the first edit |
| form/Select | `label`, `to`, `from`, `options` | `label ?? wording.label`, `to ?? new Date().getFullYear()`, `options ?? []` | Computed, code shown | R/O |
| form/Textarea | `minLines`, `maxLines` | numbers with tags | Number | Y |
| interactive/* | booleans, strings, unions with defaults | plain | Kinds | Y |
| interactive/Modal | `id?` documented "Required." | optional string | Text | Y |
| item/Card | `variant`, `theme`, `image`, `imageAlt` | `Base & (union)`, base declares `variant?` too, `theme?: never` in stacked | Visibility pill on variant | Y |
| media/Icon | `src` | `SvgComponent`, renamed `src: Svg` | Code type | Y (type as code) |
| media/Img | `src`, `alt`, `variant`, `sizes` | union inside an intersection, `sizes` only for constrained, `alt: altProp ?? ""` | Visibility pill, read-only: Runtime; `alt` Computed | R/O: the runtime type cannot be kept in step |
| media/Video | `variant`, `ratio` | fallback member keyed by an alias (`variant?: VideoRatio`) | Read-only conditions per prop | R/O: a member's option is an alias of several |
| typography/Heading | `tag`, `variant` | `tag: Tag = "h2"`, `variant = Tag` (default read from another prop) | Default value shows `Tag` as code | Y (code default) |
| wrapper/ContentWrapper | `variant`, `reverse`, `centered`, `mediaOpacity` | 5 members, two with several options | Visibility pill, read-only: Runtime | R/O: the runtime type cannot be kept in step |
| wrapper/Grid | number props per member | two members, one with two options | Visibility pill on variant | Y: split on the first edit |
| wrapper/Section | `containerAttrs` | `HTMLAttributes<"div"> = {}` | Code type, code default | Y |
| utility/BaseHead | all | `type Props = SeoProps` (imported) | Shared prop: edits name the other file | Y, in its own file |
| utility/FormattedDate | `format` | object default | Code default | Y |

## webflow-shop additions

| Component | Prop | Shape | Panel | Edit |
|---|---|---|---|---|
| Button | `variant` | the link member names three options (`"link" \| "link-arrow" \| "segment"`) | Visibility pill, one condition per option set | Y: split on the first edit |
| content/ProductRail | `heading = category` | default read from another prop | Code default | Y |
| media/FlutedGlass | `colorTwo = colorOne` | default read from an earlier prop | Code default | Y |
| section/EditorialProduct | `Pick<ComponentProps<typeof Section>, "render">` | type built from another component | Code type | R/O type, Y default |
| item/Card | `product: Product` required only for product; `variant?: "default" \| "notice"` | Visibility pill on variant; default is the fallback | Y |
| content/SizeGuide | `columns: string[][]` | nested array | List / code | Y (code) |

## Webflow.com build

| Component | Prop | Shape | Panel | Edit |
|---|---|---|---|---|
| Button | `as`, `href` | union of three intersections keyed by `href` presence and `as?: never` | Read-only conditions (no literal controller in every member) | R/O |
| IconButton | `label`, `type` | required for button, `never` for span; `type ?? "button"` | Read-only conditions (`Props` is not a local union this reader follows); `type` Computed | R/O |
| Callout | `label` | `label ?? DEFAULT_LABEL[variant]`, table typed `Record<Variant, string>` | Computed | R/O: a typed table is the author's contract |
| Column, Row, RichText, Heading | `as`, `size` | generic `Props<As extends Tag>`, number literal unions | Code types | R/O type |
| Heading | `size` | `size ?? (…)` computed from `as` | Computed | R/O |
| Slider | `slidesPerView` | object `{ lg; md?; … }` with a nested cascade | Group / code | Y (code) |
| ShareLinks | `label?: string \| false` | union of a type and a literal | Code type | Y |
| LinkOverlay | `"aria-label": string` | quoted required key | Text | Y |
| PersonaSelect, PricingMatrixDialog | `defaultId = options[0]?.id`, `trigger = matrix.trigger` | default read from another prop | Code default | Y |
| 45 files | imported data types (`CmsTemplatePage<"blog">`, `typeof HeroVideo`) | imported | Code type | R/O type |

## pigeon-test

| Component | Prop | Shape | Panel | Edit |
|---|---|---|---|---|
| Button | `href = "#"` | string default | Text | Y |
| PricingCard | `features: readonly { title; number }[] = []` | readonly array of objects | List | Y |

## Counts (components showing the shape)

| Shape | Lumos | shop extra | Webflow.com |
|---|---|---|---|
| Discriminated union | 8 | 1 member | 2 |
| `never` exclusion | 7 | 0 | 2 |
| Per-option type | 2 | 1 | 2 |
| Per-option tooltip | 2 differ, 6 in one member | 0 | 2 |
| Default computed per option | 4 | 0 | 3 |
| Default read from another prop | 1 | 2 | 3 |
| `Astro.props as X` | 8 | 0 | 2 |
| Generic props | 0 | 0 | 4 |

## Attribute expressions

The attribute values (not prop declarations) of the same projects, read from
the templates only: `test/fixtures/lumos` (my-site's components),
`webflow-shop`, `Webflow.com-Astro-Build` and `pigeon`. 231 attributes choose
between values; how each is drawn is in docs/props-conditional-values.md,
"Attribute values: the rich reading".

| Where | Attribute | Shape | Panel |
|---|---|---|---|
| Lumos Button | `aria-label` | `isWritten ? undefined : (label ?? named[variant])` | Conditional: group leaves it out, Else a fallback with a lookup |
| Lumos Button | `aria-pressed` | `variant === "play" ? pressed : undefined` | Conditional |
| All four (99) | `class:list` | entries `cond && value`, `padClass(…)` calls | Class list, calls locked |
| webflow-shop form fields | `required`, `checked`, `open` | `x \|\| undefined` | Conditional: a fallback |
| webflow-shop, Webflow.com | `name`, `alt`, `heading`, `tone` | `a ?? slug(b)`, `a?.heading ?? "…"`, `a ?? ""` | Conditional: a fallback, code locked |
| Webflow.com lists | `tabindex`, `md` | `i === 0 ? 0 : -1` | Conditional: numbers locked |
| Webflow.com | `style`, `class`, `aria-current` | `index >= PAGE_SIZE ? "display:none" : undefined` | Conditional: a code condition |
| Webflow.com | `type` | `as === "button" ? (type ?? "button") : undefined` | Conditional: a fallback in a branch |
| Webflow.com | `publishedTime` | `d ? String(d) : (item.publishedAt ?? undefined)` | Conditional: call locked |
| Webflow.com | `class:list` | `[borderless && (compact ? "a" : "b")]`, `ratio === "x" ? "a" : \`b-${ratio}\`` | Class list: the ternary locked |
| webflow-shop Nav | `aria-current` | a regular expression in the test | Computed |
| webflow-shop FlutedGlass, ProductDetail; Webflow.com ResourceTemplate | `style`, `alt`, `formName` | a condition inside a template | Computed |
| Webflow.com HoverFeatures, PricingMatrixDialog | `hidden`, `open` | a test with no value: `a && b !== c` | Computed |
