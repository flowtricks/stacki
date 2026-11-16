import React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { LocaleContext } from '../../lib/i18n/localeContext';
import { RecoveryScreen } from './RecoveryScreen';
import { describeRenderError, type RecoveryDetails } from './recoveryDetails';

// The last net under the interface: whatever a render throws that no pane's boundary (src/ui/PanelBoundary.tsx) caught,
// including the app's own hooks and a chunk that failed to load, ends here and shows the recovery screen. Without it
// React unmounts the whole tree on an uncaught render error, which is a black window with nothing to read.
//
// It has no reset key and no "try again" of its own: a failure that reached here is one the app could not contain,
// so the way back is the screen's Reload, which starts the interface from scratch.

interface AppBoundaryState {
  readonly failure: RecoveryDetails | undefined;
}

export class AppBoundary extends React.Component<{ readonly children: ReactNode }, AppBoundaryState> {
  override state: AppBoundaryState = { failure: undefined };

  static getDerivedStateFromError(error: unknown): AppBoundaryState {
    return { failure: describeRenderError(error, undefined) };
  }

  // A class cannot call a hook: the context gives it the same translator.
  static override contextType = LocaleContext;
  declare context: React.ContextType<typeof LocaleContext>;

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The component stack only exists here; it replaces the stackless description so Copy details can say where.
    console.error('[app] render error reached the top of the interface', error, info.componentStack);
    this.setState({ failure: describeRenderError(error, info.componentStack ?? undefined) });
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (failure === undefined) {
      return this.props.children;
    }
    return <RecoveryScreen reason={this.context.translate('recovery.reason.renderError', { message: failure.message })} details={failure.text} />;
  }
}
