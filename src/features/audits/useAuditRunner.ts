// Keeps the audit current: runs it when the project, the scope or the open file
// changes, when the open page saves (its checksum moves), when project files
// change on disk, and when Re-audit asks — always debounced, and never two at
// once (a run that finishes after a newer one started is dropped). Reads are cached
// between runs (auditRunner.ts AuditCache): a change event drops only the files it
// names, so a whole-site audit re-reads what changed; Re-audit drops everything.
import { useEffect, useRef } from 'react';
import type { ScanResult } from '../../../shared/properties/projectScan';
import { onFilesChanged } from '../../ipc/appBridge';
import { readAssetDimensions, listAssetEntries } from '../../ipc/assetBridge';
import { readPage, readText } from '../../ipc/bridge';
import { readVariables, styleTransport } from '../../ipc/editorEnvironment';
import { record, text } from '../../../shared/core/boundary';
import { toArray, toRecord } from '../../../shared/core/record';
import type { EditorPageState } from '../../editor/pageState';
import { auditCache, runAudit, type AuditCache, type AuditIO, type AuditRead } from './auditRunner';
import { tokenVariables } from '../../../shared/page/auditTokens';
import { fetchRenderedPage, readAuditIgnores } from './auditsBridge';
import { auditState, resetAuditState, updateAuditState, useAuditState } from './auditStore';
import { parsedTree, styledTree } from './renderedDom';

const DEBOUNCE_MS = 800;
// The newest run's number: an older run's answer, arriving late, is dropped.
let newestRun = 0;
// The project's reads and renders from earlier runs; one project at a time.
let cache: AuditCache = auditCache();
let cachedRequest = 0;
let cachedSave: string | undefined;

export interface AuditRunnerInput {
  readonly projectPath: string;
  readonly scan: ScanResult;
  readonly open: { readonly path: string; readonly kind: 'page' | 'component' } | undefined;
  readonly pageState: EditorPageState | undefined;
  /** The dev server, while it runs. */
  readonly devUrl: string | undefined;
}

export function useAuditRunner(input: AuditRunnerInput): void {
  const { projectPath } = input;
  const latest = useRef(input);
  latest.current = input;
  const { scope, request } = useAuditState();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saved = input.pageState?.save.tag === 'clean' ? input.pageState.save.checksum : undefined;
  const openPath = input.open?.path;

  useEffect(() => {
    cache = auditCache();
    cachedSave = undefined;
    resetAuditState(projectPath);
    void readAuditIgnores(projectPath).then((read) => {
      updateAuditState((current) => (read.ok ? { ...current, ignores: read.value } : { ...current, problem: `.stacki/audits.json: ${read.error}` }));
    });
  }, [projectPath]);

  useEffect(() => {
    const schedule = (): void => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void run(latest.current), DEBOUNCE_MS);
    };
    schedule();
    const off = onFilesChanged((event) => {
      // A change names its files; one that names none may have touched anything.
      if (event.files.length === 0) {
        cache = auditCache();
      }
      for (const file of event.files) {
        cache.reads.delete(file);
      }
      schedule();
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [projectPath, scope, request, saved, openPath, input.devUrl, input.scan]);
}

async function run(input: AuditRunnerInput): Promise<void> {
  newestRun += 1;
  const mine = newestRun;
  const request = auditState().request;
  if (request !== cachedRequest) {
    cachedRequest = request; // Re-audit, a fix or a settings change: read everything afresh.
    cache = auditCache();
  }
  // Stacki's own saves raise no change event (the watcher skips self writes), and one save can
  // write several files: a save of the open page drops the cached reads.
  const save = input.pageState?.save.tag === 'clean' ? input.pageState.save.checksum : undefined;
  if (save !== undefined && save !== cachedSave) {
    cachedSave = save;
    cache.reads.clear();
  }
  updateAuditState((current) => ({ ...current, running: true, progress: undefined }));
  try {
    const report = await runAudit(
      {
        scope: auditState().scope,
        projectPath: input.projectPath,
        scan: input.scan,
        open: input.open === undefined ? undefined : { ...input.open, read: editorRead(input.pageState) },
        settings: auditState().ignores.value,
        cache,
        onProgress: (progress) => {
          if (mine === newestRun) {
            updateAuditState((current) => ({ ...current, progress }));
          }
        },
      },
      projectIO(input),
    );
    if (mine === newestRun) {
      updateAuditState((current) => ({ ...current, report, running: false, progress: undefined, problem: undefined }));
    }
  } catch (error: unknown) {
    if (mine === newestRun) {
      updateAuditState((current) => ({ ...current, running: false, progress: undefined, problem: error instanceof Error ? error.message : String(error) }));
    }
  }
}

// The open file as the editor holds it, unsaved edits included.
function editorRead(state: EditorPageState | undefined): AuditRead | undefined {
  if (state === undefined) {
    return undefined;
  }
  return state.editable ? { editable: true, nodes: state.model.nodes, imports: state.model.imports, source: state.source } : { editable: false };
}

function projectIO(input: AuditRunnerInput): AuditIO {
  const { projectPath, devUrl } = input;
  return {
    readFile: async (path) => {
      const read = await readPage(path);
      return read.editable ? { editable: true, nodes: read.model.nodes, imports: read.model.imports, source: read.source } : { editable: false };
    },
    readText: async (rel) => {
      try {
        return await readText(projectPath, rel);
      } catch {
        return undefined; // A missing file is an absent fact, not a failed audit.
      }
    },
    listAssets: () => listAssetEntries(projectPath),
    imageSize: async (rel) => {
      const read = await readAssetDimensions(projectPath, rel);
      return read.ok && read.value !== undefined ? { width: read.value.w, height: read.value.h } : undefined;
    },
    renderPage: devUrl === undefined ? undefined : (route) => fetchRenderedPage(projectPath, devUrl, route),
    // Only the project's design tokens are offered as replacements (shared/page/auditTokens.ts tokenVariables).
    variables: async () => tokenVariables(record(await readVariables(projectPath))['files']),
    styleFiles: async () => {
      const files = toArray(record(await styleTransport.listStyleFiles(projectPath))['files']) ?? [];
      return files.flatMap((entry) => {
        const value = toRecord(entry);
        const rel = value?.['rel'];
        const path = value?.['path'];
        return typeof rel === 'string' && typeof path === 'string' ? [{ rel: rel.split('\\').join('/'), path }] : [];
      });
    },
    readStyle: async (path) => text(record(await styleTransport.readStyleFile(path))['css']),
    tree: (html, file, route, options) =>
      options.styled && devUrl !== undefined ? styledTree(html, file, new URL(route, devUrl).href) : Promise.resolve(parsedTree(html, file)),
  };
}
