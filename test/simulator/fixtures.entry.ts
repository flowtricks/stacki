// The simulator's fixture set, read from disk for the entry points
// (simulator.test.ts, spike.bench.ts) so both run exactly the same scenarios.
// Only entry points import this module: the simulator core stays free of I/O
// (plan §10), and receives these texts as plain values.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SimulationFile } from './world.ts';

const HOSTILE = path.resolve('test/fixtures/editor-core');
const CORPUS = path.resolve('test/corpus');
const ROUND_TRIP = path.resolve('test/fixtures/round-trip');
const CORPUS_SLICE = [
  'map-loop.astro',
  'nested-components.astro',
  'spread-props.astro',
  'slots-named.astro',
  'style-and-script.astro',
  'why-a-loop-exists.astro',
] as const;
// Step 10: the Markdown and MDX round-trip pages join the hostile Markdown
// fixtures, so seeded runs cover a post (with a CRLF and BOM variant) and MDX
// with components as well as the hand-built shapes.
const ROUND_TRIP_SLICE = ['post.md', 'post-bom-crlf.md', 'components.mdx'] as const;

export interface SimulationFixtures {
  readonly files: readonly SimulationFile[];
  readonly alternates: ReadonlyMap<string, readonly string[]>;
}

export function loadSimulationFixtures(): SimulationFixtures {
  const read = (directory: string, name: string) => fs.readFileSync(path.join(directory, name), 'utf8');
  const inputs = fs
    .readdirSync(HOSTILE)
    .filter((name) => !name.includes('.expected.'))
    .sort();
  const files = [
    ...inputs.map((name) => ({ name, text: read(HOSTILE, name) })),
    ...CORPUS_SLICE.map((name) => ({ name, text: read(CORPUS, name) })),
    ...ROUND_TRIP_SLICE.map((name) => ({ name, text: read(ROUND_TRIP, name) })),
  ];
  const alternates = new Map<string, readonly string[]>();
  for (const name of inputs) {
    const expected = name.replace(/\.(\w+)$/, '.expected.$1');
    if (fs.existsSync(path.join(HOSTILE, expected))) {
      alternates.set(name, [read(HOSTILE, name), read(HOSTILE, expected)]);
    }
  }
  alternates.set('malformed.astro', [read(HOSTILE, 'malformed.astro'), '<div>\n  <span>closed</span>\n</div>\n']);
  return { files, alternates };
}
