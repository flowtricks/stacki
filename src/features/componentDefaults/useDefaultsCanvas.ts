import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { createDefaultsCanvas, removeDefaultsCanvas } from '../../ipc/projectMetadataBridge';
import { CANVAS_DIRECTORY, type DefaultsCanvasSession } from '../../../shared/properties/defaultsCanvas';
import { parseComponentDefaults, resolveComponentRecipe, type ComponentDefaults } from '../../../shared/properties/componentDefaults';
import { isAssetSpecifier } from '../../../shared/properties/componentDefaultValues';
import { recipeFromCanvas, UnsupportedChildError, UnsupportedDefaultError, type CanvasModel } from './defaultsCanvasModel';
import { reportActionToast } from '../../ui/errorNotices';
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
  /** The project file an import on the canvas page names, when the host can resolve it (an alias needs the host). */
  readonly resolveImport: (session: DefaultsCanvasSession, specifier: string) => Promise<string | undefined>;
  readonly leave: () => Promise<void>;
}

export function useDefaultsCanvas(host: CanvasHost) {
  const translate = useTranslate();
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
    const [gone] = snapshot.missingAssets ?? [];
    if (gone !== undefined) {
      reportActionToast(translate('componentProps.defaults.missingAsset', { file: gone }), 'warning', []);
    }
  };
  const run = (kind: CanvasAction) => runCanvas(host, control, kind, translate);
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

async function runCanvas(host: CanvasHost, control: CanvasControl, kind: CanvasAction, translate: Translator) {
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
        message: translate('componentProps.defaults.saved'),
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
      message: saveFailure(error, translate),
    });
  } finally {
    operation.current = false;
  }
}

function saveFailure(error: unknown, translate: Translator): string {
  if (error instanceof UnsupportedDefaultError) {
    return translate('componentProps.defaults.unsupportedValue', { prop: error.prop, tag: error.tag });
  }
  if (error instanceof UnsupportedChildError) {
    return translate('componentProps.defaults.unsupportedChild', { child: error.child });
  }
  return error instanceof Error ? error.message : translate('componentProps.defaults.saveFailed');
}

async function saveCanvas(host: CanvasHost, session: DefaultsCanvasSession): Promise<DefaultsCanvasSession> {
  const model = await host.read(session);
  // Only a media file can become an asset default, and only the host knows where an alias to one leads.
  const media = model.imports.filter((entry) => isAssetSpecifier(entry.path));
  const resolved = await Promise.all(media.map(async (entry) => [entry.path, await host.resolveImport(session, entry.path)] as const));
  const files = new Map(resolved.flatMap(([specifier, file]) => (file === undefined ? [] : [[specifier, file] as const])));
  const recipe = recipeFromCanvas(model, session, files);
  const config = parseComponentDefaults({
    version: 1,
    // The canvas holds what an instance inserts with; how its fields are typed in is set in the Properties panel and kept.
    components: { ...session.snapshot.config.components, [session.component]: { ...editingOf(session.snapshot.config, session.component), ...recipe } },
  });
  const result = resolveComponentRecipe(session.component, config, session.snapshot.catalog);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const snapshot = await host.defaults.save({ ...session.snapshot, config });
  return { ...session, snapshot };
}

function editingOf(config: ComponentDefaults, file: string) {
  const editing = config.components[file]?.editing;
  return editing === undefined ? {} : { editing };
}
