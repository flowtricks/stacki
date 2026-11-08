import assert from 'node:assert/strict';
import test from 'node:test';
import { pasteEdits } from '../src/features/source/paste';
import { applyEdits, parseAction, parsePage } from '../src/features/source/source';
import { MAX_SOURCE } from '../src/shared/validation';

const destination = `---
import Layout from '../../layouts/Layout.astro';
// Keep this comment and formatting.
const untouched = 'leave me alone';
---
<Layout><main></main></Layout>
<!-- Keep this too. -->`;
const original = `import Card from '../components/Card.astro';
import { getCollection as collection, unused } from 'astro:content';
import * as format from '../utils/format';
const category = 'blog';
const posts = await collection(category), unrelated = 'no';
const title = format.label(posts[0]);
const ignored = 'should not move';`;

function pasted(frontmatter = original, fragment = '<Card title={title} items={posts} />', target = 'n0.0') {
  const action = parseAction({
    kind: 'paste',
    target,
    placement: 'inside',
    clipboard: { file: 'src/pages/index.astro', frontmatter, fragment },
  });
  assert.equal(action.kind, 'paste');
  if (action.kind !== 'paste') {
    throw new Error('Expected paste');
  }
  const edits = pasteEdits(destination, 'src/pages/nested/page.astro', action);
  return applyEdits(destination, edits);
}

test('cross-page paste carries recursive bindings and rebases imports without changing destination text', () => {
  const output = pasted();
  assert.match(output, /import Card from "\.\.\/\.\.\/components\/Card.astro";/);
  assert.match(output, /import \{ getCollection as collection \} from 'astro:content';/);
  assert.match(output, /import \* as format from "\.\.\/\.\.\/utils\/format";/);
  assert.match(output, /const posts = await collection\(category\);/);
  assert.ok(output.indexOf('const category') < output.indexOf('const posts'));
  assert.ok(output.indexOf('const posts') < output.indexOf('const title'));
  assert.ok(!output.includes('unused') && !output.includes('unrelated') && !output.includes('ignored'));
  assert.ok(output.includes("// Keep this comment and formatting.\nconst untouched = 'leave me alone';"));
  assert.ok(output.endsWith('<!-- Keep this too. -->'));
  assert.match(output, /<main>\n\t<Card title=\{title\} items=\{posts\} \/>\n<\/main>/);
  assert.equal(parsePage(output).editable, true);
});

test('a paste is printed for where it lands, not the indentation it left', () => {
  const fragment = '<div class="a">\n              <p>x</p>\n              <p>y</p>\n            </div>';
  assert.match(pasted('', fragment), /<main>\n\t<div class="a">\n\t\t<p>x<\/p>\n\t\t<p>y<\/p>\n\t<\/div>\n<\/main>/);
});

test('existing destination bindings are reused without carrying their old dependencies', () => {
  const output = pasted("const old = 'old'; const untouched = old;", '<p>{untouched}</p>');
  assert.equal(output.match(/const untouched/g)?.length, 1);
  assert.ok(!output.includes('const old'));
});

test('loops bring their data binding and dynamic imports are rebased', () => {
  const output = pasted("const data = await import('../data/posts'); const posts = data.posts;", '{posts.map(post => <p>{post.title}</p>)}');
  assert.match(output, /import\("\.\.\/\.\.\/data\/posts"\)/);
  assert.match(output, /const posts = data.posts/);
  assert.equal(parsePage(output).editable, true);
});

test('copying a destructured binding preserves its required declaration', () => {
  const output = pasted('const { title } = Astro.props;', '<h1>{title}</h1>');
  assert.match(output, /const \{ title \} = Astro.props;/);
});

test('same-page paste leaves frontmatter unchanged and an unframed page receives frontmatter', () => {
  const clipboard = {
    file: 'src/pages/index.astro',
    frontmatter: original,
    fragment: '<Card title={title} />',
  };
  const action = {
    kind: 'paste' as const,
    target: 'layout',
    placement: 'inside' as const,
    clipboard,
  };
  const same = pasteEdits(destination, clipboard.file, action);
  assert.equal(same.length, 1);
  const bare = '<main></main>';
  const added = applyEdits(bare, pasteEdits(bare, 'src/pages/another.astro', { ...action, target: 'n0' }));
  assert.ok(added.startsWith('---\nimport Card'));
  assert.equal(parsePage(added).editable, true);
});

test('clipboard action rejects oversized payloads and invalid source paths', () => {
  const action = {
    kind: 'paste',
    target: 'layout',
    placement: 'inside',
    clipboard: { file: '../outside.astro', fragment: '<p />', frontmatter: '' },
  };
  assert.throws(() => parseAction(action), /Invalid project path/);
  assert.throws(
    () =>
      parseAction({
        ...action,
        clipboard: {
          ...action.clipboard,
          file: 'src/pages/a.astro',
          frontmatter: 'x'.repeat(MAX_SOURCE),
        },
      }),
    /source limit/,
  );
});
