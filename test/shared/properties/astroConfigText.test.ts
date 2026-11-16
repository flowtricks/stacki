// Goal: the astro.config reader finds the settings that decide where a project's files are
// (`srcDir`, `publicDir`, `outDir`, `root`) from the config's TEXT, however the config is written,
// and says "computed" rather than guessing when code builds the value. It never runs the config.
// Method: one source per way a real config is written (object, defineConfig, async function,
// named const, CommonJS, spread, environment read, comments, strings that look like code, broken
// text), each read through the same entry point the project scan uses; the answer is checked
// for the key under test and for the keys that must stay unset.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfigText, settingOf } from '#dist/shared/properties/astroConfigText.js';
import { sourceDirectoryFromConfig } from '#dist/shared/properties/astroSourceDirectory.js';

const literal = (value: string) => ({ kind: 'literal', value });

function sourceDirectoryOf(text: string) {
  return settingOf(readConfigText(text), 'srcDir');
}

test('a plain object, defineConfig and a named const all read their literals', () => {
  assert.deepEqual(sourceDirectoryOf("export default { srcDir: './app' };"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf("import { defineConfig } from 'astro/config';\nexport default defineConfig({ srcDir: './app' });"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf("const config = { srcDir: 'app' };\nexport default config;"), literal('app'));
  assert.deepEqual(sourceDirectoryOf("const config: AstroUserConfig = { srcDir: 'app' };\nexport default defineConfig(config);"), literal('app'));
  assert.deepEqual(sourceDirectoryOf("module.exports = { srcDir: './app' };"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf('export default { \'srcDir\': "./app" };'), literal('./app'));
  assert.deepEqual(sourceDirectoryOf('export default { srcDir: `./app` };'), literal('./app'));
});

test('a function that returns the config is read through its return', () => {
  assert.deepEqual(sourceDirectoryOf("export default defineConfig(async () => ({ srcDir: './app' }));"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf("export default async function () { const x = await y(); return { srcDir: './app' }; }"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf("export default defineConfig(() => { const a = 1; return { srcDir: './app' }; });"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf("export default () => ({ srcDir: './app' });"), literal('./app'));
});

test('a setting that is not written is unset, so Astro default applies', () => {
  assert.deepEqual(sourceDirectoryOf("export default { site: 'https://x.test' };"), { kind: 'unset' });
  assert.deepEqual(sourceDirectoryOf(''), { kind: 'computed' }, 'a config with no object at all cannot be said to leave anything unset');
});

test('computed values are reported as computed, never as a literal', () => {
  assert.deepEqual(sourceDirectoryOf("export default { srcDir: process.env.SRC ?? './src' };"), { kind: 'computed' });
  assert.deepEqual(sourceDirectoryOf('export default { srcDir: `./${name}` };'), { kind: 'computed' });
  assert.deepEqual(sourceDirectoryOf("export default { srcDir: base + '/app' };"), { kind: 'computed' });
  assert.deepEqual(sourceDirectoryOf('const srcDir = "a"; export default { srcDir };'), { kind: 'computed' });
  assert.deepEqual(sourceDirectoryOf("export default { sourceDirectoryOf() { return 'a'; } };"), { kind: 'computed' });
});

test('a spread may override earlier keys and cannot override later ones', () => {
  assert.deepEqual(sourceDirectoryOf("export default { srcDir: './a', ...other };"), { kind: 'computed' });
  assert.deepEqual(sourceDirectoryOf("export default { ...other, srcDir: './a' };"), literal('./a'));
  assert.deepEqual(sourceDirectoryOf('export default { ...other };'), { kind: 'computed' });
});

test('look-alikes do not count: nested objects, comments, strings and urls', () => {
  assert.deepEqual(sourceDirectoryOf("export default { vite: { srcDir: './nope' } };"), { kind: 'unset' });
  assert.deepEqual(sourceDirectoryOf("export default {\n  // srcDir: './no',\n  /* srcDir: './no' */\n};"), { kind: 'unset' });
  assert.deepEqual(sourceDirectoryOf("export default { site: 'https://a.test/srcDir: ./no' };"), { kind: 'unset' });
  assert.deepEqual(sourceDirectoryOf('export default { integrations: [foo({ srcDir: "./no" })] };'), { kind: 'unset' });
});

test('comments, regular expressions and quotes inside strings do not derail the walk', () => {
  const text = [
    '// a comment with { and "',
    "export default { /* } */ site: 'http://a.test//b', redirect: /['\"`]/, srcDir: './app', tail: '/* not a comment */' };",
  ].join('\n');
  assert.deepEqual(sourceDirectoryOf(text), literal('./app'));
  assert.deepEqual(settingOf(readConfigText(text), 'tail'), literal('/* not a comment */'));
});

test('a BOM, CRLF line ends and a shebang read like plain text', () => {
  assert.deepEqual(sourceDirectoryOf("﻿export default {\r\n  srcDir: './app',\r\n};\r\n"), literal('./app'));
  assert.deepEqual(sourceDirectoryOf("#!/usr/bin/env node\nexport default { srcDir: './app' };"), literal('./app'));
});

test('broken and empty text never throws', () => {
  for (const text of [
    '',
    '{{{',
    'export default {',
    "export default { srcDir: './a",
    'export default defineConfig(',
    '`${',
    '/*',
    "'",
    'export default {{{ srcDir: ./x',
    '/[',
  ]) {
    assert.doesNotThrow(() => readConfigText(text), JSON.stringify(text));
  }
});

test('an opaque config still yields a literal it states, and computes the rest', () => {
  const reading = readConfigText("export default make(load('x'), { srcDir: './app' });");
  assert.equal(reading.shape, 'opaque');
  assert.deepEqual(settingOf(reading, 'srcDir'), literal('./app'));
  assert.deepEqual(settingOf(reading, 'publicDir'), { kind: 'computed' });
});

test('every structure setting is read from one config', () => {
  const reading = readConfigText("export default { srcDir: './website', publicDir: './static', outDir: './build', root: './site', cacheDir: './c' };");
  assert.deepEqual(settingOf(reading, 'publicDir'), literal('./static'));
  assert.deepEqual(settingOf(reading, 'outDir'), literal('./build'));
  assert.deepEqual(settingOf(reading, 'root'), literal('./site'));
  assert.deepEqual(settingOf(reading, 'cacheDir'), literal('./c'));
});

test('the pages folder reader keeps its contract: a folder inside the project or the default', () => {
  assert.equal(sourceDirectoryFromConfig("export default { srcDir: './app/' };"), 'app');
  assert.equal(sourceDirectoryFromConfig("export default { srcDir: '../outside' };"), undefined);
  assert.equal(sourceDirectoryFromConfig("export default { srcDir: '/abs' };"), undefined);
  assert.equal(sourceDirectoryFromConfig('export default { srcDir: process.env.X };'), undefined);
  assert.equal(sourceDirectoryFromConfig('export default {};'), undefined);
});

test('a long config is read in one pass, with no size limit', () => {
  const filler = Array.from({ length: 20000 }, (_unused, index) => `  key${index}: 'value ${index}',`).join('\n');
  const text = `export default {\n${filler}\n  srcDir: './app',\n};\n`;
  assert.deepEqual(sourceDirectoryOf(text), literal('./app'));
});
