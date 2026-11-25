import { isMobileEditor } from '../../app/mobileEditor';
import { useCallback } from 'react';
import VariablesView from '../../../vendor/stacki/src/features/variables/VariablesView';
import VariablesPanel from '../../../vendor/stacki/src/features/variables/VariablesPanel';
import type { VariableUndo } from '../../../vendor/stacki/src/features/variables/variableHistory';
import type { SharedDocument } from '../collaboration/useDocument';
import type { EditorProps } from '../../app/Editor';

export function VariablesWorkspace({ props, document }: { readonly props: EditorProps; readonly document: SharedDocument | undefined }) {
  const { report } = props;
  const toast = useCallback((message: string) => report(message), [report]);
  const record = useCallback(
    (command: VariableUndo) => {
      document?.recordCommand({
        undo: command.undo,
        redo: command.redo,
        ...(command.coalesceKey ? { coalesceKey: command.coalesceKey } : {}),
      });
    },
    [document],
  );
  if (!props.view.variable) {
    return null;
  }
  return (
    <VariablesView
      project={{ path: 'studio' }}
      selected={props.view.variable}
      hidden={props.view.panel !== 'variables'}
      onDock={() => props.view.setPanel('variables')}
      onClose={() => {
        props.view.setVariable(undefined);
        if (!isMobileEditor()) {
          props.view.setPanel(undefined);
        }
      }}
      showToast={toast}
      onRecordUndo={record}
    />
  );
}
// The open document decides which `<style>` variables the panel lists, as on
// Desktop: a page's or a component's own only while it is the one open.
export function VariableNavigation({ view, file }: { readonly view: EditorProps['view']; readonly file: string }) {
  return (
    <VariablesPanel project={{ path: 'studio' }} place={{ openFile: file, contextPage: undefined }} selected={view.variable} onSelect={view.setVariable} />
  );
}
