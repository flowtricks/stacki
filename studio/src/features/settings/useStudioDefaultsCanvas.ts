import { useDefaultsKeyboard } from '../../../vendor/stacki/src/features/componentDefaults/useDefaultsKeyboard';
import { canvasNodeAt } from '../../../vendor/stacki/src/features/componentDefaults/defaultsCanvasModel';
import { getEditorRole } from '../roles/roleStore';
import { pathFor } from '../project/previewSelection';
import { isDefaultsCanvas } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { useEffect, useRef } from 'react';
import { useDefaultsCanvas } from '../../../vendor/stacki/src/features/componentDefaults/useDefaultsCanvas';
import { studioDefaultsHost } from './defaultsHost';
import { parsePage } from '../source/source';
import type { EditorProps } from '../../app/Editor';
import type { useEditor } from '../project/useEditor';

export function useStudioDefaultsCanvas(props: EditorProps, model: ReturnType<typeof useEditor>) {
  const previous = useRef({
    file: props.file,
    preview: props.previewFile,
    focus: props.focus,
    selected: model.selected,
  });
  const restore = useRef(false);
  const selected = useRef('');
  const opened = useRef('');
  const canvas = useDefaultsCanvas({
    project: props.project.name,
    defaults: studioDefaultsHost,
    isOpen: isDefaultsCanvas(props.file),
    open: async (session) => {
      await model.document?.whenSaved();
      if (opened.current !== session.file) {
        previous.current = {
          file: props.file,
          preview: props.previewFile,
          focus: props.focus,
          selected: model.selected,
        };
        opened.current = session.file;
      }
      selected.current = '';
      props.open(session.file, { path: session.targetPath, occurrence: 0 });
      props.view.setPanel('navigator');
      props.view.setTab('settings');
    },
    read: (session) => readDefaultsCanvas(props.file, model.document, session.file),
    leave: async () => {
      await model.document?.whenSaved();
      restore.current = true;
      props.open(previous.current.preview);
      props.open(previous.current.file, previous.current.focus);
    },
  });
  useEffect(() => {
    if (restore.current && props.file === previous.current.file && model.document?.ready) {
      model.select(previous.current.selected);
      restore.current = false;
    }
    if (canvas.state.kind === 'idle' || !model.document?.ready) {
      return;
    }
    const session = canvas.state.session;
    if (props.file !== session.file || selected.current === session.file) {
      return;
    }
    const target = canvasNodeAt(model.nodes, session.targetPath);
    if (target?.id) {
      model.select(target.id);
      selected.current = session.file;
    }
  }, [canvas.state, props.file, model]);
  const rootId = canvas.state.kind === 'idle' ? undefined : canvasNodeAt(model.nodes, canvas.state.session.targetPath)?.id;
  useDefaultsKeyboard(canvas, { selected: model.selected, root: rootId });
  const { subscribeOutside } = model.preview;
  useEffect(() => subscribeOutside(() => void canvas.run('done')), [canvas, subscribeOutside]);
  return {
    ...canvas,
    rootId,
    startForNode: (_name: string, id: string) => startForNode(props, model, canvas, id),
  };
}

async function startForNode(props: EditorProps, model: ReturnType<typeof useEditor>, canvas: ReturnType<typeof useDefaultsCanvas>, id: string) {
  if (getEditorRole() === 'client' || !model.document) {
    return;
  }
  await model.document.whenSaved();
  const source = model.document.text.toString();
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  await canvas.start({ file: props.file, source, model: parsed.model, path: pathFor(id) });
}

async function readDefaultsCanvas(file: string, document: ReturnType<typeof useEditor>['document'], expectedFile: string) {
  if (!document || file !== expectedFile) {
    throw new Error('Return to the defaults canvas before saving.');
  }
  await document.whenSaved();
  const parsed = parsePage(document.text.toString());
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  return parsed.model;
}
