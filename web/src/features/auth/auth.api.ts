/**
 * Login, MFA, re-auth, logout and factor management. Calls that regenerate the server session
 * also drop the cached CSRF token (see sessionChanging).
 */
import { api, resetCsrfToken } from '@/shared/api/client';
import type {
  AuthenticationResponseJSON,
  AuthProviders,
  GoogleLoginResponse,
  LoginResponse,
  MeResponse,
  PasskeyInfo,
  PasskeyRegisterResponse,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  TotpEnrollResponse,
  User,
} from '@/shared/api/types';

/** Runs an auth call that regenerates the session, then forgets the CSRF token. */
async function sessionChanging<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } finally {
    resetCsrfToken();
  }
}

// Skip global auth redirects/re-auth for these calls; the page handles errors itself.
const noAuth = { auth: false } as const;

// Password step of login.
export const login = (email: string, password: string) =>
  sessionChanging(api.post<LoginResponse>('/api/auth/login', { email, password }, noAuth));

// Which extra sign-in providers are enabled.
export const getAuthProviders = () => api.get<AuthProviders>('/api/auth/providers', noAuth);

/** Returns Google's authorization URL; the browser navigates there. */
export const googleStart = (next?: string) => api.post<{ url: string }>('/api/auth/google/start', next ? { next } : {}, noAuth);

// Finish Google sign-in with the code/state Google returned.
export const googleCallback = (code: string, state: string) =>
  sessionChanging(api.post<GoogleLoginResponse>('/api/auth/google/callback', { code, state }, noAuth));

// Remove the linked Google account.
export const unlinkGoogle = () => api.del<{ ok: true }>('/api/auth/google');

// Second step: authenticator code.
export const mfaTotp = (code: string) =>
  sessionChanging(api.post<{ user: User }>('/api/auth/mfa/totp', { code }, noAuth));

// Second step: recovery code.
export const mfaRecovery = (code: string) =>
  sessionChanging(api.post<{ user: User; remainingCodes: number }>('/api/auth/mfa/recovery', { code }, noAuth));

// Second step: passkey challenge, then verification.
export const mfaPasskeyOptions = () =>
  api.post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/mfa/passkey/options', undefined, noAuth);

export const mfaPasskeyVerify = (response: AuthenticationResponseJSON) =>
  sessionChanging(api.post<{ user: User }>('/api/auth/mfa/passkey/verify', response, noAuth));

// Re-auth with an authenticator code.
export const reauthTotp = (code: string) =>
  sessionChanging(api.post<{ ok: true; mfaAt: string }>('/api/auth/reauth', { code }, noAuth));

// Re-auth with a passkey: challenge, then verification.
export const reauthPasskeyOptions = () =>
  api.post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/reauth/passkey/options', undefined, noAuth);

export const reauthPasskey = (passkey: AuthenticationResponseJSON) =>
  sessionChanging(api.post<{ ok: true; mfaAt: string }>('/api/auth/reauth', { passkey }, noAuth));

// End this session / all sessions.
export const logout = () => sessionChanging(api.post<{ ok: true }>('/api/auth/logout', undefined, noAuth));

export const logoutAll = () => sessionChanging(api.post<{ ok: true }>('/api/auth/logout-all'));

// Current user and MFA status.
export const getMe = () => api.get<MeResponse>('/api/auth/me');

/** Variant for public pages: does not redirect on 401. */
export const getMeQuiet = () => api.get<MeResponse>('/api/auth/me', noAuth);

// Start authenticator setup, then confirm it with a code.
export const totpEnroll = () => api.post<TotpEnrollResponse>('/api/auth/mfa/totp/enroll');

export const totpConfirm = (code: string) =>
  sessionChanging(api.post<{ recoveryCodes?: string[] }>('/api/auth/mfa/totp/confirm', { code }));

// Add a passkey: challenge, then save the new credential.
export const passkeyRegisterOptions = () =>
  api.post<PublicKeyCredentialCreationOptionsJSON>('/api/auth/mfa/passkey/register/options');

export const passkeyRegisterVerify = (response: RegistrationResponseJSON, name: string) =>
  sessionChanging(api.post<PasskeyRegisterResponse>('/api/auth/mfa/passkey/register/verify', { response, name }));

// List and remove registered passkeys.
export const listPasskeys = () => api.get<{ passkeys: PasskeyInfo[] }>('/api/auth/mfa/passkeys');

export const deletePasskey = (id: string) =>
  api.del<{ ok: boolean }>(`/api/auth/mfa/passkeys/${encodeURIComponent(id)}`);
