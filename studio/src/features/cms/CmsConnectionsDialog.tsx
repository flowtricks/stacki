// Studio's place to add or remove CMS connections: the same screen Desktop shows
// in Settings, in a dialog opened from the CMS panel's "Connect a CMS" row.
import Popup from '../../../vendor/stacki/src/ui/Popup';
import { CloseIcon } from '../../../vendor/stacki/src/ui/Icons';
import { CmsConnections } from '../../../vendor/stacki/src/features/cmsConnections/CmsConnections';

export function CmsConnectionsDialog(props: { readonly onClose: () => void }) {
  return (
    <Popup
      className="modal cms-connections-dialog"
      label="CMS connections"
      onClose={props.onClose}
      dismissible={true}
    >
      {({ close }) => (
        <>
          <div className="modal-header cms-modal-header">
            <span>Connect a CMS</span>
            <button className="ghost" title="Close" onClick={close}>
              <CloseIcon size={12} />
            </button>
          </div>
          <div className="modal-body">
            <CmsConnections projectPath="studio" />
          </div>
        </>
      )}
    </Popup>
  );
}
