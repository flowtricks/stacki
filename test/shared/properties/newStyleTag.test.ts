// Goal: the new-style-tag template (shared/properties/newStyleTag.ts) places rules the way the
// documented rules say, reads and writes `.stacki/styles.json` backward-compatibly, and refuses
// every shape it must not hold.
// Method: tables of templates with the wrapper chain and skeleton each must give (placeholder at
// top level, in a layer, nested, absent with a trailing wrapper, absent with a rule block, empty),
// the negative space (unbalanced, repeated placeholder, placeholder inside a rule), then the file
// parser and serializer: an absent section means `is:global` with no template, a version 1 section
// keeps its choice and is written back as version 2, a section round-trips, and bad sections throw
// with their reason. Last, the attribute parser: every shape an opening tag may hold, and the ones
// it may not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_NEW_STYLE_TAG,
  NEW_STYLE_TAG_RULES_TOKEN,
  newStyleTagOpening,
  parseNewStyleTag,
  parseStyleTagAttributes,
  styleTagAttributesText,
  styleTagScopeOf,
  templateFrame,
} from '#dist/shared/properties/newStyleTag.js';
import { parseStyleKeepList, serializeStyleKeepList } from '#dist/shared/properties/styleKeepList.js';

const frameOf = (content: string) => {
  const result = templateFrame(content);
  assert.ok(result.ok, content);
  return result.frame;
};

test('an empty template and a plain top-level template put rules at the top level', () => {
  assert.deepEqual(frameOf('').wrappers, []);
  assert.deepEqual(frameOf(':root { --a: 1; }').wrappers, [], 'a rule block is never a wrapper');
  assert.deepEqual(frameOf('@layer base, components;').wrappers, [], 'a statement is not a block');
});

test('a trailing block at-rule without a placeholder takes rules inside it', () => {
  assert.deepEqual(frameOf('@layer components {}').wrappers, [{ name: 'layer', params: 'components' }]);
  assert.deepEqual(frameOf('@layer   components  {\n}\n').wrappers, [{ name: 'layer', params: 'components' }]);
  assert.deepEqual(frameOf('@media (min-width: 40em) {}').wrappers, [{ name: 'media', params: '(min-width: 40em)' }]);
  assert.deepEqual(frameOf('@font-face { font-family: x; }').wrappers, [], 'not a rule container');
  assert.deepEqual(frameOf('@layer a {}\n:root { }').wrappers, [], 'only the last construct counts');
});

test('the placeholder names the wrapper chain and leaves the skeleton without it', () => {
  const layered = frameOf(`@layer components {\n  ${NEW_STYLE_TAG_RULES_TOKEN}\n}\n`);
  assert.deepEqual(layered.wrappers, [{ name: 'layer', params: 'components' }]);
  assert.equal(layered.skeleton, '@layer components {\n}\n');
  const nested = frameOf(`@layer a { @media (x) { ${NEW_STYLE_TAG_RULES_TOKEN} } }`);
  assert.deepEqual(nested.wrappers, [
    { name: 'layer', params: 'a' },
    { name: 'media', params: '(x)' },
  ]);
  const top = frameOf(`@layer a, b;\n${NEW_STYLE_TAG_RULES_TOKEN}\n`);
  assert.deepEqual(top.wrappers, []);
  assert.equal(top.skeleton, '@layer a, b;\n');
});

test('invalid templates are refused with a code', () => {
  const refusal = (content: string) => {
    const result = templateFrame(content);
    return result.ok ? undefined : result.error.code;
  };
  assert.equal(refusal('@layer a {'), 'unbalanced');
  assert.equal(refusal('}'), 'unbalanced');
  assert.equal(refusal('/* open'), 'unbalanced');
  assert.equal(refusal('a { content: "x }'), 'unbalanced');
  assert.equal(refusal(`${NEW_STYLE_TAG_RULES_TOKEN}\n${NEW_STYLE_TAG_RULES_TOKEN}`), 'repeated-placeholder');
  assert.equal(refusal(`:root { ${NEW_STYLE_TAG_RULES_TOKEN} }`), 'placeholder-in-rule');
  assert.equal(refusal('/* an ordinary comment */ @layer a {}'), undefined);
});

const GLOBAL = { name: 'is:global', value: undefined };

test('an absent section or key means is:global; a version 1 choice is kept', () => {
  assert.equal(parseStyleKeepList({ version: 1, keep: [] }).newStyleTag, undefined);
  assert.deepEqual(DEFAULT_NEW_STYLE_TAG, { attributes: [GLOBAL], content: '' });
  assert.deepEqual(parseNewStyleTag({}), DEFAULT_NEW_STYLE_TAG);
  assert.deepEqual(parseNewStyleTag({ version: 2 }), DEFAULT_NEW_STYLE_TAG);
  assert.deepEqual(parseNewStyleTag({ isGlobal: true }), DEFAULT_NEW_STYLE_TAG);
  assert.deepEqual(parseNewStyleTag({ version: 1, isGlobal: false, content: '@layer a {}' }), { attributes: [], content: '@layer a {}' });
  assert.deepEqual(parseNewStyleTag({ version: 2, attributes: '' }), { attributes: [], content: '' }, 'an explicit plain <style> is kept');
  assert.equal(styleTagScopeOf(DEFAULT_NEW_STYLE_TAG.attributes), 'global');
  assert.equal(styleTagScopeOf([]), 'scoped');
});

test('the section round-trips as version 2, and a version 1 section moves to version 2 on its next save', () => {
  const legacy = serializeStyleKeepList(parseStyleKeepList({ version: 1, keep: ['a'] }));
  assert.equal(legacy, '{\n  "version": 1,\n  "keep": [\n    "a"\n  ]\n}\n', 'a file without the section stays byte-identical');
  const content = `@layer components {\n  ${NEW_STYLE_TAG_RULES_TOKEN}\n}`;
  const attributes = [GLOBAL, { name: 'lang', value: 'scss' }];
  const written = serializeStyleKeepList({ version: 1, keep: [], lockedStylesheets: [], newStyleTag: { attributes, content } });
  assert.ok(written.includes('"attributes": "is:global lang=\\"scss\\""'), written);
  assert.deepEqual(parseStyleKeepList(JSON.parse(written)).newStyleTag, { attributes, content });
  const migrated = serializeStyleKeepList(parseStyleKeepList({ version: 1, keep: [], newStyleTag: { version: 1, isGlobal: false } }));
  assert.ok(migrated.includes('"newStyleTag": {\n    "version": 2,\n    "attributes": ""\n  }'), migrated);
  const bare = serializeStyleKeepList({ version: 1, keep: [], lockedStylesheets: [], newStyleTag: DEFAULT_NEW_STYLE_TAG });
  assert.ok(bare.includes('"newStyleTag": {\n    "version": 2,\n    "attributes": "is:global"\n  }'), bare);
});

test('bad sections are refused', () => {
  const bad = (section: unknown) => () => parseStyleKeepList({ version: 1, keep: [], newStyleTag: section });
  assert.throws(bad('x'), /Expected object/);
  assert.throws(bad({ version: 3 }), /version/);
  assert.throws(bad({ isGlobal: 'yes' }), /isGlobal/);
  assert.throws(bad({ version: 2, attributes: 7 }), /Expected string/);
  assert.throws(bad({ version: 2, attributes: 'lang={x}' }), /expressions/);
  assert.throws(bad({ content: 7 }), /Expected string/);
  assert.throws(bad({ content: '@layer a {' }), /unclosed/);
  assert.throws(bad({ content: `${NEW_STYLE_TAG_RULES_TOKEN}${NEW_STYLE_TAG_RULES_TOKEN}` }), /more than once/);
});

test('attributes: what an opening tag may hold, and what it may not', () => {
  const ok = (text: string) => {
    const result = parseStyleTagAttributes(text);
    assert.ok(result.ok, text);
    return result.attributes;
  };
  assert.deepEqual(ok(''), []);
  assert.deepEqual(ok('  is:global  '), [GLOBAL]);
  assert.deepEqual(ok('is:global lang="scss" media=\'print\''), [GLOBAL, { name: 'lang', value: 'scss' }, { name: 'media', value: 'print' }]);
  assert.deepEqual(ok('data-x=""'), [{ name: 'data-x', value: '' }]);
  assert.deepEqual(ok('\n  is:inline\n'), [{ name: 'is:inline', value: undefined }]);
  const refused = (text: string) => {
    const result = parseStyleTagAttributes(text);
    return result.ok ? undefined : result.error.code;
  };
  assert.equal(refused('lang=scss'), 'syntax', 'an unquoted value');
  assert.equal(refused('lang="scss'), 'syntax', 'an unclosed quote');
  assert.equal(refused('lang="a"media="b"'), 'syntax', 'two attributes with no space');
  assert.equal(refused('9lang'), 'syntax');
  assert.equal(refused('is:global/'), 'syntax');
  assert.equal(refused('is:global is:global'), 'duplicate');
  assert.equal(refused('{...props}'), 'expression');
  assert.equal(refused('define:vars={{ a }}'), 'expression');
  assert.equal(styleTagAttributesText([GLOBAL, { name: 'lang', value: 'scss' }]), ' is:global lang="scss"');
  assert.equal(styleTagAttributesText([{ name: 'title', value: 'say "hi"' }]), ` title='say "hi"'`, 'a value holding " is quoted with \'');
  assert.equal(newStyleTagOpening([]), '<style>');
  assert.equal(newStyleTagOpening(DEFAULT_NEW_STYLE_TAG.attributes), '<style is:global>');
});
