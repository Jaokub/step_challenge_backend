import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireGroupVisibility } from '../middleware/groupAuth.js';
import {
  getFriendsLeaderboard,
  getGroupLeaderboard
} from '../controllers/leaderboard.controller.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * ⛔ There is deliberately NO global leaderboard route.
 *
 * `GET /leaderboard/global` was removed on 2026-08-03 (TEST_FINDINGS F2). The
 * screen that consumed it, `app/leaderboard.tsx`, was deleted on 2026-07-20
 * because a faculty-wide individual ranking contradicts the hierarchy
 * visibility model — rankings flow downward through the group tree, and a flat
 * all-staff list has no place in that tree. The endpoint outlived its screen by
 * two weeks, still returning every top-ranked person's name, department and
 * step count to any signed-in caller.
 *
 * Do not re-add it as a convenience. If an admin surface ever needs a
 * faculty-wide step ranking, that is a new endpoint with `requireRole('ADMIN')`
 * on it from the first commit, not this one restored.
 */

router.get('/friends', getFriendsLeaderboard);

/**
 * @route GET /api/leaderboard/group/:groupId
 * @desc  Full member ranking (name, department, steps) for one group.
 * @access Private — members of the group, its ancestors, or Faculty Admin.
 *
 * The guard is not optional and must stay in step with
 * `GET /groups/:id/overview`, which serves substantially the same data behind
 * the same relations. Until 2026-08-03 this route had `authenticate` and
 * nothing else, so any signed-in user holding a group id could read that
 * group's full member ranking with no relationship to it whatsoever — a
 * strictly wider hole than PERMISSION_REVIEW.md B1, which at least required
 * joining an ancestor group first.
 *
 * `param: 'groupId'` because this route names the id differently to the
 * /groups routes; without it the middleware would look up `undefined` and
 * deny everyone.
 */
router.get(
  '/group/:groupId',
  requireGroupVisibility(['self', 'ancestor'], { param: 'groupId' }),
  getGroupLeaderboard
);

export default router;
