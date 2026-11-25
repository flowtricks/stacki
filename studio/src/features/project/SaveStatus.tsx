// The save status beside the project name. Quiet states are plain words; "Needs attention" becomes a button that opens the shared Menu
// listing each cause in plain language with the action that fixes it, and the word itself names the cause when there is only one.
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import Menu, { useMenuTrigger } from '../../../vendor/stacki/src/ui/Menu';
import { attentionEntries } from '../collaboration/attention';
import { NEEDS_ATTENTION, saveStatusLabel } from '../collaboration/saveStatus';
import type { SharedDocument } from '../collaboration/useDocument';

export function SaveStatus({ document, report }: { readonly document: SharedDocument | undefined; readonly report: (error: unknown) => void }) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const status = document?.status ?? 'Connecting';
  const label = saveStatusLabel(status, translate, document?.attention);
  if (document === undefined || status !== NEEDS_ATTENTION) {
    return (
      <span className="save-state" role="status" data-saved={status === 'Saved' ? '' : undefined}>
        {label}
      </span>
    );
  }
  const entries = attentionEntries(document.attention, translate, {
    retry: () => document.retrySave(),
    copyDraft: () => {
      navigator.clipboard.writeText(document.text.toString()).catch(report);
    },
  });
  return (
    <span className="save-state" role="status" data-attention="">
      <button type="button" ref={trigger.ref} className="save-state-button" aria-haspopup="menu" aria-expanded={trigger.open} onClick={trigger.toggle}>
        {label}
      </button>
      <Menu open={trigger.open} anchor={trigger.anchor} entries={entries} label={translate('studio.attention.menu')} onClose={trigger.close} />
    </span>
  );
}
