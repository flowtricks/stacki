// What the binding picker reads in Studio: the file's frontmatter and imports,
// the item of each loop around the selection, and what the file's calls to its
// imports return — a CMS query's entries, sampled by the project's dev server
// (valueSampler.ts). The desktop app assembles the same context (src/app/App.tsx).

import { useEffect, useMemo, useState } from 'react';
import type { RichContext } from '../../../vendor/stacki/src/features/props/RichContent';
import {
  importedCallsInScope,
  type ImportedCall,
} from '../../../vendor/stacki/src/editor/dataSuggest';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { parsePage, type ParserNode } from '../source/source';
import { request } from '../project/projectClient';
import { record } from '../../shared/validation';

// Loops around one node at most: deeper nesting is not a page anyone edits.
const LOOP_DEPTH_MAX = 32;

export function useBindContext(
  file: string,
  source: string,
  nodes: readonly ParserNode[],
  selected: string,
): RichContext {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const imports = useMemo(() => importsOf(source), [source]);
  const valueSamples = useValueSamples(file, frontmatter, imports);
  const [itemIndex, setItemIndex] = useState<Record<string, number>>({});
  return {
    frontmatter,
    imports,
    ancestorHeads: loopHeads(nodes, selected),
    valueSamples,
    itemIndex,
    onStepItem: (name, step, count) =>
      setItemIndex((current) => ({
        ...current,
        [name]: ((((current[name] ?? 0) + step) % count) + count) % count,
      })),
  };
}

function importsOf(source: string) {
  const parsed = parsePage(source);
  return parsed.editable && 'imports' in parsed.model ? parsed.model.imports : [];
}

// The heads of the loops around a node, outermost first: `pastors.map((pastor) => (`.
function loopHeads(nodes: readonly ParserNode[], id: string): string[] {
  const trail = trailTo(nodes, id) ?? [];
  assert(trail.length <= LOOP_DEPTH_MAX * 4, 'A selection sits at a bounded depth');
  return trail.flatMap((node) => (node.kind === 'map' ? [node.head] : []));
}

// The nodes from the root down to the one with this id, excluding it.
function trailTo(nodes: readonly ParserNode[], id: string): ParserNode[] | undefined {
  const pending = nodes.map((node) => ({ node, trail: [] as ParserNode[] }));
  for (let visited = 0; pending.length > 0 && visited < 20_000; visited++) {
    const entry = pending.pop();
    assert(entry !== undefined, 'A pending node exists');
    if (entry.node.id === id) {
      return entry.trail;
    }
    const children = 'children' in entry.node ? (entry.node.children ?? []) : [];
    for (const child of children) {
      pending.push({ node: child, trail: [...entry.trail, entry.node] });
    }
  }
  return undefined;
}

// What each of the file's import calls returns, asked once per file and call.
function useValueSamples(
  file: string,
  frontmatter: string,
  imports: ReturnType<typeof importsOf>,
): Record<string, unknown> {
  const [samples, setSamples] = useState<Record<string, unknown>>({});
  useEffect(() => {
    const wanted = importedCallsInScope(frontmatter, imports).filter(
      (call) => !(`${file}|${call.name}` in samples),
    );
    if (!wanted.length) {
      return undefined;
    }
    let live = true;
    void Promise.all(wanted.map((call) => askValue(file, call))).then((pairs) => {
      if (live) {
        setSamples((previous) => ({ ...previous, ...Object.fromEntries(pairs) }));
      }
    });
    return () => {
      live = false;
    };
  }, [file, frontmatter, imports, samples]);
  return Object.fromEntries(
    Object.entries(samples)
      .filter(([key]) => key.startsWith(`${file}|`))
      .map(([key, value]) => [key.slice(file.length + 1), value]),
  );
}

// A failure is an answer too: the value stays without fields, and is not asked again.
async function askValue(file: string, call: ImportedCall): Promise<[string, unknown]> {
  const query = new URLSearchParams({ file, spec: call.spec, name: call.exportName });
  try {
    const answer = record(await request(`/studio/api/sample-value?${query.toString()}`));
    return [`${file}|${call.name}`, answer['value'] ?? undefined];
  } catch {
    return [`${file}|${call.name}`, undefined];
  }
}
