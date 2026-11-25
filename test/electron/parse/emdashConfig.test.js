// Goal: registering EmDash in an Astro config adds exactly what EmDash's existing-project guide shows (the Node adapter,
// React and emdash() in integrations, output "server", and the imports they need), keeps every byte of the person's own
// code, comments and formatting, never replaces a different adapter, does not duplicate what is already there, does
// nothing the second time, and refuses a config it cannot read with certainty rather than guessing.
// Method: a table of real config shapes (mjs and ts style, with and without defineConfig, an integrations array that
// is missing, empty, filled, trailing-comma, with React already, output unset, static and server, comments, single
// quotes, another adapter, an unusual export). Each result is parsed again with the TypeScript compiler, checked for
// each piece exactly once, compared byte for byte outside the inserted text, and merged a second time to prove idempotence.
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { mergeEmDashConfig, newEmDashConfig, emDashConfigIsWired } = require('#dist/electron/parse/emdashConfig.js');

const merged = (source) => {
  const result = mergeEmDashConfig(source);
  assert.equal(result.kind, 'merged', `merged: ${JSON.stringify(result)}`);
  return result;
};
const count = (text, needle) => text.split(needle).length - 1;

const CASES = {
  'defineConfig with an empty object': 'import { defineConfig } from "astro/config";\n\nexport default defineConfig({});\n',
  'defineConfig with site only':
    'import { defineConfig } from "astro/config";\n\n// My site.\nexport default defineConfig({\n  site: "https://example.com",\n});\n',
  'a plain exported object': 'export default {\n  site: "https://example.com"\n};\n',
  'single quotes and no trailing comma': "import { defineConfig } from 'astro/config';\nexport default defineConfig({\n    site: 'https://example.com'\n});\n",
  'an integrations array with another integration':
    'import { defineConfig } from "astro/config";\nimport sitemap from "@astrojs/sitemap";\nexport default defineConfig({\n  integrations: [sitemap()],\n});\n',
  'an empty integrations array': 'import { defineConfig } from "astro/config";\nexport default defineConfig({\n  integrations: [],\n});\n',
  'React already registered':
    'import { defineConfig } from "astro/config";\nimport react from "@astrojs/react";\nexport default defineConfig({\n  integrations: [react()],\n});\n',
  'output static': 'import { defineConfig } from "astro/config";\nexport default defineConfig({\n  output: "static",\n  site: "https://example.com",\n});\n',
  'output already server with the Node adapter':
    'import node from "@astrojs/node";\nimport { defineConfig } from "astro/config";\nexport default defineConfig({\n  output: "server",\n  adapter: node({ mode: "middleware" }),\n});\n',
};

test('every shape ends wired: parsed, each piece once, server output, an adapter, and the person’s text untouched', () => {
  for (const [name, source] of Object.entries(CASES)) {
    const { text } = merged(source);
    assert.equal(ts.transpileModule(text, { reportDiagnostics: true }).diagnostics.length, 0, `${name}: still parses`);
    assert.equal(emDashConfigIsWired(text), true, `${name}: wired`);
    assert.equal(count(text, 'from "emdash/astro"') + count(text, "from 'emdash/astro'"), 1, `${name}: one emdash/astro import`);
    assert.equal(count(text, 'emdash({'), 1, `${name}: one emdash()`);
    assert.equal(count(text, 'react()'), 1, `${name}: one react()`);
    // Everything the person wrote is still there, in order, with only insertions between: strip what was added and compare.
    let rest = text;
    // An empty `{}` or `[]`, or an array that gains entries, is the one place the person's own characters are opened up to hold what was added.
    for (const line of source.split('\n').filter((line) => line.trim().length > 0 && !/\{\}|\[\]|integrations: \[|output: "static"/.test(line))) {
      const at = rest.indexOf(line.trimEnd().replace(/,$/, ''));
      assert.ok(at >= 0, `${name}: kept "${line.trim()}"`);
      rest = rest.slice(at);
    }
  }
});

test('the adapter, React and emdash() are what the guide shows', () => {
  const { text } = merged(CASES['defineConfig with an empty object']);
  assert.match(text, /import node from "@astrojs\/node";/);
  assert.match(text, /import react from "@astrojs\/react";/);
  assert.match(text, /import emdash, \{ local \} from "emdash\/astro";/);
  assert.match(text, /import \{ sqlite \} from "emdash\/db";/);
  assert.match(text, /output: "server"/);
  assert.match(text, /adapter: node\(\{ mode: "standalone" \}\)/);
  assert.match(text, /database: sqlite\(\{ url: "file:\.\/data\.db" \}\)/);
  assert.match(text, /storage: local\(\{ directory: "\.\/uploads", baseUrl: "\/_emdash\/api\/media\/file" \}\)/);
});

test('single quotes stay single quotes, and a comment above the export stays', () => {
  assert.match(merged(CASES['single quotes and no trailing comma']).text, /import node from '@astrojs\/node';/);
  assert.match(merged(CASES['defineConfig with site only']).text, /\/\/ My site\.\nexport default/);
});

test('the site is said to render on request only when output was not server already', () => {
  assert.equal(merged(CASES['defineConfig with an empty object']).onDemand, true);
  assert.equal(merged(CASES['output static']).onDemand, true);
  assert.match(merged(CASES['output static']).text, /output: "server"/);
  assert.doesNotMatch(merged(CASES['output static']).text, /"static"/);
  assert.equal(merged(CASES['output already server with the Node adapter']).onDemand, false);
});

test('an existing integrations array keeps its entries and gains the missing ones only', () => {
  const { text } = merged(CASES['an integrations array with another integration']);
  assert.match(text, /integrations: \[sitemap\(\), react\(\),/);
  const reactOnly = merged(CASES['React already registered']).text;
  assert.equal(count(reactOnly, 'react()'), 1);
  assert.equal(count(reactOnly, 'emdash({'), 1);
});

test('entries added to a list written over several lines go on lines of their own, after the last entry and before its trailing comma', () => {
  const source =
    'import { defineConfig } from "astro/config";\nimport sitemap from "@astrojs/sitemap";\nexport default defineConfig({\n  integrations: [\n    sitemap({\n      filter: (page) => true,\n    }),\n  ],\n});\n';
  const { text } = merged(source);
  assert.match(text, /    \}\),\n    react\(\),\n    emdash\(\{ database: [^\n]*\}\),\n  \],/);
  assert.deepEqual(mergeEmDashConfig(text), { kind: 'unchanged' });
});

test('the existing Node adapter is kept as it is', () => {
  assert.match(merged(CASES['output already server with the Node adapter']).text, /mode: "middleware"/);
});

test('a different adapter is never replaced: the config is left untouched and the reason named', () => {
  const source =
    'import vercel from "@astrojs/vercel";\nimport { defineConfig } from "astro/config";\nexport default defineConfig({\n  adapter: vercel(),\n});\n';
  assert.deepEqual(mergeEmDashConfig(source), { kind: 'otherAdapter' });
});

test('running it on its own result changes nothing', () => {
  for (const [name, source] of Object.entries(CASES)) {
    const first = merged(source);
    assert.deepEqual(mergeEmDashConfig(first.text), { kind: 'unchanged' }, `${name}: idempotent`);
  }
  assert.deepEqual(mergeEmDashConfig(newEmDashConfig()), { kind: 'unchanged' }, 'and so is a config created from the template');
});

test('a config it cannot read with certainty is left alone', () => {
  const shapes = [
    'export default somethingElse();\n',
    'const config = {};\nexport default config;\n',
    'import { defineConfig } from "astro/config";\nexport default defineConfig(getOptions());\n',
    'import { defineConfig } from "astro/config";\nexport default defineConfig({ output: process.env.MODE });\n',
    'import { defineConfig } from "astro/config";\nexport default defineConfig({ integrations: getIntegrations() });\n',
    'import { defineConfig } from "astro/config";\nexport default defineConfig({ output: "hybrid" });\n',
    'import emdash from "emdash/astro";\nimport { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
    'export default {{{ not javascript\n',
    '',
  ];
  for (const source of shapes) {
    assert.deepEqual(mergeEmDashConfig(source), { kind: 'unusualShape' }, JSON.stringify(source));
  }
});

test('the template for a project with no config is wired and parses', () => {
  const text = newEmDashConfig();
  assert.equal(emDashConfigIsWired(text), true);
  assert.equal(ts.transpileModule(text, { reportDiagnostics: true }).diagnostics.length, 0);
  assert.equal(emDashConfigIsWired('export default {};\n'), false);
  assert.equal(emDashConfigIsWired('this is not javascript {{{'), false);
});
