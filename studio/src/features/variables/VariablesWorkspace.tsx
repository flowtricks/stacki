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
        if (!window.matchMedia('(max-width: 700px)').matches) {
          props.view.setPanel(undefined);
        }
      }}
      showToast={toast}
      onRecordUndo={record}
    />
  );
}
export function VariableNavigation({ view }: { readonly view: EditorProps['view'] }) {
  return <VariablesPanel project={{ path: 'studio' }} selected={view.variable} onSelect={view.setVariable} />;
}
