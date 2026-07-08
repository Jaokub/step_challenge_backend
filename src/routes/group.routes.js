import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { requireGroupMember, requireGroupVisibility } from '../middleware/groupAuth.js';
import { validate } from '../middleware/validate.js';
import {
  getGroups,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  joinByQR,
  removeMember,
  getGroupMembers,
  getGroupQRCode,
  leaveGroup,
} from '../controllers/group.controller.js';
import { getGroupOverview, getGroupSiblings } from '../controllers/groupOverview.controller.js';

const router = Router();

/**
 * @route GET /api/groups
 * @desc List all groups the current user belongs to
 * @access Private
 */
router.get('/', authenticate, getGroups);

/**
 * @route POST /api/groups
 * @desc Create a new group
 * @access Private
 */
router.post(
  '/',
  authenticate,
  validate([
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Group name is required')
      .isLength({ max: 100 })
      .withMessage('Group name must be at most 100 characters'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description must be at most 500 characters'),
  ]),
  createGroup
);

/**
 * @route POST /api/groups/join
 * @desc Join a group using QR invite code
 * @access Private
 */
router.post(
  '/join',
  authenticate,
  validate([
    body('inviteCode')
      .trim()
      .notEmpty()
      .withMessage('Invite code is required'),
  ]),
  joinByQR
);

/**
 * @route GET /api/groups/:id
 * @desc Get group details with members list
 * @access Private
 */
router.get('/:id', authenticate, requireGroupMember(), getGroupById);

/**
 * @route PUT /api/groups/:id
 * @desc Update group name/description
 * @access Private (OWNER/ADMIN only)
 */
router.put(
  '/:id',
  authenticate,
  requireGroupMember({
    roles: ['OWNER', 'ADMIN'],
    roleMessage: 'Only group owners and admins can update group details',
  }),
  updateGroup
);

/**
 * @route DELETE /api/groups/:id
 * @desc Delete a group
 * @access Private (OWNER only)
 */
router.delete(
  '/:id',
  authenticate,
  requireGroupMember({
    roles: ['OWNER'],
    roleMessage: 'Only the group owner can delete the group',
  }),
  deleteGroup
);

/**
 * @route DELETE /api/groups/:id/members/:userId
 * @desc Remove a member from a group
 * @access Private (OWNER/ADMIN only)
 */
router.delete(
  '/:id/members/:userId',
  authenticate,
  requireGroupMember({
    roles: ['OWNER', 'ADMIN'],
    roleMessage: 'Only group owners and admins can remove members',
  }),
  removeMember
);

/**
 * @route GET /api/groups/:id/members
 * @desc List all members of a group
 * @access Private
 */
router.get('/:id/members', authenticate, requireGroupMember(), getGroupMembers);

/**
 * @route GET /api/groups/:id/qrcode
 * @desc Generate and return QR code for group invite
 * @access Private
 */
router.get('/:id/qrcode', authenticate, requireGroupMember(), getGroupQRCode);

/**
 * @route POST /api/groups/:id/leave
 * @desc Leave a group
 * @access Private
 */
router.post(
  '/:id/leave',
  authenticate,
  requireGroupMember({ notMemberStatus: 404 }),
  leaveGroup
);

/**
 * @route GET /api/groups/:id/overview
 * @desc Own overall stats + full ranking + top3/top5 for a group.
 * @access Private (members of the group, or members of its parent group)
 */
router.get(
  '/:id/overview',
  authenticate,
  requireGroupVisibility(['self', 'ancestor']),
  getGroupOverview
);

/**
 * @route GET /api/groups/:id/siblings
 * @desc Sibling groups' overall stats only (never their member ranking).
 * @access Private (members of the group, or members of its parent group)
 */
router.get(
  '/:id/siblings',
  authenticate,
  requireGroupVisibility(['self', 'ancestor']),
  getGroupSiblings
);

export default router;
