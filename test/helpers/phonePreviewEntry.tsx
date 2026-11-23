// The phone preview as Desktop mounts it, for test/renderer/preview/phonePreview.test.js: the globe in the
// address bar's markup (AppShell UrlGroup, its `trailing` slot before "Open in browser"), beside the
// window's confirmation host.
import { ConfirmHost } from '../../src/ui/ConfirmDialog';
import { PhonePreviewButton } from '../../src/features/preview/phone/PhonePreviewMenu';

export { QR_TILE_PX } from '../../src/features/preview/phone/QrCodeImage';

export function PhonePreviewHost(props: { readonly devStatus: string; readonly route: string; readonly showToast: (message: string, kind: 'error') => void }) {
  return (
    <>
      <ConfirmHost />
      <div className="url-bar">
        <input className="url" readOnly value="http://127.0.0.1:4321/" />
        <PhonePreviewButton projectPath="/site" devUrl="http://127.0.0.1:4321" devStatus={props.devStatus} route={props.route} showToast={props.showToast} />
        <button type="button" className="titlebar-btn url-open" aria-label="Open in browser" />
      </div>
    </>
  );
}
