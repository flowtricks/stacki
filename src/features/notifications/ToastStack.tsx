import { centralIcon } from '../../ui/central/CentralIcon';
import { checkCircle as centralCheckCircle, close as centralClose, info as centralInfo } from '../../ui/central/centralGeometry';
import { createPortal } from 'react-dom';
import { useToastHost } from './useToastHost';
import { runToastRecovery } from '../../ui/errorNotices';
import type { CSSProperties, ReactNode } from 'react';
import { useToastInteraction } from './useToastInteraction';
import { TOAST_LIMIT, type ToastNotice } from './useToastStack';
import { useToastLayout } from './useToastLayout';
import './toasts.css';

const CloseIcon = centralIcon(centralClose);
const SuccessIcon = centralIcon(centralCheckCircle, 20);
const InfoIcon = centralIcon(centralInfo, 20);

interface ToastStackProps<Notice extends ToastNotice> {
  readonly notices: readonly Notice[];
  readonly dismiss: (id: string) => void;
  readonly className?: string;
  readonly adornment?: (notice: Notice) => ReactNode;
  readonly action?: (notice: Notice) => ReactNode;
}

export function ToastStack<Notice extends ToastNotice>(props: ToastStackProps<Notice>) {
  const host = useToastHost();
  const layout = useToastLayout(props.notices);
  const style: CSSProperties & Record<string, string> = {
    '--toast-front-height': `${layout.positions[0]?.height ?? 0}px`,
  };
  return createPortal(
    <section
      ref={layout.ref}
      className="toast-stack"
      style={style}
      data-expanded={layout.expanded}
      data-scrollable={layout.scrollable}
      aria-label="Notifications"
      aria-live="polite"
      aria-relevant="additions"
      onMouseEnter={layout.onMouseEnter}
      onMouseLeave={layout.onMouseLeave}
      onFocus={layout.onFocus}
      onBlur={layout.onBlur}
    >
      <div className="toast-viewport" style={{ height: layout.height }}>
        <div className="toast-list" style={{ height: layout.height }}>
          {layout.expanded && layout.overflow && (
            <button type="button" className="toast-more" onClick={layout.showAll ? layout.showLess : layout.loadMore}>
              {layout.showAll ? 'Show fewer' : `Load more (${props.notices.length - layout.visibleCount})`}
            </button>
          )}
          {props.notices.slice(0, TOAST_LIMIT).map((notice, index) => (
            <ToastCard
              key={notice.id}
              notice={notice}
              layout={{
                index,
                offset: layout.positions[index]?.offset ?? 0,
                hidden: layout.expanded && index >= layout.visibleCount,
                paused: layout.expanded || (notice.recovery?.length ?? 0) > 0,
              }}
              dismiss={() => props.dismiss(notice.id)}
              className={props.className ?? ''}
              adornment={props.adornment?.(notice)}
              action={props.action?.(notice)}
            />
          ))}
        </div>
      </div>
    </section>,
    host,
  );
}

interface ToastCardLayout {
  readonly index: number;
  readonly offset: number;
  readonly hidden: boolean;
  readonly paused: boolean;
}

function ToastCard({
  notice,
  layout,
  dismiss,
  className,
  adornment,
  action,
}: {
  readonly notice: ToastNotice;
  readonly layout: ToastCardLayout;
  readonly dismiss: () => void;
  readonly className: string;
  readonly adornment: ReactNode;
  readonly action: ReactNode;
}) {
  const { leaving, offset, dragging, dismiss: close, ...interaction } = useToastInteraction({ paused: layout.paused }, dismiss);
  const style = {
    '--toast-index': layout.index,
    '--toast-stack-offset': `${layout.offset}px`,
    '--toast-drag-x': `${offset.x}px`,
    '--toast-drag-y': `${offset.y}px`,
    zIndex: TOAST_LIMIT - layout.index,
  } satisfies CSSProperties & Record<string, string | number>;
  return (
    <div className="toast-slot" style={style} data-toast-id={notice.id} data-hidden={layout.hidden} aria-hidden={layout.hidden}>
      <div
        className={`toast ${notice.kind} ${className}`}
        data-leaving={leaving}
        data-dragging={dragging}
        {...interaction}
        onPointerCancel={interaction.onLostPointerCapture}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        {adornment ?? <ToastIcon kind={notice.kind} />}
        <div className="toast-content">
          <span className="toast-message">{notice.message}</span>
          {action}
          <ToastRecoveryActions notice={notice} close={close} />
        </div>
        <ToastClose close={close} />
      </div>
    </div>
  );
}

function ToastClose({ close }: { readonly close: () => void }) {
  return (
    <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={close}>
      <CloseIcon />
    </button>
  );
}

function ToastIcon({ kind }: { readonly kind: ToastNotice['kind'] }) {
  return (
    <span className="toast-icon" aria-hidden="true">
      {kind === 'success' ? <SuccessIcon /> : <InfoIcon />}
    </span>
  );
}

function ToastRecoveryActions({ notice, close }: { readonly notice: ToastNotice; readonly close: () => void }) {
  return (
    <>
      {notice.recovery?.map((item) => (
        <button
          key={item.label}
          className="toast-recovery"
          onClick={() => {
            close();
            void runToastRecovery(item);
          }}
        >
          {item.label}
        </button>
      ))}
    </>
  );
}
