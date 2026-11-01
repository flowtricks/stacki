// What the loop's list settings load and write outside the page: the project's
// collections and their fields, a reference's choices, and a query traced into
// another file, rewritten there (LoopSettings.tsx).

import { useEffect, useMemo, useState } from 'react';
import { groqQueryText, type LoopQuery, type LoopSource } from '../../editor/loopQuery';
import {
  loadCatalog,
  loadFields,
  loadReferenceChoices,
  LOOP_CATALOG_LIMITS,
  type CatalogField,
  type LoopCatalog,
} from './loopCatalog';
import { parseSourceKey, sourceKey } from './loopSettingsModel';
import { type TracedCollection } from './LoopLineage';
import { rewrittenGroqLiteral, type GroqLiteral } from '../../editor/loopTrace';
import { readText, writeText } from '../../ipc/bridge';
import type { ChoiceContext } from './LoopFilters';
/** A traced GROQ query as list settings, when the trace found its literal and could read it. */
export function editableTrace(
  traced: TracedCollection,
): { readonly query: LoopQuery; readonly literal: GroqLiteral; readonly file: string } | undefined {
  const groq = traced.groq;
  const literal = traced.literal;
  if (groq === undefined || literal === undefined || traced.source.kind !== 'sanity') {
    return undefined;
  }
  // No projection stays none (`''`): one would change what each item holds.
  const query: LoopQuery = {
    source: traced.source,
    match: groq.match,
    conditions: groq.conditions,
    sorts: groq.sorts,
    random: false,
    offset: groq.offset,
    limit: groq.limit,
    projection: groq.projection ?? '',
    parameter: { kind: 'data' },
  };
  return { query, literal, file: traced.file };
}

export async function writeTracedQuery(
  projectPath: string,
  literal: GroqLiteral,
  change: { readonly file: string; readonly query: LoopQuery },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  try {
    const text = await readText(projectPath, change.file);
    const next = rewrittenGroqLiteral(text, literal, groqQueryText(change.query, []));
    if (next === undefined) {
      return {
        ok: false,
        message: `${change.file} changed since it was read, so nothing was saved. Its settings are shown again as they are now.`,
      };
    }
    await writeText(projectPath, change.file, next);
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Couldn’t save ${change.file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------

// One catalog per project, kept while the app runs and refreshed each time a
// loop is opened: the menu opens on what was known, then catches up.
const catalogs = new Map<string, LoopCatalog>();

export function useLoopCatalog(projectPath: string | undefined): LoopCatalog | undefined {
  const [catalog, setCatalog] = useState<LoopCatalog | undefined>(
    projectPath ? catalogs.get(projectPath) : undefined,
  );
  useEffect(() => {
    if (!projectPath) {
      return undefined;
    }
    let live = true;
    void loadCatalog(projectPath).then((loaded) => {
      if (catalogs.size >= LOOP_CATALOG_LIMITS.projectsCachedMax && !catalogs.has(projectPath)) {
        catalogs.clear();
      }
      catalogs.set(projectPath, loaded);
      if (live) {
        setCatalog(loaded);
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath]);
  return catalog;
}

export function useCatalogFields(
  projectPath: string | undefined,
  catalog: LoopCatalog | undefined,
  source: LoopSource | undefined,
): readonly CatalogField[] | undefined {
  const key = source === undefined ? '' : sourceKey(source);
  const [loaded, setLoaded] = useState<
    { readonly key: string; readonly fields: readonly CatalogField[] } | undefined
  >(undefined);
  useEffect(() => {
    // Read back from the key, so the effect depends on what names the source
    // rather than on an object rebuilt every render.
    const parsed = parseSourceKey(key);
    if (!projectPath || !catalog || parsed?.kind !== 'collection') {
      return undefined;
    }
    let live = true;
    void loadFields(projectPath, catalog, parsed.source).then((fields) => {
      if (live) {
        setLoaded({ key, fields: fields ?? [] });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, catalog, key]);
  return loaded?.key === key ? loaded.fields : undefined;
}

export function useReferenceChoices(
  context: ChoiceContext,
  field: CatalogField | undefined,
): readonly { readonly title: string; readonly value: string }[] {
  const types = field?.references ?? [];
  const typesKey = types.join(',');
  const [loaded, setLoaded] = useState<
    | {
        readonly key: string;
        readonly choices: readonly { readonly title: string; readonly value: string }[];
      }
    | undefined
  >(undefined);
  const { projectPath, catalog } = context;
  const sourceName = sourceKey(context.query.source);
  const key = `${sourceName}|${typesKey}`;
  useEffect(() => {
    const parsed = parseSourceKey(sourceName);
    if (!projectPath || !catalog || typesKey === '' || parsed?.kind !== 'collection') {
      return undefined;
    }
    let live = true;
    void loadReferenceChoices(projectPath, catalog, parsed.source, typesKey.split(',')).then(
      (choices) => {
        if (live) {
          setLoaded({ key, choices });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [projectPath, catalog, key, sourceName, typesKey]);
  return useMemo(() => (loaded?.key === key ? loaded.choices : []), [loaded, key]);
}
