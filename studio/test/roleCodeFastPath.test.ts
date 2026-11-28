// Goal: the shortcut for typing (codeInert.ts) never gives a verdict the full check would not. Wherever it answers,
// the full reading of both versions must find the same code, and a change it must not answer goes to the full check.
// Method: take pages full of the places where a page's reading turns (expressions, raw text, scripts, comments,
// unquoted and repeated attributes, a line that could become a frontmatter fence, quotes inside markup inside
// expressions) and, at every position, apply each of a set of hostile insertions and deletions. For every edit the
// shortcut answers, compare with the compiler's full syntax tree: same code units, same frontmatter (or, for a
// frontmatter edit, the very statements the shortcut hands to the judge), no new error, and, for a style edit, the
// same page outside its style blocks. Then run the whole check with and without the shortcut on named hostile edits.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeGuard } from '../src/features/roles/codeGuard';
import { InertEdits } from '../src/features/roles/codeInert';
import { markupBesideStyles, readPageCode } from '../src/features/roles/codeMarkup';
import { DEFAULT_PROJECT_ROLES, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';

const PAGES: readonly string[] = [
  `---\nconst a = 'one';\n// x\n---\n<L>\n<p title="t u" data-n=2 lang='en'>Hi - there</p>\n{a && <b>it's {a} ok</b>}\n<a href="/x" onclick="y">go</a>\n</L>\n`,
  `<div class="c">text</div>\n<script>let s = 'q';</script>\n<style>\n.a { color: red; }\n</style>\n<p>tail</p>\n`,
  `---\nimport C from './C.astro';\n---\n<C label="v" set:html="w" {...r} n={1} />\n<textarea>word</textarea><!-- note -->\n<div is:raw>raw</div><table> t </table>\n{list.map((i) => (<li title="li">row {i}</li>))}\n<svg><title>s</title></svg><title>d</title>\n`,
  `<p>-</p>\n<p>a b</p>\n<img alt="p &quot;q&quot;" src="/i.png">\n<iframe srcdoc="x"></iframe><meta content="m"><form action="/f"></form>\n`,
];

const INSERTS: readonly string[] = [
  'a',
  ' ',
  'on',
  '=',
  '"',
  "'",
  '-',
  '--',
  '---\n',
  '\n---\n',
  '/',
  '//',
  '/*',
  '*/',
  '>',
  '<',
  '<i ',
  '{',
  '}',
  '`',
  '\\',
  '&',
  ';',
  ':',
  '!',
  '?',
  '#',
  '$',
  '(',
  ')',
  '\n',
  ' onclick=x ',
  '" onclick="x',
  "' onload='x",
  'script',
  'javascript:',
  'set:html=x ',
  '| process.env',
];
const REMOVALS: readonly number[] = [1, 2, 3, 7];

interface Edit {
  readonly before: string;
  readonly after: string;
}

function* edits(page: string): Generator<Edit> {
  for (let at = 0; at <= page.length; at++) {
    for (const insert of INSERTS) {
      yield { before: page, after: page.slice(0, at) + insert + page.slice(at) };
    }
    for (const length of REMOVALS) {
      if (at + length <= page.length) {
        yield { before: page, after: page.slice(0, at) + page.slice(at + length) };
      }
    }
    yield { before: page, after: `${page.slice(0, at)}z${page.slice(at + 1)}` };
  }
}

async function codeOf(source: string) {
  const page = await readPageCode(source);
  return { keys: page.units.map((unit) => unit.key), frontmatter: page.frontmatter, errors: page.errors };
}

for (const [index, page] of PAGES.entries()) {
  test(`every shortcut answer on page ${index} matches the full reading`, async () => {
    const inert = new InertEdits();
    const counts = { markup: 0, style: 0, frontmatter: 0, total: 0 };
    let full = await codeOf(page);
    for (const edit of edits(page)) {
      if (edit.after === edit.before) {
        continue;
      }
      counts.total++;
      const answer = await inert.read(edit.before, edit.after);
      if (answer === undefined) {
        continue;
      }
      counts[answer.kind]++;
      const next = await codeOf(edit.after);
      const shown = `${answer.kind}: ${JSON.stringify(edit.after)}`;
      assert.deepEqual(next.keys, full.keys, shown);
      assert.ok(next.errors <= full.errors, shown);
      if (answer.kind === 'frontmatter') {
        assert.equal(answer.before.trim(), full.frontmatter.trim(), shown);
        assert.equal(answer.after.trim(), next.frontmatter.trim(), shown);
      } else {
        assert.equal(next.frontmatter, full.frontmatter, shown);
      }
      if (answer.kind === 'style') {
        assert.equal(await markupBesideStyles(edit.after), await markupBesideStyles(edit.before), shown);
      }
      full = await codeOf(page);
    }
    // The comparison means something only if the shortcut answers a good share of these.
    assert.ok(counts.markup > 100, JSON.stringify(counts));
  });
}

const CLIENT = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');

async function guards(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-code-fast-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { quick: new CodeGuard(root), full: new CodeGuard(root, undefined, 'full-only') };
}

const verdict = (guard: CodeGuard, before: string, after: string) =>
  guard.assertAllowed(CLIENT, { file: 'src/pages/index.astro', before, after }).then(
    () => 'allowed',
    () => 'refused',
  );

test('with and without the shortcut the check gives one verdict', async (context) => {
  const { quick, full } = await guards(context);
  const page = `---\nconst a = 'one';\nconst b = make('two');\n---\n<main>\n<p title="t">Hello</p>\n<a href="/x">go</a>\n{a && <b>yes</b>}\n<p data-x=y>z</p>\n<style>\n.a { color: red; }\n</style>\n</main>\n`;
  const changes: readonly (readonly [string, string])[] = [
    ['Hello', 'Hello there, "friend" - it\'s (fine)!'],
    ['title="t"', 'title="t and more"'],
    ['title="t"', 'title="t" onclick="x()"'],
    ['href="/x"', 'href="javascript:x()"'],
    ['href="/x"', 'href="/y"'],
    ['data-x=y', 'data-x=y onload=z'],
    ["const a = 'one';", "const a = 'one two';"],
    ["const a = 'one';", "const a = 'one' + process.env.X;"],
    ["const a = 'one';", "const a = 'one';\nconst c = process;"],
    ["make('two')", "make('three')"],
    ['<b>yes</b>', '<b>yes indeed</b>'],
    ['a && ', 'process && '],
    ['color: red', 'color: blue'],
    ['color: red; }', 'color: red; }\n</style><script>x()</script><style>'],
    ['<main>', '<main>{process.env.X}'],
    ['<p title', '<script>x()</script><p title'],
  ];
  for (const [from, to] of changes) {
    const after = page.replace(from, to);
    assert.notEqual(after, page, from);
    assert.equal(await verdict(quick, page, after), await verdict(full, page, after), `${from} -> ${to}`);
  }
});

test('a long burst of typing stays on the shortcut and the next new code is still refused', async (context) => {
  const { quick } = await guards(context);
  let source = '---\n---\n<main>\n<p>Start</p>\n</main>\n';
  const typed = ' and then some more words, "quoted" & (listed): done.'.repeat(4);
  for (const character of typed) {
    const after = source.replace('</p>', `${character}</p>`);
    assert.equal(await verdict(quick, source, after), 'allowed');
    source = after;
  }
  assert.equal(await verdict(quick, source, source.replace('</p>', '{process.env.X}</p>')), 'refused');
});

test('the compiler keeps working through many readings of a large page', async () => {
  // Without being started afresh it ran out of memory within a few dozen readings of a page this size.
  const body = Array.from({ length: 600 }, (_, i) => `<section class="s${i}"><h2>Title ${i}</h2>{items.map((item) => (<a href={item.url}>x</a>))}</section>`);
  const source = `---\nconst items = [];\n---\n${body.join('\n')}\n`;
  for (let reading = 0; reading < 40; reading++) {
    const page = await readPageCode(`${source}<p>${reading}</p>\n`);
    assert.equal(page.units.length, 1_200);
  }
});
