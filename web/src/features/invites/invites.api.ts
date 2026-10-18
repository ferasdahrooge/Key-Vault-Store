/** Invites: create (admin), look up and accept (public, from the invite link). */
import { api, resetCsrfToken, seg } from '@/shared/api/client';

// Admin creates an invite link.
export const createInvite = (body: { email: string; name: string; isAdmin?: boolean }) =>
  api.post<{ inviteUrl: string; expiresAt: string }>('/api/invites', body);

// Look up who an invite is for.
export const getInvite = (token: string) =>
  api.get<{ email: string; name: string }>(`/api/invites/${seg(token)}`, { auth: false });

// Set a password from the invite link; the session changes, so drop the CSRF token.
export const acceptInvite = async (token: string, password: string) => {
  try {
    return await api.post<{ mfaEnrollmentRequired: true }>(
      `/api/invites/${seg(token)}/accept`,
      { password },
      { auth: false },
    );
  } finally {
    resetCsrfToken();
  }
};
