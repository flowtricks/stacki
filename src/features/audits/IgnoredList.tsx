// The Audits panel's "Ignored" view: everything the project ignores, grouped by
// file, so it can be read and taken back. A file ignored whole shows its reason and
// how many findings it hides; findings ignored one by one list under their file with
// their own reason; an entry the audit no longer reports (a deleted page, markup that
// moved) is still listed so it can be removed. Unignore edits only that entry in
// `.stacki/audits.json`; "Unignore all" asks first.
import { useState } from 'react';
import type { AuditFinding } from '../../../shared/page/auditFindings';
import { ignoredEntryCount, ignoredGroups } from '../../../shared/properties/auditIgnoreList';
import type { AuditIgnores } from '../../../shared/properties/auditIgnores';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FileKindIcon, type Actions } from './AuditsPanel';

export function IgnoredList(props: { readonly findings: readonly AuditFinding[]; readonly ignores: AuditIgnores; readonly actions: Actions }) {
  const translate = useTranslate();
  const [confirming, setConfirming] = useState(false);
  const groups = ignoredGroups(props.findings, props.ignores);
  const total = ignoredEntryCount(props.ignores);
  if (groups.length === 0) {
    return <p className="audits-note">{translate('audits.ignored.empty')}</p>;
  }
  return (
    <div className="audits-ignored">
      <div className="audits-ignored-head">
        <button className="audits-link" disabled={props.actions.busy} onClick={() => setConfirming(true)}>
          {translate('audits.ignored.all')}
        </button>
      </div>
      {confirming && (
        <div className="audits-inset audits-actions" role="alertdialog" aria-label={translate('audits.ignored.all')}>
          <span>{translate('audits.ignored.allConfirm', { count: total })}</span>
          <button
            className="audits-link"
            onClick={() => {
              setConfirming(false);
              void props.actions.unignoreAll();
            }}
          >
            {translate('audits.ignored.all')}
          </button>
          <button className="audits-link muted" onClick={() => setConfirming(false)}>
            {translate('audits.ignored.cancel')}
          </button>
        </div>
      )}
      {groups.map((group) => (
        <section key={group.file} className="audits-ignored-group" aria-label={group.file}>
          <div className="list-item audits-row audits-group-row">
            <FileKindIcon file={group.file} kind={undefined} />
            <span className="label audits-title" title={group.file}>
              {group.file}
            </span>
          </div>
          {group.page !== undefined && (
            <div className="list-item audits-row audits-ignored-row">
              <span className="label audits-title">{translate('audits.ignored.page', { reason: group.page.reason })}</span>
              <span className="audits-muted-text">
                {group.page.count === 0 ? translate('audits.ignored.stale') : translate('audits.ignored.pageCount', { count: group.page.count })}
              </span>
              <button className="audits-link" disabled={props.actions.busy} onClick={() => void props.actions.unignorePage(group.file)}>
                {translate('audits.ignored.unignore')}
              </button>
            </div>
          )}
          {group.findings.map((row) => (
            <div key={row.id} className="list-item audits-row audits-ignored-row">
              <span className="label audits-title" title={row.label}>
                {row.label}
              </span>
              <span className="audits-muted-text" title={row.reason}>
                {row.live ? row.reason : `${row.reason} · ${translate('audits.ignored.stale')}`}
              </span>
              <button className="audits-link" disabled={props.actions.busy} onClick={() => void props.actions.unignoreIds([row.id])}>
                {translate('audits.ignored.unignore')}
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
