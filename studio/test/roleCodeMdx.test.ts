// Goal: a role without code permission writes MDX as words, components and data, and no spelling of an import, an
// export or a `{…}` gets past the check. MDX runs on the server, and the check reads it without an MDX parser, so each
// place where this reading could differ from MDX's own is pinned here.
// Method: add each piece of text to a real MDX entry and run the real check as such a role.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeGuard } from '../src/features/roles/codeGuard';
import { DEFAULT_PROJECT_ROLES, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';

const CLIENT = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');
const POST = 'src/content/blog/post.mdx';
const MDX = `---\ntitle: Post\n---\nimport Chart from '../../components/Chart.astro';\n\n# Title\n\n<Chart size={3} />\n`;

async function guarded(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-code-mdx-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const guard = new CodeGuard(root);
  return (text: string) => guard.assertAllowed(CLIENT, { file: POST, before: MDX, after: `${MDX}\n${text}\n` });
}

test('MDX keeps its prose, code samples and components', async (context) => {
  const add = await guarded(context);
  const added: readonly string[] = [
    'Words, with {1 + 2} and {/* a note */}.',
    'export your data whenever you like, and import it again later.',
    'Use `{ value }` in your own code.',
    '```js\nimport fs from "node:fs";\nconst a = { b: process.env };\n```',
    '~~~\nexport const x = {};\n~~~',
    "import Card from '../../components/Card.astro';\n\n<Card label=\"x\" tags={['a']} />",
    '<Chart size={5} title={props.title} />',
  ];
  for (const text of added) {
    await add(text).catch((error: unknown) => assert.fail(`${String(error)}\n${text}`));
  }
});

test('MDX code cannot be hidden from the check', async (context) => {
  const add = await guarded(context);
  const added: readonly string[] = [
    'export const leak = process.env;',
    'export /* */ const leak = process.env;',
    'export /* */ default process.env;',
    "import /* */ fs from 'node:fs';",
    "import fs\nfrom 'node:fs';",
    'Text {process.env.TOKEN}',
    'A ` {1}\n` {process.env.TOKEN} `',
    '- item\n  ```\n{process.env.TOKEN}',
    '> ```\n{process.env.TOKEN}',
    '```\r```\r\r{process.env.TOKEN}',
    '<Chart title="`" size={process.env.TOKEN} alt="`" />',
    '<Chart\n  title="\n```\n"\n  size={process.env.TOKEN}\n/>',
    '<div onclick="alert(1)">x</div>',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
  ];
  for (const text of added) {
    await assert.rejects(add(text), /cannot add or change code/, text);
  }
});
