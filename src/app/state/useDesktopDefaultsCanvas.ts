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
        name: (session.component.split('/').at(-1) ?? 'Component') + ' defaults',
        route: defaultsCanvasRoute(session.file),
      };
      await app.openFile(entry, {
        nextStack: [entry],
        selectionPath: session.targetPath,
      });
      if (app.pageStateRef.current.currentPage?.path !== entry.path) {
        throw new Error('Could not open the defaults canvas.');
      }
      app.setLeftTab('navigator');
      app.setRightTab('settings');
    },
    read: (session) => readDefaultsCanvas(app, project + '/' + session.file),
    leave: async () => {
      const entry = previous.current.stack.at(-1);
      if (entry) {
        await app.openFile(entry, {
          nextStack: previous.current.stack,
          selectionPath: previous.current.selectionPath,
        });
        if (app.pageStateRef.current.currentPage?.path !== entry.path) {
          throw new Error('Could not return to the previous page. Your defaults canvas is still open.');
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
    startForNode: (_name: string, id: string) => startForNode(app, canvas, id),
  };
}

async function startForNode(app: ReturnType<typeof useAppScope>, canvas: ReturnType<typeof useDefaultsCanvas>, id: string) {
  const project = app.project?.path ?? '';
  const file = app.currentPage?.path;
  const path = app.pathFor(id);
  if (!file || !path) {
    throw new Error('Select a component in an open page.');
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

async function readDefaultsCanvas(app: ReturnType<typeof useAppScope>, path: string) {
  if (app.pageStateRef.current.currentPage?.path !== path) {
    throw new Error('Return to the defaults canvas before saving.');
  }
  await app.flushSave();
  const page = await readPage(path);
  if (!page.editable) {
    throw new Error(page.reason);
  }
  return page.model;
}
