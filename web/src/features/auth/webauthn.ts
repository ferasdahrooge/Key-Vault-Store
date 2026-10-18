/** Thin wrappers over @simplewebauthn/browser, plus user-facing messages for passkey errors. */
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/** False on browsers without WebAuthn (and if the check itself throws, e.g. in some test DOMs). */
export const webauthnSupported = () => {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};

// Prompts for an existing passkey.
export function authenticate(optionsJSON: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

// Prompts the user to create a new passkey.
export function register(optionsJSON: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

/** Friendly text for passkey prompt errors (cancel, timeout); null for errors that aren't WebAuthn's. */
export function webauthnErrorMessage(e: unknown): string | null {
  if (e instanceof WebAuthnError) {
    if (e.code === 'ERROR_CEREMONY_ABORTED') return 'Passkey prompt was cancelled.';
    return 'Passkey operation failed or was cancelled.';
  }
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
    return 'Passkey prompt was cancelled or timed out.';
  }
  return null;
}
