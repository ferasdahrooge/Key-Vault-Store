import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { resetCsrfToken } from '@/shared/api/client';
import { externalRedirect } from '@/shared/lib/navigation';
import { apiError, mockFetch } from '@/test/fetchMock';
import { renderWithProviders } from '@/test/render';
import { GoogleCallbackPage } from './GoogleCallbackPage';
import { LoginPage } from './LoginPage';

vi.mock('@/shared/lib/navigation', async (orig) => ({ ...(await orig<typeof import('@/shared/lib/navigation')>()), externalRedirect: vi.fn() }));

afterEach(() => {
  cleanup();
  resetCsrfToken();
  vi.unstubAllGlobals();
  vi.mocked(externalRedirect).mockReset();
});

// The login + callback routes under test.
const app = (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/login/google/callback" element={<GoogleCallbackPage />} />
    <Route path="/secret-place" element={<p>arrived</p>} />
    <Route path="/enroll" element={<p>enroll page</p>} />
  </Routes>
);
// A signed-in user returned by /me once login completes.
const user = { id: 'u', email: 'a@b.c', name: 'A', isAdmin: false };

it('hides the Google button when the provider is off', async () => {
  const m = mockFetch({ 'GET /api/auth/providers': { body: { google: false } } });
  renderWithProviders(app, { route: '/login' });
  await vi.waitFor(() => expect(m.callsTo('GET /api/auth/providers')).toHaveLength(1));
  expect(screen.queryByRole('button', { name: /Google/ })).not.toBeInTheDocument();
});

it('starts the Google flow with the return path and leaves for Google', async () => {
  const m = mockFetch({
    'GET /api/auth/providers': { body: { google: true } },
    'POST /api/auth/google/start': { body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } },
  });
  renderWithProviders(app, { route: '/login?next=%2Fsecret-place' });
  await userEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
  await vi.waitFor(() => expect(externalRedirect).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
  expect(m.callsTo('POST /api/auth/google/start')[0]?.body).toEqual({ next: '/secret-place' });
});

it('callback: posts code + state once, then finishes MFA on the login page', async () => {
  const m = mockFetch({
    'POST /api/auth/google/callback': { body: { mfaRequired: true, methods: ['totp', 'recovery'], next: '/secret-place' } },
    'POST /api/auth/mfa/totp': { body: { user } },
  });
  renderWithProviders(app, { route: '/login/google/callback?state=st&code=c0de' });
  expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeInTheDocument();
  expect(m.callsTo('POST /api/auth/google/callback')).toHaveLength(1);
  expect(m.callsTo('POST /api/auth/google/callback')[0]?.body).toEqual({ code: 'c0de', state: 'st' });
  await userEvent.type(screen.getByLabelText('Authenticator code'), '123456');
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByText('arrived')).toBeInTheDocument();
});

it('callback: goes to enrollment when the user has no factor', async () => {
  mockFetch({ 'POST /api/auth/google/callback': { body: { mfaEnrollmentRequired: true } } });
  renderWithProviders(app, { route: '/login/google/callback?state=st&code=c0de' });
  expect(await screen.findByText('enroll page')).toBeInTheDocument();
});

it('callback: shows why Google sign-in failed back on the login page', async () => {
  mockFetch({ 'POST /api/auth/google/callback': apiError(401, 'google_login_failed') });
  renderWithProviders(app, { route: '/login/google/callback?state=st&code=c0de' });
  expect(await screen.findByText(/That Google account can’t be used to sign in here/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
});

it('callback: reports a cancelled consent screen without calling the API', async () => {
  const m = mockFetch({});
  renderWithProviders(app, { route: '/login/google/callback?error=access_denied&state=st' });
  expect(await screen.findByText('Google sign-in was cancelled.')).toBeInTheDocument();
  expect(m.callsTo('POST /api/auth/google/callback')).toHaveLength(0);
});
