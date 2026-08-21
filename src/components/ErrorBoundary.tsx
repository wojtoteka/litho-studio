import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '@/lib/logger.js';
import { Icon } from './Icon.js';

interface Props {
  children: ReactNode;
  /** Shown instead of the default panel; used for per-panel boundaries. */
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

/**
 * Error boundary.
 *
 * The editor writes to real files, so a crashed panel must never take the whole
 * window with it - the user has to keep access to the parts that still work,
 * and to the console panel that explains what happened. Recovery is a local
 * remount rather than a page reload, which preserves unsaved editor state.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error(`Błąd interfejsu: ${error.message}`, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <h2 className="error-boundary__title">
          <Icon name="error" size={20} />
          {this.props.fallbackTitle ?? 'Coś poszło nie tak w tej części edytora'}
        </h2>
        <p className="error-boundary__message">
          Twoje zmiany są zapisywane na bieżąco na dysku, więc nic nie zostało utracone.
        </p>
        <pre className="error-boundary__detail">{error.message}</pre>
        <button type="button" className="button button--primary" onClick={this.handleRetry}>
          <Icon name="restart_alt" size={15} />
          Spróbuj ponownie
        </button>
      </div>
    );
  }
}
