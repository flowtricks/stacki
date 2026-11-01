// Goal: reuse component parsing without stale props, slots or render mappings.
// Method: compare object reuse and changed results while changing source, imported
// declarations, previously missing candidates, and failures independently of watchers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComponentAnalysis } from '../src/features/project/componentAnalysis';

const source = `---
import type { Tone } from './types';
interface Props { tone: Tone }
const { tone } = Astro.props;
---
<button class={tone}><slot /></button>`;
const missing = () => Object.assign(new Error('Missing declaration'), { code: 'ENOENT' });

test('unchanged inputs reuse parsing; changed declarations and source do not', async () => {
  const analysis = new ComponentAnalysis();
  let declaration = "export type Tone = 'primary' | 'secondary';";
  let reads = 0;
  const read = async () => {
    reads++;
    return declaration;
  };
  const first = await analysis.read('src/components/Button.astro', source, read);
  const second = await analysis.read('src/components/Button.astro', source, read);
  assert.equal(second, first, 'Unchanged component analysis is shared');
  assert.equal(reads, 2, 'Every use still checks its declaration on disk');
  declaration = "export type Tone = 'quiet' | 'loud';";
  const changed = await analysis.read('src/components/Button.astro', source, read);
  assert.notEqual(changed, first);
  assert.notDeepEqual(changed.fields, first.fields);
  const renamed = await analysis.read('src/components/Button.astro', source.replace('<slot />', '<slot name="label" />'), read);
  assert.deepEqual(renamed.slots, ['label']);
});

test('a newly created preferred declaration invalidates a previously missing candidate', async () => {
  const analysis = new ComponentAnalysis();
  let preferred: string | undefined;
  const read = async (file: string) => {
    if (file.endsWith('/types.ts')) {
      if (preferred === undefined) {
        throw missing();
      }
      return preferred;
    }
    return "export type Tone = 'old' | 'older';";
  };
  const first = await analysis.read('src/components/Button.astro', source, read);
  preferred = "export type Tone = 'new' | 'newer';";
  const second = await analysis.read('src/components/Button.astro', source, read);
  assert.notDeepEqual(first.fields, second.fields);
  preferred = undefined;
  assert.deepEqual((await analysis.read('src/components/Button.astro', source, read)).fields, first.fields);
});

test('unreadable dependencies fail instead of serving old analysis', async () => {
  const analysis = new ComponentAnalysis();
  await analysis.read('src/components/Button.astro', source, async () => "export type Tone = 'a';");
  await assert.rejects(
    analysis.read('src/components/Button.astro', source, async () => {
      throw new Error('Permission denied');
    }),
    /Permission denied/,
  );
});

test('the cache evicts old component entries at its count bound', async () => {
  const analysis = new ComponentAnalysis();
  const first = await analysis.read('src/components/first.astro', '<p />', async () => '');
  for (let index = 0; index < 128; index++) {
    await analysis.read(`src/components/item-${index}.astro`, '<p />', async () => '');
  }
  const again = await analysis.read('src/components/first.astro', '<p />', async () => '');
  assert.notEqual(first, again, 'Old entries are evicted instead of growing without a bound');
  assert.deepEqual(first, again, 'Eviction changes work, never the resulting component');
});

test('source memory is bounded independently of component count', async () => {
  const analysis = new ComponentAnalysis();
  const large = `<p>${'x'.repeat(100_000)}</p>`;
  const first = await analysis.read('src/components/first.astro', large, async () => '');
  for (let index = 0; index < 80; index++) {
    await analysis.read(`src/components/item-${index}.astro`, large, async () => '');
  }
  const again = await analysis.read('src/components/first.astro', large, async () => '');
  assert.notEqual(first, again, 'The byte budget evicts entries before the count limit');
  assert.deepEqual(first, again);
});
