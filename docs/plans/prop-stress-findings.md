# Prop stress test: findings

What a no-code designer gets for every prop shape Astro can express, measured by
running a zoo of 80 components (194 props) through Stacki's real prop code paths.

- Fixture: `test/fixtures/propZoo/` — a real Astro 5 project (`npm install && npm run dev`).
  One component per prop family in `src/components/`, every one used on
  `src/pages/index.astro` with a few values, a `blog` content collection, an SVG in
  `src/assets/`, shared types in `src/types.ts`, constants in `src/consts.mjs` and a
  `queryItems` list helper in `src/lib/`.
- Harness: `test/helpers/propZoo.js`. Suite: `test/renderer/props/propZoo.test.js`.
- Rerun: `env -u ELECTRON_RUN_AS_NODE npm test -- propZoo` (about 5 s).
- Raw table: `PROP_ZOO_REPORT=/tmp/zoo.json node test/renderer/props/propZoo.test.js`
  writes every aspect of every prop with what was expected and what Stacki did.

## How it is measured

For every prop, on a temporary copy of the fixture:

| Stage | Real code path |
|---|---|
| Scan | main's `project:scan` handler in the windowless main harness (`safeSchema` → `parsePropSchema`) — type, options, default, required, slots, `hasRest`, `extendsTag` |
| Properties panel | `readComponentProperties`, then a no-op save of every property through `editPropertyDefinition` (it must leave the file byte-identical or refuse) |
| Readers | `readPropsDestructure` (loopProps.ts), `listPropsOf` (listProps.ts), `readPropDocumentation` (propDocumentation.ts) |
| Settings panel | the real `PropsPanel` mounted in jsdom for the instance on the index page, with `schemaFor` as the app gives it. `PropControls.tsx` is wrapped so each control tags itself; the Settings group is opened so class/style show |
| Edit | the value the shown control writes, sent through that control's own `onChange`, captured from `onSetProp`, written by main's real `page:edit`, read back with `page:read`; the control shown afterwards must be the same |

The spec in `propZoo.test.js` states the ideal for each prop. A matching aspect is
an ordinary assertion (1,802 subtests pass today). A shortfall is listed in
`KNOWN_GAPS` and runs as a `todo` (77 today), so the gate stays green; an
unlisted mismatch fails. When a gap is fixed its todo says "(now passes)".

**What works well.** Every one of the 176 attempted instance edits wrote exactly
the value sent, left the instance's other attributes alone, and read back the same
(quotes and `&`/`<` in text are written as single-quoted attributes). Primitives,
optional/required, literal defaults, imported-constant defaults, renamed and
nested destructures, `type Props =`, `export interface Props`, untyped destructures,
`Astro.props.x` and `props.x` access, string and number unions (local aliases,
multi-line), discriminated unions with `never` (the forbidden branch's fields hide),
arrays, Records, image imports (thumbnail + imported-asset field), media URLs,
`href`, `class`/`style`, `set:html`, `as` tags, slots (default, named, `has`,
`render`), the three list-setting props (Filter/Sort/Selected items detected, the
lookalike object correctly not), and JSDoc `@min`/`@max`/`@decimals`/`@onLabel`/
`@offLabel` all read correctly.

**Crashes.** None in the final run. During development, mounting the Settings panel
for an image prop without a preload bridge threw
`TypeError: Cannot read properties of undefined (reading 'onAssetsChanged')`
(`src/ipc/assetBridge.ts`, `window.avb` absent), and a bridge whose `listAssets`
answers `undefined` throws `Error: Expected object` from `parseAssetEntries` as an
**unhandled rejection** inside `AssetField`'s refresh (`listAssetEntries` treats a
malformed reply as a programmer error, which is the contract, but nothing in the
field catches the rejection, so it would take down a renderer). The harness now
stubs the bridge with methods that reject, which the field handles.

## Severity key

- **blocker** — the designer can write a value that breaks the page or build, or
  Stacki changes the source in a way that loses work or fails type-checking.
- **confusing** — the field is wrong or missing, so the designer cannot do what the
  component allows without code, or sees a misleading value.
- **cosmetic** — works, but reads or diffs worse than it should.

## Findings by family

### Code-only values given a text box

`PropField.tsx` `propFieldControl` falls through to `TextControl` for any `other`
type with no value set; a text box writes `prop="…"`, a string.

| Pattern | Today | What's wrong | Severity | Fix area |
|---|---|---|---|---|
| `render?: (item: T) => string` (GenericProps), `onSelect?: () => void` (FunctionProp) | Text box; edit wrote `render='Zoo…'` | A string where a function is called: `render is not a function` at build | blocker | `src/features/props/PropField.tsx` (route function types to the expression field); `electron/parse/astroPropTypes.ts` `normalizeType` (give `=>` types a `code`/`function` type) |
| `thing?: object`, `payload?: any` (UnknownAnyProps) | Text box | Writes a string into an object prop | blocker (`object`), confusing (`any`) | same |
| `range?: readonly [min: number, max: number]` (TupleProp) | type `other`, Text box | `normalizeType`'s array test misses `readonly [..]`; writes a string to a tuple | blocker | `electron/parse/astroPropTypes.ts` (strip `readonly` before the array/tuple tests) |
| `let { items = ['one', 'two'] } = Astro.props` (JsOnlyFrontmatter, no types) | type `other`, Text box | An array-literal default does not make it a list; a string is written and `.map` crashes | blocker | `electron/parse/astroPropFields.ts` `withDestructureDefault` (an `[`-default implies `code`) |
| `published: Date` (DateProp) | Binding field while set (`{new Date(…)}`); unset it would be a text box | No date control though `DateField` exists in the UI kit | confusing | `src/features/props/PropControls.tsx` |
| `big: bigint` (PrimBigint) | type `other`; Binding field only because the page sets `{10n}` | Unset, it is a text box writing `"20"`, a string | confusing | `normalizeType` + `PropField.tsx` |

### Objects edited as lists

| Pattern | Today | What's wrong | Severity | Fix area |
|---|---|---|---|---|
| `config?: { dense: boolean }` with `= { dense: false }` (DefaultExpression); `filters?: { filterFor…; fields… }` (ListLookalike) | `ListControl` (type `code`, no value) | The list editor writes `["zoo", "edit"]` into an object prop | blocker | `src/features/props/PropField.tsx`: the `type === 'code' && value === undefined` → ListControl branch should require an array type (`[]`/`Array<`/tuple), objects go to `ObjectControl` or the expression field |
| `cta: { label: string; link: { href: string; external?: boolean } }` written over several lines (NestedObject) | `cta` is `other`, and `label` and `link` are listed as **top-level props** | Phantom fields: editing "label" writes `label=` on the instance, which the component ignores | blocker | `electron/parse/astroPropFields.ts` / `astroPropTypes.ts` `explodeMembers`: a multi-line nested object type is split into members |

### Unions that lose their options

| Pattern | Today | What's wrong | Severity | Fix area |
|---|---|---|---|---|
| `const SIZES = ['sm','md','lg'] as const; size?: (typeof SIZES)[number]` (AsConstArray), and `type Weight = typeof WEIGHTS[number]` (AsConstAlias) | type `string`, free text | The array's values are the options | confusing | `electron/parse/astroPropSchema.ts` aliases: resolve `typeof X[number]` against an `as const` array in the frontmatter |
| `const Tone = {…} as const; type ToneValue = (typeof Tone)[keyof typeof Tone]`, default `Tone.Info` (EnumLikeObject) | type `other`, default `Tone.Info`, free text | Options and the resolved default `'info'` | confusing | same, plus `electron/properties/propDefaults.ts` `resolveIdentifierDefaults` (member access on a local const) |
| `type Props = CardProps` imported, where `CardProps.tone?: Tone` and `Tone` is a union in the same file (ImportedTypes) | `tone` is `string` | `importedTypes` reads one level: `Tone` is not brought in | confusing | `electron/properties/propDefaults.ts` `importedTypes` (follow names the imported declarations use, same file first) |
| `flag?: boolean \| 'auto'` (MixedUnion) | `boolean` with **string default `'auto'`**; True/False switch | `'auto'` cannot be chosen; the schema contradicts itself | confusing | `normalizeType`: a boolean mixed with literals is an enum of `true`/`false`/literals |
| `size?: 'sm' \| 'lg' \| number` (MixedUnion) | `string`, free text | Choices lost; a number can only be written as a string | confusing | `normalizeType` |
| `kind: 'link' \| 'button'` discriminated union where only the button branch has `disabled?` (DiscriminatedUnion) | `disabled` switch shown while `kind="link"` | A prop the active branch doesn't have is offered (only `never` hides) | confusing | `src/features/props/propRules.ts` (a member absent from the active branch is not applicable) |

### Props not found

| Pattern | Today | What's wrong | Severity | Fix area |
|---|---|---|---|---|
| No Props type, only `Astro.props.label` and `Astro.props.year ?? 2026` (DirectAccessUntyped) | No props at all | The Settings panel is empty | confusing | `electron/parse/astroPropFields.ts` `parsePropSchemaFallbacks` (read `Astro.props.x` member access without a type) |
| `'data-id': string; 'aria-label'?: string` (QuotedNames) | Missing from the scan; the Properties panel lists them (restricted) | Can't set them from Settings | confusing | `parsePropSchemaMemberEntries` (accept quoted keys) |
| `type Props = ComponentProps<typeof StringUnion> & {…}` (PassThrough) | Only `wrapperClass`; the wrapped `variant`/`label` reachable only as free Attributes | The real API of a wrapper is invisible | confusing | `electron/properties/propDefaults.ts` (resolve `ComponentProps<typeof X>` to X's schema) |
| `const props = Astro.props; const { title, level = 2 } = props;` (DestructureLater) | `level` found, default missed | Default not shown | cosmetic | `parsePropSchemaDestructure` (also follow `= props` aliases) |
| `type Props = HTMLAttributes<'button'> & { label: string }` (TypeAliasWithExtendsTag) | `extendsTag` undefined | The button's own attributes are not offered as with `interface … extends` | confusing | `electron/parse/astroComponentApi.ts` `parseExtendsTag` |

### Defaults read wrong

| Pattern | Today | What's wrong | Severity | Fix area |
|---|---|---|---|---|
| `const { title, count = 1 }: { title: string; count?: number } = Astro.props` (InlineAnnotation) | `count` default `'1 }: { title: string; count?: number'`; both types `other`; `title` optional; Text box for the number | The destructure regex runs past the pattern into the annotation | blocker | `electron/parse/astroPropFields.ts` `parsePropSchemaDestructure` (`\{([\s\S]*?)\}\s*=` stops at the wrong brace; read the pattern with the TS parser, and treat the annotation as the Props type) |
| ``prefix = `${SITE}:` ``, ``stamp = `built-${Date.now()}` `` (DefaultComputed, DefaultExpression) | Default shown as literal text `${SITE}:` | An interpolated template is treated as a plain string literal | confusing | `withDestructureDefault` (only a template without `${` is a literal) |
| `quote = "He said \"hi\""`, `multiline = 'line one\nline two'`, `path = 'C:\\zoo'` (EscapedDefaults) | Backslashes kept: `He said \"hi\"`, `line one\nline two`, `C:\\zoo` | Escapes are not decoded | cosmetic | `withDestructureDefault` (decode with the same rules as `literalValue`) |
| JSDoc `Whether to show the date. Defaults to true.` on a boolean (JsDocProseDefault) | Default is the **string** `'true'` | Boolean switch fed a string fallback | cosmetic | `electron/parse/astroPropTypes.ts` `statedDefault` (type the value by the field) |
| `exponent = 1e3`, `hex = 0x10`, `separated = 1_000` (NumericFormats) | Kept as expression text | Shown as code, not as 1000/16/1000 | cosmetic | `withDestructureDefault` number test |
| `@deprecated Use label instead.` (JsDocProps) | Not surfaced | No warning on a deprecated prop | cosmetic | `electron/parse/astroPropTypes.ts` + `src/editor/propDocumentation.ts` |

### Properties panel: a save that changes nothing rewrites the file

`editPropertyDefinition(source, { kind: 'save', property })` with the property
exactly as read should leave the file alone (or refuse). It rewrites it in 23 of
194 cases (`electron/properties/propertyDefinitions.ts`, `propertySyntax.ts`):

| Pattern | Today | Severity |
|---|---|---|
| `// The title, required.` line comment above a member (CommentsInType, JsDocProseDefault) | Comment **deleted** (`readDescription` reads only JSDoc, the save writes the empty description back) | blocker (silent loss of the agent's docs) |
| Untyped destructure with `...rest` (RestPropsPlain) | Adds `interface Props { label?: string }`, after which every page passing `href=`/`target=` fails `astro check` | blocker |
| Destructure annotated inline (InlineAnnotation) | Adds `interface Props { count?: unknown; title?: unknown }` beside the annotation — contradictory types | blocker |
| Untyped components (NoTypeDestructure, JsOnlyFrontmatter, ListSortProp, ListCuratedProp), a destructured name missing from Props (DefaultsMismatch) | Adds or extends `interface Props` | confusing (an unrequested diff) |
| Multi-line JSDoc (`/**\n * text\n * @min 1\n */`) | Reflowed to `/** text\n * @min 1 */` | cosmetic |
| Multi-line union with leading `\|`, `,` member separators, a missing `;` | Reformatted | cosmetic |

Also in the Properties panel: props of `Astro.props as CardOptions` (AsAssertion) and
of `interface Props<T>` (GenericProps) are refused with "This prop is inherited or
imported", though both types are local — the reason is misleading (confusing).
Props of an imported `type Props = CardProps` show type `unknown` for `title`/`href`.

### Smaller gaps

| Pattern | Today | Severity | Fix area |
|---|---|---|---|
| `color?: string = '#ff3366'` (ColorProp) | Text box; no colour control | cosmetic | `src/features/props/PropControls.tsx` |
| `url?: string` (HrefProp) | Text box; only `href`-like names get the link field | cosmetic | `src/features/props/propFieldModel.ts` `isHrefName` |
| `as` of `Polymorphic<{ as: Tag }>` (PolymorphicAstro) | Text box for the tag | cosmetic | `normalizeType` (`HTMLTag` → tag list) |

## Not covered

A framework island (React/Svelte props) was left out: no framework integration is
trivially available offline, so `FunctionProp` stands in for callback props.
Bounds (`@min`/`@max`) are read correctly; whether the number field clamps on
commit is covered by the props suites, not here, since the zoo calls each control's
`onChange` directly. The harness wraps whatever `export function …Control(` the
controls module declares, so new controls are picked up without changes here.
