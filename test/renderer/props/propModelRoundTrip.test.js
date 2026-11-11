// Goal: a prop the bind-dot "New property" form writes (src/editor/propDeclaration.ts)
// reads back through the prop model, the one reader every panel derives from,
// with the same kind, tooltip, default, options, number range and precision,
// and switch labels — and the renderer's own doc reader (propDocumentation.ts)
// agrees with the model on every tag. This is the pair assertion across
// writer and reader that AGENTS.md §9 asks for: the form wrote `@decimals`
// for months while the schema reader ignored it, and nothing noticed.
//
// Method: a seeded generator (fast-check is not a dependency; a small PRNG
// keeps every run the same) makes components of one to four props of each
// kind the form offers for these fields, writes each prop through
// declaredProp into a growing frontmatter, then reads the file with
// readPropModel and its schema projection and compares prop by prop. Invalid
// settings are the generator's to avoid; every generated declaration must be
// accepted by the writer.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const declaration = load('src/editor/propDeclaration.ts');
const documentation = load('src/editor/propDocumentation.ts');
const { readPropModel } = require('#dist/electron/parse/propModel/readPropModel.js');
const { schemaFieldsOf } = require('#dist/shared/properties/propModelSchema.js');

const COMPONENTS = 200;
const WORDS = ['Card', 'count', 'shown', 'in', 'the', 'badge', 'Hero', 'title', 'Wide', 'layout', 'colour', 'of', 'text'];
const OPTIONS = ['primary', 'secondary', 'ghost', 'small', 'large', 'left', 'right', 'centre'];

// mulberry32: a 32-bit seeded PRNG, so a failure is reproducible from its seed.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed) {
  const next = prng(seed);
  const int = (low, high) => low + Math.floor(next() * (high - low + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  const maybe = () => next() < 0.5;
  const words = () => (maybe() ? '' : Array.from({ length: int(1, 5) }, () => pick(WORDS)).join(' '));
  const distinct = (list, count) => {
    const pool = [...list];
    const out = [];
    for (let index = 0; index < count; index++) {
      out.push(pool.splice(int(0, pool.length - 1), 1)[0]);
    }
    return out;
  };
  return { int, pick, maybe, words, distinct, next };
}

const BLANK = {
  tooltip: '',
  defaultText: '',
  options: [],
  number: { min: undefined, max: undefined, decimals: undefined },
  attributes: [],
  tag: '',
  list: { fields: [], items: [] },
  image: '',
};

// One declaration of a random kind, with settings the form would accept.
function randomDeclaration(random, key) {
  const kind = random.pick(['string', 'number', 'boolean', 'option']);
  const base = { ...BLANK, key, kind, tooltip: random.words() };
  switch (kind) {
    case 'string':
      return { ...base, defaultText: random.maybe() ? '' : random.pick(WORDS) };
    case 'number': {
      const decimals = random.maybe() ? undefined : random.int(0, 3);
      const min = random.maybe() ? undefined : random.int(-5, 5);
      const max = random.maybe() ? undefined : (min ?? 0) + random.int(0, 20);
      const low = min ?? 0;
      const fits = max === undefined || max >= low;
      const value = fits ? low : undefined;
      return { ...base, number: { min, max, decimals }, defaultText: value === undefined || random.maybe() ? '' : String(value) };
    }
    case 'boolean': {
      return { ...base, defaultText: random.pick(['', 'true', 'false']) };
    }
    case 'option': {
      const options = random.distinct(OPTIONS, random.int(2, 4));
      return { ...base, options, defaultText: random.maybe() ? '' : random.pick(options) };
    }
    default:
      throw new Error(`no such kind ${kind}`);
  }
}

const KIND_CONTROLS = { string: 'text', number: 'number', boolean: 'switch', option: 'choice' };

function expectedDefault(written) {
  if (written.defaultText === '') {
    return undefined;
  }
  if (written.kind === 'number') {
    return Number(written.defaultText);
  }
  if (written.kind === 'boolean') {
    return written.defaultText === 'true';
  }
  return written.defaultText;
}

test('every prop the New property form writes reads back the same through the prop model', () => {
  let props = 0;
  for (let seed = 1; seed <= COMPONENTS; seed++) {
    const random = generator(seed);
    let frontmatter = random.maybe() ? '' : 'const other = 1;\n';
    const written = [];
    for (let index = 0, count = random.int(1, 4); index < count; index++) {
      const declared = randomDeclaration(random, `prop${index}`);
      const out = declaration.declaredProp(frontmatter, declared, new Set(['other']));
      assert.ok(out.ok, `seed ${seed}: the writer accepts ${JSON.stringify(declared)}: ${out.error}`);
      frontmatter = out.value.frontmatter;
      written.push(declared);
    }
    const model = readPropModel(`---\n${frontmatter}---\n<div />\n`);
    const fields = schemaFieldsOf(model);
    const where = (declared) => `seed ${seed}, ${declared.key} (${declared.kind}) in\n${frontmatter}`;
    assert.deepEqual(
      model.props.map((prop) => prop.name),
      written.map((declared) => declared.key),
      `seed ${seed}: the props, in order`,
    );
    for (const declared of written) {
      props++;
      const prop = model.props.find((entry) => entry.name === declared.key);
      const field = fields.find((entry) => entry.name === declared.key);
      assert.equal(prop.control.kind, KIND_CONTROLS[declared.kind], where(declared));
      assert.equal(prop.presence, 'optional', where(declared));
      assert.equal(prop.declared, true, where(declared));
      assert.equal(prop.tooltip, declared.tooltip, where(declared));
      assert.equal(field.default, expectedDefault(declared), where(declared));
      // The renderer reads the same doc to the same settings (one tag vocabulary).
      const renderer = documentation.readPropDocumentation(prop.documentation);
      assert.equal(renderer.tooltip, prop.tooltip, where(declared));
      if (declared.kind === 'number') {
        const { min, max, decimals } = declared.number;
        assert.deepEqual([prop.control.min, prop.control.max, prop.control.decimals], [min, max, decimals], where(declared));
        assert.deepEqual(renderer.number, { min, max, decimals }, where(declared));
        // `@decimals` is the instance field's step: 0 is whole numbers, 2 is hundredths.
        assert.equal(field.step, decimals === undefined ? undefined : Number((10 ** -decimals).toFixed(decimals)), where(declared));
      }
      if (declared.kind === 'boolean') {
        assert.deepEqual(prop.control, { kind: 'switch' }, where(declared));
        assert.doesNotMatch(prop.documentation ?? '', /@onLabel|@offLabel/, where(declared));
      }
      if (declared.kind === 'option') {
        assert.deepEqual(
          prop.control.options.map((option) => option.value),
          declared.options,
          where(declared),
        );
        assert.deepEqual(field.options, declared.options, where(declared));
      }
    }
    // Reading is a pure function of the text: the same file reads to the same model.
    assert.deepEqual(readPropModel(`---\n${frontmatter}---\n<div />\n`), model, `seed ${seed}: reading is deterministic`);
  }
  assert.ok(props >= COMPONENTS, `${props} props were written and read`);
});
