// A disposable Astro project, baked and laid out as a static host would serve it. The
// server below only reads files: no route in it knows what Studio is, which is what
// lets the demo's browser test claim that nothing server-side is involved.
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bakeSite } from '../src/features/bake/bakeDemo';

const studio = fileURLToPath(new URL('../', import.meta.url));

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'package.json': '{"name":"demo-fixture","type":"module"}',
  'astro.config.mjs': 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
  'src/styles/site.css': '.lede { color: rgb(1, 2, 3); }\n',
  'src/components/Card.astro': `---
const { title = "Card" } = Astro.props;
---
<article class="card"><h3>{title}</h3><slot /></article>
<style>
  .card { padding: 8px; }
</style>
`,
  'src/content.config.ts': `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
const notes = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/notes" }),
  schema: z.object({ title: z.string(), summary: z.string().optional() }),
});
export const collections = { notes };
`,
  'src/content/notes/first.md': `---
title: First note
summary: A short summary
---
The note's body.
`,
  'src/components/Box.astro': `---
const { tone = "plain", ...rest } = Astro.props;
---
<section class="box">
  <div class={"box_inner " + tone} {...rest}><slot /></div>
</section>
`,
  'src/pages/index.astro': `---
import "../styles/site.css";
import Card from "../components/Card.astro";
import Box from "../components/Box.astro";
import { getCollection } from "astro:content";
const items = ["one", "two"];
const notes = await getCollection("notes");
---
<html>
  <head><title>Demo fixture</title></head>
  <body>
    <main>
      <h1 class="headline">Original heading</h1>
      <p class="lede">Original lede</p>
      <div id="first">First box</div>
      <div id="second">Second box</div>
      <Card title="A card">Card body</Card>
      <ul>{items.map((item) => (<li class="item">{item}</li>))}</ul>
      <p class="note">{notes[0]?.data.title}</p>
      {/* The box below forwards its caller's attributes to an inner element. */}
      <Box><p class="boxed">Boxed text</p></Box>
    </main>
    <a id="to-about" href="/about">About</a>
    <style>
      .headline { color: teal; }
    </style>
  </body>
</html>
`,
  'src/pages/about.astro': `---
---
<html>
  <head><title>About</title></head>
  <body>
    <h1>About page</h1>
    <a id="home" href="/">Home</a>
    <a id="download" href="/download/mac">Download for Mac</a>
    <button id="ping" type="button">Ping</button>
    <script>
      document.getElementById("ping")?.addEventListener("click", () => (document.body.dataset.pinged = "yes"));
    </script>
  </body>
</html>
`,
};

// The fixture site's dependencies are git-ignored, so a clean checkout (CI, the npm publish
// workflow) has none: the bake tests then found no Astro. They are installed once, from the
// fixture's own lockfile, the first time a test needs them. Bounded by npm's own timeout.
const FIXTURE_SITE = path.join(studio, 'test/fixtures/site');
const FIXTURE_INSTALL_MS_MAX = 300_000;
let fixtureInstall: Promise<void> | undefined;

const FIXTURE_ASTRO = path.join(FIXTURE_SITE, 'node_modules/astro/package.json');
// Test files run in parallel processes, so the install is guarded by a lock directory
// (mkdir is atomic): one process installs, the others wait for Astro to appear.
const FIXTURE_LOCK = path.join(FIXTURE_SITE, '.installing');
const FIXTURE_WAIT_MS = 500;

async function installed(): Promise<boolean> {
  return access(FIXTURE_ASTRO).then(
    () => true,
    () => false,
  );
}

async function installFixtureSite(): Promise<void> {
  const started = Date.now();
  while (!(await installed())) {
    if (Date.now() - started > FIXTURE_INSTALL_MS_MAX) {
      throw new Error('The fixture site dependencies did not install in time');
    }
    const owner = await mkdir(FIXTURE_LOCK).then(
      () => true,
      () => false,
    );
    if (owner) {
      try {
        await promisify(execFile)('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
          cwd: FIXTURE_SITE,
          timeout: FIXTURE_INSTALL_MS_MAX,
        });
      } finally {
        await rm(FIXTURE_LOCK, { recursive: true, force: true });
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, FIXTURE_WAIT_MS));
    }
  }
}

function ensureFixtureInstalled(): Promise<void> {
  fixtureInstall ??= installFixtureSite();
  return fixtureInstall;
}

export async function makeProject(): Promise<{ readonly root: string; readonly stop: () => Promise<void> }> {
  // The real path: Astro and Vite disagree about a symlinked temporary folder.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stacki-demo-')));
  for (const [file, text] of Object.entries(FIXTURE_FILES)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  // The fixture site's installed Astro, so this needs no install of its own.
  await ensureFixtureInstalled();
  await symlink(path.join(studio, 'test/fixtures/site/node_modules'), path.join(root, 'node_modules'));
  return { root, stop: () => rm(root, { recursive: true, force: true }) };
}

export async function bakeFixture(root: string, out: string, runtime = path.join(studio, 'dist')): Promise<void> {
  const result = await bakeSite({ root, out, base: '/demo/site/', runtime, studioVersion: '0.0.0-test' });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

/** Lays out `/demo/` from .studio/demo-release and the bake, then serves files. Nothing else. */
export async function serveDemo(site: string): Promise<{ readonly url: string; readonly requests: readonly string[]; readonly stop: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-demo-host-'));
  const assets = path.join(studio, '.studio/demo-release');
  await mkdir(path.join(root, 'demo/app'), { recursive: true });
  for (const name of ['studio.js', 'studio.css', 'demo.js', 'demo.css']) {
    await cp(path.join(assets, name), path.join(root, 'demo/app', name));
  }
  await cp(site, path.join(root, 'demo/site'), { recursive: true });
  const index = await readFile(path.join(assets, 'index.html'), 'utf8');
  await writeFile(path.join(root, 'demo/index.html'), index.replaceAll('__BASE__', '/demo/site/').replaceAll('__APP__', '/demo/app'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://host').pathname);
    requests.push(pathname);
    const file = path.join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    readFile(file).then(
      (bytes) => {
        response.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        response.end(bytes);
      },
      () => {
        response.statusCode = 404;
        response.end('Not found');
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/demo/`,
    requests,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
