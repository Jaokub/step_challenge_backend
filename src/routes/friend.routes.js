import { Router } from 'express';
import { body } from 'express-validator';
import {
  sendFriendRequest,
  acceptFriendRequest,
  removeFriend,
  getFriendsList,
  getPendingRequests
} from '../controllers/friend.controller.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// All friend routes require authentication
router.use(authenticate);

/**
 * GET /friends
 * Get list of accepted friends
 */
router.get('/', getFriendsList);

/**
 * GET /friends/requests
 * Get pending received friend requests
 */
router.get('/requests', getPendingRequests);

/**
 * POST /friends/request
 * Send a friend request
 */
router.post(
  '/request',
  validate([
    body('friendId').isUUID().withMessage('Valid friendId is required'),
  ]),
  sendFriendRequest
);

/**
 * PUT /friends/request/:id/accept
 * Accept a friend request
 */
router.put('/request/:id/accept', acceptFriendRequest);

/**
 * DELETE /friends/:id
 * Remove a friend or cancel a request
 */
router.delete('/:id', removeFriend);

export default router;
