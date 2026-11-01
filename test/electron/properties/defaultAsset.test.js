// Goal: an image default written as an expression still names the file it
// imports, so the props panel can show its thumbnail.
// Method: write components into a temporary project and read their schemas
// through safeSchema, covering the import itself, `.src`, one local alias, and
// the defaults that must not resolve: non-media imports, missing files, files
// outside the project, deeper alias chains and plain literals.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeSchema } = require('#dist/electron/properties/propDefaults.js');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-default-asset-'));
  fs.mkdirSync(path.join(root, 'src/assets/images'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/assets/images/portrait.webp'), '');
  fs.writeFileSync(path.join(root, 'src/assets/data.json'), '{}');
  return root;
}

function sourceField(root, frontmatter, fallback) {
  const file = path.join(root, 'src/components/Feature.astro');
  fs.writeFileSync(file, `---\n${frontmatter}\ninterface Props { src?: string }\nconst { src = ${fallback} } = Astro.props;\n---\n<img src={src} />\n`);
  const field = safeSchema(file, root).schema.find((candidate) => candidate.name === 'src');
  assert.ok(field, 'src field is read');
  return field;
}

test('expression defaults name the image they import', () => {
  const root = project();
  const relative = "import portrait from '../assets/images/portrait.webp';";
  assert.equal(sourceField(root, relative, 'portrait').defaultAsset, 'src/assets/images/portrait.webp');
  assert.equal(sourceField(root, relative, 'portrait.src').defaultAsset, 'src/assets/images/portrait.webp');
  const alias = `${relative}\nconst PORTRAIT = portrait.src;`;
  const field = sourceField(root, alias, 'PORTRAIT');
  assert.equal(field.defaultAsset, 'src/assets/images/portrait.webp');
  // The default is still the expression: only the preview learns the path.
  assert.equal(field.defaultExpr, true);
  assert.equal(field.default, 'PORTRAIT');
});

test('defaults that do not import a project image stay unresolved', () => {
  const root = project();
  assert.equal(sourceField(root, "import data from '../assets/data.json';", 'data').defaultAsset, undefined);
  assert.equal(sourceField(root, "import gone from '../assets/images/gone.webp';", 'gone').defaultAsset, undefined);
  const outside = path.join(os.tmpdir(), `stacki-outside-${process.pid}.webp`);
  fs.writeFileSync(outside, '');
  assert.equal(sourceField(root, `import away from '${path.relative(path.join(root, 'src/components'), outside)}';`, 'away').defaultAsset, undefined);
  const chain = "import portrait from '../assets/images/portrait.webp';\nconst A = portrait;\nconst B = A;";
  assert.equal(sourceField(root, chain, 'B').defaultAsset, undefined);
  assert.equal(sourceField(root, '', '"/hero.png"').defaultAsset, undefined);
  assert.equal(sourceField(root, "import portrait from '../assets/images/portrait.webp';", 'portrait.width').defaultAsset, undefined);
});
