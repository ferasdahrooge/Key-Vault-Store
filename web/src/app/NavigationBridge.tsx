/** Connects the framework-free API client to React Router so auth errors can redirect. */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { setClientHandlers } from '@/shared/api/client';
import { isPublicPath, loginPathFor, navigateTo, setNavigator } from '@/shared/lib/navigation';

/** Lets the API client navigate: 401 -> /login?next=, enrollment mode -> /enroll. Render inside the router. */
export function NavigationBridge() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    // Give non-React code access to the router.
    setNavigator((to, opts) => void navigate(to, opts));
    setClientHandlers({
      // Session gone: clear cached data and send the user to login.
      onUnauthenticated: (code) => {
        qc.clear();
        const loc = window.location;
        if (isPublicPath(loc.pathname)) return;
        navigateTo(loginPathFor(loc, code === 'session_expired' ? 'expired' : undefined), { replace: true });
      },
      // No MFA factor yet: send the user to enrollment.
      onEnrollmentRequired: () => {
        if (!window.location.pathname.startsWith('/enroll')) navigateTo('/enroll', { replace: true });
      },
    });
    return () => setNavigator(null);
  }, [navigate, qc]);
  return null;
}
