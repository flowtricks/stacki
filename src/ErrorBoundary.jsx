// What stands between one broken panel and an empty window.
//
// React's answer to an uncaught render error is to unmount the whole tree —
// so without a boundary, one bad prop shape in one panel blanks the window
// with no message and no route back, in an app that is at that moment holding
// unsaved edits. A boundary per panel region instead of one at the root means
// the crash stays the size of the panel it happened in: a broken style panel
// does not take the canvas with it.
//
// The fallback says what failed and offers a way back. "Try again" remounts
// the children — enough when the crash came from a state the user has since
// navigated away from. The root boundary (main.jsx) passes `root`, where a
// remount would rebuild the app from nothing anyway, so the button reloads
// the window instead and says so.
//
// Callers whose contents change identity (the left panel's tabs) key the
// boundary on that identity, so switching to a different tab is itself the
// way out rather than showing the previous tab's crash.

import React from 'react';
import { cleanError } from './cleanError.js';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The boundary swallows the throw; the stack still belongs in the console
    // where a bug report can find it.
    console.error(`Crash in ${this.props.label || 'a panel'}:`, error, info?.componentStack || '');
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label = 'this panel', root } = this.props;
    return (
      <div className={`crash ${root ? 'crash-root' : ''}`} role="alert">
        <div className="crash-title">Something broke in {label}</div>
        <div className="crash-message">{cleanError(error)}</div>
        <div className="crash-note">
          {root
            ? 'Reloading brings the app back; your saved work is safe on disk.'
            : 'The rest of the app is still running.'}
        </div>
        <button
          className="crash-retry"
          onClick={() =>
            root ? window.location.reload() : this.setState({ error: null })
          }
        >
          {root ? 'Reload' : 'Try again'}
        </button>
      </div>
    );
  }
}
