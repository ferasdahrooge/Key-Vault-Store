/** Route guard for signed-in pages. */
import { useCallback } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from './auth.api';
import { isApiError } from '@/shared/api/client';
import { useIdleLock } from './useIdleLock';
import { useMe } from './useMe';
import { loginPathFor } from '@/shared/lib/navigation';
import { Alert, Button, Spinner } from '@/shared/components/ui';

/** Gate for authenticated routes: loads /me, redirects to /login or /enroll, and runs the idle lock. */
export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Idle timeout: clear data, log out and go to login.
  const lock = useCallback(() => {
    qc.clear();
    logout().catch(() => {});
    void navigate('/login?reason=idle', { replace: true });
  }, [qc, navigate]);
  // Only arm the idle timer once we know there is a session to lock.
  useIdleLock(lock, { enabled: me.isSuccess });

  // Still loading the session.
  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-label="Loading">
        <Spinner className="size-6" />
      </div>
    );
  }
  // No session → login; enrollment mode → enroll; anything else → retry screen.
  if (me.isError) {
    if (isApiError(me.error) && me.error.status === 401) return <Navigate to={loginPathFor(loc)} replace />;
    if (isApiError(me.error, 'mfa_enrollment_required')) return <Navigate to="/enroll" replace />;
    return (
      <div className="mx-auto max-w-md p-6">
        <Alert>Could not load your session.</Alert>
        <Button className="mt-4" onClick={() => void me.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  // Logged in but no MFA yet: finish enrollment first.
  if (me.data.mfaEnrollmentRequired) return <Navigate to="/enroll" replace />;
  return <Outlet />;
}
