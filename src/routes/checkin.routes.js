import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  checkInByQR,
  getCheckInHistory,
  getActivityCheckIns,
  cancelCheckIn,
} from '../controllers/checkin.controller.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /api/checkins/qr
 * @desc    Check in by scanning QR code
 * @access  Private
 */
router.post(
  '/qr',
  validate([
    body('qrCode')
      .trim()
      .notEmpty()
      .withMessage('QR code is required')
      .isUUID()
      .withMessage('QR code must be a valid UUID'),
    body('latitude')
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage('Latitude must be between -90 and 90'),
    body('longitude')
      .optional()
      .isFloat({ min: -180, max: 180 })
      .withMessage('Longitude must be between -180 and 180'),
  ]),
  checkInByQR
);

/**
 * @route   GET /api/checkins/history
 * @desc    Get current user's check-in history
 * @access  Private
 */
router.get('/history', getCheckInHistory);

/**
 * @route   GET /api/checkins/activity/:activityId
 * @desc    Get all check-ins for a specific activity
 * @access  Private/Admin
 */
router.get('/activity/:activityId', requireRole('ADMIN'), getActivityCheckIns);

/**
 * @route   DELETE /api/checkins/:id
 * @desc    Cancel a check-in
 * @access  Private
 */
router.delete('/:id', cancelCheckIn);

export default router;
