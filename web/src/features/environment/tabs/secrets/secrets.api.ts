/** Secrets in an environment: CRUD, reveal, version history and rollback. Values are never cached. */
import { api, seg } from '@/shared/api/client';
import type { SecretMeta, SecretType, SecretVersion } from '@/shared/api/types';

// Base path for an environment's secrets.
const base = (p: string, e: string) => `/api/projects/${seg(p)}/envs/${seg(e)}/secrets`;

// Secret metadata, optionally filtered.
export const listSecrets = (p: string, e: string, filter: { q?: string; tag?: string; type?: string } = {}) =>
  api.get<{ secrets: SecretMeta[] }>(base(p, e), { query: filter });

// Fields for a new secret.
export interface CreateSecretInput {
  key: string;
  value: string;
  type?: SecretType;
  description?: string;
  tags?: string[];
  expiresAt?: string | null;
}

// Create a secret.
export const createSecret = (p: string, e: string, body: CreateSecretInput) =>
  api.post<{ secret: SecretMeta }>(base(p, e), body);

// One secret's metadata.
export const getSecret = (p: string, e: string, id: string) =>
  api.get<{ secret: SecretMeta }>(`${base(p, e)}/${seg(id)}`);

// Fields for updating a secret (a new value adds a version).
export interface UpdateSecretInput {
  value?: string;
  type?: SecretType;
  description?: string;
  tags?: string[];
  expiresAt?: string | null;
  comment?: string;
  confirm?: string;
}

// Update a secret.
export const updateSecret = (p: string, e: string, id: string, body: UpdateSecretInput) =>
  api.patch<{ secret: SecretMeta }>(`${base(p, e)}/${seg(id)}`, body);

// Delete a secret (protected envs need confirm).
export const deleteSecret = (p: string, e: string, id: string, confirm?: string) =>
  api.del<{ ok: boolean }>(`${base(p, e)}/${seg(id)}`, { query: { confirm } });

/** Returns the plaintext value. Callers must keep it in component state only. */
export const revealSecret = (p: string, e: string, id: string, version?: number) =>
  api.post<{ value: string; version: number }>(`${base(p, e)}/${seg(id)}/reveal`, version ? { version } : {});

// Version history (no values).
export const listVersions = (p: string, e: string, id: string) =>
  api.get<{ versions: SecretVersion[] }>(`${base(p, e)}/${seg(id)}/versions`);

// Restore an old version as a new one.
export const rollbackSecret = (p: string, e: string, id: string, version: number, confirm?: string) =>
  api.post<{ secret: SecretMeta }>(`${base(p, e)}/${seg(id)}/rollback/${version}`, confirm ? { confirm } : {});
