/**
 * Authenticator codes are often copied as "123 456". Keep only digits (max 6) as the user types or
 * pastes, instead of letting maxLength truncate the paste to "123 45".
 */
export const otpDigits = (value: string) => value.replace(/\D/g, '').slice(0, 6);
