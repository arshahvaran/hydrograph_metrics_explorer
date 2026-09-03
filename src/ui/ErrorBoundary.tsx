import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State { error: Error | null }

export const RENDER_FAILED_MESSAGE = 'Something went wrong while drawing this tab. Reload the page; if it happens again, save the project file and report it.';

/**
 * Catches a render-time exception in one tab so React does not unmount the
 * whole application (a null event threshold in a project file once left a
 * blank page that only a reload recovered). Remounted on every tab or
 * dataset switch through its key, so the next tab gets a clean slate.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render failed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="card">
          <div className="error" role="alert">
            {RENDER_FAILED_MESSAGE}{' '}
            <span className="muted">({this.state.error.message || String(this.state.error)})</span>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
