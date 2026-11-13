import React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { LocaleContext } from '../lib/i18n/localeContext';

// A render error inside one panel stays inside that panel.
//
// React unmounts the whole tree when a render throws and nothing catches it,
// so one bad value in the Style panel (an assertion on a one-letter tag, once)
// blanked the entire window and read as a crash; the only way back was Reload
// All Code. Each panel, the Navigator, the canvas and the app itself sit in one
// of these instead. A failed panel shows what broke and a Try again button; the
// rest of the app keeps working, and the page on disk is untouched, since
// rendering never writes.
//
// It resets on its own when `resetKey` changes (the selection, the page), so
// picking another element brings the panel back without a click.

interface PanelBoundaryProps {
  /** The panel's name for the log; `label` is what a person reads, and callers translate it. */
  readonly name: string;
  readonly label?: string | undefined;
  readonly resetKey?: string | undefined;
  readonly children: ReactNode;
}

type PanelBoundaryState = { readonly failure: undefined } | { readonly failure: { readonly message: string; readonly resetKey: string | undefined } };

export default class PanelBoundary extends React.Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { failure: undefined };

  static getDerivedStateFromError(error: unknown): Partial<PanelBoundaryState> {
    return { failure: { message: error instanceof Error ? error.message : String(error), resetKey: undefined } };
  }

  static getDerivedStateFromProps(props: PanelBoundaryProps, state: PanelBoundaryState): PanelBoundaryState | undefined {
    if (state.failure === undefined) {
      return undefined;
    }
    // The failure remembers the key it happened under; a new key is a new
    // selection or page, and the panel tries again with it.
    if (state.failure.resetKey === undefined) {
      return { failure: { ...state.failure, resetKey: props.resetKey ?? '' } };
    }
    if (state.failure.resetKey !== (props.resetKey ?? '')) {
      return { failure: undefined };
    }
    return undefined;
  }

  // A class cannot call a hook: the context gives it the same translator.
  static override contextType = LocaleContext;
  declare context: React.ContextType<typeof LocaleContext>;

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // React has already logged the error; this names the panel it stayed in.
    console.error(`[${this.props.name}] render error contained by its panel`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (failure === undefined) {
      return this.props.children;
    }
    return (
      <div className="panel-boundary" role="alert">
        <div className="panel-boundary-title">{this.context.translate('ui.panelBoundary.title', { name: this.props.label ?? this.props.name })}</div>
        <div className="panel-boundary-message">{failure.message}</div>
        <button type="button" className="panel-boundary-retry" onClick={() => this.setState({ failure: undefined })}>
          {this.context.translate('ui.panelBoundary.retry')}
        </button>
      </div>
    );
  }
}
