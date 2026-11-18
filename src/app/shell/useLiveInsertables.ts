// The project's components with instance counts that follow the editor's own trees: the Components
// panel and the insert palette read these, so deleting, cutting, pasting, undoing or redoing an
// instance changes "1 instance" in the same commit as the tree (src/app/model/liveInstanceCounts.ts).
import { useMemo, useRef } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { CurrentPage, EditorPageState } from '../../editor/pageState';
import { fileInstanceCounts, nextHeldFiles, withLiveInstances, type HeldFile } from '../model/liveInstanceCounts';
import { scanSequenceLatest, scanSequenceOf } from '../model/scanSequence';

export interface LiveInsertablesView {
  readonly project: { readonly path: string };
  readonly scan: { readonly components: readonly ScanComponent[] };
  readonly insertables: readonly ScanComponent[];
  readonly currentPage: CurrentPage | undefined;
  readonly pageState: EditorPageState | undefined;
}

export function useLiveInsertables(view: LiveInsertablesView): readonly ScanComponent[] {
  const { insertables, currentPage, pageState } = view;
  const projectPath = view.project.path;
  const model = pageState?.editable === true ? pageState.model : undefined;
  const openPath = currentPage?.path;
  const current = useMemo(
    () =>
      model === undefined || openPath === undefined ? undefined : fileInstanceCounts(model, { project: projectPath, path: openPath, components: insertables }),
    [insertables, model, openPath, projectPath],
  );
  // The held files belong to one project; they are advanced in render, from this render's inputs
  // alone, so the count and the tree it came from are drawn in the same commit (no effect, no
  // second render). nextHeldFiles returns the map it was given when nothing moved, so repeating a
  // render repeats its answer.
  const held = useRef<{ readonly project: string; readonly files: ReadonlyMap<string, HeldFile> }>({ project: projectPath, files: new Map() });
  const before = held.current.project === projectPath ? held.current.files : new Map<string, HeldFile>();
  const files = nextHeldFiles(before, { current, appliedScan: scanSequenceOf(view.scan.components), latestScan: scanSequenceLatest() });
  held.current = { project: projectPath, files };
  return useMemo(
    () =>
      withLiveInstances(
        insertables,
        [...files.values()].map((entry) => entry.instances),
      ),
    [files, insertables],
  );
}
