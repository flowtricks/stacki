// A project file's state in a panel: loaded when the panel opens and again whenever the window regains focus
// (an edit made outside Stacki shows then), replaced by the answer of a change, and set apart from a running
// app that lacks the channel. A reply for a project the panel has since left, or one overtaken by a newer
// load or a change, is dropped. An unchanged answer keeps the state object, so a refocus redraws nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../../../shared/core/result';
import { McpUnavailableError } from './mcpBridge';

export type ChannelState<T, E> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly error: E | undefined }
  | { readonly kind: 'ready'; readonly value: T };

export interface ProjectChannel<T, E> {
  readonly state: ChannelState<T, E>;
  readonly replace: (value: T) => void;
  readonly reload: () => void;
}

export function useProjectChannel<T, E>(
  projectPath: string,
  load: (projectPath: string) => Promise<Result<T, E>>,
  same: (current: T, next: T) => boolean,
): ProjectChannel<T, E> {
  const [state, setState] = useState<ChannelState<T, E>>({ kind: 'loading' });
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const sameRef = useRef(same);
  sameRef.current = same;
  const run = useCallback(() => {
    latest.current += 1;
    const ticket = latest.current;
    const settle = (next: ChannelState<T, E>): void => {
      if (ticket !== latest.current) {
        return;
      }
      setState((current) => (current.kind === 'ready' && next.kind === 'ready' && sameRef.current(current.value, next.value) ? current : next));
    };
    // A rejected call is a broken boundary, not an operating failure; the panel says it could not read and shows no detail.
    loadRef.current(projectPath).then(
      (result) => settle(result.ok ? { kind: 'ready', value: result.value } : { kind: 'failed', error: result.error }),
      (error: unknown) => settle(error instanceof McpUnavailableError ? { kind: 'unavailable' } : { kind: 'failed', error: undefined }),
    );
  }, [projectPath]);
  useEffect(() => {
    setState({ kind: 'loading' });
    run();
    window.addEventListener('focus', run);
    return () => {
      latest.current += 1;
      window.removeEventListener('focus', run);
    };
  }, [run]);
  const replace = useCallback((value: T) => {
    latest.current += 1;
    setState({ kind: 'ready', value });
  }, []);
  return { state, replace, reload: run };
}
