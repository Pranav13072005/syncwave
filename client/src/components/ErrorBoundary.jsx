import { Component } from 'react';

// Phase 7: last-resort guard against an unexpected render error leaving the
// whole app blank with no explanation. Deliberately minimal - this is not a
// substitute for the specific try/catch error handling already in place
// throughout Room.jsx/audioEngine.js/etc. (invalid room, decode failure,
// upload failure, etc. all show their own inline messages); this only
// catches something those didn't anticipate. Logs the real error to the
// console for development, shows only a generic message + reload action to
// the user - never a raw stack trace.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="landing">
          <h1>Something went wrong</h1>
          <p>SyncWave hit an unexpected error. Reloading usually fixes it.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
