// Where a loop's list comes from when the page reads it through code: each
// layer from the name the loop uses down to the collection it reads, so
// `campusPastors` shows as Sanity's Campus documents, read by
// getCampusPastors() in src/sanity/queries.ts, filtered and sorted there.
// The trace is read from the files (loopTrace.ts); nothing here runs code.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { readSymbol } from '../../ipc/bridge';
import { TRACE_HOPS_MAX, traceFunction, type TraceStep } from '../../editor/loopTrace';
import type { LoopValueOrigin } from '../../editor/loopQueryRead';
import { AstroIcon, BracesIcon, CodeIcon, LayersIcon, SanityIcon } from '../../ui/Icons';
import { LoopDetails } from './LoopRows';
import { assert } from '../../../shared/core/assert';
import type { CatalogField, LoopCatalog } from './loopCatalog';
import { titled } from './loopCatalog';
import { conditionSummary, sortSummary, sourceKey } from './loopSettingsModel';

export interface LoopTrace {
  readonly steps: readonly TraceStep[];
  /** JS methods that change the list on its way (`map`, `filter`). */
  readonly reshaped: readonly string[];
}

export type TracedCollection = Extract<TraceStep, { readonly kind: 'collection' }>;

export function tracedCollection(trace: LoopTrace | undefined): TracedCollection | undefined {
  const last = trace?.steps[trace.steps.length - 1];
  return last?.kind === 'collection' ? last : undefined;
}

/** The trace of a value an import computes, read file by file. */
export function useLoopTrace(
  origin: LoopValueOrigin | undefined,
  location: {
    readonly projectPath: string | undefined;
    readonly filePath: string | undefined;
    readonly version: number;
  },
): LoopTrace | undefined {
  const { projectPath, filePath, version } = location;
  const exportName = origin?.kind === 'call' ? origin.exportName : undefined;
  const spec = origin?.kind === 'call' ? origin.spec : undefined;
  // The version is bumped after the panel writes a traced file, so it is read again.
  const key = `${projectPath ?? ''}|${filePath ?? ''}|${spec ?? ''}|${exportName ?? ''}|${version}`;
  const [loaded, setLoaded] = useState<
    { readonly key: string; readonly trace: LoopTrace } | undefined
  >(undefined);
  useEffect(() => {
    if (!projectPath || !filePath || exportName === undefined || spec === undefined) {
      return undefined;
    }
    let live = true;
    void traceAcross(projectPath, { fromFile: filePath, name: exportName, spec }).then((trace) => {
      if (live) {
        setLoaded({ key, trace });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, filePath, exportName, spec, key]);
  return loaded?.key === key ? loaded.trace : undefined;
}

// One file per hop: read the function, see where its data comes from, and
// follow the import it hands on to, up to the hop limit.
async function traceAcross(
  projectPath: string,
  start: { readonly fromFile: string; readonly name: string; readonly spec: string },
): Promise<LoopTrace> {
  const steps: TraceStep[] = [];
  const reshaped: string[] = [];
  let hop: { readonly fromFile: string; readonly name: string; readonly spec: string } | undefined =
    start;
  for (let count = 0; hop !== undefined && count < TRACE_HOPS_MAX; count++) {
    const current: { readonly fromFile: string; readonly name: string; readonly spec: string } =
      hop;
    const result = await readSymbol(
      projectPath,
      current.fromFile,
      current.spec,
      current.name,
    ).catch(() => undefined);
    if (!result?.ok) {
      steps.push({ kind: 'function', name: current.name, file: current.spec });
      break;
    }
    const read = traceFunction(result.text, result.rel, current.name);
    steps.push(...read.steps);
    reshaped.push(...read.reshaped);
    hop =
      read.next === undefined
        ? undefined
        : { fromFile: `${projectPath}/${result.rel}`, name: read.next.name, spec: read.next.spec };
  }
  assert(steps.length <= TRACE_HOPS_MAX * 8, 'A trace is bounded by its hops');
  return { steps, reshaped: [...new Set(reshaped)] };
}

/** The layers, top (what the loop names) to bottom (the collection). */
export function LoopLineage(props: {
  readonly names: readonly string[];
  readonly trace: LoopTrace | undefined;
  readonly catalog: LoopCatalog | undefined;
  readonly fields: readonly CatalogField[] | undefined;
  /** Whether the filters below edit the traced query where it lives. */
  readonly editable: boolean;
}) {
  const { trace } = props;
  const collection = tracedCollection(trace);
  // Folded by default: the Source menu already names the collection, and the
  // layers of code it passes through are for when someone asks.
  return (
    <LoopDetails>
      <LineageBody {...props} trace={trace} collection={collection} />
    </LoopDetails>
  );
}

function LineageBody(props: {
  readonly names: readonly string[];
  readonly trace: LoopTrace | undefined;
  readonly collection: TracedCollection | undefined;
  readonly catalog: LoopCatalog | undefined;
  readonly fields: readonly CatalogField[] | undefined;
  readonly editable: boolean;
}) {
  const { trace, collection } = props;
  return (
    <>
      <div className="loop-lineage-title">Comes from</div>
      {props.names.map((name) => (
        <LineageRow
          key={`value:${name}`}
          icon={<LayersIcon size={12} />}
          name={name}
          detail="This page"
        />
      ))}
      {trace === undefined && <div className="loop-settings-empty">Following the code…</div>}
      {trace?.steps.map((step, index) => (
        <LineageStep
          key={`${index}:${step.kind}`}
          step={step}
          catalog={props.catalog}
          fields={props.fields}
          editable={props.editable}
        />
      ))}
      {trace !== undefined && collection === undefined && (
        <div className="loop-settings-empty">
          The code doesn’t read a collection Stacki recognises.
        </div>
      )}
      {collection !== undefined && (
        <div className="loop-lineage-note">
          {trace !== undefined && trace.reshaped.length > 0
            ? `Reshaped in code (${trace.reshaped.map((method) => `.${method}`).join(', ')}). `
            : ''}
          {props.editable
            ? `Filters, sort and limit below are saved to ${collection.file}, and apply everywhere ${firstFunction(trace)} is used.`
            : `These settings live in ${collection.file}. Edit them there, or choose a collection above to set filters here.`}
        </div>
      )}
    </>
  );
}

function firstFunction(trace: LoopTrace | undefined): string {
  const step = trace?.steps.find((candidate) => candidate.kind === 'function');
  return step?.kind === 'function' ? `${step.name}()` : 'it';
}

function LineageStep(props: {
  readonly step: TraceStep;
  readonly catalog: LoopCatalog | undefined;
  readonly fields: readonly CatalogField[] | undefined;
  readonly editable: boolean;
}) {
  const { step } = props;
  switch (step.kind) {
    case 'value':
      return <LineageRow icon={<LayersIcon size={12} />} name={step.name} detail="This page" />;
    case 'function':
      return (
        <LineageRow icon={<CodeIcon size={12} />} name={`${step.name}()`} detail={step.file} />
      );
    case 'query':
      return (
        <LineageRow
          icon={<BracesIcon size={12} />}
          name={step.name ?? 'Query'}
          detail="GROQ query"
        />
      );
    case 'collection': {
      const title =
        props.catalog?.collections.find(
          (entry) => sourceKey(entry.source) === sourceKey(step.source),
        )?.title ?? titled(step.source.collection);
      const groq = step.groq;
      const details = props.editable
        ? []
        : [
            ...(groq?.conditions ?? []).map((condition) =>
              conditionSummary(condition, props.fields, []),
            ),
            ...(groq?.sorts ?? []).map((sort) => `Sorted by ${sortSummary(sort, props.fields)}`),
            ...(groq?.limit === undefined ? [] : [`First ${groq.limit}`]),
          ];
      return (
        <div className="loop-lineage-collection">
          <LineageRow
            icon={
              step.source.kind === 'sanity' ? <SanityIcon size={12} /> : <AstroIcon size={12} />
            }
            name={title}
            detail={step.source.kind === 'sanity' ? 'Sanity' : 'Content collection'}
          />
          {details.map((detail) => (
            <div key={detail} className="loop-lineage-detail">
              {detail}
            </div>
          ))}
        </div>
      );
    }
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

function LineageRow(props: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly detail: string;
}) {
  return (
    <div className="loop-lineage-row">
      <span className="loop-lineage-icon">{props.icon}</span>
      <span className="loop-lineage-name">{props.name}</span>
      <span className="loop-lineage-detail-inline">{props.detail}</span>
    </div>
  );
}
