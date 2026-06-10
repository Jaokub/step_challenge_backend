import { Router } from 'express';
import { body } from 'express-validator';
import { register, login, refreshToken, getMe, changePassword } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

/**
 * POST /auth/register
 * Create a new user account.
 */
router.post(
  '/register',
  validate([
    body('email')
      .isEmail()
      .withMessage('A valid email address is required.')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters.'),
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Full name is required.'),
    body('nickname')
      .optional()
      .trim(),
    body('department')
      .optional()
      .trim(),
  ]),
  register
);

/**
 * POST /auth/login
 * Authenticate and receive tokens.
 */
router.post(
  '/login',
  validate([
    body('email')
      .isEmail()
      .withMessage('A valid email address is required.')
      .normalizeEmail(),
    body('password')
      .notEmpty()
      .withMessage('Password is required.'),
  ]),
  login
);

/**
 * POST /auth/refresh-token
 * Exchange a refresh token for a new access token.
 */
router.post(
  '/refresh-token',
  validate([
    body('refreshToken')
      .notEmpty()
      .withMessage('Refresh token is required.'),
  ]),
  refreshToken
);

/**
 * GET /auth/me
 * Get the currently authenticated user.
 */
router.get('/me', authenticate, getMe);

/**
 * PUT /auth/change-password
 * Change password.
 */
router.put(
  '/change-password',
  authenticate,
  validate([
    body('currentPassword')
      .notEmpty()
      .withMessage('Current password is required.'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters.'),
  ]),
  changePassword
);

export default router;
