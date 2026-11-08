// The Settings panel's handlers that change a page's structure or reach past the
// selected node, wired as Desktop wires them (settingsValues and settingsHandlers
// in src/app/shell/AppPanes.tsx): the Tag field's options and kind change, the
// layout picker, an element's whole attribute list, a component's list props, a
// loop's Code row, its property settings and a variable rename, a condition's
// else branch, and a text connected to data. Each write goes through
// settingsGestures.ts, which builds Desktop's gesture and plans it as Desktop does.
import { useMemo } from 'react';
import type { PropsPanelProps } from '../../../vendor/stacki/src/features/props/propsPanelTypes';
import type { NewPropHost } from '../../../vendor/stacki/src/features/props/newPropModel';
import { useListProps } from '../../../vendor/stacki/src/app/state/useListProps';
import { editLoopProperty } from '../../../vendor/stacki/src/app/state/loopPropertyEdit';
import type { SharedDocument } from '../collaboration/useDocument';
import type { Component, Project } from '../project/projectClient';
import { revertComponentProperties } from '../componentProperties/propertyTransport';
import { usePropertySaveGuard } from '../componentProperties/usePropertySaveGuard';
import {
  changedLayout,
  changedTag,
  committedLoopHead,
  layoutOptions,
  newPropHost,
  renamedVariable,
  replacedProps,
  tagOptions,
  textPieces,
  toggledElse,
} from './settingsGestures';

interface StructureInput {
  readonly document: SharedDocument;
  readonly selected: string;
  readonly component: Component | undefined;
  readonly project: Project;
  readonly source: string;
  /** Says what went wrong, as every Settings write does. */
  readonly error: (error: unknown) => void;
}

export type StructureSettings = Pick<
  PropsPanelProps,
  | 'tagOptions'
  | 'onChangeTag'
  | 'layouts'
  | 'onChangeLayout'
  | 'onReplaceProps'
  | 'listProps'
  | 'onCommitLoopHead'
  | 'onRenameVariable'
  | 'onEditLoopProperty'
  | 'onToggleElse'
  | 'onSetTextPieces'
>;

export function useStructureSettings(input: StructureInput): { readonly handlers: StructureSettings; readonly newProp: NewPropHost | undefined } {
  const { document, selected, project, source } = input;
  const file = document.file;
  const listProps = useListProps('studio', input.component?.file);
  const { changePhase } = usePropertySaveGuard();
  const options = useMemo(() => tagOptions(project, source), [project, source]);
  const layouts = useMemo(() => layoutOptions(project), [project]);
  const current = (): string => document.text.toString();
  const write = (next: string): void => {
    if (next !== current()) {
      document.replaceSource(next);
    }
  };
  // A write that throws says why and leaves the page alone.
  const attempt = <T>(run: () => T, failed: T): T => {
    try {
      return run();
    } catch (error) {
      input.error(error);
      return failed;
    }
  };
  const handlers: StructureSettings = {
    tagOptions: options,
    // False puts the old name back in the field, as Desktop's does when nothing provides it.
    onChangeTag: (name: string) =>
      attempt(() => {
        const next = changedTag(current(), file, selected, name, project);
        if (next === undefined) {
          return false;
        }
        write(next);
        return true;
      }, false),
    layouts,
    onChangeLayout: (name: string) => attempt(() => write(changedLayout(current(), file, name, project)), undefined),
    onReplaceProps: (id, props) => attempt(() => write(replacedProps(current(), id, props)), undefined),
    listProps,
    onCommitLoopHead: (value, renames) =>
      attempt(() => {
        const result = committedLoopHead(current(), selected, value, renames);
        if (!result.ok) {
          return result.error;
        }
        write(result.value);
        return undefined;
      }, 'This loop could not be changed. Edit it in Code.'),
    onRenameVariable: (rename) =>
      attempt(() => {
        const result = renamedVariable(current(), rename);
        if (!result.ok) {
          return result.error;
        }
        write(result.value);
        return undefined;
      }, 'This name could not be changed. Rename it in Code.'),
    // The property is renamed through the Properties panel's transaction: the open
    // file saved first, every page passing it updated, one undo step (Desktop's
    // loopPropertyEditor in AppPanes.tsx).
    onEditLoopProperty: (key, edit) =>
      editLoopProperty(
        {
          projectPath: 'studio',
          file,
          flushSave: () => document.whenSaved(),
          changePhase,
          recordUndo: (initial) => {
            let token = initial;
            const restore = async () => {
              await document.whenSaved();
              const result = await revertComponentProperties(token);
              if (!result.ok) {
                throw new Error(result.error.message);
              }
              token = result.value.undo;
            };
            document.recordCommand({ undo: restore, redo: restore });
          },
          completeSave: async () => undefined,
        },
        key,
        edit,
      ),
    onToggleElse: (want) => attempt(() => write(toggledElse(current(), selected, want)), undefined),
    onSetTextPieces: (pieces) => attempt(() => write(textPieces(current(), selected, pieces)), undefined),
  };
  const declared = project.components.find((entry) => entry.file === file)?.fields.map((field) => field.name) ?? [];
  const newProp = newPropHost(file, source, declared, write);
  return { handlers, newProp };
}
