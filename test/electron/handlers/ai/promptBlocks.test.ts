// Goal: a message with mentions becomes the right ACP blocks, and nothing the person
// did not mean to share leaves the project. A file chip embeds its text when it fits
// and is linked (and marked truncated) when it does not; a skill chip is a leading
// slash command only where the protocol allows one; a built-in chip wraps its text;
// every bound refuses cleanly instead of growing.
// Methodology: the pure builder from dist/ against a temporary project and a fake
// home, with the reader injected, so each rule is one small case and every refusal
// (outside the project, a link out of it, too many chips, too many parts) is a value.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildPrompt, type PromptSource } from '#dist/electron/handlers/ai/promptBlocks.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import type { PromptPart } from '#dist/shared/properties/ai/mentions.js';

interface SetupOverrides {
  readonly read?: PromptSource['read'];
  readonly embeddedContext?: boolean;
}

// A block's field, read without trusting its shape: the blocks are plain objects built by the module under test.
function field(block: unknown, name: string): unknown {
  return typeof block === 'object' && block !== null ? Object.entries(block).find(([key]) => key === name)?.[1] : undefined;
}

function setup(overrides: SetupOverrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prompt-project-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prompt-home-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.astro'), '<h1>Hello</h1>\n');
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'seo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'seo', 'SKILL.md'), '---\nname: seo\n---\n');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'voice', 'SKILL.md'), '---\nname: voice\n---\n');
  const source: PromptSource = {
    root,
    home,
    agent: 'claude',
    embeddedContext: true,
    commands: new Set(['seo']),
    read: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
    ...overrides,
  };
  return { root, home, source };
}

function built(source: PromptSource, text: string, parts: readonly PromptPart[] | undefined) {
  const result = buildPrompt(source, { text, attachments: [], parts });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
}

test('without parts the message is its text; an empty one has no blocks', () => {
  const { source } = setup();
  assert.deepEqual(built(source, 'hello', undefined), { blocks: [{ type: 'text', text: 'hello' }], sent: undefined });
  assert.deepEqual(built(source, '   ', undefined).blocks, []);
});

test('a file chip is read into the text and embedded once, however often it is named', () => {
  const { root, source } = setup();
  const result = built(source, 'x', [
    { kind: 'text', text: 'Fix ' },
    { kind: 'file', path: 'src/index.astro' },
    { kind: 'text', text: ' and again ' },
    { kind: 'file', path: 'src/index.astro' },
  ]);
  const uri = pathToFileURL(path.join(root, 'src', 'index.astro')).href;
  assert.deepEqual(result.blocks, [
    { type: 'text', text: 'Fix @src/index.astro and again @src/index.astro' },
    { type: 'resource', resource: { uri, mimeType: 'text/plain', text: '<h1>Hello</h1>\n' } },
  ]);
  assert.deepEqual(
    result.sent?.map((part) => part.kind),
    ['text', 'file', 'text', 'file'],
  );
  assert.deepEqual(result.sent?.[1], { kind: 'file', path: 'src/index.astro', truncated: false, excerpt: '<h1>Hello</h1>\n' });
});

test('a file that is too big, too much in all, binary, or for an agent without embedded context travels as a link, marked truncated', () => {
  const big = 'x'.repeat(AI_LIMITS.mentionFileCharsMax + 1);
  const cases: { readonly label: string; readonly source: SetupOverrides; readonly expectExcerpt: boolean }[] = [
    { label: 'past the file bound', source: { read: () => big }, expectExcerpt: true },
    {
      label: 'binary',
      source: {
        read: () => {
          throw new Error('not text');
        },
      },
      expectExcerpt: false,
    },
    { label: 'no embedded context', source: { embeddedContext: false }, expectExcerpt: true },
  ];
  for (const entry of cases) {
    const { source } = setup(entry.source);
    const result = built(source, 'x', [{ kind: 'file', path: 'src/index.astro' }]);
    assert.equal(result.blocks.length, 2, entry.label);
    assert.equal(field(result.blocks[1], 'type'), 'resource_link', entry.label);
    const part = result.sent?.[0];
    assert.ok(part?.kind === 'file' && part.truncated, entry.label);
    assert.equal(part.excerpt !== undefined, entry.expectExcerpt, entry.label);
    if (part.excerpt !== undefined) {
      assert.ok(part.excerpt.length <= AI_LIMITS.mentionPreviewCharsMax, 'the excerpt is bounded');
    }
  }
  // Each file fits, all together do not: the first is embedded, the one that would pass the total is linked.
  const { source } = setup({ read: () => 'y'.repeat(AI_LIMITS.mentionFileCharsMax) });
  const root = source.root;
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    fs.writeFileSync(path.join(root, `${name}.txt`), name);
  }
  const parts = ['a', 'b', 'c', 'd', 'e'].map((name): PromptPart => ({ kind: 'file', path: `${name}.txt` }));
  const result = built(source, 'x', parts);
  const types = result.blocks.slice(1).map((block) => field(block, 'type'));
  assert.deepEqual(types, ['resource', 'resource', 'resource', 'resource', 'resource_link'], 'four fit within the total, the fifth is linked');
});

test('a file that does not exist is only named', () => {
  const { source } = setup();
  const result = built(source, 'x', [{ kind: 'file', path: 'src/gone.astro' }]);
  assert.deepEqual(result.blocks, [{ type: 'text', text: '@src/gone.astro' }]);
  assert.deepEqual(result.sent, [{ kind: 'file', path: 'src/gone.astro', truncated: false, excerpt: undefined }]);
});

test('a path outside the project is refused, including a link that leaves it', () => {
  const { root, source } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prompt-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  for (const bad of ['../secret.txt', '/etc/hosts', 'src/../../x', 'link/secret.txt', 'C:/Windows/win.ini', 'a\\b']) {
    const result = buildPrompt(source, { text: 'x', attachments: [], parts: [{ kind: 'file', path: bad }] });
    assert.ok(!result.ok, bad);
    assert.equal(result.error.code, 'invalid', bad);
  }
});

test('more than the allowed chips or parts is refused', () => {
  const { source } = setup();
  const chips: PromptPart[] = Array.from({ length: AI_LIMITS.mentionsMax + 1 }, () => ({ kind: 'file', path: 'src/index.astro' }));
  const tooMany = buildPrompt(source, { text: 'x', attachments: [], parts: chips });
  assert.ok(!tooMany.ok);
  assert.equal(tooMany.error.code, 'invalid');
  const atLimit = buildPrompt(source, { text: 'x', attachments: [], parts: chips.slice(0, AI_LIMITS.mentionsMax) });
  assert.ok(atLimit.ok, 'exactly the limit passes');
  const parts: PromptPart[] = Array.from({ length: AI_LIMITS.promptPartsMax + 1 }, () => ({ kind: 'text', text: 'a' }));
  const tooLong = buildPrompt(source, { text: 'x', attachments: [], parts });
  assert.ok(!tooLong.ok);
});

test('a skill leading a Claude message is the slash command; anywhere else it is asked for in words with a link', () => {
  const { root, home, source } = setup();
  const skill: PromptPart = { kind: 'skill', name: 'seo', source: 'project', path: '.claude/skills/seo/SKILL.md' };
  const leading = built(source, 'x', [skill, { kind: 'text', text: 'audit the home page' }]);
  assert.deepEqual(leading.blocks, [{ type: 'text', text: '/seo audit the home page' }]);
  assert.deepEqual(leading.sent?.[0], { kind: 'skill', name: 'seo', source: 'project', path: '.claude/skills/seo/SKILL.md' });
  const middle = built(source, 'x', [{ kind: 'text', text: 'Please' }, skill]);
  assert.deepEqual(middle.blocks, [
    { type: 'text', text: 'Please Use the `seo` skill. ' },
    { type: 'resource_link', name: 'SKILL.md', uri: pathToFileURL(path.join(root, '.claude', 'skills', 'seo', 'SKILL.md')).href },
  ]);
  const unknown = built(source, 'x', [{ kind: 'skill', name: 'voice', source: 'user', path: '~/.claude/skills/voice/SKILL.md' }]);
  assert.equal(field(unknown.blocks[0], 'text'), 'Use the `voice` skill. ', 'not an advertised command: words, even first');
  assert.deepEqual(unknown.blocks[1], {
    type: 'resource_link',
    name: 'SKILL.md',
    uri: pathToFileURL(path.join(home, '.claude', 'skills', 'voice', 'SKILL.md')).href,
  });
  const codex = built({ ...source, agent: 'codex' }, 'x', [skill]);
  assert.equal(field(codex.blocks[0], 'text'), 'Use the `seo` skill. ', 'Codex gets the words, never a slash command');
});

test('a skill link is given only where its source says: never an escaping or misnamed path', () => {
  const { source } = setup();
  const attempts: PromptPart[] = [
    { kind: 'skill', name: 'seo', source: 'project', path: '.claude/skills/seo/NOTES.md' },
    { kind: 'skill', name: 'seo', source: 'user', path: '.claude/skills/voice/SKILL.md' },
    { kind: 'skill', name: 'seo', source: 'user', path: '~/../x/SKILL.md' },
  ];
  for (const attempt of attempts) {
    const result = buildPrompt({ ...source, agent: 'codex' }, { text: 'x', attachments: [], parts: [attempt] });
    assert.ok(result.ok);
    assert.equal(result.value.blocks.length, 1, `no link for ${attempt.kind === 'skill' ? attempt.path : ''}`);
  }
});

test('a built-in chip is a block of its own, wrapped, and the transcript keeps only a hash', () => {
  const { source } = setup();
  const result = built(source, 'x', [
    { kind: 'builtin', id: 'app-builder', text: 'Build it like so.' },
    { kind: 'text', text: 'A pricing page' },
  ]);
  assert.deepEqual(result.blocks, [
    { type: 'text', text: '<app-builder-instructions>\nBuild it like so.\n</app-builder-instructions>' },
    { type: 'text', text: 'A pricing page' },
  ]);
  const part = result.sent?.[0];
  assert.ok(part?.kind === 'builtin');
  assert.match(part.textHash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(result.sent).includes('Build it like so.'), 'the instructions themselves are not stored');
});

test('attachments follow the parts: an image inline, a project file as a link, one outside the project dropped', () => {
  const { root, source } = setup();
  const result = buildPrompt(source, {
    text: 'x',
    parts: [{ kind: 'text', text: 'look' }],
    attachments: [
      { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'AAAA' },
      { kind: 'file', path: 'src/index.astro' },
      { kind: 'file', path: '../etc' },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.blocks, [
    { type: 'text', text: 'look' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    { type: 'resource_link', name: 'index.astro', uri: pathToFileURL(path.join(root, 'src', 'index.astro')).href },
  ]);
});
