import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import type { PublishStage, PublishState } from './publish';

const stages: Readonly<Record<PublishStage, { readonly done: number; readonly label: string }>> = {
  preparing: { done: 0, label: 'Preparing files' },
  building: { done: 1, label: 'Building website' },
  committing: { done: 2, label: 'Saving to GitHub' },
  cleanup: { done: 3, label: 'Cleaning up storage' },
  deploying: { done: 4, label: 'Deploying live website' },
};

export function PublishProgress({
  state,
  busy,
  failed,
  dismiss,
}: {
  readonly state: PublishState | undefined;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly dismiss: () => void;
}) {
  const { error, done, total, label, title, hint } = progressView(state, failed);
  if (state?.kind === 'review-open') {
    return (
      <section className="studio-publish-progress" aria-label="Review ready">
        <strong>Ready for review</strong>
        <p>
          <a href={state.url} target="_blank" rel="noreferrer">
            Open pull request
          </a>
        </p>
        <p>Your live site is unchanged. Merge and deploy through GitHub.</p>
        <button onClick={dismiss}>Dismiss</button>
      </section>
    );
  }
  if (error) {
    return <ErrorToast message={state?.kind === 'failed' ? state.message : 'Publishing did not finish. Please try again.'} />;
  }
  return (
    <section className="studio-publish-progress" aria-label="Publish progress" aria-busy={busy}>
      <div className="studio-publish-progress-heading">
        <strong>{title}</strong>
        {!busy && (
          <button aria-label="Dismiss publish progress" onClick={dismiss}>
            ×
          </button>
        )}
      </div>
      <div className="studio-publish-progress-status" role="status" aria-live="polite">
        <span>{label}</span>
        {!error && done !== undefined && (
          <span>
            {done}/{total} steps
          </span>
        )}
      </div>
      <div className="studio-publish-track">
        <progress
          max={total}
          value={done}
          aria-label="Publish stages completed"
          aria-valuetext={done === undefined ? label : `${done} of ${total} stages complete. ${label}`}
        />
      </div>
      <p>{hint}</p>
    </section>
  );
}

function progressView(state: PublishState | undefined, failed: boolean) {
  const committed = state?.kind === 'committed';
  const live = committed && state.deployment === 'live';
  const pending = committed && state.deployment === 'pending';
  const complete = committed && !pending;
  const total = state && 'deployment' in state && state.deployment ? 5 : 4;
  const error = failed || state?.kind === 'failed';
  const stage = state?.kind === 'building' && state.stage ? stages[state.stage] : undefined;
  const done = complete ? total : pending ? 4 : stage?.done;
  const label = error ? 'Publish interrupted' : complete ? 'Saved to GitHub' : (stage?.label ?? 'Starting publish');

  const title = error ? 'Publish needs attention' : live ? 'Your site is live' : committed ? 'Saved to GitHub' : 'Publishing';
  const hint = error
    ? 'Check the error details before trying again.'
    : live
      ? 'Hosting deployment completed.'
      : pending
        ? 'Deployment is still unconfirmed. Check your hosting provider before publishing again.'
        : committed
          ? 'Live deployment is not connected in this Studio.'
          : publishingHint(state);
  return {
    error,
    done,
    total,
    label: live ? 'Changes are live' : pending ? 'Awaiting live deployment' : label,
    title,
    hint,
  };
}

function publishingHint(state: PublishState | undefined): string {
  const stage = state?.kind === 'building' ? state.stage : undefined;
  switch (stage) {
    case 'preparing':
      return 'Saving your draft and preparing the files to publish.';
    case 'building':
      return 'Generating your website. Publishing continues if you switch tabs.';
    case 'committing':
      return 'Uploading your changes to GitHub.';
    case 'cleanup':
      return 'Releasing temporary files before the final deployment check.';
    case 'deploying':
      return 'Waiting for hosting to serve this update. You can switch tabs.';
    case undefined:
      return 'Starting your publish. You can continue working while it runs.';
  }
}
