// Deleting what the Pages panel's Select mode has ticked: plan it (nothing written), ask in the app's own confirm
// dialog with what will happen, then hand the host one request. The host owns the write and its undo step; this owns
// only the order of the questions, so Studio or a test can supply a host of its own.
import { useCallback, useState } from 'react';
import type { AppError, Result } from '../../../shared/core/result';
import type { PageBulkRemoveRequest, PageBulkRemoveSummary } from '../../../shared/properties/pageBulkRemove';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { confirmDialog } from '../../ui/ConfirmDialog';
import './pageSelect.css';

/** What a host that can delete several pages at once offers the panel. */
export interface PageBulkRemoveHost {
  readonly plan: (request: PageBulkRemoveRequest) => Promise<Result<PageBulkRemoveSummary>>;
  /** Writes the deletion and records its single undo step; false when it was refused (the host has said why). */
  readonly apply: (request: PageBulkRemoveRequest) => Promise<Result<void>>;
  /** Shows a refusal where the host shows errors. */
  readonly fail: (error: AppError) => void;
}

/** "3 pages", "1 folder" or "3 pages and 1 folder": what a deletion removes, as a title and a toast say it. */
export function describeRemoval(summary: Pick<PageBulkRemoveSummary, 'pages' | 'folders'>, translate: Translator): string {
  const pages = translate('pages.select.pagesCount', { count: summary.pages });
  const folders = translate('pages.select.foldersCount', { count: summary.folders });
  if (summary.folders === 0) {
    return pages;
  }
  return summary.pages === 0 ? folders : translate('pages.select.both', { pages, folders });
}

const REVIEWS_SHOWN = 5;

export function usePageBulkRemoveFlow(host: PageBulkRemoveHost | undefined, done: () => void) {
  const translate = useTranslate();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (request: PageBulkRemoveRequest) => {
      if (host === undefined || busy) {
        return;
      }
      setBusy(true);
      try {
        const planned = await host.plan(request);
        if (!planned.ok) {
          host.fail(planned.error);
          return;
        }
        const summary = planned.value;
        const sure = await confirmDialog({
          title: translate('pages.select.confirm.title', { what: describeRemoval(summary, translate) }),
          body: <RemovalBody summary={summary} />,
          confirmLabel: translate('pages.select.delete'),
          danger: true,
        });
        if (sure === false) {
          return;
        }
        const applied = await host.apply(request);
        if (applied.ok) {
          done();
        } else {
          host.fail(applied.error);
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, done, host, translate],
  );
  return { busy, run };
}

function RemovalBody({ summary }: { readonly summary: PageBulkRemoveSummary }) {
  const translate = useTranslate();
  const { impact } = summary;
  const shown = impact.reviews.slice(0, REVIEWS_SHOWN);
  const more = impact.reviews.length - shown.length + impact.reviewsMore;
  return (
    <div className="page-select-confirm">
      <p>{translate('pages.select.confirm.files', { count: summary.pages })}</p>
      {summary.errorPages > 0 && <p>{translate('pages.select.confirm.errorPage')}</p>}
      <p>{impact.links === 0 ? translate('pages.select.confirm.noLinks') : translate('pages.select.confirm.links', { count: impact.links })}</p>
      {shown.length > 0 && (
        <ul>
          {shown.map((review) => (
            <li key={review.file + ':' + review.line}>
              <span className="page-select-confirm-place">
                {review.file}:{review.line}
              </span>
              <span className="page-select-confirm-text">{review.text}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p>{translate('pages.settings.confirm.reviewMore', { count: more })}</p>}
    </div>
  );
}
