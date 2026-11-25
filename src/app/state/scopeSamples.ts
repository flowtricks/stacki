// What the open file's frontmatter values held on the canvas's last render —
// every top-level value, wherever it came from — for the binding picker.
//
// The dev server keeps what each file's frontmatter computed as the canvas
// rendered it (electron/previewServer/scopeCapture.ts), so asking runs nothing
// in the project: no fetch is repeated and no CMS is queried again. The file is
// asked about when it opens, and again once an edit to its frontmatter (or a
// different entry on the canvas) has settled, for a render no older than the
// change.

import { useEffect, useRef } from 'react';
import type { Data } from '../../../shared/core/boundary';
import { readScopeSamples } from '../../ipc/appBridge';
import { keyScopeSamples, SCOPE_SAMPLE_LIMITS, withoutFileSamples } from '../../editor/scopeSampleValues';
import type { useCoreState } from './appLifecycle';
import type { useRoutes } from './appShortcuts';

export function useScopeSamples(coreState: ReturnType<typeof useCoreState>, routes: ReturnType<typeof useRoutes>): void {
  const { currentPage, devStatus, devUrl, dynamicIndex, project, setScopeSamples } = coreState;
  const { pageFrontmatter } = routes;
  const pagePath = currentPage?.path;
  const projectPath = project?.path;
  // The file whose first answer has been asked for: that one takes any render.
  const askedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setScopeSamples({});
    askedRef.current = undefined;
  }, [projectPath, setScopeSamples]);

  useEffect(() => {
    if (!devUrl || devStatus !== 'on' || projectPath === undefined || pagePath === undefined || pagePath === '') {
      return undefined;
    }
    const first = askedRef.current !== pagePath;
    const sinceMs = first ? 0 : Date.now();
    let live = true;
    const timer = setTimeout(
      () => {
        askedRef.current = pagePath;
        void readScopeSamples({ projectPath, devUrl, pagePath, sinceMs })
          .catch((): Readonly<Record<string, Data>> => ({}))
          .then((values) => {
            // No answer keeps the last one: a render that failed says nothing
            // about what the values were.
            if (live && Object.keys(values).length > 0) {
              setScopeSamples((previous) => ({ ...withoutFileSamples(previous, pagePath), ...keyScopeSamples(pagePath, values) }));
            }
          });
      },
      first ? 0 : SCOPE_SAMPLE_LIMITS.askDelayMs,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [devUrl, devStatus, projectPath, pagePath, pageFrontmatter, dynamicIndex, setScopeSamples]);
}
