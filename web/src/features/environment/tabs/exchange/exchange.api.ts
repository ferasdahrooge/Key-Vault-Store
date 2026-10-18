/** ejson import/export for an environment. */
import { api, seg } from '@/shared/api/client';
import type { ImportCommitResult, ImportPreview } from '@/shared/api/types';

// Base path for an environment.
const base = (p: string, e: string) => `/api/projects/${seg(p)}/envs/${seg(e)}`;

// Server public key that import files must be encrypted to.
export const getImportKey = () => api.get<{ publicKey: string }>('/api/import-key');

/** Returns the encrypted .ejson document as a Blob (never parsed or cached). */
export const exportEjson = (p: string, e: string, body: { recipientPublicKey: string; keys?: string[] }) =>
  api.post<Blob>(`${base(p, e)}/export`, body, { responseType: 'blob' });

// Dry run of an import: what would change.
export const importPreview = (p: string, e: string, ejson: string) =>
  api.post<ImportPreview>(`${base(p, e)}/import/preview`, { ejson });

// Apply an import.
export const importCommit = (p: string, e: string, ejson: string, confirm?: string) =>
  api.post<ImportCommitResult>(`${base(p, e)}/import/commit`, confirm ? { ejson, confirm } : { ejson });
