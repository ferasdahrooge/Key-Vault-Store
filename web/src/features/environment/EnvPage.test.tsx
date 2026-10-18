import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment, SecretMeta } from '@/shared/api/types';
import { ToastProvider } from '@/shared/components/Toast';

vi.mock('./tabs/secrets/secrets.api', () => ({
  listSecrets: vi.fn(),
  createSecret: vi.fn(),
  updateSecret: vi.fn(),
  deleteSecret: vi.fn(),
  revealSecret: vi.fn(),
  listVersions: vi.fn(),
  rollbackSecret: vi.fn(),
}));
vi.mock('./tabs/exchange/exchange.api', () => ({
  getImportKey: vi.fn(),
  exportEjson: vi.fn(),
  importPreview: vi.fn(),
  importCommit: vi.fn(),
}));
vi.mock('@/shared/lib/clipboard', () => ({
  CLIPBOARD_CLEAR_MS: 30_000,
  copyWithAutoClear: vi.fn(),
  copyText: vi.fn(),
}));

import * as exchange from './tabs/exchange/exchange.api';
import * as secrets from './tabs/secrets/secrets.api';
import * as clipboard from '@/shared/lib/clipboard';
import { ExchangeTab } from './tabs/exchange/ExchangeTab';
import { RevealCell } from './tabs/secrets/RevealCell';
import { EditSecretDrawer, NewSecretDialog } from './tabs/secrets/SecretDialogs';

// Casts a mocked module function so its mock API is typed.
const m = <T,>(f: T) => f as unknown as ReturnType<typeof vi.fn>;

// Wraps a component in the providers it needs.
function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// Fixtures: an unprotected and a protected environment plus one secret.
const devEnv: Environment = { id: 'e1', slug: 'dev', name: 'Dev', color: 'green', protected: false, role: 'editor' };
const prodEnv: Environment = { id: 'e2', slug: 'prod', name: 'Prod', color: 'red', protected: true, role: 'owner' };
const secret: SecretMeta = {
  id: 's1',
  key: 'DB_PASSWORD',
  type: 'password',
  description: null,
  tags: [],
  currentVersion: 2,
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  updatedBy: null,
};

beforeEach(() => {
  m(secrets.listVersions).mockResolvedValue({ versions: [] });
  m(secrets.listSecrets).mockResolvedValue({ secrets: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// Reveal, auto-hide and copy behaviour.
describe('RevealCell', () => {
  it('shows the value then re-masks after 30s', async () => {
    vi.useFakeTimers();
    m(secrets.revealSecret).mockResolvedValue({ value: 'hunter2', version: 2 });
    wrap(<RevealCell project="app" env="dev" secretId="s1" secretKey="DB_PASSWORD" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal DB_PASSWORD' }));
    });
    expect(screen.getByTestId('value-DB_PASSWORD')).toHaveTextContent('hunter2');
    expect(screen.getByText('30s')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('20s')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByTestId('value-DB_PASSWORD')).not.toHaveTextContent('hunter2');
  });

  it('copy reveals and calls copyWithAutoClear without displaying', async () => {
    m(secrets.revealSecret).mockResolvedValue({ value: 'hunter2', version: 2 });
    m(clipboard.copyWithAutoClear).mockResolvedValue(() => {});
    wrap(<RevealCell project="app" env="dev" secretId="s1" secretKey="DB_PASSWORD" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy DB_PASSWORD' }));
    await waitFor(() => expect(clipboard.copyWithAutoClear).toHaveBeenCalledWith('hunter2'));
    expect(await screen.findByText('Copied — clipboard clears in 30s')).toBeInTheDocument();
    expect(screen.getByTestId('value-DB_PASSWORD')).not.toHaveTextContent('hunter2');
  });
});

// Protected environments require the typed slug.
describe('protected env edit', () => {
  it('requires typing the slug and sends confirm', async () => {
    m(secrets.updateSecret).mockResolvedValue({ secret });
    wrap(<EditSecretDrawer secret={secret} onClose={() => {}} project="app" env={prodEnv} canEdit />);
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'main db' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type "prod" to confirm'), { target: { value: 'pro' } });
    expect(confirmBtn).toBeDisabled();
    expect(secrets.updateSecret).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Type "prod" to confirm'), { target: { value: 'prod' } });
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(secrets.updateSecret).toHaveBeenCalled());
    const [p, e, id, body] = m(secrets.updateSecret).mock.calls[0]!;
    expect([p, e, id]).toEqual(['app', 'prod', 's1']);
    expect(body).toMatchObject({ description: 'main db', confirm: 'prod' });
    expect(body).not.toHaveProperty('value');
  });

  it('unprotected env saves without confirm', async () => {
    m(secrets.updateSecret).mockResolvedValue({ secret });
    wrap(<EditSecretDrawer secret={secret} onClose={() => {}} project="app" env={devEnv} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(secrets.updateSecret).toHaveBeenCalled());
    expect(m(secrets.updateSecret).mock.calls[0]![3]).not.toHaveProperty('confirm');
  });
});

// Creating a secret from the dialog.
describe('new secret', () => {
  it('blocks invalid JSON for json type', async () => {
    wrap(<NewSecretDialog open onClose={() => {}} project="app" env={devEnv} />);
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'CONFIG' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'json' } });
    const value = screen.getByLabelText('Value');
    expect(value.tagName).toBe('TEXTAREA');
    fireEvent.change(value, { target: { value: '{"a": ' } });
    expect(screen.getByText('Value must be valid JSON.')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    fireEvent.submit(document.getElementById('new-secret-form')!);
    expect(secrets.createSecret).not.toHaveBeenCalled();

    fireEvent.change(value, { target: { value: '{"a": 1}' } });
    expect(create).toBeEnabled();
  });

  it('rejects an invalid key', () => {
    wrap(<NewSecretDialog open onClose={() => {}} project="app" env={devEnv} />);
    const key = screen.getByLabelText('Key');
    fireEvent.change(key, { target: { value: '1BAD KEY' } });
    fireEvent.blur(key);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  // Regression: each keystroke in Value used to bounce focus back to Key.
  it('keeps focus in Value while typing', async () => {
    const user = userEvent.setup();
    wrap(<NewSecretDialog open onClose={() => {}} project="app" env={devEnv} />);
    await user.type(screen.getByLabelText('Key'), 'AWS_KEY');
    await user.click(screen.getByLabelText('Value'));
    await user.keyboard('123');
    expect(screen.getByLabelText('Value')).toHaveFocus();
    expect(screen.getByLabelText('Value')).toHaveValue('123');
    expect(screen.getByLabelText('Key')).toHaveValue('AWS_KEY');
  });
});

describe('import preview', () => {
  it('renders new/changed/unchanged and rejected rows', async () => {
    m(exchange.getImportKey).mockResolvedValue({ publicKey: 'a'.repeat(64) });
    m(exchange.importPreview).mockResolvedValue({
      changes: [
        { key: 'NEW_KEY', status: 'new' },
        { key: 'CHANGED_KEY', status: 'changed' },
        { key: 'SAME_KEY', status: 'unchanged' },
      ],
      rejected: [{ path: 'PLAIN', reason: 'value is not encrypted' }],
    });
    wrap(<ExchangeTab project="app" env={devEnv} role="editor" />);
    expect(await screen.findByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByText(/Export to \.ejson/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('…or paste encrypted contents'), { target: { value: '{"_public_key":"x"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    const table = await screen.findByRole('table', { name: 'Import preview' });
    expect(table).toHaveTextContent('NEW_KEY');
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('changed')).toBeInTheDocument();
    expect(screen.getByText('unchanged')).toBeInTheDocument();
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect(screen.getByText('value is not encrypted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit import' })).toBeEnabled();
  });
});
