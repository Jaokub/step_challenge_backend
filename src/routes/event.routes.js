import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createEvent,
  getEvents,
  getEvent,
  joinEvent,
  leaveEvent,
  getEventLeaderboard,
  getEventStatsController,
} from '../controllers/event.controller.js';

const router = Router();

/**
 * @route POST /api/v1/events
 * @desc Create a step-count event
 * @access Private (ADMIN)
 */
router.post(
  '/',
  authenticate,
  requireRole('ADMIN'),
  validate([
    body('title').trim().notEmpty().withMessage('Event title is required.').isLength({ max: 150 }),
    body('description').optional().trim().isLength({ max: 1000 }),
    body('startDate').notEmpty().withMessage('startDate is required.').isISO8601(),
    body('endDate').notEmpty().withMessage('endDate is required.').isISO8601(),
  ]),
  createEvent
);

/**
 * @route GET /api/v1/events
 * @desc List all events
 * @access Private
 */
router.get('/', authenticate, getEvents);

/**
 * @route GET /api/v1/events/:id
 * @desc Get one event (with the caller's join status)
 * @access Private
 */
router.get('/:id', authenticate, getEvent);

/**
 * @route POST /api/v1/events/:id/join
 * @desc Join an event individually or enroll a whole group (group admin only)
 * @access Private
 */
router.post(
  '/:id/join',
  authenticate,
  validate([
    body('mode').isIn(['INDIVIDUAL', 'GROUP']).withMessage("mode must be 'INDIVIDUAL' or 'GROUP'."),
    body('groupId').optional().isString(),
  ]),
  joinEvent
);

/**
 * @route DELETE /api/v1/events/:id/leave
 * @desc Leave an event
 * @access Private
 */
router.delete('/:id/leave', authenticate, leaveEvent);

/**
 * @route GET /api/v1/events/:id/leaderboard?scope=individual|group
 * @desc Event leaderboard (individual ranking or group-sum ranking)
 * @access Private
 */
router.get('/:id/leaderboard', authenticate, getEventLeaderboard);

/**
 * @route GET /api/v1/events/:id/stats
 * @desc Event-wide stats (total steps of all participants)
 * @access Private
 */
router.get('/:id/stats', authenticate, getEventStatsController);

export default router;
