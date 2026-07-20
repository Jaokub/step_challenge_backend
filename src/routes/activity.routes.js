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
import {
  enrollGroupIntoActivity,
  joinActivity,
  leaveActivity,
  getActivityParticipants,
} from '../controllers/activityParticipant.controller.js';

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
 * @route   POST /api/activities/:id/enroll-group
 * @desc    Enroll every member of a group as activity participants
 *          (registration only — no points, no check-ins). Caller must be
 *          OWNER/ADMIN of the group.
 * @access  Private
 */
router.post(
  '/:id/enroll-group',
  validate([body('groupId').trim().notEmpty().withMessage('groupId is required')]),
  enrollGroupIntoActivity
);

/**
 * @route   POST /api/activities/:id/join
 * @desc    Individual self-enroll as an activity participant
 * @access  Private
 */
router.post('/:id/join', joinActivity);

/**
 * @route   DELETE /api/activities/:id/leave
 * @desc    Remove the caller's own participant row (opt out of a cascade)
 * @access  Private
 */
router.delete('/:id/leave', leaveActivity);

/**
 * @route   GET /api/activities/:id/participants
 * @desc    List activity participants (admin, or an already-enrolled caller)
 * @access  Private
 */
router.get('/:id/participants', getActivityParticipants);

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
      // `<` not `<=`: a single-day activity legitimately has endDate ===
      // startDate, and SINGLE_DAY is the create form's DEFAULT duration (it
      // mirrors startDate into endDate). The old `<=` rejected that, so the
      // form's default state could never be submitted — while the controller
      // and the mobile-side validation both allowed `>=`. This validator was
      // the odd one out and it runs first. Fixed 2026-07-19; covered by
      // controllers/activity.controller.test.js.
      .custom((value, { req }) => {
        if (new Date(value) < new Date(req.body.startDate)) {
          throw new Error('End date must not be before start date');
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
