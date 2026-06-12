import { Router } from 'express';
import { body, query } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  syncHealthData,
  getMyHealthHistory,
  getHealthSummary,
  getTodayHealth,
  syncFromWebhook,
  getWeeklyChart,
} from '../controllers/health.controller.js';

const router = Router();

/**
 * @route POST /api/health/sync
 * @desc Sync health data from mobile app
 * @access Private
 */
router.post(
  '/sync',
  authenticate,
  validate([
    body('recordDate')
      .notEmpty()
      .withMessage('Record date is required')
      .isISO8601()
      .withMessage('Record date must be a valid ISO 8601 date'),
    body('source')
      .trim()
      .notEmpty()
      .withMessage('Source is required')
      .isIn(['GOOGLE_HEALTH', 'APPLE_HEALTH', 'MANUAL'])
      .withMessage('Source must be one of: GOOGLE_HEALTH, APPLE_HEALTH, MANUAL'),
    body('steps')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Steps must be a non-negative integer'),
    body('calories')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Calories must be a non-negative number'),
    body('distanceKm')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Distance must be a non-negative number'),
    body('activeMinutes')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Active minutes must be a non-negative integer'),
  ]),
  syncHealthData
);

/**
 * @route GET /api/health/history
 * @desc Get current user's health history with optional date range
 * @access Private
 */
router.get(
  '/history',
  authenticate,
  validate([
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be a valid ISO 8601 date'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Limit must be an integer between 1 and 365'),
  ]),
  getMyHealthHistory
);

/**
 * @route GET /api/health/summary
 * @desc Get current user's health summary
 * @access Private
 */
router.get('/summary', authenticate, getHealthSummary);

/**
 * @route GET /api/health/today
 * @desc Get today's health data
 * @access Private
 */
router.get('/today', authenticate, getTodayHealth);

/**
 * @route GET /api/health/weekly-chart
 * @desc Get weekly chart data (last 7 days)
 * @access Private
 */
router.get('/weekly-chart', authenticate, getWeeklyChart);

/**
 * @route POST /api/health/webhook
 * @desc Webhook for iOS Shortcuts to sync health data
 * @access Public (Uses syncToken)
 */
router.post(
  '/webhook',
  validate([
    body('syncToken').notEmpty().withMessage('syncToken is required'),
    body('steps').optional(),
    body('distanceKm').optional(),
  ]),
  syncFromWebhook
);

export default router;
