import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { numericStyleBindings } from '../src/features/preview/numericStyleBindings';
import { parseNumericBindings } from '../src/features/preview/numericStyleProtocol';
const heading = await readFile('test/fixtures/site/src/components/typography/Heading.astro', 'utf8');
test('direct numeric width binding is read from Astro without changing its fields', () => {
  assert.deepEqual(numericStyleBindings(heading), [{ prop: 'maxWidth', variable: '--_mw', unit: 'ch', marker: '0.0.0' }]);
});
test('numbers that change HTML, defaults or computed behavior use authoritative rendering', () => {
  for (const source of [
    heading.replace('const content =', "const extra = Astro.props['maxWidth'];\nconst content ="),
    heading.replace('const content =', 'const extra = maxWidth + 1;\nconst content ='),
    heading.replace('  maxWidth,', '  maxWidth = 20,'),
    heading.replace('<Fragment set:html={content} />', '{maxWidth > 20 && <span>More HTML</span>}<Fragment set:html={content} />'),
    heading.replace('${maxWidth}ch', '${maxWidth * 2}ch'),
  ]) {
    assert.deepEqual(numericStyleBindings(source), []);
  }
  assert.throws(() => parseNumericBindings([{ prop: 'maxWidth', variable: 'width', unit: 'ch', marker: '0' }]));
});
