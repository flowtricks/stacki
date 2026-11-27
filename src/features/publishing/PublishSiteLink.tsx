import { ExternalIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

/** The arrow beside a destination that opens its site. */
export function OpenSiteLink({ url, label }: { readonly url: string; readonly label: string }) {
  const translate = useTranslate();
  return (
    <a
      className="stacki-publish-repository"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={translate('publish.menu.openUrl', { url })}
    >
      <ExternalIcon size={12} />
    </a>
  );
}
