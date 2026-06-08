import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/**
 * Generate a JWT access token for a user.
 * @param {Object} user - The user object.
 * @param {string} user.id - User ID.
 * @param {string} user.email - User email.
 * @param {string} user.role - User role (ADMIN/STAFF).
 * @returns {string} Signed JWT access token.
 */
export function generateAccessToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}

/**
 * Generate a longer-lived JWT refresh token for a user.
 * @param {Object} user - The user object.
 * @param {string} user.id - User ID.
 * @param {string} user.email - User email.
 * @param {string} user.role - User role (ADMIN/STAFF).
 * @returns {string} Signed JWT refresh token.
 */
export function generateRefreshToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
}

/**
 * Hash a plaintext password using bcrypt.
 * @param {string} password - The plaintext password.
 * @returns {Promise<string>} The bcrypt hash.
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * @param {string} password - The plaintext password.
 * @param {string} hash - The bcrypt hash to compare against.
 * @returns {Promise<boolean>} True if the password matches the hash.
 */
export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Verify and decode a JWT refresh token.
 * @param {string} token - The refresh token to verify.
 * @returns {Object} The decoded token payload.
 * @throws {jwt.JsonWebTokenError} If the token is invalid or expired.
 */
export function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
}
