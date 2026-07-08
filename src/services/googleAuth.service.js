import { OAuth2Client } from 'google-auth-library';

/**
 * @module GoogleAuthService
 * @description Verifies Google ID tokens sent up by the mobile app. Kept
 * separate from auth.service.js so the Google-specific verification logic
 * (and its dependency on GOOGLE_CLIENT_ID) doesn't spread into the existing
 * JWT issuance helpers.
 *
 * GOOGLE_CLIENT_ID may be a comma-separated list (web client ID + Android
 * client ID) since a token minted for either audience must be accepted.
 */

const configuredClientIds = (process.env.GOOGLE_CLIENT_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const client = new OAuth2Client();

/**
 * Verify a Google ID token and return the payload's identity claims.
 * @param {string} idToken - The ID token obtained on-device via Google Sign-In.
 * @returns {Promise<{googleId: string, email: string, fullName: string, avatarUrl: string|null, emailVerified: boolean}>}
 * @throws {Error} If the token is missing/invalid/expired, or GOOGLE_CLIENT_ID isn't configured.
 */
export async function verifyGoogleIdToken(idToken) {
  if (!configuredClientIds.length) {
    throw new Error('GOOGLE_CLIENT_ID is not configured on the server.');
  }
  if (!idToken) {
    throw new Error('idToken is required.');
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: configuredClientIds,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error('Google token did not contain an email address.');
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    fullName: payload.name || payload.email.split('@')[0],
    avatarUrl: payload.picture || null,
    emailVerified: !!payload.email_verified,
  };
}

export default { verifyGoogleIdToken };
