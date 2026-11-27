// Goal: a component mention reaches the agent as its compact reference and nothing else. The
// serialization is pinned string for string: a component is its project-relative path, a member
// is `prop:<name>`, `prop:<name>=<value>` or `slot:<name>`, a member right after its component is
// written alone and anywhere else carries the path first, and no type, description, schema or file
// text is ever added. The negative space: names and values with spaces, quotes, `=`, unicode and
// control characters stay one unambiguous token; drafts and parsers refuse a member that names no
// project-relative component, a slot with a value, or a path that leaves the project.
// Methodology: drafts built by hand go through `promptPartsOf` and `plainTextOf` and the result is
// compared with the exact expected string; each known-bad chip shape goes through `parseMentionChip`
// and `parseDraftSegments` one at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chipPlainText,
  memberReference,
  parseDraftSegments,
  parseMentionChip,
  plainTextOf,
  promptPartsOf,
  referenceToken,
  type ComposerSegments,
  type MentionChip,
} from '#dist/shared/properties/ai/mentions.js';

const HERO = 'src/components/Hero.astro';
const hero: MentionChip = { kind: 'component', path: HERO, name: 'Hero' };
const prop = (name: string, value?: string, component = HERO): MentionChip => ({ kind: 'member', component, role: 'prop', name, value });
const slot = (name: string, component = HERO): MentionChip => ({ kind: 'member', component, role: 'slot', name, value: undefined });
const chip = (value: MentionChip) => ({ kind: 'chip', chip: value }) as const;
const text = (value: string) => ({ kind: 'text', text: value }) as const;
const noBuiltin = (): string => {
  throw new Error('no built-in chip in these drafts');
};

/** A value as storage gives it back: through JSON, and untyped until a parser accepts it. */
function roundTrip(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

/** The words the agent reads for a draft of component mentions: text and reference parts joined, equal to the plain text. */
function sent(segments: ComposerSegments): string {
  const parts = promptPartsOf(segments, noBuiltin);
  const words = parts.map((part) => {
    assert.ok(part.kind === 'text' || part.kind === 'reference', 'a component mention is words, never an expanded part');
    return part.text;
  });
  assert.equal(plainTextOf(segments), words.join(''), 'the plain-text fallback says exactly the same');
  return words.join('');
}

test('the exact serialization: a path, then bare members, and nothing else', () => {
  assert.equal(sent([chip(hero)]), 'src/components/Hero.astro');
  assert.equal(sent([chip(hero), text(' '), chip(prop('variant', 'large'))]), 'src/components/Hero.astro prop:variant=large');
  assert.equal(
    sent([
      text('Make '),
      chip(hero),
      text(' '),
      chip(prop('variant', 'large')),
      text(' '),
      chip(prop('title')),
      text(' '),
      chip(slot('header')),
      text(' bigger'),
    ]),
    'Make src/components/Hero.astro prop:variant=large prop:title slot:header bigger',
  );
  // A member typed straight after its component, with no space, still reads as two tokens.
  assert.equal(sent([chip(hero), chip(prop('variant', 'large'))]), 'src/components/Hero.astro prop:variant=large');
});

test('a member away from its component carries the component path, so it is never ambiguous', () => {
  const card = 'src/ui/Card.astro';
  assert.equal(sent([chip(prop('variant', 'large'))]), 'src/components/Hero.astro prop:variant=large');
  assert.equal(sent([chip(hero), text(' and then '), chip(prop('title'))]), 'src/components/Hero.astro and then src/components/Hero.astro prop:title');
  assert.equal(
    sent([chip(hero), text(' '), chip({ kind: 'component', path: card, name: 'Card' }), text(' '), chip(prop('title'))]),
    'src/components/Hero.astro src/ui/Card.astro src/components/Hero.astro prop:title',
    'a member after another component names its own',
  );
  assert.equal(sent([chip(hero), text(' '), chip(prop('tone', 'dark', card))]), 'src/components/Hero.astro src/ui/Card.astro prop:tone=dark');
});

test('nothing beyond the reference: no type, description, schema, name label or file text', () => {
  const output = sent([chip(hero), text(' '), chip(prop('variant', 'large'))]);
  for (const extra of ['Hero ', 'string', 'type', 'description', 'schema', '{', '<', '@', '\n']) {
    assert.ok(!output.includes(extra), `the reference holds no ${JSON.stringify(extra)}`);
  }
  assert.equal(output.split(' ').length, 2, 'exactly two tokens');
});

test('awkward names and values stay one token: spaces, quotes, equals, unicode, control characters', () => {
  assert.equal(referenceToken('large'), 'large');
  assert.equal(referenceToken('größe'), 'größe', 'unicode is kept as is');
  assert.equal(referenceToken('日本語'), '日本語');
  assert.equal(referenceToken('Read more'), '"Read more"');
  assert.equal(referenceToken('say "hi"'), '"say \\"hi\\""');
  assert.equal(referenceToken('a=b'), '"a=b"');
  assert.equal(referenceToken(''), '""');
  assert.equal(referenceToken('tab\there'), '"tab\\there"');
  assert.equal(referenceToken('line\nbreak'), '"line\\nbreak"');
  assert.equal(memberReference({ kind: 'member', component: HERO, role: 'prop', name: 'label', value: 'Read more' }), 'prop:label="Read more"');
  assert.equal(memberReference({ kind: 'member', component: HERO, role: 'prop', name: 'data label', value: undefined }), 'prop:"data label"');
  assert.equal(memberReference({ kind: 'member', component: HERO, role: 'slot', name: 'en-tête', value: undefined }), 'slot:en-tête');
  assert.equal(
    sent([chip({ kind: 'component', path: 'src/components/My Hero.astro', name: 'My Hero' })]),
    '"src/components/My Hero.astro"',
    'a path with a space is one quoted token',
  );
  // Every quoted token reads back as the text it stands for.
  for (const value of ['Read more', 'say "hi"', 'a=b', '', 'tab\there']) {
    assert.equal(JSON.parse(referenceToken(value)), value);
  }
});

test('the context-free form a chip has alone is the full reference', () => {
  assert.equal(chipPlainText(hero), 'src/components/Hero.astro');
  assert.equal(chipPlainText(prop('variant', 'large')), 'src/components/Hero.astro prop:variant=large');
  assert.equal(chipPlainText(slot('header')), 'src/components/Hero.astro slot:header');
});

test('component and member chips parse, and survive storage as a draft', () => {
  for (const value of [hero, prop('variant', 'large'), prop('title'), slot('header')]) {
    assert.deepEqual(parseMentionChip(roundTrip(value)), value);
  }
  const draft: ComposerSegments = [chip(hero), text(' '), chip(prop('variant', 'large'))];
  const stored = parseDraftSegments(roundTrip(draft));
  assert.ok(stored.ok);
  assert.deepEqual(stored.value, draft);
});

test('each bad component or member shape is refused at the boundary', () => {
  const bad: readonly [string, unknown][] = [
    ['a path that leaves the project', { kind: 'component', path: '../Hero.astro', name: 'Hero' }],
    ['an absolute path', { kind: 'component', path: '/src/components/Hero.astro', name: 'Hero' }],
    ['a backslash path', { kind: 'component', path: 'src\\components\\Hero.astro', name: 'Hero' }],
    ['an empty name', { kind: 'component', path: HERO, name: '' }],
    ['a member of no component', { kind: 'member', role: 'prop', name: 'title' }],
    ['a member of a path outside', { kind: 'member', component: '../x.astro', role: 'prop', name: 'title' }],
    ['an unknown role', { kind: 'member', component: HERO, role: 'variant', name: 'title' }],
    ['a slot with a value', { kind: 'member', component: HERO, role: 'slot', name: 'header', value: 'x' }],
    ['a value that is not text', { kind: 'member', component: HERO, role: 'prop', name: 'size', value: 3 }],
    ['an empty member name', { kind: 'member', component: HERO, role: 'prop', name: '' }],
    ['an over-long name', { kind: 'member', component: HERO, role: 'prop', name: 'x'.repeat(4_001) }],
  ];
  for (const [what, value] of bad) {
    assert.throws(() => parseMentionChip(value), Error, what);
    assert.equal(parseDraftSegments([{ kind: 'chip', chip: value }]).ok, false, `a stored draft with ${what} reads as empty`);
  }
});

test('an element, its attributes and its text: the locator and the bare names, text always quoted', () => {
  const element: MentionChip = { kind: 'element', path: 'src/pages/index.astro', locator: '0.2', tag: 'a' };
  const owner = 'src/pages/index.astro#0.2';
  const attr: MentionChip = { kind: 'member', component: owner, role: 'attr', name: 'class', value: 'cta wide' };
  const words: MentionChip = { kind: 'member', component: owner, role: 'text', name: 'text', value: 'Go' };
  assert.equal(sent([chip(element), text(' '), chip(attr), text(' '), chip(words)]), 'src/pages/index.astro#0.2 attr:class="cta wide" text="Go"');
  assert.equal(sent([chip(attr)]), 'src/pages/index.astro#0.2 attr:class="cta wide"', 'away from its element it names the element');
  for (const value of [element, attr, words]) {
    assert.deepEqual(parseMentionChip(roundTrip(value)), value);
  }
  for (const bad of [
    { kind: 'element', path: 'src/pages/index.astro', locator: '0.x', tag: 'a' },
    { kind: 'element', path: '../index.astro', locator: '0', tag: 'a' },
    { kind: 'element', path: 'src/pages/index.astro', locator: '0', tag: '<a>' },
    { kind: 'member', component: owner, role: 'text', name: 'label', value: 'Go' },
    { kind: 'member', component: owner, role: 'text', name: 'text' },
  ]) {
    assert.throws(() => parseMentionChip(bad));
  }
});

test('CSS variables, classes and assets: the reference only, and each bad shape refused', () => {
  const variable: MentionChip = { kind: 'css', target: 'variable', name: '--brand-1', path: 'src/styles/global.css' };
  const className: MentionChip = { kind: 'css', target: 'class', name: 'hero-title', path: undefined };
  const asset: MentionChip = { kind: 'asset', assetKind: 'image', path: 'public/images/hero.png' };
  assert.equal(sent([chip(variable)]), 'css:var(--brand-1) (src/styles/global.css)');
  assert.equal(sent([chip(className)]), 'css:.hero-title');
  assert.equal(sent([chip(asset)]), 'asset:public/images/hero.png', 'the path, never the bytes');
  for (const value of [variable, className, asset]) {
    assert.deepEqual(parseMentionChip(roundTrip(value)), value);
  }
  for (const bad of [
    { kind: 'css', target: 'variable', name: 'brand' },
    { kind: 'css', target: 'class', name: '.hero' },
    { kind: 'css', target: 'class', name: 'a b' },
    { kind: 'css', target: 'mixin', name: 'x' },
    { kind: 'css', target: 'variable', name: '--a', path: '../global.css' },
    { kind: 'asset', assetKind: 'image', path: 'public/notes.txt' },
    { kind: 'asset', assetKind: 'video', path: 'public/hero.png' },
    { kind: 'asset', assetKind: 'image', path: '/etc/hero.png' },
    { kind: 'asset', assetKind: 'audio', path: 'public/a.mp3' },
  ]) {
    assert.throws(() => parseMentionChip(bad));
  }
});
