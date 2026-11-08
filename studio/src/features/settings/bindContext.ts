// What the binding picker reads in Studio: the file's frontmatter and imports,
// the item of each loop around the selection, and what the file's calls to its
// imports return — a CMS query's entries, sampled by the project's dev server
// (valueSampler.ts). The desktop app assembles the same context (src/app/App.tsx).

import { useEffect, useMemo, useState } from 'react';
import type { RichContext } from '../../../vendor/stacki/src/features/props/RichContent';
import { importedCallsInScope, type ImportedCall } from '../../../vendor/stacki/src/editor/dataSuggest';
import { importedModuleRequests, readImportedValues, type ImportedValue } from '../../../vendor/stacki/src/editor/importedValues';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { parsePage, type ParserNode } from '../source/source';
import { request } from '../project/projectClient';
import { record } from '../../shared/validation';
import { useTemplateEntryProps } from '../pages/templateEntryStore';

// Loops around one node at most: deeper nesting is not a page anyone edits.
const LOOP_DEPTH_MAX = 32;

export function useBindContext(file: string, source: string, nodes: readonly ParserNode[], selected: string): RichContext {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const imports = useMemo(() => importsOf(source), [source]);
  const valueSamples = useValueSamples(file, frontmatter, imports);
  const importedValues = useImportedValues(file, imports);
  const [itemIndex, setItemIndex] = useState<Record<string, number>>({});
  // A template page's data is the shown entry's props: `doc` and every field it holds.
  const propsSample = useTemplateEntryProps(file);
  return {
    ...(propsSample === undefined ? {} : { propsSample }),
    frontmatter,
    imports,
    ancestorHeads: loopHeads(nodes, selected),
    valueSamples,
    importedValues,
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
function useValueSamples(file: string, frontmatter: string, imports: ReturnType<typeof importsOf>): Record<string, unknown> {
  const [samples, setSamples] = useState<Record<string, unknown>>({});
  useEffect(() => {
    const wanted = importedCallsInScope(frontmatter, imports).filter((call) => !(`${file}|${call.name}` in samples));
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

// What the file's imports hold, read from the modules they name without running
// them: `APP_VERSION` from src/consts.ts. Asked again only when the file or what
// it imports changes; a module that does not answer leaves its imports unresolved.
function useImportedValues(file: string, imports: ReturnType<typeof importsOf>): Readonly<Record<string, ImportedValue>> {
  const key = useMemo(() => JSON.stringify([file, importedModuleRequests(imports)]), [file, imports]);
  const [answer, setAnswer] = useState<{ readonly key: string; readonly values: Readonly<Record<string, ImportedValue>> } | undefined>(undefined);
  useEffect(() => {
    if (!imports.length) {
      return undefined;
    }
    let live = true;
    void readImportedValues(imports, (spec) => askImportSource(file, spec)).then((values) => {
      if (live) {
        setAnswer({ key, values });
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the file and its imports' names and modules; the imports array is new on every parse.
  }, [key]);
  return answer !== undefined && answer.key === key ? answer.values : {};
}

async function askImportSource(file: string, spec: string): Promise<{ readonly file: string; readonly text: string } | undefined> {
  const query = new URLSearchParams({ file, spec });
  try {
    const answer = record(await request(`/studio/api/import-source?${query.toString()}`));
    const resolved = answer['file'];
    const text = answer['text'];
    return typeof resolved === 'string' && typeof text === 'string' ? { file: resolved, text } : undefined;
  } catch {
    return undefined;
  }
}
