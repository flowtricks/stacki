import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { Avatar } from '../auth/Avatar';
import type { ActionableNotice } from '../notifications/notice';
import './lockedSettings.css';

export function LockedSettings({ notice, report }: { readonly notice: ActionableNotice; readonly report: (error: unknown) => void }) {
  const translate = useTranslate();
  const action = notice.details.action;
  const person = notice.details.person;
  const name = person?.name ?? translate('settings.element.anotherEditor');
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>{translate('settings.title')}</h2>
      </div>
      <section className="locked-settings" aria-label={translate('settings.element.lockedAria')}>
        <div className="locked-settings-person">
          <span className="locked-settings-avatar">
            <Avatar key={person?.id ?? name} id={person?.id} name={name} />
          </span>
          <div className="locked-settings-identity">
            <span className="locked-settings-name">{name}</span>
            <span className="locked-settings-status">{translate('settings.element.currentlyEditing')}</span>
          </div>
        </div>
        <h3>{translate('settings.element.beingEdited')}</h3>
        <p>{translate('settings.element.takeOver')}</p>
        {action && (
          <button type="button" className="locked-settings-action" onClick={() => void Promise.resolve().then(action.run).catch(report)}>
            {action.label}
          </button>
        )}
      </section>
    </div>
  );
}
