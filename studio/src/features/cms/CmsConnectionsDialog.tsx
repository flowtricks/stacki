// Studio's place to add or remove CMS connections: the same screen Desktop shows
// in Settings, in a dialog opened from the CMS panel's "Connect a CMS" row.
import Popup from '../../../vendor/stacki/src/ui/Popup';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { CloseIcon } from '../../../vendor/stacki/src/ui/Icons';
import { CmsConnections } from '../../../vendor/stacki/src/features/cmsConnections/CmsConnections';

export function CmsConnectionsDialog(props: { readonly onClose: () => void }) {
  const translate = useTranslate();
  return (
    <Popup className="modal cms-connections-dialog" label={translate('cmsConnections.title')} onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header cms-modal-header">
            <span>{translate('cmsConnections.dialog.title')}</span>
            <button className="ghost" title={translate('ui.close')} onClick={close}>
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
