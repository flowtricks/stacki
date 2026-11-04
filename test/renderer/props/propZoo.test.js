// Goal: stress Stacki's handling of component props with a zoo of Astro
// components (test/fixtures/propZoo), one family of prop shapes each, written
// the way an AI agent writes them, and pin down what a no-code designer gets
// for every prop: is it found, is its type and default read right, which
// control the instance Settings panel shows, can that control edit it, and
// does the edit land in the file and read back the same.
//
// Method: test/helpers/propZoo.js runs each component through the real code
// paths (main's project scan, the Properties panel reader and a no-op save,
// the renderer's frontmatter readers, the mounted PropsPanel, and main's
// page:edit) and returns one record per component. SPEC below states what a
// designer should get. Every aspect of every prop is compared with it:
//   - an aspect that matches is an ordinary assertion and must keep passing;
//   - an aspect listed in KNOWN_GAPS is a `todo` subtest that records the
//     shortfall without failing the gate (docs/plans/prop-stress-findings.md
//     explains each one and its severity);
//   - an aspect that differs and is not listed fails: a regression, or a gap
//     to add to KNOWN_GAPS and the findings.
// When a known gap is fixed its todo reports "(now passes)": drop it from
// KNOWN_GAPS so the aspect is held from then on.
// Rerun: env -u ELECTRON_RUN_AS_NODE npm test -- propZoo
// Findings table, as JSON: PROP_ZOO_REPORT=/some/file.json node test/renderer/props/propZoo.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test, before } = require('node:test');
const { runZoo, zooComponentNames } = require('../../helpers/propZoo.js');

// "Absent": no default, no extended tag.
const NONE = Symbol('none');
// Any of several answers is right: an expression default may also be resolved to its value.
const anyOf = (...values) => ({ anyOf: values });
const expectProp = (type, control, extra = {}) => ({ type, control, ...extra });
const text = (extra) => expectProp('string', 'TextControl', extra);
const number = (extra) => expectProp('number', 'NumberControl', extra);
const boolean = (extra) => expectProp('boolean', 'BooleanControl', extra);
const choice = (options, extra) => expectProp('enum', 'EnumControl', { options, ...extra });
const list = (extra) => expectProp('code', 'ListControl', extra);
// Values only code can express (functions, dates, entries, objects): an
// expression or binding field, never a plain text box that writes a string.
const code = (extra) => expectProp(undefined, anyOf('ExpressionControl', 'BindingControl', 'ObjectControl'), extra);

// What a designer should get. Component-level keys: slots, hasRest, extendsTag,
// listProps (the props the list editor owns). `props` lists every prop the
// component's own declaration has; inherited element attributes are not listed.
const SPEC = {
  ArrayObjects: { props: { links: list({ required: true }) } },
  ArrayPrimitives: { props: { tags: list({ required: true }), scores: list({ default: '[1, 2, 3]' }), flags: list({ default: '[]' }) } },
  AsAssertion: { props: { title: text({ required: true }), compact: boolean({ default: false }) } },
  AsConstAlias: { props: { weight: choice(['light', 'regular', 'bold'], { default: 'regular' }) } },
  AsConstArray: { props: { size: choice(['sm', 'md', 'lg'], { default: 'md' }) } },
  ClassListVariants: {
    props: {
      variant: choice(['primary', 'secondary'], { default: 'primary' }),
      size: choice(['sm', 'md', 'lg'], { default: 'md' }),
      rounded: boolean({ default: false }),
      class: expectProp('string', 'ClassControl'),
    },
  },
  CollectionEntryProp: { props: { post: code({ required: true }), showDate: boolean({ default: true }) } },
  ColorProp: {
    props: {
      // Stacki has no colour control; a hex typed into a text box is the gap.
      color: expectProp('string', 'ColorControl', { default: '#ff3366' }),
      background: text({ default: 'transparent' }),
      opacity: number({ default: 1 }),
    },
  },
  CommentsInType: {
    props: {
      title: text({ required: true, doc: 'The title, required.' }),
      subtitle: text({ default: 'a; b' }),
      count: number({ default: 1 }),
      mode: choice(['a', 'b'], { default: 'a' }),
    },
  },
  ConditionalRender: { props: { showBadge: boolean({ default: false }), showIcon: boolean({ default: true }), title: text({ required: true }) } },
  DateProp: {
    props: { published: code({ required: true, edit: { type: 'expr', value: "new Date('2027-03-04')" } }), updated: expectProp(undefined, 'TextControl') },
  },
  DefaultComputed: {
    props: {
      brand: text({ default: 'Zoo' }),
      prefix: text({ default: anyOf('Zoo:', '`${SITE}:`') }),
      limit: number({ default: anyOf(8, 'MAX * 2') }),
      heading: text({ default: anyOf('ZOO', 'SITE.toUpperCase()') }),
    },
  },
  DefaultExpression: {
    props: {
      year: number({ default: 'new Date().getFullYear()' }),
      items: list({ default: '[]' }),
      config: code({ default: '{ dense: false }' }),
      stamp: text({ default: '`built-${Date.now()}`' }),
    },
  },
  DefaultImportedConst: { props: { title: text({ default: 'Prop Zoo' }), max: number({ default: 6 }), banner: boolean({ default: true }) } },
  DefaultLiteral: {
    props: {
      label: text({ default: 'Click me' }),
      size: number({ default: 3 }),
      open: boolean({ default: false }),
      ratio: number({ default: 0.5 }),
      offset: number({ default: -2 }),
    },
  },
  DefaultsMismatch: {
    props: { align: choice(['left', 'center'], { default: 'center' }), undeclared: text(), extra: text({ default: 'not in Props' }) },
  },
  DestructureLater: { props: { title: text({ required: true }), level: number({ default: 2 }) } },
  DirectAccess: { props: { title: text({ required: true }), tagline: text() } },
  DirectAccessUntyped: { props: { label: expectProp(undefined, 'TextControl'), year: expectProp(undefined, 'NumberControl', { default: 2026 }) } },
  DiscriminatedNever: {
    props: {
      mode: choice(['image', 'quote'], { required: true }),
      // The instance is in quote mode: the image branch's fields are forbidden there.
      src: expectProp('string', 'hidden'),
      alt: expectProp('string', 'hidden'),
      caption: text(),
    },
  },
  DiscriminatedUnion: {
    props: {
      kind: choice(['link', 'button'], { required: true }),
      href: expectProp('string', 'LinkControl'),
      label: text({ required: true }),
      // Only the button branch has it; the instance is a link.
      disabled: expectProp('boolean', 'hidden'),
    },
  },
  EnumLikeObject: { props: { tone: choice(['info', 'warn', 'error'], { default: 'info' }) } },
  EscapedDefaults: {
    props: {
      quote: text({ default: 'He said "hi"' }),
      emoji: text({ default: '🦒 zoo' }),
      multiline: text({ default: 'line one\nline two' }),
      path: text({ default: 'C:\\zoo' }),
    },
  },
  ExportInterface: { props: { message: text({ required: true }), urgent: boolean({ default: false }) } },
  FunctionProp: {
    props: {
      value: number({ required: true }),
      format: code({ default: '(amount) => `$${amount.toFixed(2)}`', edit: { type: 'expr', value: '(value) => `${value}!`' } }),
      onSelect: code(),
    },
  },
  GenericProps: { props: { items: list({ required: true }), label: text({ required: true }), render: code({ default: '(item) => String(item)' }) } },
  HrefProp: {
    props: {
      href: expectProp('string', 'LinkControl', { required: true }),
      label: text({ default: 'Read more' }),
      target: choice(['_blank', '_self'], { default: '_self' }),
      url: expectProp('string', 'LinkControl'),
    },
  },
  HtmlAttributesProp: { props: { label: text({ required: true }), linkAttrs: expectProp('attrs', 'AttributeControl', { default: '{}' }) } },
  ImageMetadataProp: {
    props: {
      image: expectProp(undefined, 'ImportedAssetControl', { default: 'square' }),
      alt: text({ required: true }),
      width: number({ default: 40 }),
    },
  },
  ImageUrl: {
    props: { src: expectProp('string', 'MediaControl', { required: true }), alt: text({ required: true }), poster: expectProp('string', 'MediaControl') },
  },
  ImportedMember: {
    props: {
      author: code({ required: true }),
      tone: choice(['info', 'success', 'warning', 'danger'], { default: 'success' }),
      links: list({ default: '[]' }),
    },
  },
  ImportedTypes: {
    props: {
      title: text({ required: true, doc: "The card's heading." }),
      body: text({ default: 'Body text' }),
      tone: choice(['info', 'success', 'warning', 'danger'], { default: 'info' }),
      href: expectProp('string', 'LinkControl'),
    },
  },
  InlineAnnotation: { props: { title: text({ required: true }), count: number({ default: 1 }) } },
  Intersection: {
    props: {
      id: text({ required: true }),
      hidden: boolean({ default: false }),
      title: text({ required: true }),
      tone: choice(['calm', 'loud'], { default: 'calm' }),
    },
  },
  JsDocProps: {
    props: {
      label: text({ default: 'Go', doc: 'The text on the button.' }),
      columns: number({ default: 3, min: 1, max: 6, decimals: 0 }),
      opacity: number({ default: 0.8, min: 0, max: 1, decimals: 2 }),
      open: boolean({ default: true, onLabel: 'Shown', offLabel: 'Hidden' }),
      text: text({ deprecated: true }),
      density: choice(['compact', 'medium', 'comfortable'], { default: 'medium' }),
    },
  },
  JsDocProseDefault: { props: { heading: text({ default: 'Welcome' }), size: number({ default: 12 }), dated: boolean({ default: true }) } },
  JsOnlyFrontmatter: { props: { heading: expectProp(undefined, 'TextControl'), items: list({ default: "['one', 'two']" }) } },
  ListCuratedProp: { listProps: ['items'], props: { items: expectProp(undefined, 'ListPropField', { default: '{ "itemIds": [] }' }) } },
  ListFilterProp: { listProps: ['filters'], props: { filters: expectProp(undefined, 'ListPropField', { default: '{ "filterFor": "ALL", "fields": [] }' }) } },
  ListLookalike: {
    // Shaped like list settings, but no list reads them: plain object props.
    props: { filters: code({ default: "{ filterFor: 'ALL', fields: [] }" }), sort: list({ default: '[]' }) },
  },
  ListSortProp: {
    listProps: ['sort', 'limit', 'skip'],
    props: {
      sort: expectProp(undefined, 'ListPropField', { default: '[{ "field": "title", "direction": "asc" }]' }),
      limit: number({ default: 2 }),
      skip: number({ default: 0 }),
    },
  },
  LocalAliasUnion: { props: { level: choice(['h1', 'h2', 'h3'], { default: 'h2' }), emphasis: choice(['none', 'italic'], { default: 'none' }) } },
  LoopCount: { props: { count: number({ default: 3, min: 0, max: 10 }) } },
  MixedUnion: {
    props: {
      value: expectProp(undefined, anyOf('BindingControl', 'TextControl', 'NumberControl'), { required: true, edit: { type: 'expr', value: '7' } }),
      flag: choice(['true', 'false', 'auto'], { default: 'auto' }),
      size: choice(['sm', 'lg'], { default: 'sm' }),
    },
  },
  MultiLineUnion: { props: { color: choice(['gray', 'blue', 'green', 'red'], { default: 'gray' }), shape: choice(['pill', 'square'], { default: 'pill' }) } },
  NestedDestructure: { props: { author: code({ required: true }), meta: code() } },
  NestedObject: { props: { cta: code({ required: true, edit: { type: 'expr', value: "{ label: 'Go', link: { href: '/go' } }" } }) } },
  NoTypeDestructure: { props: { title: text({ default: 'No types here' }), count: number({ default: 2 }), active: boolean({ default: true }) } },
  Nullable: {
    props: {
      subtitle: expectProp('string', anyOf('TextControl', 'BindingControl'), { required: true, edit: { type: 'string', value: 'Now set' } }),
      count: number(),
      note: text({ default: anyOf(NONE, 'null') }),
    },
  },
  NumberUnion: { props: { cols: choice(['1', '2', '3', '4'], { default: 3 }), gap: choice(['0', '0.5', '1', '2'], { default: 1 }) } },
  NumericFormats: {
    props: {
      negative: number({ default: -1 }),
      decimal: number({ default: 0.25 }),
      exponent: number({ default: anyOf(1000, '1e3') }),
      hex: number({ default: anyOf(16, '0x10') }),
      separated: number({ default: anyOf(1000, '1_000') }),
    },
  },
  OptionalChainDefault: { props: { title: text(), subtitle: text({ default: 'Fallback subtitle' }) } },
  OptionalRequired: { props: { name: text({ required: true }), nickname: text(), age: number(), verified: boolean() } },
  PassThrough: {
    hasRest: true,
    props: {
      wrapperClass: expectProp('string', 'ClassControl', { default: 'pass-through' }),
      // The wrapped StringUnion's own props, through ComponentProps<typeof StringUnion>.
      variant: choice(['primary', 'secondary', 'ghost'], { default: 'primary' }),
      label: text({ required: true }),
    },
  },
  PolymorphicAs: { props: { as: choice(['h1', 'h2', 'h3', 'p'], { default: 'h2' }), text: text({ required: true }) } },
  PolymorphicAstro: { hasRest: true, props: { as: text({ default: 'div' }), label: text({ default: 'Polymorphic' }) } },
  PrimBigint: {
    props: {
      big: expectProp(undefined, anyOf('NumberControl', 'BindingControl', 'ExpressionControl'), { required: true, edit: { type: 'expr', value: '20n' } }),
    },
  },
  PrimBoolean: { props: { visible: boolean({ required: true }) } },
  PrimNumber: { props: { count: number({ required: true }) } },
  PrimString: { props: { title: text({ required: true }) } },
  PromiseProp: { props: { names: code({ required: true }) } },
  PropsObject: { props: { title: text({ required: true }), count: number({ default: 1 }) } },
  QuotedNames: { props: { 'data-id': text({ required: true }), 'aria-label': text({ default: 'Zoo' }), title: text({ default: 'Quoted' }) } },
  ReadonlyMembers: { props: { title: text({ required: true }), items: list({ default: '[]' }) } },
  RecordProp: {
    props: {
      labels: expectProp('attrs', 'AttributeControl', { required: true }),
      totals: expectProp('attrs', 'AttributeControl', { default: '{ a: 1, b: 2 }' }),
    },
  },
  RenamedDestructure: { props: { title: text({ default: 'Untitled' }), class: expectProp('string', 'ClassControl') } },
  RestPropsExtends: {
    hasRest: true,
    extendsTag: 'a',
    props: { label: text({ required: true }), variant: choice(['solid', 'outline'], { default: 'solid' }) },
  },
  RestPropsPlain: { hasRest: true, props: { label: text({ default: 'Link' }) } },
  RichText: { props: { html: text({ required: true }), content: text({ default: '<em>Default rich</em>' }) } },
  SlotsDefault: { slots: ['default'], props: { title: text({ default: 'Card' }) } },
  SlotsNamed: { slots: ['default', 'header', 'footer'], props: { bordered: boolean({ default: false }) } },
  SlotsRender: { slots: ['default'], props: { items: list({ required: true }) } },
  StringUnion: { props: { variant: choice(['primary', 'secondary', 'ghost'], { default: 'primary' }), label: text({ required: true }) } },
  StyleAndClass: { props: { class: expectProp('string', 'ClassControl'), style: expectProp('string', 'StyleControl'), id: text() } },
  TemplateLiteral: { props: { width: text({ default: '120px' }), anchor: text({ required: true }) } },
  TupleProp: { props: { point: list({ required: true }), range: list({ default: '[0, 10]' }) } },
  TwoOptionUnion: { props: { align: choice(['left', 'right'], { default: 'left' }), theme: choice(['light', 'dark']) } },
  TypeAliasProps: { props: { title: text({ required: true }), subtitle: text({ default: 'Sub' }), level: number({ default: 2 }) } },
  TypeAliasWithExtendsTag: { hasRest: true, extendsTag: 'button', props: { label: text({ required: true }) } },
  UnknownAnyProps: { props: { data: code(), payload: code(), thing: code() } },
};

// Aspects that fall short today, keyed `Component.prop.aspect` (or
// `Component.aspect` for the component itself). The value says what happens;
// docs/plans/prop-stress-findings.md has the severity and the fix area.
const KNOWN_GAPS = {
  'AsConstAlias.weight.type': '`typeof WEIGHTS[number]` over an `as const` array reads as a plain string',
  'AsConstAlias.weight.options': "the const array's values are not offered",
  'AsConstAlias.weight.control': 'a free text box instead of the three choices',
  'AsConstArray.size.type': '`(typeof SIZES)[number]` reads as a plain string',
  'AsConstArray.size.options': "the const array's values are not offered",
  'AsConstArray.size.control': 'a free text box instead of the three choices',
  'ColorProp.color.control': 'no colour control: a hex colour is a plain text box',
  'CommentsInType.title.panelSave': 'a no-op save deletes the `//` comment above the member and rewrites `,` to `;`',
  'CommentsInType.subtitle.panelSave': 'a no-op save rewrites the member separators',
  'CommentsInType.count.panelSave': 'a no-op save adds a semicolon',
  'CommentsInType.mode.panelSave': 'a no-op save rewrites the member separators',
  'DefaultComputed.prefix.default': 'a template literal with `${}` is shown as literal text `${SITE}:`',
  'DefaultExpression.config.control': 'an object prop gets the list editor, which writes an array',
  'DefaultExpression.stamp.default': 'a template literal with `${}` is shown as literal text',
  'DefaultsMismatch.extra.panelSave': 'a no-op save of an undeclared destructured prop adds it to Props',
  'DestructureLater.level.default': 'a default in `const { \u2026 } = props` (not Astro.props) is missed',
  'DirectAccessUntyped.label.detected': '`Astro.props.label` with no Props type is not a prop',
  'DirectAccessUntyped.year.detected': '`Astro.props.year ?? 2026` with no Props type is not a prop',
  'DiscriminatedUnion.disabled.control': 'a prop only the other branch has is still offered',
  'EnumLikeObject.tone.type': '`(typeof Tone)[keyof typeof Tone]` reads as other',
  'EnumLikeObject.tone.options': "the object's values are not offered",
  'EnumLikeObject.tone.default': "`Tone.Info` is not resolved to 'info'",
  'EnumLikeObject.tone.control': 'a free text box',
  'EscapedDefaults.quote.default': 'escape sequences are kept: the default shows backslashes',
  'EscapedDefaults.multiline.default': '`\\n` in a default shows as a backslash and n',
  'EscapedDefaults.path.default': 'a `\\\\` in a default shows doubled',
  'FunctionProp.onSelect.control': 'an unset callback prop gets a text box that writes a string',
  'GenericProps.render.control': 'an unset function prop gets a text box that writes a string',
  'HrefProp.url.control': 'a prop named url is not offered the link field',
  'ImportedTypes.tone.type': 'an alias used inside an imported type is not followed (one level deep only)',
  'ImportedTypes.tone.options': "the imported Tone union's options are lost",
  'ImportedTypes.tone.control': 'a free text box',
  'InlineAnnotation.title.type': 'an annotation on the destructure is not read as the Props type',
  'InlineAnnotation.title.required': 'required in the annotation, optional in Stacki',
  'InlineAnnotation.title.panelSave': 'a no-op save adds an `interface Props` of unknowns that contradicts the annotation',
  'InlineAnnotation.count.type': 'an annotation on the destructure is not read as the Props type',
  'InlineAnnotation.count.default': "the default runs into the annotation: '1 }: { title: string; count?: number'",
  'InlineAnnotation.count.control': 'a text box for a number prop',
  'InlineAnnotation.count.panelSave': 'a no-op save adds an `interface Props` of unknowns that contradicts the annotation',
  'JsDocProps.columns.panelSave': 'a no-op save reflows a multi-line JSDoc block',
  'JsDocProps.opacity.panelSave': 'a no-op save reflows a multi-line JSDoc block',
  'JsDocProps.open.panelSave': 'a no-op save reflows a multi-line JSDoc block',
  'JsDocProps.text.deprecated': '@deprecated is not surfaced anywhere',
  'JsDocProps.text.panelSave': 'a no-op save reflows a multi-line JSDoc block',
  'JsDocProseDefault.size.panelSave': 'a no-op save deletes the `//` documentation comment',
  'JsDocProseDefault.dated.default': "'Defaults to true.' is read as the string 'true' on a boolean",
  'JsOnlyFrontmatter.heading.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'JsOnlyFrontmatter.items.type': 'an array default does not make the prop a list',
  'JsOnlyFrontmatter.items.control': 'a text box for an array prop, which writes a string the component .map()s',
  'JsOnlyFrontmatter.items.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'ListCuratedProp.items.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'ListLookalike.filters.control': 'an object prop gets the list editor, which writes an array',
  'ListSortProp.sort.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'ListSortProp.limit.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'ListSortProp.skip.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'MixedUnion.flag.type': "`boolean | 'auto'` reads as boolean, with the string default 'auto'",
  'MixedUnion.flag.options': "'auto' cannot be chosen",
  'MixedUnion.flag.control': "a True/False switch that cannot write 'auto'",
  'MixedUnion.size.type': "`'sm' | 'lg' | number` reads as a plain string",
  'MixedUnion.size.options': 'the literal choices are lost',
  'MixedUnion.size.control': 'a text box that can only write strings',
  'MultiLineUnion.color.panelSave': 'a no-op save moves the leading `|` of a multi-line union',
  'NestedObject.label.phantom': 'a member of a nested object type becomes a top-level prop',
  'NestedObject.link.phantom': 'a member of a nested object type becomes a top-level prop',
  'NoTypeDestructure.title.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'NoTypeDestructure.count.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'NoTypeDestructure.active.panelSave': 'a no-op save adds an `interface Props` to an untyped component',
  'PassThrough.variant.detected': "ComponentProps<typeof X> is not followed: the wrapped component's props are missing",
  'PassThrough.label.detected': "ComponentProps<typeof X> is not followed: the wrapped component's props are missing",
  'QuotedNames.data-id.detected': 'a quoted member name is not a prop in the scan',
  'QuotedNames.aria-label.detected': 'a quoted member name is not a prop in the scan',
  'RestPropsPlain.label.panelSave': 'a no-op save adds `interface Props { label }`, which rejects the attributes `...rest` forwards',
  'TupleProp.range.type': 'a readonly labelled tuple reads as other',
  'TupleProp.range.control': 'a text box for a tuple, which writes a string',
  'TypeAliasWithExtendsTag.extendsTag': "`type Props = HTMLAttributes<'button'> & {\u2026}` does not give the button's attributes",
  'UnknownAnyProps.payload.control': 'an unset `any` prop gets a text box',
  'UnknownAnyProps.thing.control': 'an unset `object` prop gets a text box that writes a string',
};

const ASPECTS = ['detected', 'type', 'options', 'default', 'required', 'doc', 'settings', 'deprecated', 'control', 'edit', 'stable', 'panel', 'panelSave'];

let zoo;
before(async () => {
  zoo = await runZoo({ editsFor: (component, prop) => SPEC[component]?.props[prop]?.edit });
  if (process.env.PROP_ZOO_REPORT) {
    fs.writeFileSync(process.env.PROP_ZOO_REPORT, JSON.stringify(reportRows(zoo), undefined, 2));
  }
});

// One expected value against the actual; anyOf holds plain values only, so no recursion.
const matchesOne = (expected, actual) => (expected === NONE ? actual === undefined : JSON.stringify(expected) === JSON.stringify(actual));
const matches = (expected, actual) =>
  expected !== null && typeof expected === 'object' && 'anyOf' in expected
    ? expected.anyOf.some((value) => matchesOne(value, actual))
    : matchesOne(expected, actual);
const shownOne = (value) => (value === NONE ? 'none' : JSON.stringify(value));
const shown = (value) => (value !== null && typeof value === 'object' && 'anyOf' in value ? value.anyOf.map(shownOne).join(' or ') : shownOne(value));

// Each aspect of one prop as [aspect, expected, actual], only the aspects the spec states.
function propAspects(record, name, spec) {
  const field = record.schema.find((entry) => entry.name === name);
  const out = [['detected', true, field !== undefined]];
  if (field === undefined) {
    return out;
  }
  if (spec.type !== undefined) {
    out.push(['type', spec.type, field.type]);
  }
  if (spec.options !== undefined) {
    out.push(['options', spec.options, field.options]);
  }
  if ('default' in spec) {
    out.push(['default', spec.default, field.default]);
  }
  if (spec.required !== undefined) {
    out.push(['required', spec.required, !field.optional]);
  }
  if (spec.doc !== undefined) {
    out.push(['doc', spec.doc, record.docs.get(name)?.tooltip]);
  }
  const documentation = record.docs.get(name);
  for (const key of ['min', 'max', 'decimals']) {
    if (spec[key] !== undefined) {
      out.push(['settings', `${key} ${spec[key]}`, `${key} ${documentation?.number[key]}`]);
    }
  }
  for (const key of ['onLabel', 'offLabel']) {
    if (spec[key] !== undefined) {
      out.push(['settings', `${key} ${spec[key]}`, `${key} ${documentation?.switch[key]}`]);
    }
  }
  if (spec.deprecated) {
    // Nothing in the schema or the documentation reader carries it yet.
    out.push(['deprecated', true, 'deprecated' in field || 'deprecated' in (documentation ?? {})]);
  }
  out.push(['control', spec.control, record.controls.get(name)]);
  const edit = record.edits.get(name);
  if (edit !== undefined && edit.status !== 'not attempted') {
    out.push(['edit', 'ok', edit.status === 'ok' ? 'ok' : `${edit.status} ${JSON.stringify({ sent: edit.sent, reread: edit.reread, error: edit.error })}`]);
    if (edit.status === 'ok') {
      // The field keeps its control after the edit, or moves to another the spec allows
      // (a binding showing `{null}` becomes a text field once text is set).
      out.push(['stable', edit.control, matches(spec.control, edit.controlAfter) ? edit.control : edit.controlAfter]);
    }
  }
  const property = record.panel?.find((entry) => entry.name === name);
  out.push(['panel', 'listed', property === undefined ? 'missing' : 'listed']);
  const saved = record.panelSave.get(name);
  if (saved !== undefined) {
    // A save that changes nothing either leaves the file alone or says why it cannot.
    out.push(['panelSave', 'unchanged or refused', saved === 'unchanged' || saved.startsWith('refused') ? 'unchanged or refused' : saved]);
  }
  return out;
}

function componentAspects(record, spec) {
  const declared = new Set(Object.keys(spec.props));
  const out = [
    ['slots', spec.slots ?? [], record.scan?.slots ?? []],
    ['hasRest', spec.hasRest ?? false, record.scan?.hasRest ?? false],
    ['extendsTag', spec.extendsTag ?? NONE, record.scan?.extendsTag],
    ['listProps', spec.listProps ?? [], [...record.listProps.keys()]],
  ];
  for (const field of record.schema) {
    if (!declared.has(field.name)) {
      out.push([`${field.name}.phantom`, 'not a prop', `listed as a ${field.type} prop`]);
    }
  }
  return out;
}

function reportRows({ records, crashes }) {
  const rows = [];
  for (const record of records.values()) {
    const spec = SPEC[record.name];
    for (const [name, propSpec] of Object.entries(spec?.props ?? {})) {
      for (const [aspect, expected, actual] of propAspects(record, name, propSpec)) {
        rows.push({ key: `${record.name}.${name}.${aspect}`, expected: shown(expected), actual: JSON.stringify(actual), ok: matches(expected, actual) });
      }
    }
    for (const [aspect, expected, actual] of spec ? componentAspects(record, spec) : []) {
      rows.push({ key: `${record.name}.${aspect}`, expected: shown(expected), actual: JSON.stringify(actual), ok: matches(expected, actual) });
    }
  }
  return { rows, crashes };
}

test('every zoo component has a spec, and every spec a component', () => {
  assert.deepEqual(Object.keys(SPEC).sort(), zooComponentNames());
  for (const key of Object.keys(KNOWN_GAPS)) {
    const [component, prop, aspect] = key.split('.');
    assert.ok(SPEC[component], `${key}: a known gap names a zoo component`);
    const isComponentAspect = ['slots', 'hasRest', 'extendsTag', 'listProps'].includes(prop) && aspect === undefined;
    const isPhantom = aspect === 'phantom';
    assert.ok(isComponentAspect || isPhantom || (SPEC[component].props[prop] && ASPECTS.includes(aspect)), `${key}: a known gap names a stated aspect`);
  }
});

test('no stage of the zoo throws', () => {
  assert.deepEqual(zoo.crashes, []);
  assert.equal(zoo.records.size, zooComponentNames().length, 'every component was read');
});

for (const name of zooComponentNames()) {
  test(name, async (context) => {
    const record = zoo.records.get(name);
    const spec = SPEC[name];
    assert.ok(record, `${name} was read`);
    assert.ok(spec, `${name} has a spec`);
    assert.ok(record.instance, `${name} is used on the index page`);
    const rows = [
      ...componentAspects(record, spec).map(([aspect, expected, actual]) => [`${name}.${aspect}`, expected, actual]),
      ...Object.entries(spec.props).flatMap(([prop, propSpec]) =>
        propAspects(record, prop, propSpec).map(([aspect, expected, actual]) => [`${name}.${prop}.${aspect}`, expected, actual]),
      ),
    ];
    for (const [key, expected, actual] of rows) {
      const gap = KNOWN_GAPS[key];
      const holds = matches(expected, actual);
      if (gap !== undefined) {
        await context.test(key, { todo: holds ? `${gap} (now passes: drop it from KNOWN_GAPS)` : gap }, () => {
          assert.ok(holds, `${key}: expected ${shown(expected)}, got ${JSON.stringify(actual)}`);
        });
      } else {
        await context.test(key, () => {
          assert.ok(holds, `${key}: expected ${shown(expected)}, got ${JSON.stringify(actual)}`);
        });
      }
    }
  });
}
