import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ComponentProperties, PropertyChange } from '../../../shared/properties/propertyEditing';
import { onPropertyFilesChanged as onFilesChanged } from '../../ipc/editorEnvironment';
import { onWindowReturn } from '../../lib/windowReturn';
import { editComponentProperties, readComponentProperties } from './propertiesBridge';

export interface ComponentPropertiesPanelProps {
  readonly projectPath: string;
  readonly file: string;
  readonly name: string;
  readonly flushSave: () => Promise<unknown>;
  readonly onSavePhase: (phase: 'idle' | 'saving') => void;
  readonly onSaved: () => Promise<void>;
  /** An applied batch can be undone with this token (step 6). */
  readonly onRecordUndo?: (token: string) => void;
}
type PanelState =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly data: ComponentProperties };
type LoadReason = 'initial' | 'external';
interface Snapshot {
  readonly state: PanelState;
  readonly revision: number;
}

export function useComponentProperties(props: ComponentPropertiesPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const snapshot = usePropertySnapshot(props, pending, setError);
  const save = async (change: PropertyChange): Promise<boolean> => {
    if (snapshot.state.kind !== 'ready' || pending.current) {
      return false;
    }
    pending.current = true;
    snapshot.invalidate();
    props.onSavePhase('saving');
    setBusy(true);
    setError('');
    try {
      await props.flushSave();
      const result = await editComponentProperties(props.projectPath, props.file, snapshot.state.data.source, change);
      if (!result.ok) {
        if (snapshot.active.current) {
          if (result.error.code === 'conflict') {
            snapshot.requestRefresh();
          }
          setError(result.error.message);
        }
        return false;
      }
      if (snapshot.active.current) {
        snapshot.accept(result.value);
      }
      props.onRecordUndo?.(result.value.undo);
      await props.onSaved();
      return true;
    } catch (caught: unknown) {
      if (snapshot.active.current) {
        setError(String(caught));
      }
      return false;
    } finally {
      pending.current = false;
      props.onSavePhase('idle');
      if (snapshot.active.current) {
        setBusy(false);
        snapshot.flushExternal();
      }
    }
  };
  return { state: snapshot.state, revision: snapshot.revision, busy, error, save };
}

function usePropertySnapshot(props: ComponentPropertiesPanelProps, pending: MutableRefObject<boolean>, setError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: { kind: 'loading' }, revision: 0 });
  const active = useRef(false);
  const version = useRef(0);
  const invalidateReads = useCallback(() => {
    version.current++;
  }, []);
  // Coalesce external notifications during a save into one latest-disk read.
  const queued = useRef(false);
  const reading = useRef<LoadReason>();
  const currentProps = useRef(props);
  currentProps.current = props;
  const reload = useCallback(
    async (reason: LoadReason): Promise<void> => {
      const request = ++version.current;
      if (pending.current) {
        queued.current = true;
        return;
      }
      queued.current = false;
      reading.current = reason;
      const next = await loadPropertiesPanel(currentProps.current, reason);
      if (!active.current || request !== version.current) {
        return;
      }
      reading.current = undefined;
      setSnapshot((previous) => refreshSnapshot(previous, next));
      setError('');
    },
    [pending, setError],
  );
  usePropertyWatcher(props, { active, invalidateReads, reload });
  return {
    ...snapshot,
    active,
    accept: (data: ComponentProperties) =>
      setSnapshot((previous) => ({
        ...previous,
        state: { kind: 'ready', data },
      })),
    invalidate: () => {
      invalidateReads();
      queued.current = queued.current || reading.current === 'external';
      reading.current = undefined;
    },
    requestRefresh: () => {
      void reload('external');
    },
    flushExternal: () => {
      if (queued.current) {
        void reload('external');
      }
    },
  };
}

function usePropertyWatcher(
  props: Pick<ComponentPropertiesPanelProps, 'file' | 'projectPath'>,
  {
    active: activeRef,
    invalidateReads,
    reload,
  }: {
    readonly active: MutableRefObject<boolean>;
    readonly invalidateReads: () => void;
    readonly reload: (reason: LoadReason) => Promise<void>;
  },
): void {
  useEffect(() => {
    activeRef.current = true;
    // This event excludes self writes in projectWatcher, before IPC dispatch.
    const off = onFilesChanged(({ files }) => {
      if (files.length === 0 || files.includes(props.file)) {
        void reload('external');
      }
    });
    const offFocus = onWindowReturn(() => void reload('external'));
    void reload('initial');
    return () => {
      activeRef.current = false;
      invalidateReads();
      off();
      offFocus();
    };
  }, [props.file, props.projectPath, reload, invalidateReads, activeRef]);
}

function refreshSnapshot(previous: Snapshot, state: PanelState): Snapshot {
  if (previous.state.kind === 'ready' && state.kind === 'ready') {
    // Touching a file without changing its content must not discard a draft.
    if (previous.state.data.source === state.data.source) {
      return previous;
    }
  }
  return { state, revision: previous.revision + 1 };
}

async function loadPropertiesPanel(props: ComponentPropertiesPanelProps, reason: LoadReason): Promise<PanelState> {
  try {
    // An external read must never flush a stale model over the new disk source.
    if (reason === 'initial') {
      await props.flushSave();
    }
    const result = await readComponentProperties(props.projectPath, props.file);
    return result.ok ? { kind: 'ready', data: result.value } : { kind: 'error', message: result.error.message };
  } catch (caught: unknown) {
    return { kind: 'error', message: String(caught) };
  }
}
