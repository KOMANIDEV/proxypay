// Minimal WebAuthn stubs.
// The project previously used @simplewebauthn/server. To avoid hard
// compile-time coupling during this change, expose small stub helpers
// that will throw if called without a proper WebAuthn implementation.

export const CHALLENGE_TTL_SECONDS = 300;

export function generateRegistrationOptionsForUser(_userId: string) {
  throw new Error("WebAuthn registration not configured in this build");
}
export function getRpConfig(): {
  rpName: string;
  rpID: string;
  origin: string;
} {
  return {
    rpName: process.env.WEBAUTHN_RP_NAME || "ProxyPay",
    rpID: process.env.WEBAUTHN_RP_ID || "localhost",
    origin: process.env.WEBAUTHN_ORIGIN || "http://localhost:3000",
  };
}

export async function verifyRegistration(_response: unknown) {
  throw new Error("WebAuthn verification not configured in this build");
}

export function generateAuthenticationOptionsForUser() {
  throw new Error("WebAuthn authentication not configured in this build");
}

export async function verifyAuthentication(_response: unknown) {
  throw new Error(
    "WebAuthn authentication verification not configured in this build",
  );
}
