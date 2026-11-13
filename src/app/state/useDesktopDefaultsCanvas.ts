import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { useDefaultsKeyboard } from '../../features/componentDefaults/useDefaultsKeyboard';
import { canvasNodeAt } from '../../features/componentDefaults/defaultsCanvasModel';
import { useMemo, useRef } from 'react';
import { useDefaultsCanvas } from '../../features/componentDefaults/useDefaultsCanvas';
import { desktopDefaultsHost, relativeComponentPath } from '../../features/componentDefaults/defaultsHost';
import { defaultsCanvasRoute } from '../../../shared/properties/defaultsCanvas';
import { readPage } from '../../ipc/bridge';
import type { OpenFile } from '../../editor/pageState';
import type { useAppScope } from './appComposers';

export function useDesktopDefaultsCanvas(app: ReturnType<typeof useAppScope>) {
  const translate = useTranslate();
  const project = app.project?.path ?? '';
  const defaults = useMemo(() => desktopDefaultsHost(project), [project]);
  const previous = useRef<{
    readonly stack: readonly OpenFile[];
    readonly selectionPath: string | undefined;
  }>({ stack: [], selectionPath: undefined });
  const opened = useRef('');
  const canvas = useDefaultsCanvas({
    project,
    defaults,
    isOpen: app.currentPage?.path?.includes('/.stacki/canvas/') ?? false,
    open: async (session) => {
      if (opened.current !== session.file) {
        previous.current = {
          stack: app.editStackRef.current,
          selectionPath: app.pathFor(app.selectedId),
        };
        opened.current = session.file;
      }
      const entry: OpenFile = {
        kind: 'page',
        path: project + '/' + session.file,
        name: translate('shell.defaults.pageName', { name: session.component.split('/').at(-1) ?? 'Component' }), // i18n-ignore: the fallback is a component name, not a sentence.
        route: defaultsCanvasRoute(session.file),
      };
      await app.openFile(entry, {
        nextStack: [entry],
        selectionPath: session.targetPath,
      });
      if (app.pageStateRef.current.currentPage?.path !== entry.path) {
        throw new Error(translate('shell.defaults.openFailed'));
      }
      app.setLeftTab('navigator');
      app.setRightTab('settings');
    },
    read: (session) => readDefaultsCanvas(app, project + '/' + session.file, translate),
    leave: async () => {
      const entry = previous.current.stack.at(-1);
      if (entry) {
        await app.openFile(entry, {
          nextStack: previous.current.stack,
          selectionPath: previous.current.selectionPath,
        });
        if (app.pageStateRef.current.currentPage?.path !== entry.path) {
          throw new Error(translate('shell.defaults.returnFailed'));
        }
      } else {
        app.setCurrentPage(undefined);
        app.setPageState(undefined);
        app.setEditStack([]);
      }
    },
  });
  const rootId = canvas.state.kind === 'idle' ? undefined : canvasNodeAt(app.model?.nodes ?? [], canvas.state.session.targetPath)?.id;
  useDefaultsKeyboard(canvas, { selected: app.selectedId, root: rootId });
  return {
    ...canvas,
    rootId,
    startForNode: (_name: string, id: string) => startForNode(app, canvas, id, translate),
  };
}

async function startForNode(app: ReturnType<typeof useAppScope>, canvas: ReturnType<typeof useDefaultsCanvas>, id: string, translate: Translator) {
  const project = app.project?.path ?? '';
  const file = app.currentPage?.path;
  const path = app.pathFor(id);
  if (!file || !path) {
    throw new Error(translate('shell.defaults.selectComponent'));
  }
  await app.flushSave();
  const page = await readPage(file);
  if (!page.editable) {
    throw new Error(page.reason);
  }
  await canvas.start({
    file: relativeComponentPath(project, file),
    source: page.source,
    model: page.model,
    path,
  });
}

async function readDefaultsCanvas(app: ReturnType<typeof useAppScope>, path: string, translate: Translator) {
  if (app.pageStateRef.current.currentPage?.path !== path) {
    throw new Error(translate('shell.defaults.returnFirst'));
  }
  await app.flushSave();
  const page = await readPage(path);
  if (!page.editable) {
    throw new Error(page.reason);
  }
  return page.model;
}
