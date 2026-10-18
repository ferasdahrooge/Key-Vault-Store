import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { resetCsrfToken } from '@/shared/api/client';
import { apiError, mockFetch } from '@/test/fetchMock';
import { renderWithProviders } from '@/test/render';
import { LoginPage } from './LoginPage';

afterEach(() => {
  resetCsrfToken();
  vi.unstubAllGlobals();
});

// The login page inside the app's providers.
const app = (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/secret-place" element={<p>arrived</p>} />
    <Route path="/enroll" element={<p>enroll page</p>} />
  </Routes>
);

it('shows the MFA step after the password and signs in with TOTP', async () => {
  const m = mockFetch({
    'POST /api/auth/login': { body: { mfaRequired: true, methods: ['totp', 'recovery'] } },
    'POST /api/auth/mfa/totp': { body: { user: { id: 'u', email: 'a@b.c', name: 'A', isAdmin: false } } },
  });
  renderWithProviders(app, { route: '/login?next=%2Fsecret-place' });
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Recovery code' })).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Authenticator code'), '654321');
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByText('arrived')).toBeInTheDocument();
  expect(m.callsTo('POST /api/auth/mfa/totp')[0]?.body).toEqual({ code: '654321' });
});

it('shows a generic error for bad credentials, and a lockout message on 423 at the MFA step', async () => {
  mockFetch({
    'POST /api/auth/login': [apiError(401, 'invalid_credentials', 'nope'), { body: { mfaRequired: true, methods: ['totp'] } }],
    'POST /api/auth/mfa/totp': apiError(423, 'account_locked'),
  });
  renderWithProviders(app, { route: '/login' });
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Invalid email or password. Repeated failures temporarily lock the account.')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await userEvent.type(await screen.findByLabelText('Authenticator code'), '111111');
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByText(/temporarily locked after too many/)).toBeInTheDocument();
});

it('goes to /enroll when enrollment is required', async () => {
  mockFetch({ 'POST /api/auth/login': { body: { mfaEnrollmentRequired: true } } });
  renderWithProviders(app, { route: '/login' });
  await userEvent.type(screen.getByLabelText('Email'), 'a@b.c');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('enroll page')).toBeInTheDocument();
});
