import './cms.css';
import { useCallback, useState } from 'react';
import CmsPanel from '../../../vendor/stacki/src/features/cms/CmsPanel';
import CmsView from '../../../vendor/stacki/src/features/cms/CmsView';
import ContentView from '../../../vendor/stacki/src/features/content/ContentView';
import { RemoteCmsView } from '../../../vendor/stacki/src/features/cms/RemoteCmsView';
import type { RemoteCmsSelection } from '../../../vendor/stacki/src/features/cms/remoteCmsShared';
import { CmsConnectionsDialog } from './CmsConnectionsDialog';
import { AssetsPanel } from '../assets/AssetsPanel';
import { AssetPickOverlay, assetPickTitle } from '../../../vendor/stacki/src/ui/AssetPickOverlay';
import { clearAssetRequest } from '../../../vendor/stacki/src/ui/assetPick';
import type { CmsUndo } from '../../../vendor/stacki/src/features/cms/cmsWriter';
import type { EditorProps } from '../../app/Editor';
import type { SharedDocument } from '../collaboration/useDocument';

export type CmsSelection =
  | { readonly kind: 'data'; readonly rel: string; readonly settings: boolean }
  | { readonly kind: 'content'; readonly name: string }
  | { readonly kind: 'remote'; readonly selection: RemoteCmsSelection };
export function CmsNavigation({ props }: { readonly props: EditorProps }) {
  const { cms, setCms } = props.view;
  // Reopening the panel's list after the connections dialog reads the new ones.
  const [connecting, setConnecting] = useState(false);
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  return (
    <>
      <CmsPanel
        project={{ path: 'studio' }}
        selectedRel={cms?.kind === 'data' ? cms.rel : undefined}
        selectedContent={cms?.kind === 'content' ? cms.name : undefined}
        selectedRemote={cms?.kind === 'remote' ? cms.selection : undefined}
        onSelectRemote={(selection) => setCms(selection === undefined ? undefined : { kind: 'remote', selection })}
        onConnect={() => setConnecting(true)}
        currentFile={props.file.replace(/^src\//, '')}
        refreshKey={`${props.project.pages.length}:${connectionsRevision}`}
        onSelect={(rel) => setCms(rel === undefined ? undefined : { kind: 'data', rel, settings: false })}
        onSelectContent={(name) => setCms(name === undefined ? undefined : { kind: 'content', name })}
        onOpenSettings={(rel) => setCms({ kind: 'data', rel, settings: true })}
        showToast={props.report}
      />
      {connecting && (
        <CmsConnectionsDialog
          onClose={() => {
            setConnecting(false);
            setConnectionsRevision((count) => count + 1);
          }}
        />
      )}
    </>
  );
}
export function CmsWorkspace({ props, document }: { readonly props: EditorProps; readonly document: SharedDocument | undefined }) {
  const { cms, setCms, panel, setPanel } = props.view;
  const record = useCallback(
    (command: CmsUndo) => {
      document?.recordCommand({
        undo: command.undo,
        redo: command.redo,
        coalesceKey: command.coalesceKey,
      });
    },
    [document],
  );
  const close = () => {
    if (window.matchMedia('(max-width: 700px)').matches) {
      setCms(undefined);
    } else {
      setPanel(undefined);
    }
  };
  if (!cms) {
    return null;
  }
  if (cms.kind === 'remote') {
    return <RemoteWorkspace props={props} selection={cms.selection} />;
  }
  if (cms.kind === 'content') {
    return (
      <ContentView key={cms.name} project={{ path: 'studio' }} name={cms.name} hidden={panel !== 'collections'} showToast={props.report} onClose={close} />
    );
  }
  return (
    <CmsView
      project={{ path: 'studio' }}
      rel={cms.rel}
      settings={cms.settings}
      hidden={panel !== 'collections'}
      showToast={props.report}
      onRecordUndo={record}
      onClose={close}
      onCloseSettings={() => setCms({ ...cms, settings: false })}
      onDeleted={() => {
        setCms(undefined);
        props.refresh();
      }}
    />
  );
}

// A connected CMS's collection, or the project's content collections; an
// entry's image is chosen in a pop-up over it, so the entry stays open.
function RemoteWorkspace({ props, selection }: { readonly props: EditorProps; readonly selection: RemoteCmsSelection }) {
  const { panel, setCms, pick } = props.view;
  return (
    <>
      <RemoteCmsView
        key={`${selection.connection.id}:${selection.collection}`}
        projectPath="studio"
        selection={selection}
        hidden={panel !== 'collections'}
        onSelect={(next) => setCms(next === undefined ? undefined : { kind: 'remote', selection: next })}
      />
      {pick?.presentation === 'overlay' && (
        <AssetPickOverlay title={assetPickTitle(pick.mediaKind)} onClose={clearAssetRequest}>
          <AssetsPanel project={props.project} refresh={props.refresh} error={props.report} pick={pick} />
        </AssetPickOverlay>
      )}
    </>
  );
}
