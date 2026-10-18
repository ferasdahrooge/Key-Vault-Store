/** Service tokens for CI/servers: list, create (the plaintext token is returned once) and revoke. */
import { api, seg } from '@/shared/api/client';
import type { ServiceTokenMeta, TokenScope } from '@/shared/api/types';

// Base path for an environment's tokens.
const base = (p: string, e: string) => `/api/projects/${seg(p)}/envs/${seg(e)}/tokens`;

// Tokens for an environment.
export const listTokens = (p: string, e: string) => api.get<{ tokens: ServiceTokenMeta[] }>(base(p, e));

// Create a token; the response contains the only copy of the plaintext.
export const createToken = (
  p: string,
  e: string,
  body: { name: string; scopes: TokenScope[]; ejsonPublicKey?: string; expiresInDays?: number },
) => api.post<{ token: string; meta: ServiceTokenMeta }>(base(p, e), body);

// Revoke a token.
export const revokeToken = (p: string, e: string, id: string) => api.del<{ ok: boolean }>(`${base(p, e)}/${seg(id)}`);
