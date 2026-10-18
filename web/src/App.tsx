import { Link, Route, Routes } from 'react-router-dom';
import { Layout } from '@/app/Layout';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { EmptyState } from '@/shared/components/ui';
import { AccessRequestsPage } from '@/features/access-requests/AccessRequestsPage';
import { AccountPage } from '@/features/account/AccountPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { ComparePage } from '@/features/projects/ComparePage';
import { DashboardPage } from '@/features/projects/DashboardPage';
import { EnrollPage } from '@/features/auth/EnrollPage';
import { EnvPage } from '@/features/environment/EnvPage';
import { GoogleCallbackPage } from '@/features/auth/GoogleCallbackPage';
import { InvitePage } from '@/features/invites/InvitePage';
import { LoginPage } from '@/features/auth/LoginPage';

// Fallback page for unknown routes.
function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="text-brand-600 dark:text-brand-400 underline">
        Back to projects
      </Link>
    </EmptyState>
  );
}

// Route table: public auth pages first, then everything behind RequireAuth + Layout.
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/google/callback" element={<GoogleCallbackPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route path="/enroll" element={<EnrollPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="p/:project/compare" element={<ComparePage />} />
          <Route path="p/:project/:env" element={<EnvPage />} />
          <Route path="access-requests" element={<AccessRequestsPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
