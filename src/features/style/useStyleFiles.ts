import { useCallback, useEffect, useState } from 'react';
import type { HostState } from './model/host';
import type { Result } from '../../../shared/core/result';

type StyleFiles = HostState['files'];
type ReadFiles = (project: string) => Promise<Result<StyleFiles, string>>;

// A failed inventory is not an empty project. Keep the last usable list and
// retry interrupted startup reads; a later focus/online event can recover too.
export function useStyleFiles(project: string | undefined, refreshKey: string | undefined, read: ReadFiles) {
  const [state, setState] = useState<{ readonly files: StyleFiles; readonly error: string }>({
    files: [],
    error: '',
  });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
    };
  }, [retry]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!project) {
      setState({ files: [], error: '' });
      return;
    }
    const load = async (): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let result: Result<StyleFiles, string>;
        try {
          result = await read(project);
        } catch (error: unknown) {
          result = { ok: false, error: String(error) };
        }
        if (!active) {
          return;
        }
        if (result.ok) {
          setState({ files: result.value, error: '' });
          return;
        } else {
          const error = result.error;
          setState((previous) => ({ ...previous, error }));
          if (attempt < 2) {
            await new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 500 * (attempt + 1));
            });
          }
        }
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [project, refreshKey, read, revision]);
  return { ...state, retry };
}
