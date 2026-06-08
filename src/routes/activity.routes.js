import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  getActivities,
  getActivityById,
  createActivity,
  updateActivity,
  deleteActivity,
  getMyActivities,
} from '../controllers/activity.controller.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/activities
 * @desc    List activities with filters, search, and pagination
 * @access  Private
 */
router.get('/', getActivities);

/**
 * @route   GET /api/activities/my
 * @desc    Get activities the current user has checked into
 * @access  Private
 */
router.get('/my', getMyActivities);

/**
 * @route   GET /api/activities/:id
 * @desc    Get single activity with participants and check-in status
 * @access  Private
 */
router.get('/:id', getActivityById);

/**
 * @route   POST /api/activities
 * @desc    Create a new activity
 * @access  Private/Admin
 */
router.post(
  '/',
  requireRole('ADMIN'),
  validate([
    body('title')
      .trim()
      .notEmpty()
      .withMessage('Title is required')
      .isLength({ max: 255 })
      .withMessage('Title must be at most 255 characters'),
    body('startDate')
      .notEmpty()
      .withMessage('Start date is required')
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date'),
    body('endDate')
      .notEmpty()
      .withMessage('End date is required')
      .isISO8601()
      .withMessage('End date must be a valid ISO 8601 date')
      .custom((value, { req }) => {
        if (new Date(value) <= new Date(req.body.startDate)) {
          throw new Error('End date must be after start date');
        }
        return true;
      }),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage('Description must be at most 2000 characters'),
    body('location')
      .optional()
      .trim()
      .isLength({ max: 255 })
      .withMessage('Location must be at most 255 characters'),
    body('maxParticipants')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Max participants must be a positive integer'),
    body('points')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Points must be a non-negative integer'),
  ]),
  createActivity
);

/**
 * @route   PUT /api/activities/:id
 * @desc    Update an activity
 * @access  Private/Admin
 */
router.put('/:id', requireRole('ADMIN'), updateActivity);

/**
 * @route   DELETE /api/activities/:id
 * @desc    Soft delete (cancel) an activity
 * @access  Private/Admin
 */
router.delete('/:id', requireRole('ADMIN'), deleteActivity);

export default router;
