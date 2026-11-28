// Goal: the code check judges what the site really runs, in bounded time, and editing goes on whatever it is handed.
// Method: run the real check as a role without code permission. For pages, hold it to the compiler that builds the
// site: a new call is refused wherever that compiler would run it, whatever element surrounds it. For every other
// kind of input, state the rule and try several spellings of it. The calls named here do nothing.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transform } from '@astrojs/compiler-rs';
import { measureSpeedFactor } from '../../test/helpers/scaleFixtures';
import { CodeGuard } from '../src/features/roles/codeGuard';
import { parseAsRun } from '../src/features/roles/codeRuntimeCompiler';
import { assertEditorRequest } from '../src/features/roles/editorRoutes';
import { DEFAULT_PROJECT_ROLES, EDITOR_PARTS, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';

const CLIENT = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');
const PAGE = 'src/pages/index.astro';
const SOURCE = `---\nconst title = 'Hi';\nconst items = ['a'];\n---\n\n<main><h1>{title}</h1>\n<p>text</p></main>\n`;
const ENTRY = 'src/content/blog/post.mdx';
const MDX = `---\ntitle: Post\n---\nimport Chart from '../../components/Chart.astro';\n\n# Title\n\n<Chart size={3} />\n`;

// Every kind of element: ordinary ones, those whose content HTML reads as text, and those it moves or drops.
const ELEMENTS: readonly string[] = [
  'div', 'p', 'a', 'button', 'form', 'select', 'option', 'table', 'tr', 'td', 'colgroup', 'head', 'body', 'html',
  'frameset', 'template', 'svg', 'math', 'textarea', 'title', 'iframe', 'noscript', 'noembed', 'noframes', 'xmp',
  'plaintext', 'listing', 'pre',
]; // prettier-ignore

async function guarded(context: TestContext, reading: 'shortcut' | 'full-only' = 'shortcut') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-code-reading-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const guard = new CodeGuard(root, undefined, reading);
  return {
    page: (after: string, before = SOURCE) => guard.assertAllowed(CLIENT, { file: PAGE, before, after }),
    entry: (added: string) => guard.assertAllowed(CLIENT, { file: ENTRY, before: MDX, after: `${MDX}\n${added}\n` }),
  };
}

const inPage = (markup: string) => SOURCE.replace('<p>text</p>', markup);
const inFrontmatter = (code: string) => SOURCE.replace("const title = 'Hi';", `const title = 'Hi';\n${code}`);
const REFUSED = /cannot add or change code|could not|too large|took too long|compiler/;

function compiles(source: string): string {
  const result = transform(source, { filename: '/page.astro', internalURL: 'astro/compiler-runtime' });
  return result.diagnostics.some((item) => item.severity === 'error') ? '' : result.code;
}

test('a new expression is refused inside every element the site compiler would run it in', async (context) => {
  const { page } = await guarded(context, 'full-only');
  let ran = 0;
  for (const outer of ['', 'select', 'table', 'svg']) {
    for (const inner of ELEMENTS) {
      const held = `<${inner}>{probe()}</${inner}>`;
      const after = inPage(outer === '' ? held : `<${outer}>${held}</${outer}>`);
      // The site's compiler is the judge of what runs: a call it leaves as words is words.
      if (compiles(after).includes('${probe()}')) {
        ran++;
        await assert.rejects(page(after), REFUSED, after);
      }
    }
  }
  assert.ok(ran > ELEMENTS.length, `${ran} places ran the expression`);
});

test('the check reads a page exactly as it is written', async (context) => {
  const { page } = await guarded(context);
  // The loop settings’ file size sort is accepted as one parsed expression. Whatever a field is called, the page around
  // it is judged as written: this one is broken as written.
  const sort = "(globalThis.process?.getBuiltinModule?.('node:fs')?.statSync(items['*/ ) /*']?.fsPath ?? '', { throwIfNoEntry: false })?.size ?? 0)";
  await assert.rejects(page(inFrontmatter(`/* ${sort} */`)), REFUSED);
});

test('markup that could become script is code however it is written', async (context) => {
  const { page } = await guarded(context);
  const refused: readonly string[] = [
    '<div is:raw><b>bold</b></div>',
    '<svg><a><animate attributeName="href" values="javascript:probe()" /></a></svg>',
    '<svg><a><set attributeName="href" to="javascript:probe()" /></a></svg>',
    '<img src="/a.png" {...{ title: items }} />',
    "<div {'a b'}></div>",
    '<div set:html={title}></div>',
    '<Fragment set:html=\'<img alt=">" onerror="probe()">\' />',
  ];
  for (const markup of refused) {
    await assert.rejects(page(inPage(markup)), REFUSED, markup);
  }
  await assert.rejects(page(inFrontmatter("const link = 'javascript:probe()';")), REFUSED);
  await assert.rejects(page(inFrontmatter("const word = String<number>('x');")), REFUSED);
  await page(inFrontmatter("const book = 'JavaScript: the basics';"));
  await page(inPage('<p title="JavaScript: the basics">{title}</p>'));
  await page(inPage('<textarea>words</textarea><svg><title>words</title></svg>'));
});

test('a tag that is a value is code, and so is a change to its value', async (context) => {
  const { page } = await guarded(context);
  for (const declaration of ["const Tag = 'b';", "const { Tag } = { Tag: 'b' };", 'const Tag = title;']) {
    await assert.rejects(page(inFrontmatter(declaration).replace('<p>text</p>', '<Tag>words</Tag>')), REFUSED, declaration);
  }
  await assert.rejects(page(inPage("{['b'].map((Tag) => (<Tag>words</Tag>))}")), REFUSED);
  const developer = inFrontmatter("const Tag = 'b';").replace('<p>text</p>', '<Tag>words</Tag>');
  await page(developer.replace('words', 'more words'), developer);
  // Typed one character at a time, so the shortcut for typing is asked.
  await assert.rejects(page(developer.replace("'b'", "'bs'"), developer), REFUSED);
});

test('MDX code is found however it is spaced, wrapped or hidden', async (context) => {
  const { entry } = await guarded(context);
  const refused: readonly string[] = [
    'export\tconst value = probe();',
    "export const value = String<number>('x');",
    "{String<number>('x')}",
    "export default 'section'",
    "export const components = { p: 'section' };",
    "export const Tag = 'section';\n\n<Tag>words</Tag>",
    '[a link](javascript:probe())',
    '[a link]: javascript:probe()',
    "<Fragment set:html=\"<img alt='>' onerror='probe()'>\" />",
    // What only looks like a tag, a quote or a code span to a quick reading hides nothing.
    '<http://example.test/ a="{probe()}">',
    '<http://example.test/\nexport const value = probe();',
    'one ` two\n`{` {probe()} `}`',
  ];
  for (const text of refused) {
    await assert.rejects(entry(text), REFUSED, text);
  }
  await entry('JavaScript: the basics. A [link](https://example.test/) and <Chart size={4} />.');
});

test('hostile text is judged in seconds, whatever repeats in it', { timeout: 60_000 }, async (context) => {
  const { entry } = await guarded(context);
  const many = 200_000;
  const started = Date.now();
  for (const text of [`{"${'\\"'.repeat(many)}`, `{${'/* '.repeat(many)}}`, `](${' '.repeat(many)}x`]) {
    await entry(text).catch(() => undefined);
  }
  const role = { ...CLIENT, editorOff: new Set(EDITOR_PARTS.slice(0, 1)) };
  const styles = '<style>'.repeat(40_000);
  assert.throws(() => assertEditorRequest(role, '/studio/api/source', JSON.stringify({ file: PAGE, base: styles, source: `${styles}x` })));
  const elapsedMs = Date.now() - started;
  const boundMs = 20_000 * measureSpeedFactor();
  assert.ok(elapsedMs < boundMs, `${elapsedMs} ms, bound ${Math.round(boundMs)} ms`);
});

test('an input that ends the site compiler is refused, and the next page is read', async () => {
  const deep = `<p>{${'('.repeat(60_000)}1${')'.repeat(60_000)}}</p>`;
  await assert.rejects(parseAsRun(deep), /site compiler/);
  assert.equal((await parseAsRun(SOURCE)).errors, 0);
});

test('an empty expression is no code and no failure', async (context) => {
  const { page } = await guarded(context);
  await page(inPage('<p>{}</p><p>{ /* note */ }</p>'));
});
