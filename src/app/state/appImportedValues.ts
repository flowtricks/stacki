// What the open file's imports hold, for the binding picker: each module the
// file imports from is read over IPC (src:readSymbol, which resolves the
// project's aliases and stays inside the project) and its exports are read
// without running anything (src/editor/importedValues.ts). Studio assembles
// the same answer from its dev server (studio/src/features/settings/bindContext.ts).

import { useEffect, useMemo, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { readSymbol } from '../../ipc/bridge';
import { importedModuleRequests, readImportedValues, type ImportedValue } from '../../editor/importedValues';
import type { ImportLike } from '../../editor/dataSource';
import type { useCoreState } from './appLifecycle';
import type { useRoutes } from './appShortcuts';

interface FileValues {
  readonly key: string;
  readonly values: Readonly<Record<string, ImportedValue>>;
}

const NO_VALUES: Readonly<Record<string, ImportedValue>> = {};

export function useImportedValues(coreState: ReturnType<typeof useCoreState>, routes: ReturnType<typeof useRoutes>): Readonly<Record<string, ImportedValue>> {
  const projectPath = coreState.project?.path;
  const filePath = coreState.currentPage?.path;
  const imports = routes.model?.imports;
  // Asked again only when what is imported changes, not on every edit to the page.
  const key = useMemo(() => importsKey(projectPath, filePath, imports ?? []), [projectPath, filePath, imports]);
  const [answer, setAnswer] = useState<FileValues | undefined>(undefined);

  useEffect(() => {
    if (projectPath === undefined || filePath === undefined || filePath === '' || imports === undefined || imports.length === 0) {
      return undefined;
    }
    let live = true;
    const readModule = async (spec: string) => {
      const symbol = await readSymbol(projectPath, filePath, spec, '');
      return symbol.ok ? { file: symbol.rel, text: symbol.text } : undefined;
    };
    void readImportedValues(imports, readModule)
      .catch((): Record<string, ImportedValue> => ({}))
      .then((values) => {
        if (live) {
          setAnswer({ key, values });
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for projectPath, filePath and the imports' names and modules; the imports array is new on every edit.
  }, [key]);

  return answer !== undefined && answer.key === key ? answer.values : NO_VALUES;
}

// Which file, and which names from which modules: the inputs the answer depends on.
function importsKey(projectPath: string | undefined, filePath: string | undefined, imports: readonly ImportLike[]): string {
  const requests = importedModuleRequests(imports);
  const parts = requests.map((request) => `${request.spec}:${request.bindings.map((binding) => `${binding.local}=${binding.exported}`).join(',')}`);
  assert(parts.length === requests.length, 'importsKey: one part per module');
  return JSON.stringify([projectPath ?? '', filePath ?? '', parts]);
}
