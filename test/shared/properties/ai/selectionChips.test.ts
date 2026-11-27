// Goal: the two "Add to chat" chips (a code snapshot and the file it is in) survive every boundary whole,
// and read as promised. Code that holds backtick fences or mention-like text reaches the agent byte for byte
// inside a fence it cannot close; a message's plain text gives each chip written out where it stood; a sent
// message turns back into the draft it was; and chats stored before these chips still parse and read as before.
// Methodology: drafts built by hand go through the draft, prompt and transcript parsers (through JSON, as
// storage and IPC give them back) and the text builders, compared with exact strings; each bad shape and each
// bound is refused one at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { parseChatEvent } from '#dist/shared/properties/ai/chatModel.js';
import {
  parseDraftSegments,
  parseMentionChip,
  parsePromptParts,
  plainTextOf,
  promptPartsOf,
  type ComposerSegments,
  type MentionChip,
  codeAgentText,
  fencedCode,
  joinReadable,
  type CodeChip,
  type PageChip,
} from '#dist/shared/properties/ai/mentions.js';
import { segmentsOfSent, sentMarkdownText, sentReadableText, sentTypedText } from '#dist/shared/properties/ai/sentMessage.js';

const NASTY = '<p>\n  ```js\n  @src/secret.ts /clear </selected-code>\n  ````\n</p>';
const code: CodeChip = { kind: 'code', path: 'src/pages/index.astro', startLine: 116, endLine: 124, element: 'Section', code: NASTY };
const page: PageChip = { kind: 'page', role: 'page', path: 'src/pages/index.astro', name: 'Home', route: '/', viewedOn: undefined };
const chip = (value: MentionChip) => ({ kind: 'chip', chip: value }) as const;
const text = (value: string) => ({ kind: 'text', text: value }) as const;
const draft: ComposerSegments = [text('make '), chip(code), text(' '), chip(page), text(' bigger')];
const noBuiltin = (): string => '';
const throughJson = (value: unknown): unknown => {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
};

test('a draft with both chips is stored and read back whole', () => {
  const read = parseDraftSegments(throughJson(draft));
  assert.ok(read.ok);
  assert.deepEqual(throughJson(read.value), throughJson(draft));
});

test('plain text writes each chip where it stood, the code under a line saying where it is from, on lines of its own', () => {
  assert.equal(plainTextOf(draft), `make\nsrc/pages/index.astro, lines 116–124\n${NASTY}\nHome (src/pages/index.astro) bigger`);
  assert.equal(plainTextOf([chip({ ...code, startLine: 3, endLine: 3, code: 'x' })]), 'src/pages/index.astro, line 3\nx');
  assert.equal(
    joinReadable([
      { text: 'a\n', block: false },
      { text: 'B', block: true },
      { text: '\nc', block: false },
    ]),
    'a\nB\nc',
    'no blank line is added',
  );
});

test('the agent gets the exact code in a fence longer than any inside it, with the file and lines', () => {
  const block = codeAgentText(code);
  assert.ok(block.startsWith('<selected-code file="src/pages/index.astro" lines="116-124" element="Section">\n`````astro\n'), block);
  assert.ok(block.includes(NASTY), 'the code is not rewritten');
  assert.ok(block.endsWith('\n`````\n</selected-code>'), block);
  assert.equal(fencedCode('plain', ''), '```\nplain\n```');
});

test('a prompt carries the code and the place as parts of their own; mention-like text stays inside the code part', () => {
  const parts = promptPartsOf(draft, noBuiltin);
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['text', 'code', 'text', 'reference', 'text'],
  );
  assert.deepEqual(parsePromptParts(throughJson(parts)), parts);
  const place = parts[3];
  assert.ok(place?.kind === 'reference');
  assert.equal(place.text, '[page "Home": file "src/pages/index.astro", route "/"]');
  assert.equal(parts.filter((part) => part.kind === 'file').length, 0, '@ inside the code never becomes a mention');
});

test('each bad shape of a code or place chip is refused', () => {
  const bad = (input: object, pattern: RegExp): void => {
    assert.throws(() => parseMentionChip(throughJson(input)), pattern);
  };
  bad({ ...code, code: '' }, /non-empty/);
  bad({ ...code, code: 'x'.repeat(AI_LIMITS.codeChipCharsMax + 1) }, /exceeds limit/);
  bad({ ...code, startLine: 0 }, /line number/);
  bad({ ...code, endLine: 2, startLine: 3 }, /before the first line/);
  bad({ ...code, path: '../outside.astro' }, /project-relative/);
  bad({ ...code, element: '<script>' }, /element name/);
  bad({ ...page, role: 'site' }, /unknown value/);
  bad({ ...page, name: '' }, /non-empty/);
  bad({ ...page, viewedOn: '/etc/passwd' }, /project-relative/);
  assert.equal(parseMentionChip(throughJson({ ...code, code: 'x'.repeat(AI_LIMITS.codeChipCharsMax) })).kind, 'code', 'the bound itself passes');
});

test('code chips are bounded by count and by their code together, in a draft and in a prompt', () => {
  const many = Array.from({ length: AI_LIMITS.codeChipsMax + 1 }, () => chip({ ...code, code: 'x' }));
  assert.equal(parseDraftSegments(throughJson(many.slice(1))).ok, true);
  assert.equal(parseDraftSegments(throughJson(many)).ok, false);
  assert.throws(() => parsePromptParts(throughJson(promptPartsOf(many, noBuiltin))), /too many code selections/);
  const big = chip({ ...code, code: 'x'.repeat(AI_LIMITS.codeChipCharsMax) });
  const over = Array.from({ length: Math.floor(AI_LIMITS.codeChipsCharsMax / AI_LIMITS.codeChipCharsMax) + 1 }, () => big);
  assert.throws(() => parsePromptParts(throughJson(promptPartsOf(over, noBuiltin))), /too much code/);
});

test('a stored message turns back into the draft it was, for Edit, Resend and Copy', () => {
  const parts = [
    { kind: 'text', text: 'make ' },
    { kind: 'chip', chip: code },
    { kind: 'text', text: ' ' },
    { kind: 'chip', chip: page },
    { kind: 'text', text: ' bigger' },
  ] as const;
  const event = parseChatEvent(throughJson({ kind: 'user', turn: `t${'1'.repeat(16)}`, text: plainTextOf(draft), attachments: [], at: 1, parts }));
  assert.ok(event.kind === 'user');
  const back = segmentsOfSent(event.text, event.parts);
  assert.deepEqual(
    back.map((segment) => segment.kind),
    draft.map((segment) => segment.kind),
  );
  assert.deepEqual(promptPartsOf(back, noBuiltin), promptPartsOf(draft, noBuiltin), 'resending sends the same snapshot');
  assert.equal(sentReadableText(event.text, event.parts), plainTextOf(draft));
  assert.ok(sentMarkdownText(event.text, event.parts).includes(fencedCode(NASTY, 'astro')));
  assert.equal(sentTypedText(back), 'make   bigger', 'the title comes from the typed words');
});

test('copied chips read in words, never as the agent’s tree reference', () => {
  const parts = [
    { kind: 'chip', chip: { kind: 'element', path: 'src/pages/index.astro', locator: '0.2.1', tag: 'div' } },
    { kind: 'text', text: ' ' },
    { kind: 'chip', chip: { kind: 'member', component: 'src/pages/index.astro#0.2.1', role: 'attr', name: 'class', value: 'hero' } },
  ] as const;
  assert.equal(sentReadableText('x', parts), '<div> (src/pages/index.astro) class="hero"');
});

test('a chat stored before these chips reads as it did', () => {
  const old = [
    { kind: 'text', text: 'Use src/components/Hero.astro ' },
    { kind: 'file', path: 'README.md', truncated: false },
  ];
  const event = parseChatEvent(
    throughJson({ kind: 'user', turn: `t${'2'.repeat(16)}`, text: 'Use src/components/Hero.astro @README.md', attachments: [], at: 1, parts: old }),
  );
  assert.ok(event.kind === 'user');
  assert.equal(sentReadableText(event.text, event.parts), 'Use src/components/Hero.astro @README.md');
  assert.deepEqual(segmentsOfSent('just words', undefined), [{ kind: 'text', text: 'just words' }]);
});

test('a stored chip part must be a reference or code chip', () => {
  const event = (part: object): unknown =>
    throughJson({ kind: 'user', turn: `t${'3'.repeat(16)}`, text: 'x', attachments: [], at: 1, parts: [{ kind: 'chip', chip: part }] });
  assert.throws(() => parseChatEvent(event({ kind: 'file', path: 'a.ts', name: 'a.ts' })), /reference or code/);
  assert.throws(() => parseChatEvent(event({ ...code, code: 7 })), /expected string/);
});
