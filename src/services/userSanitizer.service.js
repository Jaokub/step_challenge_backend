/**
 * @module UserSanitizerService
 * @description Strips sensitive fields from user objects before returning them
 * in API responses. Single source of truth to prevent accidental data leaks.
 */

/**
 * Remove sensitive fields (e.g. passwordHash) from a Prisma user record.
 * @param {Object} user - The raw Prisma user object.
 * @returns {Object} A safe user object with no sensitive fields.
 */
export const sanitizeUser = (user) => {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
};
