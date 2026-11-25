// Goal: the `.env` codec prints back every byte it did not change, reads values as dotenv does, and
// edits only the line it touches; every bound and every invalid edit is refused as a value.
// Method: round-trip a table of messy files (CRLF, no final newline, BOM, comments, quotes holding
// '#', export prefixes, duplicates, odd spacing, multi-line and unterminated quotes) plus a seeded
// random corpus; read entries; apply add, update and remove and compare the whole text; then push each
// bound and each invalid name or value through the edit functions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENV_LIMITS,
  changeEnvFile,
  envEntries,
  envInvalidLines,
  envValueProblem,
  isEnvName,
  parseEnvFile,
  serializeEnvFile,
  type EnvChange,
  type EnvFile,
} from '#dist/shared/properties/envFile.js';

function parsed(text: string): EnvFile {
  const result = parseEnvFile(text);
  assert.ok(result.ok);
  return result.value;
}

function edited(text: string, change: EnvChange): string {
  const result = changeEnvFile(parsed(text), change);
  assert.ok(result.ok, JSON.stringify(result));
  return serializeEnvFile(result.value);
}

function editFailure(text: string, change: EnvChange): string {
  const result = changeEnvFile(parsed(text), change);
  assert.ok(!result.ok);
  return result.error;
}

const MESSY = [
  '',
  '\n',
  'A=1',
  'A=1\n',
  'A=1\r\nB=2\r\n',
  'A=1\nB=2\r\nC=3\rD=4',
  '﻿A=1\r\n# note\r\n',
  '# only a comment',
  '\n\n  \t\n',
  "export  A = 'x # not a comment' # real comment\n",
  'A="x # kept" # c\nB=y # c\nC=y#notcomment\n',
  'A=\nB=""\nC=\'\'\n',
  'A=1\nA=2\n',
  '  INDENT = v  \n',
  'not an entry\n1BAD=x\nA B=c\nexport\n',
  'KEY="line one\nline two"\nAFTER=1\n',
  'OPEN="never closed\nNEXT=1\n',
  'A=`tick`\nB="a\\nb"\n',
  'A="x" trailing\n',
  'PEM="-----BEGIN\nMIIB==\n-----END"\nZ=1',
];

test('round trip: every messy file prints back byte for byte', () => {
  for (const text of MESSY) {
    assert.equal(serializeEnvFile(parsed(text)), text, JSON.stringify(text));
  }
});

test('round trip: a seeded random corpus', () => {
  let seed = 12345;
  const next = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  const pieces = ['A=1', '# c', '', 'export B = "q"', "C='s'", '  D =  x # y', 'junk ', 'E="a', 'f"', '=', '﻿'];
  const endings = ['\n', '\r\n', '\r', ''];
  for (let round = 0; round < 300; round += 1) {
    let text = '';
    for (let part = 0; part < 1 + next(8); part += 1) {
      text += (pieces[next(pieces.length)] ?? '') + (endings[next(endings.length)] ?? '');
    }
    assert.equal(serializeEnvFile(parsed(text)), text, JSON.stringify(text));
  }
});

test('values are read as dotenv reads them', () => {
  const entries = envEntries(parsed(['A=plain # c', 'B="x # kept"', "C='lit\\n'", 'D="a\\nb"', 'E=a#b', 'F=', 'G=`t`', 'H="two', 'lines"'].join('\n')));
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.value]),
    [
      ['A', 'plain'],
      ['B', 'x # kept'],
      ['C', 'lit\\n'],
      ['D', 'a\nb'],
      ['E', 'a#b'],
      ['F', ''],
      ['G', 't'],
      ['H', 'two\nlines'],
    ],
  );
  assert.equal(entries[7]?.multiline, true);
  assert.equal(entries[0]?.multiline, false);
});

test('duplicates are kept and flagged; lines it cannot read are counted and kept', () => {
  const file = parsed('A=1\nB=2\nA=3\nwhat is this\nOPEN="x\n');
  assert.deepEqual(
    envEntries(file).map((entry) => entry.duplicate),
    [true, false, true],
  );
  assert.equal(envInvalidLines(file), 2);
});

test('add appends and keeps the file ending style', () => {
  assert.equal(edited('', { kind: 'add', name: 'A', value: '1' }), 'A=1\n');
  assert.equal(edited('X=1\n', { kind: 'add', name: 'A', value: '1' }), 'X=1\nA=1\n');
  assert.equal(edited('X=1', { kind: 'add', name: 'A', value: '1' }), 'X=1\nA=1');
  assert.equal(edited('X=1\r\n', { kind: 'add', name: 'A', value: '1' }), 'X=1\r\nA=1\r\n');
  assert.equal(edited('X=1\r\nY=2', { kind: 'add', name: 'A', value: '1' }), 'X=1\r\nY=2\r\nA=1');
});

test('add chooses a quote that says the value exactly', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['abc-1.2/x', 'abc-1.2/x'],
    ['', ''],
    ['two words', "'two words'"],
    ['a#b c', "'a#b c'"],
    ["it's", "`it's`"],
    ["it's `x`", '"it\'s `x`"'],
    ['$HOME', "'$HOME'"],
  ];
  for (const [value, written] of cases) {
    assert.equal(edited('', { kind: 'add', name: 'A', value }), `A=${written}\n`, value);
    assert.equal(envEntries(parsed(`A=${written}`))[0]?.value, value, `read back ${value}`);
  }
  assert.equal(editFailure('', { kind: 'add', name: 'A', value: `it's \`x\` "y"` }), 'invalid-value');
});

test('update changes only its line and keeps prefix, spacing, quote style and comment', () => {
  const text = '# top\n\nexport A = "old" # why\nB=2\r\n';
  assert.equal(edited(text, { kind: 'update', index: 0, name: 'A', value: 'new' }), '# top\n\nexport A = "new" # why\nB=2\r\n');
  assert.equal(edited(text, { kind: 'update', index: 0, name: 'C', value: undefined }), '# top\n\nexport C = "old" # why\nB=2\r\n');
  assert.equal(edited(text, { kind: 'update', index: 1, name: 'B', value: 'x y' }), '# top\n\nexport A = "old" # why\nB=\'x y\'\r\n');
  // A value a double quote cannot hold falls to the next style.
  assert.equal(edited('A="x"\n', { kind: 'update', index: 0, name: 'A', value: 'a"b' }), "A='a\"b'\n");
  assert.equal(edited('A="x"\n', { kind: 'update', index: 0, name: 'A', value: 'a\\nb' }), "A='a\\nb'\n");
});

test('update refuses to edit a multi-line value but may rename it', () => {
  const text = 'A="one\ntwo"\n';
  assert.equal(editFailure(text, { kind: 'update', index: 0, name: 'A', value: 'x' }), 'read-only');
  assert.equal(edited(text, { kind: 'update', index: 0, name: 'B', value: undefined }), 'B="one\ntwo"\n');
});

test('remove deletes only the entry line and keeps comments', () => {
  assert.equal(edited('# keep\nA=1\n# also\nB=2\n', { kind: 'remove', index: 0 }), '# keep\n# also\nB=2\n');
  assert.equal(edited('A="x\ny"\nB=2', { kind: 'remove', index: 0 }), 'B=2');
});

test('invalid edits are values, and say why', () => {
  const text = 'A=1\nB=2\nB=3\n';
  assert.equal(editFailure(text, { kind: 'add', name: 'A', value: 'x' }), 'name-taken');
  assert.equal(editFailure(text, { kind: 'update', index: 1, name: 'A', value: undefined }), 'name-taken');
  assert.equal(edited(text, { kind: 'update', index: 1, name: 'C', value: undefined }), 'A=1\nC=2\nB=3\n');
  assert.equal(editFailure(text, { kind: 'update', index: 9, name: 'A', value: undefined }), 'not-found');
  assert.equal(editFailure(text, { kind: 'update', index: -1, name: 'A', value: undefined }), 'not-found');
  assert.equal(editFailure(text, { kind: 'remove', index: 3 }), 'not-found');
  for (const name of ['', '1A', 'A-B', 'A B', 'A=', 'é', 'x'.repeat(ENV_LIMITS.nameCharsMax + 1)]) {
    assert.equal(editFailure(text, { kind: 'add', name, value: 'v' }), 'invalid-name', JSON.stringify(name));
  }
  assert.equal(isEnvName('x'.repeat(ENV_LIMITS.nameCharsMax)), true);
  for (const value of ['a\nb', 'a\rb', 'a\0b', 'é'.repeat(Math.floor(ENV_LIMITS.valueBytesMax / 2) + 1)]) {
    assert.equal(editFailure(text, { kind: 'add', name: 'Z', value }), 'invalid-value');
  }
  assert.equal(envValueProblem('é'.repeat(Math.floor(ENV_LIMITS.valueBytesMax / 2))), undefined);
  assert.equal(envValueProblem('é'.repeat(Math.floor(ENV_LIMITS.valueBytesMax / 2) + 1)), 'too-long');
});

test('bounds: files past a limit are refused whole, not truncated', () => {
  const lines = Array.from({ length: ENV_LIMITS.entriesMax }, (_unused, at) => `K${at}=1`);
  const full = lines.join('\n');
  assert.ok(parseEnvFile(full).ok);
  assert.equal(editFailure(full, { kind: 'add', name: 'EXTRA', value: '1' }), 'limit');
  const over = parseEnvFile(`${full}\nEXTRA=1`);
  assert.ok(!over.ok);
  assert.equal(over.error, 'too-many-entries');
  const tooManyLines = parseEnvFile('#\n'.repeat(ENV_LIMITS.linesMax + 1));
  assert.ok(!tooManyLines.ok);
  assert.equal(tooManyLines.error, 'too-many-lines');
  const large = parseEnvFile(`#${'x'.repeat(ENV_LIMITS.fileBytesMax)}`);
  assert.ok(!large.ok);
  assert.equal(large.error, 'too-large');
});
