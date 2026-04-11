/**
 * Auth service — portal integration.
 *
 * All authentication is delegated to the MSP Portal.
 * This file retains stubs for functions that other modules may still
 * reference during the migration. They throw at runtime so any
 * lingering call site is surfaced immediately.
 */

import { ShelfError } from "~/utils/error";

const label = "Auth" as const;

function unsupported(fn: string): never {
  throw new ShelfError({
    cause: null,
    message: `${fn} is not available — authentication is managed by the MSP Portal`,
    label,
  });
}

/** @deprecated — portal manages account creation */
export function createEmailAuthAccount(
  _email: string,
  _password: string
): never {
  unsupported("createEmailAuthAccount");
}

/** @deprecated */
export function confirmExistingAuthAccount(
  _email: string,
  _password: string
): never {
  unsupported("confirmExistingAuthAccount");
}

/** @deprecated */
export function signInWithEmail(_email: string, _password: string): never {
  unsupported("signInWithEmail");
}

/** @deprecated */
export function updateAccountPassword(
  _id: string,
  _password: string,
  _accessToken?: string
): never {
  unsupported("updateAccountPassword");
}

/** @deprecated */
export function deleteAuthAccount(_userId: string): never {
  unsupported("deleteAuthAccount");
}

/** @deprecated */
export function getAuthUserById(_userId: string): never {
  unsupported("getAuthUserById");
}

/** @deprecated */
export function signUpWithEmailPass(_email: string, _password: string): never {
  unsupported("signUpWithEmailPass");
}

/** @deprecated */
export function sendOTP(_email: string): never {
  unsupported("sendOTP");
}

/** @deprecated */
export function verifyOtpAndSignin(_email: string, _otp: string): never {
  unsupported("verifyOtpAndSignin");
}

/** @deprecated */
export function refreshAccessToken(_refreshToken?: string): never {
  unsupported("refreshAccessToken");
}

/** @deprecated */
export function validateSession(_token: string): never {
  unsupported("validateSession");
}
