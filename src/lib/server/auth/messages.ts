/** The one answer for a wrong password, an unknown e-mail, a disabled or a locked account (no oracle). */
export const INVALID_CREDENTIALS = 'Incorrect e-mail or password.';
export const TOO_MANY_ATTEMPTS = 'Too many attempts. Try again in a few minutes.';
export const FIELDS_REQUIRED = 'Enter your e-mail and password.';
export const NAME_REQUIRED = 'Enter your name.';
export const EMAIL_INVALID = 'Enter a valid e-mail address.';
/** Any refused invite link: unknown, expired, revoked or already used (one answer, the token is a secret). */
export const INVITE_INVALID = 'This invite link is no longer valid. Ask an admin for a new one.';
/** A 401 for a non-GET request without a live session (auth/gate.ts). */
export const SESSION_ENDED = 'Your session has ended. Please sign in again.';
