// Goal: the installer's output is sorted into command, header, log and empty lines
// so only shell commands are coloured, and the sorting stays bounded on any input.
// Method: bundle the pure classifier with esbuild and feed it npm's real script echo,
// the installer's `$ ` echo, and hostile shapes: no header, empty and CRLF lines,
// lines over the colouring limit, control characters, and more lines than the cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const output = repoPath('node_modules/.stacki-test/install-output-lines.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/studioSetup/installOutputLines.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { classifyInstallOutput, INSTALL_OUTPUT_COMMAND_CHARS_MAX, INSTALL_OUTPUT_LINES_MAX } = require(output);
const kinds = (text) => classifyInstallOutput(text).map((line) => line.kind);

test('npm script echo: the header is muted and the command under it is code', () => {
  const lines = classifyInstallOutput('> @stacki/studio@1.4.10 check\n> tsc --noEmit && tsc -p tsconfig.worker.json\n\nadded 3 packages');
  assert.deepEqual(
    lines.map((line) => line.kind),
    ['header', 'command', 'empty', 'log'],
  );
  assert.deepEqual(lines[1], { kind: 'command', prefix: '> ', text: 'tsc --noEmit && tsc -p tsconfig.worker.json' });
  assert.equal(lines[0].text, '> @stacki/studio@1.4.10 check');
});

test('unscoped packages and a trailing working directory still make a header', () => {
  assert.deepEqual(kinds('> left-pad@1.0.0 build /tmp/project\n> node build.js'), ['header', 'command']);
});

test('a `> ` line without a header before it stays a log line', () => {
  assert.deepEqual(kinds('> tsx scripts/assemble.ts'), ['log']);
  assert.deepEqual(kinds('> @stacki/studio@1.4.10 assemble\n\n> tsx scripts/assemble.ts'), ['header', 'empty', 'log']);
});

test('two commands in a row: only the line right after a header is code', () => {
  assert.deepEqual(kinds('> a@1.0.0 x\n> one\n> two'), ['header', 'command', 'log']);
});

test('the installer echo `$ cmd` is a command; a bare `$ ` is not', () => {
  assert.deepEqual(classifyInstallOutput('$ npm ci')[0], { kind: 'command', prefix: '$ ', text: 'npm ci' });
  assert.deepEqual(kinds('$ \n$ x'), ['log', 'command']);
});

test('progress text, warnings, errors and notices are log lines', () => {
  assert.deepEqual(kinds('npm warn deprecated x@1\nnpm notice New version\nError: boom\nDownloading packages'), ['log', 'log', 'log', 'log']);
});

test('empty input is one empty line; CRLF and whitespace-only lines are empty', () => {
  assert.deepEqual(kinds(''), ['empty']);
  assert.deepEqual(kinds('a\r\n   \r\n'), ['log', 'empty', 'empty']);
  assert.equal(classifyInstallOutput('a\r\nb')[0].text, 'a');
});

test('a line over the colouring limit is plain log text, at the limit it is code', () => {
  const atLimit = '$ ' + 'x'.repeat(INSTALL_OUTPUT_COMMAND_CHARS_MAX - 2);
  assert.equal(classifyInstallOutput(atLimit)[0].kind, 'command');
  assert.equal(classifyInstallOutput(atLimit + 'x')[0].kind, 'log');
});

test('control characters and markup pass through as text', () => {
  const [line] = classifyInstallOutput('$ echo "<script>" \u0000 \u001b[31m');
  assert.equal(line.kind, 'command');
  assert.equal(line.text, 'echo "<script>" \u0000 \u001b[31m');
});

test('more lines than the cap keep the last ones', () => {
  const rows = Array.from({ length: INSTALL_OUTPUT_LINES_MAX + 10 }, () => 'x');
  rows[rows.length - 1] = 'last';
  rows[9] = 'dropped';
  rows[10] = 'first kept';
  const lines = classifyInstallOutput(rows.join('\n'));
  assert.equal(lines.length, INSTALL_OUTPUT_LINES_MAX);
  assert.equal(lines.at(-1).text, 'last');
  assert.equal(lines[0].text, 'first kept');
});

test('output over the progress limit is a programmer error and throws', () => {
  assert.throws(() => classifyInstallOutput('x'.repeat(24_001)), /within the progress limit/);
});
