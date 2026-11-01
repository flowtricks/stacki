import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { createDefaultsCanvas, removeDefaultsCanvas } from '../../ipc/projectMetadataBridge';
import { CANVAS_DIRECTORY, type DefaultsCanvasSession } from '../../../shared/properties/defaultsCanvas';
import { parseComponentDefaults, resolveComponentRecipe } from '../../../shared/properties/componentDefaults';
import { recipeFromCanvas, type CanvasModel } from './defaultsCanvasModel';
import type { DefaultsHost } from './defaultsHost';
import { prepareDefaultsCanvas, type DefaultsContext } from './defaultsCanvasContext';

type CanvasState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'editing' | 'saving';
      readonly session: DefaultsCanvasSession;
      readonly message: string;
    };
type CanvasAction = 'save' | 'done' | 'discard' | 'resume';
interface CanvasControl {
  readonly active: MutableRefObject<DefaultsCanvasSession | undefined>;
  readonly operation: MutableRefObject<boolean>;
  readonly setState: (state: CanvasState) => void;
}
export interface CanvasHost {
  readonly project: string;
  readonly isOpen: boolean;
  readonly defaults: DefaultsHost;
  readonly open: (session: DefaultsCanvasSession) => Promise<void>;
  readonly read: (session: DefaultsCanvasSession) => Promise<CanvasModel>;
  readonly leave: () => Promise<void>;
}

export function useDefaultsCanvas(host: CanvasHost) {
  const [state, setState] = useState<CanvasState>({ kind: 'idle' });
  const active = useRef<DefaultsCanvasSession>();
  const operation = useRef(false);
  useEffect(() => {
    setState({ kind: 'idle' });
    return () => {
      const session = active.current;
      active.current = undefined;
      if (session) {
        void removeDefaultsCanvas(host.project, session.file).catch((error: unknown) => {
          console.warn('Could not remove temporary defaults canvas:', error);
        });
      }
    };
  }, [host.project]);
  const control = { active, operation, setState };
  const start = async (context: DefaultsContext) => {
    if (control.active.current || control.operation.current) {
      throw new Error('Close the current defaults editor first.');
    }
    const snapshot = await host.defaults.load();
    const prepared = prepareDefaultsCanvas(CANVAS_DIRECTORY + crypto.randomUUID() + '.astro', snapshot, context);
    await startCanvas(host, control, prepared.session, prepared.source);
  };
  const run = (kind: CanvasAction) => runCanvas(host, control, kind);
  return { state, start, run, isOpen: host.isOpen };
}

async function startCanvas(host: CanvasHost, control: CanvasControl, session: DefaultsCanvasSession, source: string) {
  if (control.active.current || control.operation.current) {
    throw new Error('Finish editing the current component defaults first.');
  }
  const { active, operation } = control;
  operation.current = true;
  let created = false;
  try {
    await createDefaultsCanvas(host.project, session.file, source);
    created = true;
    await host.open(session);
    active.current = session;
    control.setState({ kind: 'editing', session, message: '' });
  } catch (error: unknown) {
    if (created) {
      await removeDefaultsCanvas(host.project, session.file);
    }
    throw error;
  } finally {
    operation.current = false;
  }
}

async function runCanvas(host: CanvasHost, control: CanvasControl, kind: CanvasAction) {
  const session = control.active.current;
  if (!session || control.operation.current) {
    return;
  }
  const { active, operation } = control;
  operation.current = true;
  control.setState({ kind: 'saving', session, message: '' });
  try {
    if (kind === 'resume') {
      await host.open(session);
      control.setState({ kind: 'editing', session, message: '' });
      return;
    }
    const next = kind === 'discard' ? session : await saveCanvas(host, session);
    active.current = next;
    if (kind === 'save') {
      control.setState({
        kind: 'editing',
        session: next,
        message: 'Defaults saved to this project.',
      });
    } else {
      await host.leave();
      await removeDefaultsCanvas(host.project, next.file);
      active.current = undefined;
      control.setState({ kind: 'idle' });
    }
  } catch (error: unknown) {
    control.setState({
      kind: 'editing',
      session: control.active.current ?? session,
      message: error instanceof Error ? error.message : 'Could not save component defaults.',
    });
  } finally {
    operation.current = false;
  }
}

async function saveCanvas(host: CanvasHost, session: DefaultsCanvasSession): Promise<DefaultsCanvasSession> {
  const recipe = recipeFromCanvas(await host.read(session), session);
  const config = parseComponentDefaults({
    version: 1,
    components: { ...session.snapshot.config.components, [session.component]: recipe },
  });
  const result = resolveComponentRecipe(session.component, config, session.snapshot.catalog);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const snapshot = await host.defaults.save({ ...session.snapshot, config });
  return { ...session, snapshot };
}
