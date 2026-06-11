import { Router } from 'express';
import { body } from 'express-validator';
import {
  getProfile,
  updateProfile,
  getAllUsers,
  searchUsers,
} from '../controllers/user.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

/**
 * GET /users/profile/:id
 * Get a user's profile by ID. Requires authentication.
 */
router.get('/profile/:id', authenticate, getProfile);

/**
 * GET /users/search
 * Search users by name or email
 */
router.get('/search', authenticate, searchUsers);

/**
 * PUT /users/profile
 * Update the authenticated user's own profile.
 */
router.put(
  '/profile',
  authenticate,
  validate([
    body('fullName')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Full name cannot be empty.'),
    body('nickname')
      .optional()
      .trim(),
    body('department')
      .optional()
      .trim(),
    body('avatarUrl')
      .optional()
      .isURL()
      .withMessage('Avatar URL must be a valid URL.'),
  ]),
  updateProfile
);

/**
 * GET /users/
 * Admin only — list all users with pagination and search.
 */
router.get('/', authenticate, requireRole('ADMIN'), getAllUsers);

export default router;
