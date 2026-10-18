import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, resetClientHandlers, resetCsrfToken } from '@/shared/api/client';
import { mockFetch, apiError } from '@/test/fetchMock';
import { renderWithProviders } from '@/test/render';
import { ReauthProvider } from './ReauthProvider';

afterEach(() => {
  resetClientHandlers();
  resetCsrfToken();
  vi.unstubAllGlobals();
});

it('shows the re-auth modal on reauth_required, verifies TOTP, then retries the request', async () => {
  const m = mockFetch({
    'POST /api/projects/p/envs/prod/rotate-key': [apiError(401, 'reauth_required'), { body: { ok: true, dekVersion: 2, reencrypted: 3 } }],
    'POST /api/auth/reauth': { body: { ok: true, mfaAt: new Date().toISOString() } },
  });
  renderWithProviders(
    <ReauthProvider>
      <div />
    </ReauthProvider>,
  );
  const pending = api.post('/api/projects/p/envs/prod/rotate-key');
  const dialog = await screen.findByRole('dialog', { name: /confirm it's you/i });
  expect(dialog).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await expect(pending).resolves.toMatchObject({ ok: true });
  expect(m.callsTo('POST /api/auth/reauth')[0]?.body).toEqual({ code: '123456' });
  expect(m.callsTo('POST /api/projects/p/envs/prod/rotate-key')).toHaveLength(2);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('rejects the original request when the modal is cancelled', async () => {
  mockFetch({ 'POST /api/x': [apiError(401, 'reauth_required')] });
  renderWithProviders(
    <ReauthProvider>
      <div />
    </ReauthProvider>,
  );
  const pending = api.post('/api/x').then(
    () => null,
    (e: unknown) => e,
  );
  await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(await pending).toMatchObject({ code: 'reauth_required' });
});
