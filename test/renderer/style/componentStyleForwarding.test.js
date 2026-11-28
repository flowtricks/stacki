// Goal: the Style panel writes a style on a component instance only where it is proven to take effect. A component
// "combines" when it writes its own style and the instance's into one attribute, the instance's last; "passes"
// when the style reaches an element that writes none; "overrides" or "drops" when it would be lost; and anything
// the reading cannot follow is "unproven". A false "combines" or "passes" is the failure that matters: an edit
// that silently does nothing, or replaces the component's own style.
// Method: the pure reading (model/componentStyleForwarding.ts) over small components, one spelling each, accepted
// and rejected, then over every component of the repo's three fixture copies of Lumos, which must agree with
// each other, the ones that write their own style all combining it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'component-style-forwarding.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: "export { styleForwardingOf, instanceStyleRefusal } from './src/features/style/model/componentStyleForwarding';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { styleForwardingOf, instanceStyleRefusal } = require(bundle);

const PROPS = 'const { cols, class: className, style, ...rest } = Astro.props;';
const JOINED = '[cols && `--c: ${cols}`, style].filter(Boolean).join("; ") || undefined';
const file = (frontmatter, template) => `---\n${frontmatter}\n---\n${template}\n`;
const merged = (expression, frontmatter = PROPS) => file(frontmatter, `<div class:list={["a", className]} style={${expression}} {...rest}>x</div>`);

const CASES = {
  combines: {
    'the array, filtered and joined': merged(JOINED),
    'without the undefined fallback, a bare separator': merged('[cols, style].filter(Boolean).join(";")'),
    'a computed list spread into the array': merged('[...list, style].filter(Boolean).join("; ")'),
    'a class naming text-style is not a read of style': file(PROPS, `<div class={\`text-style-\${cols}\`} style={${JOINED}} {...rest} />`),
    'built in the frontmatter': merged('merged', `${PROPS}\nconst merged = ${JOINED};`),
    'under an alias': merged('[cols, own].filter(Boolean).join("; ")', 'const { cols, style: own, ...rest } = Astro.props as Props;'),
    'a template ending in the style': merged('`--c: ${cols}; ${style ?? ""}`'),
    'a template with ||': merged("`--c: 1; ${style || ''};`"),
    'the style alone': merged('style'),
    'the shorthand': file(PROPS, '<div {style} {...rest} />'),
    'a tag chosen by a prop': file("const { tag: Tag = 'h2', style, ...rest } = Astro.props;", `<Tag style={${JOINED}} {...rest} />`),
    'every branch keeps it': file(PROPS, `{cols ? <a style={${JOINED}} {...rest} /> : <div style={style} {...rest} />}`),
    'styles and comments around it': file(PROPS, `<!-- <p style={x}> -->\n<div style={${JOINED}} {...rest} />\n<style>.a { color: red }</style>`),
  },
  passes: {
    'the rest spread on an element with no style': file('const { cols, ...rest } = Astro.props;', '<div class="a" {...rest} />'),
    'all of Astro.props spread': file('', '<div {...Astro.props} />'),
  },
  overrides: {
    'its own style before the spread': file('const { cols, ...rest } = Astro.props;', '<div style={cols} {...rest} />'),
    'its own style after the spread': file('const { cols, ...rest } = Astro.props;', '<div {...rest} style="a: b" />'),
  },
  drops: {
    'no spread at all': file('const { title } = Astro.props;', '<div>{title}</div>'),
    'style named and never written': file(PROPS, '<div {...rest} />'),
  },
  unproven: {
    'the style first, so the component wins': merged('[style, cols].filter(Boolean).join("; ")'),
    'a computed value after the style': merged('[cols, style, "a: b"].filter(Boolean).join("; ")'),
    'not filtered': merged('[cols, style].join("; ")'),
    'filtered by something else': merged('[cols, style].filter(isSet).join("; ")'),
    'joined with a comma': merged('[cols, style].filter(Boolean).join(", ")'),
    'an array not joined': merged('[cols, style]'),
    'a nested array': merged('[[cols, "a: b"], style].filter(Boolean).join("; ")'),
    'the style only in a condition': merged('style ? cols : undefined'),
    'a fallback instead of both': merged('style ?? cols'),
    'a template without a separator': merged('`--c: ${cols} ${style ?? ""}`'),
    'a template with the style first': merged('`${style ?? ""}; --c: ${cols};`'),
    'a template printing undefined': merged('`--c: ${cols}; ${style}`'),
    'an !important of its own': merged('[`gap: 1rem !important`, style].filter(Boolean).join("; ")'),
    'an !important built in the frontmatter': merged('merged', `${PROPS}\nconst merged = ["a: b !important", style].filter(Boolean).join("; ");`),
    'style read in the frontmatter too': merged(JOINED, `${PROPS}\nconst tone = style?.includes("red");`),
    'style assigned again': merged(JOINED, 'let { cols, style, ...rest } = Astro.props;'),
    'style read past the destructure': merged('[Astro.props.style, cols].filter(Boolean).join("; ")', 'const { cols, ...rest } = Astro.props;'),
    'the rest read in the frontmatter': merged(JOINED, `${PROPS}\nconst label = rest.title;`),
    'the rest passed through a call': file(PROPS, `<div style={${JOINED}} {...pick(rest)} />`),
    'another object spread beside it': file(PROPS, `<div style={${JOINED}} {...attrs} {...rest} />`),
    'one branch loses it': file(PROPS, `{cols ? <a style={${JOINED}} {...rest} /> : <div {...rest} />}`),
    'an imported component': file(`import Box from "./Box.astro";\n${PROPS}`, `<Box style={${JOINED}} {...rest} />`),
    'the rest into an imported component': file('import Box from "./Box.astro";\nconst { ...rest } = Astro.props;', '<Box {...rest} />'),
    'the style on an element the rest does not reach': file(PROPS, `<div><span style={${JOINED}} /><input {...rest} /></div>`),
    'the root styled, the rest inside': file('const { ...rest } = Astro.props;', '<div style="a: b"><input {...rest} /></div>'),
    'define:vars writes styles of its own': file(PROPS, `<div style={${JOINED}} {...rest} />\n<style define:vars={{ cols }}></style>`),
    'frontmatter that does not parse': file('const { = ;', '<div />'),
    'a tag the scan cannot read': file(PROPS, '<div {...rest'),
  },
};

for (const [expected, cases] of Object.entries(CASES)) {
  test(`${expected}: each spelling reads as ${expected}`, () => {
    for (const [name, source] of Object.entries(cases)) {
      assert.equal(styleForwardingOf(source), expected, name);
    }
  });
}

test('only a proven reading lets an instance’s style be written; a file not held does not', () => {
  assert.equal(instanceStyleRefusal(undefined), 'unreadable');
  assert.equal(instanceStyleRefusal(merged(JOINED)), undefined);
  assert.equal(instanceStyleRefusal(CASES.passes['all of Astro.props spread']), undefined);
  assert.equal(instanceStyleRefusal(CASES.drops['no spread at all']), 'drops');
  assert.equal(instanceStyleRefusal(CASES.unproven['not filtered']), 'unproven');
});

const COMBINING = [
  'interactive/Marquee',
  'interactive/Slider',
  'media/Overlay',
  'media/Video',
  'typography/Heading',
  'typography/Paragraph',
  'typography/RichText',
  'wrapper/ContentWrapper',
  'wrapper/Grid',
];
const COPIES = ['test/fixtures/lumos/components', 'test/fixtures/lumos-card/components', 'studio/test/fixtures/site/src/components'];

test('every fixture copy of the Lumos components that write their own style combines the instance’s', () => {
  const files = [
    ...COPIES.flatMap((copy) => COMBINING.map((name) => `${copy}/${name}.astro`)),
    'test/fixtures/lumos-card/Heading.astro',
    'test/fixtures/lumos-card/Paragraph.astro',
  ];
  for (const name of files) {
    assert.equal(styleForwardingOf(fs.readFileSync(repoPath(name), 'utf8')), 'combines', name);
  }
});
