// Goal: the new-style-tag template (shared/properties/newStyleTag.ts) places rules the way the
// documented rules say, reads and writes `.stacki/styles.json` backward-compatibly, and refuses
// every shape it must not hold.
// Method: tables of templates with the wrapper chain and skeleton each must give (placeholder at
// top level, in a layer, nested, absent with a trailing wrapper, absent with a rule block, empty),
// the negative space (unbalanced, repeated placeholder, placeholder inside a rule), then the file
// parser and serializer: a legacy file reads as scoped with no template, a section round-trips,
// and bad sections throw with their reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_NEW_STYLE_TAG,
  NEW_PROJECT_NEW_STYLE_TAG,
  NEW_STYLE_TAG_RULES_TOKEN,
  newStyleTagPreview,
  parseNewStyleTag,
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

test('a file without the section reads as the legacy behaviour; new projects are global', () => {
  assert.equal(parseStyleKeepList({ version: 1, keep: [] }).newStyleTag, undefined);
  assert.deepEqual(LEGACY_NEW_STYLE_TAG, { scope: 'scoped', content: '' });
  assert.deepEqual(NEW_PROJECT_NEW_STYLE_TAG, { scope: 'global', content: '' });
  assert.deepEqual(parseNewStyleTag({}), LEGACY_NEW_STYLE_TAG);
  assert.deepEqual(parseNewStyleTag({ isGlobal: true }), NEW_PROJECT_NEW_STYLE_TAG);
});

test('the section round-trips through the serializer and a legacy file stays byte-identical', () => {
  const legacy = serializeStyleKeepList(parseStyleKeepList({ version: 1, keep: ['a'] }));
  assert.equal(legacy, '{\n  "version": 1,\n  "keep": [\n    "a"\n  ]\n}\n');
  const content = `@layer components {\n  ${NEW_STYLE_TAG_RULES_TOKEN}\n}`;
  const written = serializeStyleKeepList({ version: 1, keep: [], lockedStylesheets: [], newStyleTag: { scope: 'global', content } });
  const reread = parseStyleKeepList(JSON.parse(written));
  assert.deepEqual(reread.newStyleTag, { scope: 'global', content });
  const bare = serializeStyleKeepList({ version: 1, keep: [], lockedStylesheets: [], newStyleTag: NEW_PROJECT_NEW_STYLE_TAG });
  assert.ok(bare.includes('"isGlobal": true'));
  assert.ok(!bare.includes('"content"'));
});

test('bad sections are refused', () => {
  const bad = (section: unknown) => () => parseStyleKeepList({ version: 1, keep: [], newStyleTag: section });
  assert.throws(bad('x'), /Expected object/);
  assert.throws(bad({ version: 2 }), /version/);
  assert.throws(bad({ isGlobal: 'yes' }), /isGlobal/);
  assert.throws(bad({ content: 7 }), /Expected string/);
  assert.throws(bad({ content: '@layer a {' }), /unclosed/);
  assert.throws(bad({ content: `${NEW_STYLE_TAG_RULES_TOKEN}${NEW_STYLE_TAG_RULES_TOKEN}` }), /more than once/);
});

test('the preview shows the opening tag the setting makes and the template', () => {
  assert.equal(newStyleTagPreview({ scope: 'global', content: '' }), '<style is:global>\n  /* rules */\n</style>');
  assert.equal(newStyleTagPreview({ scope: 'scoped', content: '@layer a {}' }), '<style>\n@layer a {}\n</style>');
});
