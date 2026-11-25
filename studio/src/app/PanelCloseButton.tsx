import { CloseIcon } from '../../vendor/stacki/src/ui/Icons';

// Closes a side panel floating over the canvas in the collapsed layout (mobileEditor.ts).
// Docked panels have no close button: studio.css shows it only while the editor is collapsed.
export function PanelCloseButton({ label, close }: { readonly label: string; readonly close: () => void }) {
  return (
    <button type="button" className="panel-close ghost" onClick={close} aria-label={label} title={label}>
      <CloseIcon size={14} />
    </button>
  );
}
