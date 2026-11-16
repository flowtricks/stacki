// The catalogue of unusual-but-valid Astro project shapes the sweep tests open.
//
// Why: Stacki's promise is that it opens every Astro site; one shape that crashes the scan is
// a customer's project showing black. Each entry is one shape named for what is unusual about
// it, so a new report from the field becomes one more entry and a permanent regression test.
//
// How: `shapes()` returns descriptions for `buildProject` (projectFixtures.ts). Every shape
// carries the base Astro files unless it replaces them, and `pages` names the page files
// (relative to the pages folder) a scan must list, so the sweep checks the result as well as
// "did not throw". Text is plain generated source: nothing here is executed.

import { ASTRO_BASE, type FixtureFiles } from './projectFixtures.ts';

export type ShapeArea = 'config' | 'workspace' | 'content' | 'routes' | 'filesystem' | 'css';

export interface ProjectShape {
  readonly name: string;
  readonly area: ShapeArea;
  readonly files: FixtureFiles;
  /** The project-relative folder Stacki is opened on (default: the built root). */
  readonly directory?: string;
  /** Page files (relative to the pages folder) the scan must list. Omit to skip the check. */
  readonly pages?: readonly string[];
}

// Two levels up from src/pages, spelled so the source-path rule does not read it as a repository path.
const upTwo = (target: string): string => ['..', '..', target].join('/');

const PAGE = '---\n---\n<h1>Page</h1>\n';

function configShape(name: string, file: string, text: string, extra: FixtureFiles = {}, pages: readonly string[] = ['index.astro']): ProjectShape {
  return { name, area: 'config', files: { ...ASTRO_BASE, [file]: text, ...extra }, pages };
}

function configShapes(): readonly ProjectShape[] {
  return [
    configShape(
      'config mjs plain',
      'astro.config.mjs',
      "import { defineConfig } from 'astro/config';\nexport default defineConfig({ site: 'https://example.com' });\n",
    ),
    configShape(
      'config ts typed',
      'astro.config.ts',
      "import type { AstroUserConfig } from 'astro';\nconst config: AstroUserConfig = { base: '/docs' };\nexport default config;\n",
    ),
    configShape('config js commonjs', 'astro.config.js', "module.exports = { srcDir: './src' };\n"),
    configShape('config cjs', 'astro.config.cjs', "const { defineConfig } = require('astro/config');\nmodule.exports = defineConfig({});\n"),
    configShape('config mts', 'astro.config.mts', "import { defineConfig } from 'astro/config';\nexport default defineConfig({ trailingSlash: 'always' });\n"),
    configShape(
      'config async function',
      'astro.config.mjs',
      "export default async () => {\n  const site = await fetch('https://x.test').then((r) => r.text());\n  return { site };\n};\n",
    ),
    configShape(
      'config defineConfig async arrow',
      'astro.config.mjs',
      "import { defineConfig } from 'astro/config';\nexport default defineConfig(async () => ({ srcDir: './app' }));\n",
      { 'app/pages/index.astro': PAGE },
    ),
    configShape(
      'config spread and env',
      'astro.config.mjs',
      "import base from './base.config.mjs';\nexport default { ...base, site: process.env.SITE_URL ?? 'https://a.test', srcDir: process.env.SRC ?? './src' };\n",
      { 'base.config.mjs': 'export default { output: "static" };\n' },
    ),
    configShape(
      'config conditional integrations',
      'astro.config.mjs',
      "import { defineConfig } from 'astro/config';\nconst dev = process.env.NODE_ENV !== 'production';\nexport default defineConfig({ integrations: [dev ? [] : [import('x')], ...(dev ? [] : [1])] });\n",
    ),
    configShape(
      'config srcDir literal other folder',
      'astro.config.mjs',
      "export default { srcDir: './website', publicDir: './static', outDir: './build', cacheDir: './.cache/astro' };\n",
      { 'website/pages/index.astro': PAGE },
    ),
    configShape('config srcDir commented out', 'astro.config.mjs', "export default {\n  // srcDir: './nope',\n  /* srcDir: './no' */\n  site: 'x',\n};\n"),
    configShape('config srcDir inside vite block', 'astro.config.mjs', "export default { vite: { srcDir: './not-astros' } };\n"),
    configShape('config root override', 'astro.config.mjs', "export default { root: './site' };\n"),
    configShape('config url with slashes in string', 'astro.config.mjs', "export default { site: 'https://example.com/a//b', base: '/x' }; // trailing\n"),
    configShape(
      'config i18n routing',
      'astro.config.mjs',
      "export default { i18n: { defaultLocale: 'en', locales: ['en', 'fr'], routing: { prefixDefaultLocale: true } } };\n",
    ),
    configShape(
      'config output server adapter',
      'astro.config.mjs',
      "import node from '@astrojs/node';\nexport default { output: 'server', adapter: node({ mode: 'standalone' }) };\n",
    ),
    configShape('config output hybrid', 'astro.config.mjs', "export default { output: 'hybrid' };\n"),
    configShape('config redirects', 'astro.config.mjs', "export default { redirects: { '/old': '/new', '/blog/[slug]': '/posts/[slug]' } };\n"),
    configShape('config trailingSlash never', 'astro.config.mjs', "export default { trailingSlash: 'never' };\n"),
    configShape('config empty file', 'astro.config.mjs', ''),
    configShape('config syntax error', 'astro.config.mjs', 'export default {{{ srcDir: ./x'),
    configShape('config only comments', 'astro.config.mjs', '// nothing here\n/* at all */\n'),
    configShape('config with BOM and CRLF', 'astro.config.mjs', "﻿export default {\r\n  srcDir: './src',\r\n};\r\n"),
    configShape('config both mjs and ts', 'astro.config.mjs', 'export default {};\n', { 'astro.config.ts': 'export default {};\n' }),
    {
      name: 'config only no package.json',
      area: 'config',
      files: { 'astro.config.mjs': 'export default {};\n', 'src/pages/index.astro': PAGE },
      pages: ['index.astro'],
    },
  ];
}

function workspaceShapes(): readonly ProjectShape[] {
  const astroPackage = '{"name":"web","dependencies":{"astro":"workspace:*"}}';
  return [
    {
      name: 'pnpm workspace package',
      area: 'workspace',
      directory: 'apps/web',
      pages: ['index.astro'],
      files: {
        'package.json': '{"private":true,"packageManager":"pnpm@9.1.0"}',
        'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
        'pnpm-lock.yaml': 'lockfileVersion: 9\n',
        'apps/web/package.json': astroPackage,
        'apps/web/astro.config.mjs': 'export default {};\n',
        'apps/web/src/pages/index.astro': PAGE,
      },
    },
    {
      name: 'yarn workspaces astro in parent',
      area: 'workspace',
      directory: 'packages/site',
      pages: ['index.astro'],
      files: {
        'package.json': '{"private":true,"workspaces":["packages/*"],"dependencies":{"astro":"^5"}}',
        'yarn.lock': '# yarn lockfile v1\n',
        'packages/site/package.json': '{"name":"site"}',
        'packages/site/src/pages/index.astro': PAGE,
      },
    },
    {
      name: 'bun lockb package',
      area: 'workspace',
      files: { ...ASTRO_BASE, 'bun.lockb': new Uint8Array([0, 1, 2]) },
      pages: ['index.astro'],
    },
    { name: 'bun lock text', area: 'workspace', files: { ...ASTRO_BASE, 'bun.lock': '{}' }, pages: ['index.astro'] },
    { name: 'npm lock', area: 'workspace', files: { ...ASTRO_BASE, 'package-lock.json': '{}' }, pages: ['index.astro'] },
    {
      name: 'packageManager field wins',
      area: 'workspace',
      files: { ...ASTRO_BASE, 'package.json': '{"packageManager":"yarn@4.1.0+sha512.abc","dependencies":{"astro":"5"}}', 'pnpm-lock.yaml': '' },
    },
    {
      name: 'no package.json at all',
      area: 'workspace',
      files: { 'src/pages/index.astro': PAGE, 'astro.config.mjs': 'export default {};\n' },
      pages: ['index.astro'],
    },
    {
      name: 'broken package.json',
      area: 'workspace',
      files: { 'package.json': '{ not json', 'astro.config.mjs': 'export default {};\n', 'src/pages/index.astro': PAGE },
      pages: ['index.astro'],
    },
    {
      name: 'package.json is an array',
      area: 'workspace',
      files: { 'package.json': '[1,2]', 'astro.config.mjs': 'export default {};\n', 'src/pages/index.astro': PAGE },
      pages: ['index.astro'],
    },
    { name: 'node_modules missing', area: 'workspace', files: { ...ASTRO_BASE }, pages: ['index.astro'] },
    {
      name: 'node_modules hoisted to workspace root',
      area: 'workspace',
      directory: 'site',
      pages: ['index.astro'],
      files: {
        'package.json': '{"private":true,"workspaces":["site"]}',
        'node_modules/.bin/astro': '#!/bin/sh\n',
        'site/package.json': '{"dependencies":{"astro":"5"}}',
        'site/src/pages/index.astro': PAGE,
      },
    },
  ];
}

function routeShapes(): readonly ProjectShape[] {
  const withPages = (name: string, pages: Readonly<Record<string, string>>, extra: FixtureFiles = {}): ProjectShape => ({
    name,
    area: 'routes',
    files: { ...ASTRO_BASE, ...Object.fromEntries(Object.entries(pages).map(([file, text]) => [`src/pages/${file}`, text])), ...extra },
    pages: Object.keys(pages).filter((file) => /\.(astro|mdx?)$/i.test(file) && !file.split('/').some((part) => part.startsWith('_'))),
  });
  return [
    withPages('dynamic params', {
      'index.astro': PAGE,
      'blog/[slug].astro': PAGE,
      'docs/[...rest].astro': PAGE,
      'shop/[[optional]].astro': PAGE,
      '[lang]/[section]/[id].astro': PAGE,
      '[a]-[b].astro': PAGE,
    }),
    withPages('getStaticPaths odd returns', {
      'a/[x].astro': '---\nexport const getStaticPaths = () => 5;\n---\n<p/>\n',
      'b/[x].astro': '---\nexport async function getStaticPaths() { return [ ...Array(3).keys() ].map(i => ({ params: { x: i } })); }\n---\n<p/>\n',
      'c/[x].astro': '---\nexport const getStaticPaths = undefined\n---\n<p/>\n',
    }),
    withPages('endpoints and non-pages in pages', {
      'index.astro': PAGE,
      'api/data.json.ts': 'export const GET = () => new Response("{}");\n',
      'api/hook.js': 'export const POST = () => new Response("");\n',
      'feed.xml.ts': 'export const GET = () => new Response("<rss/>");\n',
      'logo.png': 'png',
      'style.css': 'a{}',
      'robots.txt.ts': 'export const GET = () => new Response("");\n',
      'types.d.ts': 'declare const x: number;\n',
      'README.md': '# Readme\n',
      'notes.txt': 'hi',
    }),
    withPages('underscore partials ignored', {
      'index.astro': PAGE,
      '_partial.astro': PAGE,
      '_private/inner.astro': PAGE,
      'blog/_draft.md': '# draft\n',
      'blog/post.md': '# post\n',
    }),
    withPages('md and mdx pages', {
      'index.astro': PAGE,
      'about.md': '---\ntitle: A\n---\n# A\n',
      'team.mdx': 'import X from "../x.astro"\n\n# Team\n',
      'UPPER.MD': '# up\n',
    }),
    withPages('names with spaces unicode brackets emoji', {
      'index.astro': PAGE,
      'about us.astro': PAGE,
      'café.astro': PAGE,
      '日本語/ページ.astro': PAGE,
      '🎉.astro': PAGE,
      '(group)/name.astro': PAGE,
      'a b/c d.md': '# x\n',
      'weird\nname.astro': PAGE,
      "it's.astro": PAGE,
    }),
    withPages('index variants', { 'index.astro': PAGE, 'blog/index.astro': PAGE, 'blog/index.md': '# i\n' }),
    withPages('deeply nested pages', { [`${Array.from({ length: 40 }, (_, index) => `d${index}`).join('/')}/leaf.astro`]: PAGE }),
    {
      name: 'ssr middleware actions',
      area: 'routes',
      files: {
        ...ASTRO_BASE,
        'src/middleware.ts': 'export const onRequest = (_c, next) => next();\n',
        'src/middleware/index.ts': 'export const onRequest = (_c, next) => next();\n',
        'src/actions/index.ts': 'export const server = {};\n',
        'astro.config.mjs': "export default { output: 'server' };\n",
      },
      pages: ['index.astro'],
    },
    { name: 'no pages folder', area: 'routes', files: { 'package.json': '{"dependencies":{"astro":"5"}}' }, pages: [] },
    { name: 'pages is a file', area: 'routes', files: { 'package.json': '{"dependencies":{"astro":"5"}}', 'src/pages': 'not a folder' }, pages: [] },
    { name: 'src is a file', area: 'routes', files: { 'package.json': '{"dependencies":{"astro":"5"}}', src: 'not a folder' }, pages: [] },
  ];
}

function filesystemShapes(): readonly ProjectShape[] {
  return [
    {
      name: 'symlink cycle in pages',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/pages/blog/post.astro': PAGE, 'src/pages/blog/loop': { symlink: '..' }, 'src/pages/self': { symlink: '.' } },
    },
    {
      name: 'symlink cycle through src',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/components/A.astro': '<div/>', 'src/components/up': { symlink: '../..' }, 'src/pages/back': { symlink: '../..' } },
    },
    {
      name: 'symlink to a page folder outside the project',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/pages/shared': { symlink: '/definitely/not/here' } },
      pages: ['index.astro'],
    },
    {
      name: 'dangling symlinks',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/pages/gone.astro': { symlink: 'missing.astro' }, 'src/components/Gone.astro': { symlink: '../nope.astro' } },
      pages: ['index.astro'],
    },
    {
      name: 'symlinked page file and folder',
      area: 'filesystem',
      files: {
        ...ASTRO_BASE,
        'shared/team.astro': PAGE,
        'shared/docs/a.astro': PAGE,
        'src/pages/team.astro': { symlink: upTwo('shared/team.astro') },
        'src/pages/docs': { symlink: upTwo('shared/docs') },
      },
    },
    {
      name: 'CRLF and BOM pages',
      area: 'filesystem',
      files: {
        ...ASTRO_BASE,
        'src/pages/crlf.astro': '---\r\nconst a = 1;\r\n---\r\n<h1 class="x">Hi</h1>\r\n',
        'src/pages/bom.astro': '﻿---\n---\n<h1>Hi</h1>\n',
        'src/pages/both.md': '﻿---\r\ntitle: A\r\n---\r\n# A\r\n',
      },
      pages: ['index.astro', 'crlf.astro', 'bom.astro', 'both.md'],
    },
    {
      name: 'empty and binary page files',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/pages/empty.astro': '', 'src/pages/binary.astro': new Uint8Array([0, 255, 0, 254, 1, 2]), 'src/pages/lone.md': '' },
      pages: ['index.astro', 'empty.astro', 'binary.astro', 'lone.md'],
    },
    {
      name: 'read-only page',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/pages/locked.astro': { text: PAGE, mode: 0o444 } },
      pages: ['index.astro', 'locked.astro'],
    },
    {
      name: 'unreadable folders',
      area: 'filesystem',
      files: {
        ...ASTRO_BASE,
        'src/pages/private/secret.astro': PAGE,
        'src/pages/private': { directory: true, mode: 0o000 },
        'src/components/hidden/X.astro': '<div/>',
        'src/components/hidden': { directory: true, mode: 0o000 },
      },
    },
    {
      name: 'unreadable page file',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/pages/nope.astro': { text: PAGE, mode: 0o000 } },
      pages: ['index.astro', 'nope.astro'],
    },
    {
      name: 'huge public folder',
      area: 'filesystem',
      files: { ...ASTRO_BASE, ...Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`public/img/${Math.floor(index / 100)}/i${index}.png`, 'x'])) },
      pages: ['index.astro'],
    },
    {
      name: 'thousand pages and components',
      area: 'filesystem',
      files: {
        ...ASTRO_BASE,
        ...Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`src/pages/p${Math.floor(index / 50)}/page${index}.astro`, PAGE])),
        ...Object.fromEntries(
          Array.from({ length: 60 }, (_, index) => [`src/components/C${index}.astro`, `---\nconst { a } = Astro.props;\n---\n<div>{a}</div>\n`]),
        ),
      },
    },
    {
      name: 'node_modules inside src',
      area: 'filesystem',
      files: { ...ASTRO_BASE, 'src/node_modules/pkg/Comp.astro': '<div/>', 'src/components/A.astro': '<div/>' },
      pages: ['index.astro'],
    },
    {
      name: 'project path contains a folder named pages',
      area: 'filesystem',
      directory: 'pages/site',
      pages: ['index.astro'],
      files: {
        'pages/site/package.json': '{"dependencies":{"astro":"5"}}',
        'pages/site/src/pages/index.astro': PAGE,
        'pages/site/src/components/README.md': '# readme\n',
      },
    },
    {
      name: 'component names',
      area: 'filesystem',
      files: {
        ...ASTRO_BASE,
        'src/components/my card.astro': '<div/>',
        'src/components/Émile.astro': '<div/>',
        'src/components/.hidden.astro': '<div/>',
        'src/components/a.b.astro': '<div/>',
      },
    },
  ];
}

function contentShapes(): readonly ProjectShape[] {
  const post = '---\ntitle: P\n---\nbody\n';
  return [
    {
      name: 'legacy content config',
      area: 'content',
      files: {
        ...ASTRO_BASE,
        'src/content/config.ts':
          "import { defineCollection, z } from 'astro:content';\nexport const collections = { blog: defineCollection({ type: 'content', schema: z.object({ title: z.string() }) }) };\n",
        'src/content/blog/a.md': post,
        'src/content/blog/nested/deep/b.mdx': post,
      },
    },
    {
      name: 'loader glob and file',
      area: 'content',
      files: {
        ...ASTRO_BASE,
        'src/content.config.ts':
          "import { defineCollection, z } from 'astro:content';\nimport { glob, file } from 'astro/loaders';\nexport const collections = {\n  posts: defineCollection({ loader: glob({ pattern: '**/*.{md,mdx}', base: './src/data/posts' }), schema: z.object({ title: z.string() }) }),\n  people: defineCollection({ loader: file('src/data/people.json') }),\n};\n",
        'src/data/posts/a.md': post,
        'src/data/posts/b.mdx': post,
        'src/data/people.json': '[{"id":"a","name":"A"}]',
      },
    },
    {
      name: 'data entries yaml json toml',
      area: 'content',
      files: {
        ...ASTRO_BASE,
        'src/content/config.ts': 'export const collections = {};\n',
        'src/content/authors/a.yaml': 'name: A\n',
        'src/content/authors/b.yml': 'name: B\n',
        'src/content/authors/c.json': '{"name":"C"}',
        'src/content/authors/d.toml': 'name = "D"\n',
      },
    },
    {
      name: 'entry names weird',
      area: 'content',
      files: {
        ...ASTRO_BASE,
        'src/content/config.ts': 'export const collections = {};\n',
        'src/content/blog/my post.md': post,
        'src/content/blog/日本.md': post,
        'src/content/blog/🎉.md': post,
        'src/content/blog/a.b.c.md': post,
        'src/content/blog/_draft.md': post,
        'src/content/blog/[x].md': post,
        'src/content/blog/CRLF.md': '---\r\ntitle: X\r\n---\r\nbody\r\n',
        'src/content/blog/bom.md': '﻿---\ntitle: X\n---\nbody\n',
      },
    },
    {
      name: 'content config syntax error',
      area: 'content',
      files: { ...ASTRO_BASE, 'src/content.config.ts': 'export const collections = {{{', 'src/content/blog/a.md': post },
    },
    { name: 'content config empty', area: 'content', files: { ...ASTRO_BASE, 'src/content.config.ts': '' } },
    {
      name: 'both content configs',
      area: 'content',
      files: { ...ASTRO_BASE, 'src/content.config.ts': 'export const collections = {};\n', 'src/content/config.ts': 'export const collections = {};\n' },
    },
    {
      name: 'content folder is a file',
      area: 'content',
      files: { ...ASTRO_BASE, 'src/content': 'x', 'src/content.config.ts': 'export const collections = {};\n' },
    },
  ];
}

function cssShapes(): readonly ProjectShape[] {
  const css = (name: string, files: Readonly<Record<string, string>>): ProjectShape => ({
    name,
    area: 'css',
    files: { ...ASTRO_BASE, ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`src/styles/${file}`, text])) },
    pages: ['index.astro'],
  });
  return [
    css('scss sass less', {
      'a.scss': '$c: red;\n:root { --x: #{$c}; }\n.a { &:hover { color: $c; } }\n',
      'b.sass': '$c: red\n.b\n  color: $c\n',
      'c.less': '@c: red;\n.c { color: @c; }\n',
    }),
    css('postcss and nesting', {
      'a.pcss': ':root{--x:1}\n.a { & .b { color: red } }\n',
      'b.css': '.a { color: red; .b { color: blue; @media (min-width: 1px) { color: green } } }\n',
    }),
    css('tailwind v4', {
      'global.css':
        '@import "tailwindcss";\n@theme { --color-brand: #f00; --font-sans: Inter; }\n@layer base { :root { --x: 1 } }\n@custom-variant dark (&:where(.dark, .dark *));\n@utility tab-4 { tab-size: 4; }\n',
    }),
    css('tailwind v3', { 'global.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n@layer components { .btn { @apply px-4 py-2; } }\n' }),
    css('css modules and global', {
      'a.module.css': ':global(.x) { color: red }\n.y :global(.z) { color: blue }\n',
      'b.css': ':global { .q { color: red } }\n',
    }),
    css('import cycle', {
      'a.css': '@import "./b.css";\n:root{--a:1}\n',
      'b.css': '@import "./a.css";\n:root{--b:1}\n',
      'self.css': '@import "./self.css";\n',
    }),
    css('layers and properties', {
      'a.css':
        '@layer reset, base, components;\n@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }\n@layer base { :root { --x: 1 } }\n@container (min-width: 1px) { .a { color: red } }\n@scope (.card) { img { border: 1px solid } }\n',
    }),
    css('css vars unusual places', {
      'a.css':
        ':root { --a: calc(var(--b) * 2); --b: 1px; --c: ; --d: { a: b }; --e: "str;ing"; --🎉: 1; }\n.x { --local: var(--a, var(--b, 2)); }\n@media (prefers-color-scheme: dark) { :root { --a: 0 } }\n',
    }),
    css('broken css', { 'a.css': ':root { --a: 1\n.b { color: \n/* unterminated', 'b.css': '}}}{{{ @@@ ;;; "unterminated', 'c.css': '﻿:root{--bom:1}\r\n' }),
    css('empty and huge css', {
      'a.css': '',
      'b.css': Array.from({ length: 20000 }, (_, index) => `.c${index} { color: red; --v${index}: ${index}px; }`).join('\n'),
    }),
  ];
}

export function shapes(): readonly ProjectShape[] {
  const all = [...configShapes(), ...workspaceShapes(), ...routeShapes(), ...filesystemShapes(), ...contentShapes(), ...cssShapes()];
  const names = new Set(all.map((shape) => shape.name));
  if (names.size !== all.length) {
    throw new Error('Assertion failed: shape names are unique');
  }
  return all;
}
