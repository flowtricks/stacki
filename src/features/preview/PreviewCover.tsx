// What stands over the canvas while the preview is not there (previewSupervisor.ts): placeholder shapes while it is
// started again, and when that did not work, what happened and the button that tries again. The canvas is never left
// blank without either.
import { EmptyState } from '../../ui/EmptyState';
import { RefreshIcon } from '../../ui/Icons';
import { SkeletonRows, Skeleton } from '../../ui/Skeleton';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { restartPreview, useSupervision } from './previewSupervisorBus';
import './previewCover.css';

export function PreviewCover() {
  const translate = useTranslate();
  const { state } = useSupervision();
  switch (state.kind) {
    case 'ok': {
      return undefined;
    }
    case 'restarting': {
      return (
        <div className="preview-cover" data-preview-cover="restarting">
          <div className="preview-cover-skeleton">
            <Skeleton height="40%" radius="10px" />
            <SkeletonRows count={5} />
          </div>
        </div>
      );
    }
    case 'stopped': {
      return (
        <div className="preview-cover" data-preview-cover="stopped">
          <EmptyState
            align="center"
            icon={<RefreshIcon size={18} />}
            title={translate('preview.stopped.title')}
            action={
              <button type="button" className="primary" onClick={restartPreview}>
                {translate('preview.stopped.restart')}
              </button>
            }
          />
        </div>
      );
    }
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
