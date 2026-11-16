// Goal: pre-flight catches the edits that would break a page, and only those. Each error class is
// produced by a real parse of a generated file and checked with its severity and remedy; only the
// findings an edit ADDS count, so a page that was already odd never blocks an edit elsewhere; a
// gesture's policy refuses new errors while typed code is advised and never blocked; every planner
// operation declares its checks (the registry, read from the operation union like the instant-
// edits table); the repository's corpus of real-world fixtures produces no error at all (the
// false-positive budget, zero); and a large page is checked inside the 50 ms real-time budget.
// Set STACKI_PREFLIGHT_CORPUS to a folder of Astro sites to sweep them too, read-only.
// Method: the real Astro parser from dist and the pure pre-flight, no I/O but reading fixtures.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { PREFLIGHT_CHECKS, PREFLIGHT_CODES, addedFindings, preflightFile, preflightVerdict, type PreflightFile } from '#dist/shared/engine/preflight.js';
import { preflightRefusalText } from '#dist/shared/ipc/preflightMessages.js';
import { ENGLISH_TRANSLATE } from '#dist/shared/properties/i18n/englishTranslator.js';
import { resolvedImport } from '#dist/electron/documents/documentPreflight.js';

const ROOT = new URL('../../../', import.meta.url);
const ALL = PREFLIGHT_CODES;

function file(source: string, filePath = '/site/src/pages/index.astro'): PreflightFile {
  const parsed = parsePageResult(parsePage(source, {}));
  assert.equal(parsed.editable, true, 'The fixture parses');
  if (!parsed.editable) {
    throw new Error('unreachable');
  }
  return { path: filePath, model: parsed.model };
}

const codes = (source: string, filePath?: string): readonly string[] =>
  preflightFile(file(source, filePath), ALL).map((finding) => `${finding.severity}:${finding.code}:${finding.subject}`);

test('an undefined name in markup is an error to explain', () => {
  const findings = preflightFile(file('---\nconst title = "Hi";\n---\n<h1>{titel}</h1>\n'), ALL);
  assert.deepEqual(findings, [{ code: 'undefined-name', severity: 'error', subject: 'titel', remedy: { kind: 'explain' } }]);
});

test('a component without an import is an error with the add-import fix', () => {
  const findings = preflightFile(file('<main><StatWrap /></main>\n'), ALL);
  assert.deepEqual(findings, [{ code: 'missing-component', severity: 'error', subject: 'StatWrap', remedy: { kind: 'one-click', fix: 'add-import' } }]);
});

test('a default import of a named-only module is an error with an automatic fix', () => {
  const findings = preflightFile(
    file("---\nimport getCollection from 'astro:content';\nconst posts = await getCollection('blog');\n---\n<p>{posts.length}</p>\n"),
    ALL,
  );
  assert.deepEqual(findings, [{ code: 'default-from-module', severity: 'error', subject: 'getCollection', remedy: { kind: 'auto-fix', fix: 'named-import' } }]);
  assert.deepEqual(
    codes("---\nimport { getCollection } from 'astro:content';\nconst posts = await getCollection('blog');\n---\n<p>{posts.length}</p>\n"),
    [],
    'The named form is fine',
  );
});

test('a component imported by name from its file is a warning; a helper exported from one is fine', () => {
  assert.deepEqual(codes("---\nimport { Card } from './Card.astro';\n---\n<Card />\n"), ['warning:named-from-astro:Card']);
  assert.deepEqual(codes("---\nimport { getSinglePage } from '../lib/contentParser.astro';\nconst pages = getSinglePage();\n---\n<p>{pages}</p>\n"), []);
});

test('a name bound twice is an error with the rename fix', () => {
  assert.deepEqual(codes("---\nimport Button from './Button.astro';\nconst Button = 1;\n---\n<p>{Button}</p>\n"), ['error:duplicate-name:Button']);
  assert.deepEqual(codes("---\nimport A from './A.astro';\nimport A from './B.astro';\n---\n<A />\n"), ['error:duplicate-name:A']);
});

test('Astro.props in a page without getStaticPaths is a warning; with it, nothing', () => {
  assert.deepEqual(codes('---\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n'), ['warning:props-in-page:Astro.props']);
  assert.deepEqual(codes('---\nexport function getStaticPaths() { return []; }\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n'), []);
  assert.deepEqual(codes('---\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n', '/site/src/components/Card.astro'), [], 'A component reads its props');
});

test('a relative import of a missing file is an error, with Vite-style resolution', () => {
  const exists = (target: string): boolean => target === '/site/src/components/Card.astro' || target === '/site/src/lib/format.ts';
  assert.equal(resolvedImport('/site/src/pages/index.astro', '../components/Card.astro', exists), 'exists');
  assert.equal(resolvedImport('/site/src/pages/index.astro', '../lib/format', exists), 'exists');
  assert.equal(resolvedImport('/site/src/pages/index.astro', '../lib/format.js', exists), 'exists', 'A .js import of a .ts file');
  assert.equal(resolvedImport('/site/src/pages/index.astro', '../components/Gone.astro', exists), 'missing');
  assert.equal(resolvedImport('/site/src/pages/index.astro', 'astro:content', exists), 'unknown');
  const findings = preflightFile(file("---\nimport Gone from '../components/Gone.astro';\n---\n<Gone />\n"), ALL, (from, spec) =>
    resolvedImport(from, spec, exists),
  );
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ['missing-file'],
  );
});

test('the negative space: valid markup is never flagged', () => {
  const valid = `---
import Card from '../components/Card.astro';
import * as Icons from '../icons';
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
const Heading = 'h2';
function label(post) { return post.data.title; }
const { a = 1, b: [c] = [2] } = { a: 3 };
---
<Heading>{label(posts[0])}</Heading>
<Icons.Arrow />
{posts.map((post, index) => <Card title={post.data.title} index={index} />)}
{posts.map(({ data }) => (<p>{data.title}</p>))}
{posts.length > 0 && <p>{new Intl.NumberFormat('en').format(posts.length)}</p>}
<p class:list={['a', { b: c > a }]} set:html={JSON.stringify(Astro.url)}>{Math.max(1, 2)}</p>
<Fragment set:html="<b>x</b>" />
<p>{/* a comment */}</p>
<script>const local = document.querySelector('p'); console.log(local);</script>
`;
  assert.deepEqual(codes(valid), []);
});

test('only what an edit adds counts: a page that was already odd never blocks an edit', () => {
  const before = file('<main>{missing}</main>\n');
  const after = file('<main>{missing}<p>new</p></main>\n');
  assert.deepEqual(addedFindings(preflightFile(before, ALL), preflightFile(after, ALL)), []);
  const worse = file('<main>{missing}{missing}<p>{other}</p></main>\n');
  assert.deepEqual(
    addedFindings(preflightFile(before, ALL), preflightFile(worse, ALL)).map((finding) => finding.subject),
    ['other'],
  );
});

test('a gesture is refused for a new error, typed code is advised and goes ahead', () => {
  const before = file('<main></main>\n');
  const after = file('<main><StatWrap /></main>\n');
  const refused = preflightVerdict('insert-node', { before, after });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(
      preflightRefusalText(refused.error.findings, ENGLISH_TRANSLATE),
      'Stacki didn’t make this change because it would break the page: the StatWrap component isn’t imported in this file.',
    );
  }
  const typed = preflightVerdict('apply-code-patch', { before, after });
  assert.equal(typed.ok, true, 'Typing is never blocked');
  if (typed.ok) {
    assert.deepEqual(
      typed.value.map((finding) => finding.code),
      ['missing-component'],
    );
  }
  assert.deepEqual(preflightVerdict('insert-node', { before, after: file('<main><p>ok</p></main>\n') }), { ok: true, value: [] });
});

test('the owner scenario: a stat_wrap pasted bare is refused, pasted with its context passes', () => {
  const page = file("---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout><main></main></Layout>\n");
  const bare = file(
    '---\nimport Layout from \'../layouts/Layout.astro\';\n---\n<Layout><main><div class="stat_wrap">{heading}<Button /></div></main></Layout>\n',
  );
  const refused = preflightVerdict('insert-node', { before: page, after: bare });
  assert.equal(refused.ok, false);
  const carried = file(
    "---\nimport Layout from '../layouts/Layout.astro';\nimport Button from '../components/Button.astro';\nconst heading = 'OUR STATS';\n---\n<Layout><main><div class=\"stat_wrap\">{heading}<Button /></div></main></Layout>\n",
  );
  assert.equal(preflightVerdict('insert-node', { before: page, after: carried }).ok, true);
});

test('every planner operation declares its pre-flight (the registry)', () => {
  const source = readFileSync(new URL('shared/engine/intent.ts', ROOT), 'utf8');
  const operations = source.slice(source.indexOf('export type Operation ='), source.indexOf('export type OperationTag'));
  const tags = [...operations.matchAll(/readonly tag: '([a-z-]+)'/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  assert.ok(tags.length >= 15, 'the operation union was read');
  assert.deepEqual(Object.keys(PREFLIGHT_CHECKS).sort(), [...new Set(tags)].sort(), 'every operation, and only those, has an entry');
  for (const [tag, entry] of Object.entries(PREFLIGHT_CHECKS)) {
    for (const check of entry.checks) {
      assert.ok(PREFLIGHT_CODES.includes(check), `${tag}: ${check} is a known check`);
    }
    if (entry.policy === 'refuse-new-errors') {
      assert.ok(entry.checks.length > 0, `${tag}: a refusing policy runs at least one check`);
    }
  }
});

function astroFiles(directory: string, limit: number): readonly string[] {
  const out: string[] = [];
  const pending = [directory];
  while (pending.length > 0 && out.length < limit) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    for (const entry of readdirSync(next)) {
      const full = path.join(next, entry);
      if (entry === 'node_modules' || entry.startsWith('.')) {
        continue;
      }
      const stat = statSync(full);
      if (stat.isDirectory()) {
        pending.push(full);
      } else if (entry.endsWith('.astro')) {
        out.push(full);
      }
    }
  }
  return out;
}

test('false-positive budget: real-world fixtures produce no pre-flight error', () => {
  const corpus = astroFiles(new URL('test/corpus', ROOT).pathname, 10_000);
  assert.ok(corpus.length >= 20, 'the corpus was read');
  for (const fixture of corpus) {
    const parsed = parsePageResult(parsePage(readFileSync(fixture, 'utf8'), {}));
    if (parsed.editable) {
      const errors = preflightFile({ path: fixture, model: parsed.model }, ALL).filter((finding) => finding.severity === 'error');
      assert.deepEqual(errors, [], `${path.basename(fixture)} has no pre-flight error`);
    }
  }
});

test('an external corpus of real sites, when given, is swept read-only', { skip: process.env['STACKI_PREFLIGHT_CORPUS'] === undefined }, () => {
  const root = process.env['STACKI_PREFLIGHT_CORPUS'] ?? '';
  let checked = 0;
  for (const fixture of astroFiles(root, 100_000)) {
    let parsed;
    try {
      parsed = parsePageResult(parsePage(readFileSync(fixture, 'utf8'), {}));
    } catch {
      continue;
    }
    if (parsed.editable) {
      checked += 1;
      preflightFile({ path: fixture, model: parsed.model }, ALL); // Must never throw.
    }
  }
  assert.ok(checked > 0);
});

test('a large page is checked inside the real-time budget', () => {
  const sections = Array.from(
    { length: 400 },
    (_, index) => `<section class="s${index}"><h2>{title}</h2>{items.map((item) => <p>{item.label} {index}</p>)}<Card title={title} /></section>`,
  );
  const source = `---\nimport Card from './Card.astro';\nconst title = 'T';\nconst items = [{ label: 'a' }];\nconst index = 0;\n---\n${sections.join('\n')}\n`;
  const large = file(source);
  const times: number[] = [];
  for (let run = 0; run < 20; run++) {
    const started = performance.now();
    preflightVerdict('insert-node', { before: large, after: large });
    times.push(performance.now() - started);
  }
  times.sort((first, second) => first - second);
  const latencyMsSlowest95th = times[Math.floor(times.length * 0.95)] ?? Infinity;
  assert.ok(latencyMsSlowest95th < 50, `p95 ${latencyMsSlowest95th.toFixed(1)} ms is under the 50 ms budget`);
});
