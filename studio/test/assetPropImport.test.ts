// Goal: choosing a src/ asset in Settings adds its import without damaging the frontmatter,
// however the file opens: a byte order mark, blank lines or spaces around the first fence.
// Method: run the Settings write on each opening and read the result back with the parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetProp } from '../src/features/settings/settingsEdits';
import { nodesOf, parsePage } from '../src/features/source/source';

const IMPORT = 'import studioAsset from "../assets/a.png";';

function choose(source: string): string {
  const image = nodesOf(source).find((node) => node.name === 'img');
  assert.ok(image?.id);
  return assetProp(source, image.id, 'src/pages/index.astro', 'src', 'src/assets/a.png');
}

test('the import gets its own line below the opening fence, however the file starts', () => {
  const openings = ['---\n', '---\r\n', '﻿---\n', '\n---\n', '--- \n', '﻿\r\n---\t\r\n'];
  for (const opening of openings) {
    const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
    const rest = `const a = 1;${eol}---${eol}<img />${eol}`;
    const next = choose(opening + rest);
    assert.equal(next, `${opening}${IMPORT}${eol}${rest.replace('<img />', '<img src={studioAsset.src} />')}`, JSON.stringify(opening));
    const parsed = parsePage(next);
    assert.ok(parsed.editable);
    assert.deepEqual(
      parsed.model.imports.map((entry) => entry.name),
      ['studioAsset'],
    );
  }
});

test('a page without frontmatter gains one after any byte order mark', () => {
  assert.equal(choose('<img />\n'), `---\n${IMPORT}\n---\n<img src={studioAsset.src} />\n`);
  assert.equal(choose('﻿<img />\n'), `﻿---\n${IMPORT}\n---\n<img src={studioAsset.src} />\n`);
});

test('an asset already imported adds no second import', () => {
  const source = `﻿---\n${IMPORT}\n---\n<img />\n`;
  assert.equal(choose(source), source.replace('<img />', '<img src={studioAsset.src} />'));
});
