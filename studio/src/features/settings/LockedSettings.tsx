import { Avatar } from '../auth/Avatar';
import type { ActionableNotice } from '../notifications/notice';
import './lockedSettings.css';

export function LockedSettings({ notice, report }: { readonly notice: ActionableNotice; readonly report: (error: unknown) => void }) {
  const action = notice.details.action;
  const person = notice.details.person;
  const name = person?.name ?? 'Another editor';
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Settings</h2>
      </div>
      <section className="locked-settings" aria-label="Element editing status">
        <div className="locked-settings-person">
          <span className="locked-settings-avatar">
            <Avatar key={person?.id ?? name} id={person?.id} name={name} />
          </span>
          <div className="locked-settings-identity">
            <span className="locked-settings-name">{name}</span>
            <span className="locked-settings-status">Currently editing</span>
          </div>
        </div>
        <h3>This element is being edited</h3>
        <p>You can still select it and add elements inside. Take over to change its settings.</p>
        {action && (
          <button type="button" className="locked-settings-action" onClick={() => void Promise.resolve().then(action.run).catch(report)}>
            {action.label}
          </button>
        )}
      </section>
    </div>
  );
}
