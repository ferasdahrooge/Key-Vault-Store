/**
 * Catches render errors so a bug in one page shows a recoverable message instead of a blank
 * screen. Resets when the route changes. Never renders error details (they could include data).
 */
import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/shared/components/ui';

// Class component because React error boundaries can't be hooks.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-24 max-w-md rounded-lg p-6 text-center ring-1 ring-stone-200 dark:ring-stone-700">
        <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">Try again, or go back to your projects.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => this.setState({ failed: false })}>
            Try again
          </Button>
          <Button onClick={() => window.location.assign('/')}>Projects</Button>
        </div>
      </div>
    );
  }
}

// Keyed by pathname so navigating away resets the error.
export function ErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
