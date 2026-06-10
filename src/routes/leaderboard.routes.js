import express from 'express';
import { protect } from '../middleware/auth.middleware.js';
import {
  getGlobalLeaderboard,
  getFriendsLeaderboard,
  getGroupLeaderboard
} from '../controllers/leaderboard.controller.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

router.get('/global', getGlobalLeaderboard);
router.get('/friends', getFriendsLeaderboard);
router.get('/group/:groupId', getGroupLeaderboard);

export default router;
